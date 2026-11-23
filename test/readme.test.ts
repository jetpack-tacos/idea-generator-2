import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';
import { cleanReadme, fetchReadme, repoFromUrl, seedPitch } from '../server/scouts/readme.ts';
import { createScoutScheduler } from '../server/scouts/scheduler.ts';

const README = `<p align="center"><img src="logo.png"></p>
# WeatherDial
[![build](https://img.shields.io/b.svg)](https://ci) ![shot](shot.png)
A **tiny** dial that shows [tomorrow's weather](https://example.test) on an e-ink screen.

\`\`\`bash
npm install weatherdial
\`\`\`
| a | b |
|---|---|
- Runs on an ESP32
`;

test('cleanReadme keeps what the project does and drops markup', () => {
  assert.equal(cleanReadme(README), "WeatherDial\nA tiny dial that shows tomorrow's weather on an e-ink screen.\n- Runs on an ESP32");
  assert.ok(cleanReadme('word '.repeat(600)).length <= 1200);
  assert.equal(repoFromUrl('https://github.com/test-maker/weatherdial'), 'test-maker/weatherdial');
  assert.equal(repoFromUrl('https://example.test/a/b'), null);
  assert.equal(seedPitch('A dial.', 'More text.'), 'A dial.\n\nFrom its README: More text.');
});

test('fetchReadme asks GitHub for the raw README and never throws', async () => {
  let asked = '';
  const ok: typeof fetch = async (input) => { asked = String(input); return new Response(README, { status: 200 }); };
  assert.match(await fetchReadme('https://github.com/test-maker/weatherdial', ok, ''), /tiny dial/);
  assert.equal(asked, 'https://api.github.com/repos/test-maker/weatherdial/readme');
  assert.equal(await fetchReadme('https://github.com/a/b', async () => new Response('no', { status: 404 }), ''), '');
  assert.equal(await fetchReadme('https://example.test/x', ok, ''), '');
});

test('a repo seed carries its README text; other seeds keep their summary', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'TEST', goal: 'TEST goal', config: { mode: 'auto' } });
  const settings = () => ({ ...DEFAULT_APP_SETTINGS, judgeManyPath: '', seedsPerRound: 5 });
  const engine = createEngine({ repo, chat: async () => assert.fail('no paid call'), settings, gitInit: false });
  let now = new Date(2026, 10, 22, 9).getTime() - 120_000;
  repo.addFinds([
    { source: 'github-new', externalId: '1', title: 't/dial', url: 'https://github.com/t/dial', summary: 'A dial.', score: 0.9 },
    { source: 'hackernews', externalId: '2', title: 'HN post', url: 'https://example.test/p', summary: 'A post.', score: 0.9 },
  ], now);
  const asked: string[] = [];
  const scout = createScoutScheduler({
    repo, engine, settings, now: () => now, log: () => {},
    readme: async (url) => { asked.push(url); return 'It turns weather into a dial.'; },
    sources: { lobsters: async () => [] },
  });
  try {
    scout.start();
    now += 120_000;
    await scout.tick();
    const pitches = Object.fromEntries(repo.listIdeas(board.id).map((idea) => [idea.seedSource, idea.pitch]));
    assert.equal(pitches['github-new'], 'A dial.\n\nFrom its README: It turns weather into a dial.');
    assert.equal(pitches.hackernews, 'A post.');
    assert.deepEqual(asked, ['https://github.com/t/dial'], 'only repo seeds fetch a README');
  } finally {
    await scout.stop();
    repo.close();
  }
});
