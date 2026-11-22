import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeManySessions, type SessionJudgement } from './filter.ts';
import type { Find } from './http.ts';

const THREE_DAYS_MS = 3 * 86_400_000;
const WISH_CUE = /\b(wish|want|need|frustrat\w*|annoy\w*|tired of|hate|automate|tool|script|app|build|if only|would be nice|pain|manual(?:ly)?)\b/i;

export const MAX_ITEMS_PER_ROUND = 300;
// Text the app, hooks or other sessions put into a user turn; never a wish typed by a person.
const APP_TEXT = /^(<|Base directory for this skill|Background \(from the session|Stop hook feedback|Caveat: |This session is being continued|\[Request interrupted|\[SCHEDULED TASK|\[Image:)/;
const APP_BLOCK = /<(system-reminder|task-notification|local-command-stdout|command-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
// A message typed mid-turn arrives wrapped in app text; keep only the person's words.
const MID_TURN_START = /^The user sent a new message while you were working:\s*/;
const MID_TURN_END = /\s*This is how Claude Code surfaces messages[\s\S]*$/;

function plainContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .filter((text: string) => !APP_TEXT.test(text.trim()))
      .join('\n');
  }
  return '';
}

export function extractUserMessageText(row: any): string | null {
  if (!row || typeof row !== 'object') return null;
  // Hook feedback, skill text, helper threads, summaries and headless helper runs are not typed by a person.
  if (row.isMeta || row.isSidechain || row.isCompactSummary || row.entrypoint === 'sdk-cli') return null;
  let content: unknown = null;
  if (row.role === 'user') {
    content = row.content ?? row.text;
  } else if (row.message && typeof row.message === 'object' && (row.message.role === 'user' || (row.type === 'user' && !row.message.role))) {
    content = row.message.content ?? row.message.text;
  } else if (row.author && typeof row.author === 'object' && row.author.role === 'user') {
    content = row.content;
  } else {
    return null;
  }
  let raw = plainContent(content).trim();
  if (MID_TURN_START.test(raw)) raw = raw.replace(MID_TURN_START, '').replace(MID_TURN_END, '').trim();
  if (APP_TEXT.test(raw)) return null;
  const text = raw.replace(APP_BLOCK, ' ').replace(/\s+/g, ' ').trim();
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
  const out: { file: string; mtime: number }[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'subagents') continue; // helper threads, written by Claude
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        try {
          const st = await stat(full);
          if (st.mtimeMs >= cutoffMs) out.push({ file: full, mtime: st.mtimeMs });
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  await walk(root, 0);
  // Oldest first, so the per-round cap keeps the newest messages.
  return out.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file)).map((x) => x.file);
}

async function readJsonlLines(file: string, onLine: (line: string, idx: number) => void, maxLineChars = 512 * 1024): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    let buf = '';
    let dropping = false;
    let idx = 0;
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let start = 0;
      while (true) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) {
          const rest = text.slice(start);
          if (!dropping) {
            if (buf.length + rest.length > maxLineChars) {
              buf = '';
              dropping = true;
            } else {
              buf += rest;
            }
          }
          break;
        }
        const segment = text.slice(start, nl);
        if (!dropping) {
          const full = buf + segment;
          buf = '';
          if (full.length <= maxLineChars) {
            const trimmed = full.trim();
            if (trimmed) onLine(trimmed, idx);
          }
        } else {
          dropping = false;
          buf = '';
        }
        idx++;
        start = nl + 1;
      }
    });
    stream.on('end', () => {
      if (!dropping && buf.trim()) onLine(buf.trim(), idx);
      resolve();
    });
    stream.on('error', reject);
  });
}

export type SessionFind = Find & { score: number };

export async function fetchSessionWishes(opts: {
  sessionsPath: string;
  judgeManyPath: string;
  now?: number;
  judgeSessions?: (path: string, items: { id: string; text: string }[]) => Promise<Map<string, SessionJudgement>>;
  seen?: (id: string) => boolean;
  markSeen?: (ids: string[]) => void;
  log?: (message: string) => void;
}): Promise<SessionFind[]> {
  const root = opts.sessionsPath.trim();
  const judgePath = opts.judgeManyPath.trim();
  if (!root || !judgePath) return [];
  const now = opts.now ?? Date.now();
  const judgeFn = opts.judgeSessions ?? judgeManySessions;

  const files = await listRecentJsonl(root, now - THREE_DAYS_MS);
  if (!files.length) return [];

  const items: { id: string; text: string }[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    try {
      await readJsonlLines(file, (line) => {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const text = extractUserMessageText(parsed);
        if (!text) return;
        // The id comes from the text alone, so a forked session's copy of a message is judged only once.
        const id = createHash('sha256').update(text).digest('hex').slice(0, 16);
        if (seenIds.has(id) || opts.seen?.(id)) return;
        seenIds.add(id);
        items.push({ id, text: text.slice(0, 4000) });
      });
    } catch {
      continue;
    }
  }
  if (!items.length) return [];
  // A capped batch keeps judge_many inside its time limit; older messages wait for a later round.
  items.splice(0, Math.max(0, items.length - MAX_ITEMS_PER_ROUND));

  // Never fall back to a cloud model: if judge_many fails, let the caller record the error and skip cloud scoring.
  const scores = await judgeFn(judgePath, items);
  opts.markSeen?.(items.map((item) => item.id));

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
