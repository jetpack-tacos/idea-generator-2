import { request, type Find } from './http.ts';

type Repository = { id: number; full_name: string; html_url: string; description: string | null; created_at: string };

export async function fetch(transport = globalThis.fetch, now = Date.now(), token = process.env.GITHUB_TOKEN): Promise<Find[]> {
  const since = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  const url = `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=30`;
  const headers: Record<string, string> = { 'User-Agent': 'idea-generator', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data: { items?: Repository[] } = await (await request(url, transport, headers)).json();
  if (!Array.isArray(data?.items)) throw new Error('GitHub returned invalid repository list');
  return data.items.map((repo) => ({
    source: 'github-new', externalId: String(repo.id), title: repo.full_name,
    url: repo.html_url, summary: repo.description ?? '', publishedAt: repo.created_at,
  }));
}
