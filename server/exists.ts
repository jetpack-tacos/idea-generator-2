import { setTimeout as delay } from 'node:timers/promises';
import type { ExistsVerdict } from './db.ts';
import { normalizeUrl } from './leads.ts';
import type { ChatFn } from './providers.ts';
import { request } from './scouts/http.ts';

export type ExistingSearchResult = {
  source: 'github' | 'hn';
  title: string;
  url: string;
  detail: string;
};

const QUERIES_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      description: '2–3 short search queries (2–5 words each) to find existing open-source tools or discussions.',
      items: { type: 'string' },
    },
  },
  required: ['queries'],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['exists', 'partial', 'new'],
      description: 'exists if an existing tool already does what this idea proposes; partial if related tools cover part of it or need adaptation; new if nothing close was found.',
    },
    url: {
      type: 'string',
      description: 'URL of the closest matching result from the list when verdict is exists or partial; empty string when new.',
    },
    reason: {
      type: 'string',
      description: 'One concise sentence explaining the verdict.',
    },
  },
  required: ['verdict', 'url', 'reason'],
  additionalProperties: false,
};

export async function generateExistsQueries(a: {
  chat: ChatFn;
  model: string;
  idea: { title: string; pitch: string };
  goal: string;
}) {
  const user = [
    'Write 2–3 short search queries (2–5 words each) to check GitHub and Hacker News for existing tools that already do what this idea describes.',
    `Idea: ${a.idea.title}${a.idea.pitch ? ` — ${a.idea.pitch}` : ''}`,
    a.goal.trim() ? `Board goal: ${a.goal.trim()}` : '',
  ].filter(Boolean).join('\n\n');

  const { value, costUsd } = await a.chat({
    model: a.model,
    system: 'You write short, focused keyword search queries to check whether a software tool already exists.',
    user,
    schemaName: 'exists_queries',
    schema: QUERIES_SCHEMA,
    temperature: 0.2,
    maxTokens: 600,
  });
  const queries = (Array.isArray(value?.queries) ? value.queries : [])
    .map((q: unknown) => String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 3);
  if (!queries.length) throw new Error('exists role returned no search queries');
  return { queries, costUsd };
}

export async function searchExistingTools(
  queries: string[],
  opts: { transport?: typeof fetch; githubToken?: string; delayMs?: number } = {},
): Promise<ExistingSearchResult[]> {
  const transport = opts.transport ?? globalThis.fetch;
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  const delayMs = opts.delayMs ?? 500;
  const ghHeaders: Record<string, string> = {
    'User-Agent': 'idea-generator',
    Accept: 'application/vnd.github+json',
  };
  if (token) ghHeaders.Authorization = `Bearer ${token}`;

  let ghSuccess = 0;
  let hnSuccess = 0;
  let lastErr: unknown = null;
  const seen = new Map<string, ExistingSearchResult>();

  for (let idx = 0; idx < queries.length; idx++) {
    if (idx > 0 && delayMs > 0) await delay(delayMs);
    const q = queries[idx];
    const encoded = encodeURIComponent(q);
    const [ghRes, hnRes] = await Promise.allSettled([
      (async () => {
        const res = await request(
          `https://api.github.com/search/repositories?q=${encoded}&sort=stars&per_page=5`,
          transport,
          ghHeaders,
        );
        return res.json() as Promise<{ items?: any[] }>;
      })(),
      (async () => {
        const res = await request(
          `https://hn.algolia.com/api/v1/search?query=${encoded}&tags=story&hitsPerPage=5`,
          transport,
        );
        return res.json() as Promise<{ hits?: any[] }>;
      })(),
    ]);

    if (ghRes.status === 'fulfilled') {
      ghSuccess++;
      for (const item of (Array.isArray(ghRes.value?.items) ? ghRes.value.items : []).slice(0, 5)) {
        const url = String(item?.html_url ?? '').trim();
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        const stars = Number.isFinite(item?.stargazers_count) ? `${item.stargazers_count}★` : '';
        const desc = String(item?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        seen.set(url, {
          source: 'github',
          title: String(item?.full_name ?? url),
          url,
          detail: [stars, desc].filter(Boolean).join(' · '),
        });
      }
    } else {
      lastErr = ghRes.reason;
    }

    if (hnRes.status === 'fulfilled') {
      hnSuccess++;
      for (const hit of (Array.isArray(hnRes.value?.hits) ? hnRes.value.hits : []).slice(0, 5)) {
        const hnUrl = hit?.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : '';
        const url = String(hit?.url || hnUrl).trim();
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        const pts = Number.isFinite(hit?.points) ? `${hit.points} pts` : '';
        seen.set(url, {
          source: 'hn',
          title: String(hit?.title ?? url),
          url,
          detail: pts,
        });
      }
    } else {
      lastErr = hnRes.reason;
    }
  }

  if (!ghSuccess || !hnSuccess) {
    throw new Error(`Search incomplete (GitHub ${ghSuccess}/${queries.length}, HN ${hnSuccess}/${queries.length}): ${(lastErr as any)?.message ?? lastErr ?? 'failed'}`);
  }
  return [...seen.values()];
}

export async function judgeExistingTool(a: {
  chat: ChatFn;
  model: string;
  idea: { title: string; pitch: string };
  goal: string;
  results: ExistingSearchResult[];
}): Promise<{ verdict: ExistsVerdict; url: string | null; reason: string; costUsd: number }> {
  const list = a.results.length
    ? a.results
        .slice(0, 30)
        .map((r, i) => `${i + 1}. [${r.source}] ${r.title} (${r.url})${r.detail ? ` — ${r.detail}` : ''}`)
        .join('\n')
    : 'No search results found.';

  const user = [
    `Idea:\n${a.idea.title}${a.idea.pitch ? `: ${a.idea.pitch}` : ''}`,
    a.goal.trim() ? `Board goal: ${a.goal.trim()}` : '',
    `Search results from GitHub and Hacker News:\n${list}`,
    'Decide if this tool already exists ("exists"), partially exists or needs clear adaptation ("partial"), or is meaningfully new ("new").',
  ].filter(Boolean).join('\n\n');

  const { value, costUsd } = await a.chat({
    model: a.model,
    system: 'You compare a proposed software idea against GitHub and Hacker News search results and judge whether it already exists. Be conservative: only mark "exists" when an existing project clearly solves the same problem.',
    user,
    schemaName: 'exists_verdict',
    schema: VERDICT_SCHEMA,
    temperature: 0.1,
    maxTokens: 1000,
  });

  const verdict = value?.verdict;
  if (verdict !== 'exists' && verdict !== 'partial' && verdict !== 'new') {
    throw new Error(`Invalid exists verdict: ${String(verdict)}`);
  }
  const rawUrl = String(value?.url ?? '').trim();
  const normRaw = /^https?:\/\//i.test(rawUrl) ? normalizeUrl(rawUrl) : null;
  const matched = normRaw
    ? a.results.find((r) => r.url === rawUrl || normalizeUrl(r.url) === normRaw)
    : undefined;
  const url = matched ? matched.url.slice(0, 500) : null;
  let finalVerdict: ExistsVerdict = verdict;
  if (finalVerdict === 'exists' && !url) {
    finalVerdict = a.results.length ? 'partial' : 'new';
  }
  const reason = String(value?.reason ?? '').trim().slice(0, 400) || (finalVerdict === 'new' ? 'No equivalent tool found in search results.' : 'Related work found.');
  return { verdict: finalVerdict, url, reason, costUsd };
}

export async function checkIdeaExists(a: {
  chat: ChatFn;
  model: string;
  idea: { title: string; pitch: string };
  goal: string;
  transport?: typeof fetch;
  githubToken?: string;
}) {
  const q = await generateExistsQueries({ chat: a.chat, model: a.model, idea: a.idea, goal: a.goal });
  const results = await searchExistingTools(q.queries, { transport: a.transport, githubToken: a.githubToken });
  const j = await judgeExistingTool({ chat: a.chat, model: a.model, idea: a.idea, goal: a.goal, results });
  return {
    verdict: j.verdict,
    url: j.url,
    reason: j.reason,
    queries: q.queries,
    results,
    costUsd: q.costUsd + j.costUsd,
  };
}
