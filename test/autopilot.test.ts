import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createAutopilot, nextLocalMidnight, rateCheck, type RateInput } from '../server/autopilot.ts';
import { localDay, openDb } from '../server/db.ts';
import { createBus, createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

const T = Date.parse('2026-11-02T12:00:00');
const base: RateInput = {
  now: T, activeHours: DEFAULT_APP_SETTINGS.activeHours, steps: [], lastAt: 0, paceSeconds: 10, stepsPerHour: 60, boardSpent: 0, boardUsdPerDay: 1,
  globalSpent: 0, globalUsdPerDay: 5, errors: 0, lastErrorAt: 0,
};

test('rate limiter: budgets, backoff, hourly window, pace', () => {
  assert.deepEqual(rateCheck(base), { ok: true });
  assert.deepEqual(rateCheck({ ...base, globalSpent: 5 }), { ok: false, reason: 'global_budget', until: nextLocalMidnight(T) });
  assert.equal((rateCheck({ ...base, boardSpent: 1.2 }) as any).reason, 'board_budget');
  assert.equal((rateCheck({ ...base, boardSpent: 0.99 }) as any).ok, true);
  // 0 = free models only: nothing spent keeps running, the first paid cent stops it
  assert.equal(rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0 }).ok, true);
  assert.equal((rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0.001 }) as any).reason, 'board_budget');

  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [30_000, 60_000, 120_000, 900_000]);
  assert.equal((rateCheck({ ...base, errors: 2, lastErrorAt: T - 30_000 }) as any).reason, 'backoff');
  assert.equal(rateCheck({ ...base, errors: 2, lastErrorAt: T - 61_000 }).ok, true);

  const steps = [T - 3_500_000, T - 1000];
  assert.deepEqual(rateCheck({ ...base, steps, stepsPerHour: 2 }), { ok: false, reason: 'hourly', until: T - 3_500_000 + 3_600_000 });
  assert.equal(rateCheck({ ...base, steps: [T - 3_700_000, T - 1000], stepsPerHour: 2 }).ok, true, 'old steps leave the window');

  assert.deepEqual(rateCheck({ ...base, lastAt: T - 4000 }), { ok: false, reason: 'pace', until: T + 6000 });
});

test('active hours use local time and include start but exclude end', () => {
  const at = (time: string, day = '02') => Date.parse(`2026-11-${day}T${time}`);
  const check = (time: string) => rateCheck({ ...base, now: at(time) });
  assert.deepEqual(check('07:59:59.999'), { ok: false, reason: 'night', until: at('08:00:00') });
  assert.deepEqual(check('08:00:00'), { ok: true });
  assert.deepEqual(check('21:59:59.999'), { ok: true });
  assert.deepEqual(check('22:00:00'), { ok: false, reason: 'night', until: at('08:00:00', '03') });
});

test('local midnight is the next calendar day at 00:00', () => {
  const m = new Date(nextLocalMidnight(T));
  assert.deepEqual([m.getDate(), m.getHours(), m.getMinutes()], [3, 0, 0]);
});

function fakeEngineFor(repo: ReturnType<typeof openDb>) {
  const bus = createBus();
  const steps: number[] = [];
  let fail = false;
  return {
    steps,
    setFail: (v: boolean) => (fail = v),
    engine: {
      bus,
      async autoStep(boardId: number) {
        if (fail) throw Object.assign(new Error('no key'), { code: 'no_key' });
        steps.push(boardId);
        // Spend lands on the test clock's day, as the autopilot reads it.
        repo.addSpend(boardId, 0.3, localDay(new Date(T)));
        return { did: 'combine' as const };
      },
    } as any,
  };
}

test('scheduler: only auto boards run, at their pace, within their limits', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine, steps, setFail } = fakeEngineFor(repo);
  const ap = createAutopilot({ repo, engine, settings: () => ({ ...DEFAULT_APP_SETTINGS, maxUsdPerDay: 5 }), now: () => now });
  const auto = repo.createBoard({ title: 'Auto', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 3, usdPerDay: 100 } } });
  repo.createBoard({ title: 'Manual' });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick(); await flush();
  assert.deepEqual(steps, [auto.id], 'the manual board never runs');
  now += 5_000; await ap.tick(); await flush();
  assert.equal(steps.length, 1);
  assert.equal(ap.status(auto.id).state, 'pace');
  now += 5_000; await ap.tick(); await flush();
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3);
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3, 'three steps per hour');
  assert.equal(ap.status(auto.id).state, 'hourly');

  // Errors back off, and the status says why.
  now += 3_600_000; setFail(true);
  await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'error');
  assert.equal(ap.status(auto.id).code, 'no_key');
  now += 15_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'backoff');
  setFail(false);
  now += 30_000; await ap.tick(); await flush();
  assert.equal(steps.length, 4, 'recovers after the backoff');

  // Budget: the board has spent 4 × $0.30; a $1 cap stops it until midnight.
  repo.updateBoard(auto.id, { config: { rate: { stepsPerHour: 3, usdPerDay: 1 } } });
  now += 20_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'board_budget');
  assert.equal(steps.length, 4);

  repo.updateBoard(auto.id, { config: { mode: 'manual' } });
  await ap.tick();
  assert.equal(ap.status(auto.id).state, 'manual');
});

test('autoStep with the real engine: judge first, grow a small pool, then breed', async () => {
  const repo = openDb(':memory:');
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 2 + (n % 3), feasibility: 3, impact: 3, keywords: ['k'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  assert.deepEqual(await engine.autoStep(board.id), { did: 'idle', reason: 'empty' });
  repo.insertIdea({ boardId: board.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });

  const did: string[] = [];
  for (let i = 0; i < 6; i++) did.push((await engine.autoStep(board.id)).did);
  assert.equal(did[0], 'judge', 'an unjudged seed is judged first');
  assert.equal(did[1], 'expand', 'a pool under three grows by expanding');
  assert.ok(did.includes('combine'), `breeds once the pool is big enough: ${did.join(',')}`);
  const ideas = repo.listIdeas(board.id);
  assert.ok(ideas.every((i) => i.judgedAt), 'every step leaves its ideas judged');
  assert.ok(ideas.some((i) => i.kind === 'combine' && i.generation >= 2));
});

test('dollar cap is checked before every paid call inside autoStep, rejects $0 paid calls, and updates status spentToday', async () => {
  const repo = openDb(':memory:');
  try {
    let now = T;
    let maxUsdPerDay = 0;
    let chatCalls = 0;
    const chat = async (r: ChatRequest) => {
      chatCalls++;
      if (r.schemaName === 'expand') {
        return { value: { ideas: [1, 2, 3].map((k) => ({ title: `E${k}`, pitch: 'p' })) }, costUsd: 0.015 };
      }
      return { value: { reason: 'ok', originality: 3, feasibility: 3, impact: 3, keywords: ['k'] }, costUsd: 0.015 };
    };
    const settings = () => ({ ...DEFAULT_APP_SETTINGS, maxUsdPerDay });
    const engine = createEngine({ repo, chat, settings, now: () => now, gitInit: false });
    const board = repo.createBoard({ title: 'CapBoard', config: { mode: 'auto', autopilotSeconds: 5, rate: { stepsPerHour: 60, usdPerDay: 0.01 } } });
    const seed = repo.insertIdea({ boardId: board.id, title: 'S', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    repo.saveJudgement(seed.id, { originality: 4, feasibility: 4, impact: 3, reason: 'ok' });

    const ap = createAutopilot({ repo, engine, settings, now: () => now });
    assert.equal(ap.status(board.id).state, 'idle', 'fresh auto board starts idle, not manual');

    // 1) maxUsdPerDay = 0 blocks paid models before any chat call
    await ap.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(chatCalls, 0);
    assert.equal(ap.status(board.id).state, 'global_budget');

    // 2) Raise global cap; board cap $0.01 lets expand ($0.015) run once then blocks judge calls inside the SAME autoStep
    maxUsdPerDay = 5;
    now += 10_000;
    await ap.tick();
    for (let i = 0; i < 100 && ap.status(board.id).state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(chatCalls, 1, 'judge calls inside autoStep are blocked once board budget is exceeded');
    assert.equal(ap.status(board.id).state, 'board_budget');
    assert.equal(ap.status(board.id).spentToday, 0.015);
    await ap.stop();

    // ap.stop() awaits in-flight autoStep before resolving (preventing close-on-active-DB races)
    let finishedSlow = false;
    const slowEngine = {
      bus: createBus(),
      async autoStep() {
        await new Promise((r) => setTimeout(r, 40));
        finishedSlow = true;
        return { did: 'idle' as const, reason: 'nothing_to_do' };
      },
    } as any;
    // A fresh board with budget left, so the slow step actually starts (CapBoard above is over its cap).
    const slowRepo = openDb(':memory:');
    slowRepo.createBoard({ title: 'Slow', config: { mode: 'auto' } });
    const apSlow = createAutopilot({ repo: slowRepo, engine: slowEngine, settings: () => ({ ...DEFAULT_APP_SETTINGS, maxUsdPerDay: 5 }), now: () => T });
    await apSlow.tick();
    await apSlow.stop();
    assert.equal(finishedSlow, true);
    slowRepo.close();
  } finally {
    repo.close();
  }
});
