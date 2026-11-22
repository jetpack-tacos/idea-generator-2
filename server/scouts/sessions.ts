import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { judgeManySessions, type SessionJudgement } from './filter.ts';
import type { Find } from './http.ts';

const THREE_DAYS_MS = 3 * 86_400_000;
const WISH_CUE = /\b(wish|want|need|frustrat\w*|annoy\w*|tired of|hate|automate|tool|script|app|build|if only|would be nice|pain|manual(?:ly)?)\b/i;

function plainContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n');
  }
  return '';
}

export function extractUserMessageText(row: any): string | null {
  if (!row || typeof row !== 'object') return null;
  let content: unknown = null;
  if (row.role === 'user') {
    content = row.content ?? row.text;
  } else if (row.message && typeof row.message === 'object' && (row.message.role === 'user' || row.type === 'user')) {
    content = row.message.content ?? row.message.text;
  } else if (row.author && typeof row.author === 'object' && row.author.role === 'user') {
    content = row.content;
  } else {
    return null;
  }
  const text = plainContent(content).replace(/\s+/g, ' ').trim();
  return text.length >= 15 ? text : null;
}

export function trimAroundWish(text: string, maxLen = 300): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const match = WISH_CUE.exec(clean);
  if (!match) {
    const slice = clean.slice(0, maxLen);
    const space = slice.lastIndexOf(' ');
    return (space > maxLen * 0.6 ? slice.slice(0, space) : slice).trim();
  }
  const center = match.index + Math.floor(match[0].length / 2);
  let start = Math.max(0, center - Math.floor(maxLen / 2));
  let end = Math.min(clean.length, start + maxLen);
  if (end - start < maxLen) start = Math.max(0, end - maxLen);
  if (start > 0) {
    const nextSpace = clean.indexOf(' ', start);
    if (nextSpace > start && nextSpace - start < 24) start = nextSpace + 1;
  }
  if (end < clean.length) {
    const prevSpace = clean.lastIndexOf(' ', end);
    if (prevSpace > start + maxLen * 0.5) end = prevSpace;
  }
  return clean.slice(start, end).trim().slice(0, maxLen);
}

function deriveTitle(excerpt: string): string {
  const first = excerpt.split(/(?<=[.!?])\s+/)[0] || excerpt;
  const clean = first.replace(/\s+/g, ' ').trim();
  if (clean.length <= 72) return clean;
  const slice = clean.slice(0, 72);
  const space = slice.lastIndexOf(' ');
  return (space > 30 ? slice.slice(0, space) : slice).trim();
}

async function listRecentJsonl(root: string, cutoffMs: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        try {
          const st = await stat(full);
          if (st.mtimeMs >= cutoffMs) out.push(full);
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  await walk(root);
  return out.sort();
}

export type SessionFind = Find & { score: number };

export async function fetchSessionWishes(opts: {
  sessionsPath: string;
  judgeManyPath: string;
  now?: number;
  judgeSessions?: (path: string, items: { id: string; text: string }[]) => Promise<Map<string, SessionJudgement>>;
  log?: (message: string) => void;
}): Promise<SessionFind[]> {
  const root = opts.sessionsPath.trim();
  const judgePath = opts.judgeManyPath.trim();
  if (!root || !judgePath) return [];
  const now = opts.now ?? Date.now();
  const log = opts.log ?? console.log;
  const judgeFn = opts.judgeSessions ?? judgeManySessions;

  const files = await listRecentJsonl(root, now - THREE_DAYS_MS);
  if (!files.length) return [];

  const items: { id: string; text: string }[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, '/');
    const lines = raw.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractUserMessageText(parsed);
      if (!text) continue;
      const id = createHash('sha256').update(`${rel}:${idx}:${text.slice(0, 200)}`).digest('hex').slice(0, 16);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({ id, text: text.slice(0, 4000) });
    }
  }
  if (!items.length) return [];

  let scores: Map<string, SessionJudgement>;
  try {
    scores = await judgeFn(judgePath, items);
  } catch (error: any) {
    // Never fall back to a cloud model for private session messages.
    log(`[scouts] sessions skipped (judge_many unavailable): ${error?.message ?? error}`);
    return [];
  }

  const finds: SessionFind[] = [];
  for (const item of items) {
    const s = scores.get(item.id);
    if (!s || s.wish < 0.7 || s.personal >= 0.2) continue;
    const excerpt = trimAroundWish(item.text, 300);
    finds.push({
      source: 'sessions',
      externalId: item.id,
      title: deriveTitle(excerpt),
      url: '',
      summary: excerpt,
      score: s.wish,
    });
  }
  return finds;
}
