import { plainText, request, type Find } from './http.ts';

const API = 'https://hacker-news.firebaseio.com/v0';
const discussion = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

type Story = { id: number; title?: string; url?: string; text?: string; time: number; deleted?: boolean; dead?: boolean };
type Show = { objectID: string; title?: string; url?: string; story_text?: string; created_at: string };

export async function fetch(transport = globalThis.fetch): Promise<Find[]> {
  const get = async (url: string) => (await request(url, transport)).json();
  const top = async () => {
    const ids: number[] = await get(`${API}/topstories.json`);
    return Promise.all(ids.slice(0, 40).map((id): Promise<Story | null> => get(`${API}/item/${id}.json`)));
  };
  const [stories, { hits }]: [Array<Story | null>, { hits: Show[] }] = await Promise.all([
    top(), get('https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=30'),
  ]);
  const finds = new Map<string, Find>();
  for (const hit of hits.slice(0, 30)) {
    if (!hit.title) continue;
    finds.set(hit.objectID, {
      source: 'hackernews', externalId: hit.objectID, title: hit.title,
      url: hit.url || discussion(hit.objectID), summary: plainText(hit.story_text), publishedAt: hit.created_at,
    });
  }
  const topFinds = new Map<string, Find>();
  for (const story of stories) {
    if (!story?.title || story.deleted || story.dead) continue;
    const id = String(story.id);
    topFinds.set(id, {
      source: 'hackernews', externalId: id, title: story.title, url: story.url || discussion(id),
      summary: plainText(story.text) || finds.get(id)?.summary || '',
      publishedAt: new Date(story.time * 1000).toISOString(),
    });
    finds.delete(id);
  }
  return [...topFinds.values(), ...finds.values()];
}
