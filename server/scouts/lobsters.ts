import { plainText, request, type Find } from './http.ts';

type Story = { short_id: string; title: string; url?: string; comments_url: string; description?: string; created_at: string };

export async function fetch(transport = globalThis.fetch): Promise<Find[]> {
  const stories: Story[] = await (await request('https://lobste.rs/hottest.json', transport)).json();
  if (!Array.isArray(stories)) throw new Error('Lobsters returned invalid story list');
  return stories.map((story) => ({
    source: 'lobsters', externalId: story.short_id, title: story.title,
    url: story.url || story.comments_url, summary: plainText(story.description), publishedAt: story.created_at,
  }));
}
