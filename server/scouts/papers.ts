import { request, type Find } from './http.ts';

export type Paper = { id: string; title: string; summary: string; published: string; upvotes: number };

function toPaper(raw: any): Paper | null {
  const p = raw?.paper ?? raw;
  if (!p?.id || !p?.title) return null;
  return {
    id: String(p.id),
    title: String(p.title).replace(/\s+/g, ' ').trim(),
    summary: String(p.ai_summary || p.summary || raw.summary || '').replace(/\s+/g, ' ').trim(),
    published: String(p.publishedAt || raw.publishedAt || ''),
    upvotes: Number(p.upvotes) || 0,
  };
}

const API = 'https://huggingface.co/api';

async function getPapers(path: string, transport: typeof fetch) {
  const rows = await (await request(API + path, transport, { Accept: 'application/json' })).json();
  if (!Array.isArray(rows)) throw new Error('Hugging Face returned invalid papers');
  return rows.map(toPaper).filter((paper): paper is Paper => paper !== null);
}

const dailyPapers = (transport: typeof fetch) => getPapers('/daily_papers?limit=60', transport);
export const paperUrl = (id: string) => `https://huggingface.co/papers/${id}`;

export async function fetch(transport = globalThis.fetch): Promise<Find[]> {
  const papers = await dailyPapers(transport);
  return papers.map((paper) => ({
    source: 'papers', externalId: paper.id, title: paper.title, url: paperUrl(paper.id),
    summary: paper.summary, publishedAt: paper.published || undefined,
  }));
}

export async function fetchPapers(goal: string, transport = globalThis.fetch): Promise<Paper[]> {
  const query = encodeURIComponent(goal.trim().slice(0, 200));
  const [daily, searched] = await Promise.all([
    dailyPapers(transport).catch(() => []),
    query ? getPapers(`/papers/search?q=${query}&limit=30`, transport).catch(() => []) : [],
  ]);
  const yearAgo = Date.now() - 365 * 86_400_000;
  const papers = new Map<string, Paper>();
  for (const paper of [...searched.filter((p) => !p.published || Date.parse(p.published) >= yearAgo), ...daily]) {
    if (!papers.has(paper.id)) papers.set(paper.id, paper);
  }
  return [...papers.values()];
}
