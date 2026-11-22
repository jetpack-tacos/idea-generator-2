import { scouts } from '../server/scouts/sources.ts';

const sources = Object.entries(scouts);
const results = await Promise.allSettled(sources.map(([, fetch]) => fetch()));
for (const [i, result] of results.entries()) {
  const source = sources[i][0];
  if (result.status === 'rejected') {
    console.error(`${source}: ERROR ${result.reason?.message ?? result.reason}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`${source}: ${result.value.length} finds`);
  for (const find of result.value.slice(0, 2)) console.log(`  ${find.title.replace(/\s+/g, ' ').trim()}`);
}
