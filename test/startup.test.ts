import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { startServer } from '../server/index.ts';
import { todaySpend } from '../server/spend.ts';
import { openSettings } from '../server/settings.ts';

test('startup loads disk settings, waits overnight, then judges and budgets without an HTTP client', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-start-'));
  const dbFile = join(dir, 'test.db');
  const settingsFile = join(dir, 'settings.local.json');
  const spendFile = join(dir, 'logs', 'spend.jsonl');
  const repo = openDb(dbFile);
  const board = repo.createBoard({ title: 'TEST startup', config: { mode: 'auto' } });
  const oldBoard = repo.createBoard({ title: 'TEST existing board' });
  const oldIdea = repo.insertIdea({ boardId: oldBoard.id, title: 'TEST existing idea', pitch: '', kind: 'seed', generation: 0, x: 0, y: 0 });
  repo.saveJudgement(oldIdea.id, { originality: 3, feasibility: 5, impact: 4, reason: 'TEST saved verdict' });
  const seed = repo.insertIdea({ boardId: board.id, title: 'TEST seed', pitch: '', kind: 'seed', generation: 0, x: 0, y: 0 });
  repo.close();
  const legacyDb = new DatabaseSync(dbFile);
  legacyDb.prepare('UPDATE boards SET config = ? WHERE id = ?').run(JSON.stringify({
    lang: 'sv', flowName: 'Affärsstrategen · Business',
    flow: { system: 'You are a sharp business strategist. TEST old preset', expand: 'TEST old expansion', combine: 'TEST old combination' },
    models: { expand: 'retired:model' },
  }), oldBoard.id);
  legacyDb.close();
  writeFileSync(settingsFile, JSON.stringify({
    models: { judge: 'zai:glm-5.3-flash' }, maxUsdPerDay: 0.001,
    activeHours: { start: '09:00', end: '17:00' }, keys: { zai: 'ignored-file-key' },
  }));
  const previousKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'test-env-key';
  const calls: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    if (calls.length === 1) {
      res.writeHead(400).end(JSON.stringify({ error: 'Unsupported response_format' }));
      return;
    }
    res.end(JSON.stringify({
      usage: { prompt_tokens: 10_000, completion_tokens: 1000 },
      choices: [{ message: { content: JSON.stringify({
        originality: 2, feasibility: 3, impact: 2, reason: 'TEST verdict', keywords: ['test'],
      }) } }],
    }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');

  let now = Date.parse('2026-11-22T08:59:00');
  let scoutRuns = 0;
  const service = startServer({
    port: 0, dbFile, settingsFile, spendFile, now: () => now,
    scoutSources: { hackernews: async () => { scoutRuns++; return []; } },
    baseUrls: { zai: `http://127.0.0.1:${(provider.address() as any).port}` },
  });
  t.after(async () => {
    service.autopilot.stop();
    await service.scoutScheduler.stop();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    service.repo.close();
    if (previousKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = previousKey;
    rmSync(dir, { recursive: true, force: true });
  });
  await once(service.server, 'listening');
  async function waitFor(state: string) {
    for (let n = 0; n < 120; n++) {
      if (service.autopilot.status(board.id).state === state) return;
      await delay(50);
    }
    assert.fail(`Expected ${state}, got ${JSON.stringify(service.autopilot.status(board.id))}`);
  }
  await waitFor('night');
  assert.equal(service.autopilot.status(board.id).until, Date.parse('2026-11-22T09:00:00'));
  assert.equal(calls.length, 0);
  now = Date.parse('2026-11-22T09:00:00');
  await waitFor('global_budget');
  assert.equal(scoutRuns, 0);
  now = Date.parse('2026-11-22T09:01:00');
  await service.scoutScheduler.tick();
  assert.equal(scoutRuns, 1);
  assert.equal(service.repo.getIdea(seed.id)?.reason, 'TEST verdict');
  const existing = service.repo.getIdea(oldIdea.id)!;
  assert.deepEqual([existing.originality, existing.feasibility, existing.impact, existing.reason], [3, 5, 4, 'TEST saved verdict']);
  const oldConfig = service.repo.getBoard(oldBoard.id)!.config;
  assert.equal(oldConfig.flowName, 'Inventor');
  assert.doesNotMatch(oldConfig.flow.system, /TEST old preset/);
  assert.deepEqual(oldConfig.models, {});
  assert.equal(service.repo.spentOn(board.id), 0.002);
  assert.deepEqual(calls.map((c) => c.body.response_format.type), ['json_schema', 'json_object']);
  assert.ok(calls.every((c) => c.auth === 'Bearer test-env-key' && c.body.model === 'glm-5.3-flash'));

  const rows = readFileSync(spendFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map(({ boardId, role, model, costUsd }) => ({ boardId, role, model, costUsd })), [
    { boardId: board.id, role: 'judge', model: 'zai:glm-5.3-flash', costUsd: 0 },
    { boardId: board.id, role: 'judge', model: 'zai:glm-5.3-flash', costUsd: 0.002 },
  ]);
  assert.deepEqual(todaySpend(spendFile), [
    { model: 'zai:glm-5.3-flash', calls: 2, inputTokens: 10000, outputTokens: 1000, costUsd: 0.002 },
  ]);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.deepEqual(todaySpend(spendFile, tomorrow), []);

  const base = `http://127.0.0.1:${(service.server.address() as any).port}`;
  async function put(body: object) {
    return fetch(base + '/api/runtime-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
    });
  }
  assert.equal((await put({ activeHours: { start: '22:00', end: '08:00' } })).status, 400);
  assert.equal((await put({ activeHours: { start: '08:00', end: '08:00' } })).status, 400);
  assert.equal((await put({ scoutIntervalsHours: { hackernews: 0 } })).status, 400);
  assert.equal((await put({ judgeManyPath: join(dir, 'test.py') })).status, 400);
  assert.equal((await put({
    activeHours: { start: '08:00', end: '21:00' }, projectsRoot: dir, maxUsdPerDay: 2,
    keys: { zai: 'secret-from-request' }, baseUrls: { zai: 'https://example.com' },
    scoutIntervalsHours: { hackernews: 4 }, interests: 'TEST seedlings', seedThreshold: 0.7, seedsPerRound: 1,
  })).status, 200);
  const saved = readFileSync(settingsFile, 'utf8');
  assert.doesNotMatch(saved, /keys|baseUrls|secret-from-request|test-env-key/);
  assert.deepEqual(openSettings(settingsFile).get().activeHours, { start: '08:00', end: '21:00' });
  assert.equal(openSettings(settingsFile).get().projectsRoot, dir);
  assert.equal(openSettings(settingsFile).get().models.x, '');
  const savedSettings = openSettings(settingsFile).get();
  assert.equal(savedSettings.models.judge, 'zai:glm-5.3-flash');
  assert.equal(savedSettings.scoutIntervalsHours.hackernews, 4);
  assert.equal(savedSettings.scoutIntervalsHours.papers, 24);
  assert.deepEqual([savedSettings.interests, savedSettings.seedThreshold, savedSettings.seedsPerRound], ['TEST seedlings', 0.7, 1]);
  assert.ok(!readdirSync(dir).some((name) => name.endsWith('.tmp')));
});
