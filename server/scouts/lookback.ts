import { setTimeout as delay } from 'node:timers/promises';
import { plainText, request, type Find } from './http.ts';
import { toFinds } from './github-new.ts';
import { getPapers, paperUrl } from './papers.ts';

/**
 * One-time look back over the past six months, the first time the board runs (Jer 2026-11-22 7:28 PM:
 * "wouldn't it make sense to look at like the past 6 months of good ideas out there for the first time it runs?").
 * Month by month: Hacker News' best stories, GitHub's most-starred new repos, the top AI papers. The finds keep their
 * usual source names, so they mix with this week's finds, pass the same filter and are seeded a few per round.
 */
export const LOOKBACK_MONTHS = 6;
export const PER_MONTH = { hackernews: 30, github: 20, papers: 20 };
const HN_MIN_POINTS = 200;
const GITHUB_MIN_STARS = 100;
const DAY = 86_400_000;

type Hit = { objectID: string; title?: string; url?: string; story_text?: string; created_at?: string };

/** The six 30-day windows before `now`, newest first, as [startMs, endMs). */
export function monthWindows(now: number, months = LOOKBACK_MONTHS): [number, number][] {
  return Array.from({ length: months }, (_, i) => [now - (i + 1) * 30 * DAY, now - i * 30 * DAY] as [number, number]);
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ym = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export async function fetch(
  transport = globalThis.fetch, now = Date.now(), wait: (ms: number) => Promise<unknown> = delay,
  log: (message: string) => void = console.warn,
): Promise<Find[]> {
  const windows = monthWindows(now);
  const finds: Find[] = [];
  let failures = 0;
  const attempt = async (label: string, run: () => Promise<Find[]>) => {
    try {
      finds.push(...await run());
    } catch (error: any) {
      failures++;
      log(`[scouts] lookback ${label} failed: ${error?.message ?? error}`);
    }
  };

  for (const [start, end] of windows) {
    await attempt(`hackernews ${ymd(start)}`, async () => {
      const filters = `created_at_i>${Math.floor(start / 1000)},created_at_i<${Math.floor(end / 1000)},points>${HN_MIN_POINTS}`;
      const data = await (await request(
        `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=${filters}&hitsPerPage=${PER_MONTH.hackernews}`, transport,
      )).json();
      if (!Array.isArray(data?.hits)) throw new Error('HN Algolia returned invalid hits');
      return (data.hits as Hit[]).filter((h) => h?.objectID && h.title).map((h) => ({
        source: 'hackernews', externalId: String(h.objectID), title: h.title!,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, summary: plainText(h.story_text),
        publishedAt: h.created_at || undefined,
      }));
    });
  }

  const headers: Record<string, string> = { 'User-Agent': 'idea-generator', Accept: 'application/vnd.github+json' };
  for (const [start, end] of windows) {
    // Anonymous search allows 10 a minute, shared with the network: space them out, and wait out one refusal.
    await wait(10_000);
    await attempt(`github ${ymd(start)}`, async () => {
      const q = `created:${ymd(start)}..${ymd(end - DAY)} stars:>${GITHUB_MIN_STARS}`;
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_MONTH.github}`;
      try {
        return toFinds(await (await request(url, transport, headers)).json());
      } catch (error: any) {
        if (!/HTTP (403|429)/.test(error?.message ?? '')) throw error;
        await wait(61_000);
        return toFinds(await (await request(url, transport, headers)).json());
      }
    });
  }

  const months = [...new Set(windows.map(([start]) => ym(start)))];
  for (const month of months) {
    await attempt(`papers ${month}`, async () => {
      const papers = await getPapers(`/daily_papers?month=${month}&limit=100`, transport);
      return papers.sort((a, b) => b.upvotes - a.upvotes).slice(0, PER_MONTH.papers).map((p) => ({
        source: 'papers', externalId: p.id, title: p.title, url: paperUrl(p.id), summary: p.summary,
        publishedAt: p.published || undefined,
      }));
    });
  }

  if (!finds.length && failures) throw new Error(`lookback found nothing (${failures} requests failed)`);
  const unique = new Map(finds.map((f) => [`${f.source}:${f.externalId}`, f]));
  return [...unique.values()];
}
