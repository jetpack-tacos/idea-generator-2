import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatFn } from '../server/providers.ts';
import { judgeMany } from '../server/scouts/filter.ts';
import { createScoutScheduler } from '../server/scouts/scheduler.ts';
import type { Find } from '../server/scouts/http.ts';

const HOUR = 3_600_000;
const start = new Date(2026, 10, 22, 8).getTime();
const python = join(import.meta.dirname, 'fixtures/judge_many.py');
const draft = (source: string, id: number, score = 0.9): Find => ({
  source, externalId: String(id), title: `TEST find ${id} ${score}`, url: `https://example.test/${id}`, summary: 'TEST summary',
});

test('unattended rounds gate fetches, isolate failures, use one free batch and seed each automatic board', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-scouts-'));
  const file = join(dir, 'test.db');
  let repo = openDb(file);
  const board1 = repo.createBoard({ title: 'TEST old auto', goal: 'TEST goal', config: { mode: 'auto' } });
  const board2 = repo.createBoard({ title: 'TEST new auto', goal: 'TEST goal', config: { mode: 'auto' } });
  const manual = repo.createBoard({ title: 'TEST manual' });
  repo.addFinds([draft('hackernews', 999)], start - 91 * 24 * HOUR);
  const settings = () => ({ ...DEFAULT_APP_SETTINGS, judgeManyPath: python, interests: 'TEST interests', seedsPerRound: 2 });
  const chat: ChatFn = async () => assert.fail('No paid call for a successful free filter');
  let now = start - 2 * 60_000 - 1;
  const times: Record<string, number[]> = { hackernews: [], 'github-trending': [] };
  const sources = {
    hackernews: async () => {
      times.hackernews.push(now);
      return [draft('hackernews', 1, 0.7), draft('hackernews', 2, 0.95), draft('hackernews', 3, 0.5),
        draft('hackernews', 4, 0.9), draft('hackernews', 5, 0.8), draft('hackernews', 1, 0.1)];
    },
    'github-trending': async () => {
      times['github-trending'].push(now);
      if (times['github-trending'].length === 1) throw new Error('TEST unavailable');
      return [draft('github-trending', 2, 0.65)];
    },
  };
  const logs: string[] = [];
  const scheduler = () => {
    const engine = createEngine({ repo, chat, settings, gitInit: false });
    return { engine, scout: createScoutScheduler({ readme: async () => '', repo, engine, settings, now: () => now, sources, log: (line) => logs.push(line) }) };
  };
  let { engine, scout } = scheduler();
  t.after(async () => {
    await scout.stop();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const published: unknown[] = [];
  engine.bus.on(manual.id, (event) => { if (event.type === 'finds') published.push(event.finds); });
  scout.start();
  now = start - 2;
  await scout.tick();
  now = start - 1;
  await scout.tick();
  assert.equal(times.hackernews.length, 0, 'the startup delay and active hours both apply');
  now = start;
  await Promise.all([scout.tick(), scout.tick()]);
  assert.deepEqual(times, { hackernews: [start], 'github-trending': [start] });
  assert.deepEqual(repo.listIdeas(board2.id).map((idea) => [idea.title, idea.kind, idea.sourceUrl, idea.seedSource]), [
    ['TEST find 2 0.95', 'seed', 'https://example.test/2', 'hackernews'],
    ['TEST find 4 0.9', 'seed', 'https://example.test/4', 'hackernews'],
  ]);
  assert.deepEqual(repo.listIdeas(board1.id).map((idea) => idea.title), ['TEST find 5 0.8', 'TEST find 1 0.7']);
  assert.equal(repo.listIdeas(manual.id).length, 0);
  assert.equal(repo.latestFinds().length, 5, 'duplicate and expired finds are absent');
  assert.equal(repo.latestFinds().find((find) => find.externalId === '3')?.seededIdeaId, null);
  assert.equal(published.length, 2, 'retention and completed round both reach the browser feed');
  assert.equal(logs.filter((line) => line.includes('judge_many filter for')).length, 1);
  assert.match(logs.join('\n'), /github-trending failed, retry on its next round: TEST unavailable/);
  const seeded = repo.listIdeas(board2.id)[0];
  repo.deleteIdea(seeded.id);
  assert.throws(() => engine.seedFind(board2.id, repo.latestFinds().find((find) => find.seededIdeaId === seeded.id)!.id, {}), { code: 'already_seeded' });

  await scout.stop();
  repo.close();
  repo = openDb(file);
  ({ engine, scout } = scheduler());
  scout.start();
  now = start + 3 * HOUR - 1;
  await scout.tick();
  assert.equal(times.hackernews.length, 1, 'a restart does not reset the last hit');
  now++;
  await scout.tick();
  assert.equal(logs.filter((line) => line.includes('judge_many filter for')).length, 1, 'seen finds are never sent to the filter again');
  now = start + 6 * HOUR;
  await scout.tick();
  assert.deepEqual(times, { hackernews: [start, start + 3 * HOUR, now], 'github-trending': [start, now] });
  assert.equal(repo.latestFinds().filter((find) => find.externalId === '2').length, 2, 'deduplication is per source');
  assert.equal(repo.latestFinds().find((find) => find.source === 'github-trending')?.score, 0.65);
});

test('a failed Python filter falls back in batches of ten through the board research model', async (t) => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'TEST fallback', goal: 'TEST goal TEST force failure', config: { mode: 'auto', models: { research: 'deepseek:deepseek-flash' } } });
  let now = start;
  const settings = () => ({
    ...DEFAULT_APP_SETTINGS, judgeManyPath: python, interests: 'TEST interests',
  });
  const batches: number[] = [];
  const chat: ChatFn = async (req) => {
    assert.equal(req.schemaName, 'scout_fit');
    assert.ok(!/"minimum"|"maximum"/.test(JSON.stringify(req.schema)), 'researchScores schema must omit minimum/maximum for Anthropic');
    assert.equal(req.boardId, board.id);
    assert.equal(req.model, 'deepseek:deepseek-flash');
    assert.equal(req.role, 'research');
    const { context, items } = JSON.parse(req.user);
    assert.match(context, /TEST goal/);
    assert.doesNotMatch(context, /TEST interests/, 'the filter sees the board goal only (2026-11-23)');
    batches.push(items.length);
    return { costUsd: 0.01, value: { scores: items.map(({ id }: { id: string }) => ({ id, fit: 0.35 })) } };
  };
  const logs: string[] = [];
  const engine = createEngine({ repo, chat, settings });
  const scout = createScoutScheduler({ readme: async () => '', repo, engine, settings, now: () => now, log: (line) => logs.push(line),
    sources: { hackernews: async () => Array.from({ length: 21 }, (_, i) => draft('hackernews', i)) } });
  t.after(async () => { await scout.stop(); repo.close(); });
  scout.start();
  now += 120_000;
  await scout.tick();
  assert.deepEqual(batches, [10, 10, 1]);
  assert.equal(repo.spentTotal().calls, 3);
  assert.ok(repo.latestFinds().every((find) => find.score === 0.35 && find.seededIdeaId === null));
  assert.match(logs.join('\n'), /judge_many filter failed: judge_many failed \(3\)[\s\S]+research model filter for 21 new finds/);
});

test('seeding takes the best find of each source before any second-best', () => {
  const repo = openDb(':memory:');
  const added = repo.addFinds([
    draft('github-trending', 1), draft('github-trending', 2), draft('github-trending', 3),
    draft('hackernews', 4), draft('google-news', 5),
  ], start);
  const score = new Map(added.map((f) => [f.id, f.source === 'github-trending' ? 0.95 - f.id * 0.01 : 0.7]));
  repo.saveFindScores(score);
  const picked = repo.seedableFinds(0.6, 3).map((f) => f.source).sort();
  assert.deepEqual(picked, ['github-trending', 'google-news', 'hackernews'], 'one per source while sources remain');
  assert.equal(repo.seedableFinds(0.6, 5).length, 5, 'then the next best of each source');
  repo.close();
});

test('finds whose scoring failed are retried for 24 hours, sessions never', () => {
  const repo = openDb(':memory:');
  repo.addFinds([draft('hackernews', 1)], start - 25 * HOUR);
  repo.addFinds([draft('lobsters', 2), draft('sessions', 3)], start - 2 * HOUR);
  assert.deepEqual(repo.unscoredFinds(start - 24 * HOUR).map((f) => f.source), ['lobsters']);
  repo.close();
});

test("a source's single best find seeds from 0.4; its others still need the threshold", () => {
  const repo = openDb(':memory:');
  const added = repo.addFinds([draft('google-news', 1), draft('google-news', 2), draft('google-news', 3)], start);
  repo.saveFindScores(new Map([[added[0].id, 0.45], [added[1].id, 0.44], [added[2].id, 0.3]]));
  assert.deepEqual(repo.seedableFinds(0.6, 6).map((f) => f.id), [added[0].id]);
  repo.close();
});

test('scoring never runs outside activeHours, waitIdle awaits in-flight rounds, and malformed out.jsonl lines are skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-scout-edge-'));
  const repo = openDb(':memory:');
  try {
    // 1) Malformed line in judge_many out.jsonl does not discard valid scores
    const badOutJudge = join(dir, 'judge_partial.py');
    writeFileSync(badOutJudge, `
import argparse, json
p = argparse.ArgumentParser()
for f in ('--questions', '--items', '--out', '--task', '--context-file'): p.add_argument(f)
p.add_argument('--public', action='store_true')
a = p.parse_args()
items = [json.loads(l) for l in open(a.items, encoding='utf-8') if l.strip()]
with open(a.out, 'w', encoding='utf-8') as out:
    out.write('{bad json line\\n')
    for it in items:
        out.write(json.dumps({'id': it['id'], 'ok': True, 'answers': {'fit': {'noul': 0.8}}}) + '\\n')
`, 'utf8');
    const added = repo.addFinds([draft('lobsters', 10)], start);
    const partialScores = await judgeMany(badOutJudge, 'ctx', added);
    assert.equal(partialScores.get(added[0].id), 0.8);

    // 2) If clock crosses activeHours.end while fetching, scoring does NOT run outside activeHours; waitIdle waits for in-flight round
    let now = new Date(2026, 10, 22, 21, 57, 0).getTime();
    let llmCalled = false;
    const settings = () => ({ ...DEFAULT_APP_SETTINGS, judgeManyPath: '' });
    const engine = createEngine({
      repo,
      chat: async () => { llmCalled = true; throw new Error('must not score outside activeHours'); },
      settings,
      now: () => now,
      gitInit: false,
    });
    const scout2 = createScoutScheduler({
      readme: async () => '',
      repo,
      engine,
      settings,
      now: () => now,
      sources: {
        hackernews: async () => {
          await new Promise((r) => setTimeout(r, 40));
          now = new Date(2026, 10, 22, 22, 0, 10).getTime(); // crossed 22:00 end during fetch
          return [draft('hackernews', 20)];
        },
      },
    });
    scout2.start();
    now = new Date(2026, 10, 22, 21, 59, 50).getTime();
    const first = scout2.tick();
    // Second tick while first is in-flight returns immediately, so waitIdle() is needed to await completion
    await scout2.tick();
    await scout2.waitIdle();
    await first;
    await scout2.stop();
    assert.equal(llmCalled, false, 'no scoring call may run outside activeHours');
    assert.equal(repo.latestFinds().find((f) => f.externalId === '20')?.score, null);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
