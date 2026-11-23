// Rejudge every judged idea on a board with the current jury, a few at a time.
// Jer 2026-11-23 1:12 AM: "if we fix this stuff, we'll have to go back and judge all these again so we don't leave a
// lot of potential out there artificially suppressed."
// Usage: node scripts/rejudge-all.mjs <ids file, one id per line> <log file> [parallel=4]
// Safe to rerun: ids already logged as 200 are skipped.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [idsFile, logFile, parallelArg] = process.argv.slice(2);
const parallel = Number(parallelArg) || 4;
const done = new Set(existsSync(logFile)
  ? readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.endsWith(' 200')).map((l) => l.split(' ')[0]) : []);
const ids = readFileSync(idsFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !done.has(s));
let next = 0;
let ok = 0;
let failed = 0;

async function worker() {
  while (next < ids.length) {
    const id = ids[next++];
    let code = 'error';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:8300/api/ideas/${id}/judge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(240_000),
        });
        code = String(res.status);
        await res.arrayBuffer();
        if (res.ok) break;
      } catch (error) {
        code = `error:${error?.cause?.code ?? error?.name ?? 'fetch'}`;
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
    appendFileSync(logFile, `${id} ${code}\n`);
    if (code === '200') ok++; else failed++;
  }
}

await Promise.all(Array.from({ length: parallel }, worker));
console.log(`rejudged ${ok}, failed ${failed}, skipped ${done.size} already done`);
