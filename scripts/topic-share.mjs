// How spread out are the board's topics? Counts the ideas made after a given id: by kind, how many seeds came in,
// and the share of those ideas that carry each of the most common keywords, beside the 200 ideas before them.
// Made 2026-11-23 to check the topic-spread fix on a real run. Read-only.
// Usage: node --no-warnings scripts/topic-share.mjs <last id before the run> [board id=1]
import { DatabaseSync } from 'node:sqlite';

const after = Number(process.argv[2]);
const board = Number(process.argv[3] ?? 1);
if (!Number.isInteger(after)) throw new Error('Give the last idea id before the run');
const db = new DatabaseSync(new URL('../data/ideas.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), { readOnly: true });

const ids = (sql, ...a) => db.prepare(sql).all(...a).map((r) => r.id);
const newIds = ids('SELECT id FROM ideas WHERE board_id = ? AND id > ? ORDER BY id', board, after);
const beforeIds = ids('SELECT id FROM ideas WHERE board_id = ? AND id <= ? ORDER BY id DESC LIMIT 200', board, after);

function shares(list) {
  if (!list.length) return new Map();
  const rows = db.prepare(`SELECT keyword, COUNT(*) AS n FROM idea_keywords WHERE idea_id IN (${list.join(',')}) GROUP BY keyword`).all();
  return new Map(rows.map((r) => [r.keyword, r.n / list.length]));
}
const kinds = db.prepare(`SELECT kind, COUNT(*) AS n FROM ideas WHERE board_id = ? AND id > ? GROUP BY kind`).all(board, after);
console.log(`new ideas: ${newIds.length} (${kinds.map((k) => `${k.kind} ${k.n}`).join(', ')})`);
const now = shares(newIds);
const then = shares(beforeIds);
const top = [...new Set([...[...then].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k), ...[...now].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)])];
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`.padStart(4);
console.log('keyword               before  new');
for (const k of top.sort((a, b) => (now.get(b) ?? 0) - (now.get(a) ?? 0))) console.log(`${k.padEnd(22)}${pct(then.get(k))}  ${pct(now.get(k))}`);
const judged = db.prepare(`SELECT originality + feasibility + impact AS s, COUNT(*) AS n FROM ideas WHERE board_id = ? AND id > ? AND judged_at IS NOT NULL GROUP BY s ORDER BY s`).all(board, after);
console.log('scores of new ideas: ' + judged.map((r) => `${r.s}:${r.n}`).join(' '));
