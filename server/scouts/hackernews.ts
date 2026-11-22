import { plainText, request, type Find } from './http.ts';

const API = 'https://hacker-news.firebaseio.com/v0';
const discussion = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

type Story = { id: number; title?: string; url?: string; text?: string; time?: number; deleted?: boolean; dead?: boolean };
type Show = { objectID: string; title?: string; url?: string; story_text?: string; created_at?: string };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function fetch(transport = globalThis.fetch): Promise<Find[]> {
  const get = async (url: string) => (await request(url, transport)).json();
  const top = async () => {
    const ids = await get(`${API}/topstories.json`);
    if (!Array.isArray(ids)) throw new Error('Hacker News returned invalid topstories');
    return mapLimit(ids.slice(0, 40), 8, async (id): Promise<Story | null> => {
      try {
        return await get(`${API}/item/${id}.json`);
      } catch {
        return null;
      }
    });
  };
  const show = async () => {
    const data = await get('https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=30');
    if (!Array.isArray(data?.hits)) throw new Error('HN Algolia returned invalid hits');
    return data.hits as Show[];
  };
  const [topRes, showRes] = await Promise.allSettled([top(), show()]);
  if (topRes.status === 'rejected' && showRes.status === 'rejected') {
    throw topRes.reason;
  }
  const stories = topRes.status === 'fulfilled' ? topRes.value : [];
  const hits = showRes.status === 'fulfilled' ? showRes.value : [];

  const finds = new Map<string, Find>();
  for (const hit of hits.slice(0, 30)) {
    if (!hit?.objectID || !hit.title) continue;
    finds.set(String(hit.objectID), {
      source: 'hackernews', externalId: String(hit.objectID), title: hit.title,
      url: hit.url || discussion(String(hit.objectID)), summary: plainText(hit.story_text),
      publishedAt: typeof hit.created_at === 'string' && hit.created_at ? hit.created_at : undefined,
    });
  }
  const topFinds = new Map<string, Find>();
  for (const story of stories) {
    if (!story?.id || !story?.title || story.deleted || story.dead) continue;
    const id = String(story.id);
    topFinds.set(id, {
      source: 'hackernews', externalId: id, title: story.title, url: story.url || discussion(id),
      summary: plainText(story.text) || finds.get(id)?.summary || '',
      publishedAt: Number.isFinite(story.time) ? new Date(story.time! * 1000).toISOString() : undefined,
    });
    finds.delete(id);
  }
  return [...topFinds.values(), ...finds.values()];
}
