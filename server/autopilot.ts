// Server-side autopilot for boards in automatic mode, with a rate limiter.
//
// Limits, checked in this order before every step:
//   1. global dollars per local day (app setting, across all boards)
//   2. the board's dollars per local day
//   3. error backoff (30 s, doubling, max 15 min)
//   4. the board's steps per hour (sliding window)
//   5. the board's pace (seconds between steps)

import type { Repo } from './db.ts';
import type { Engine } from './engine.ts';
import type { AppSettings } from './providers.ts';

export type RateInput = {
  now: number;
  activeHours: AppSettings['activeHours'];
  steps: number[];
  lastAt: number;
  paceSeconds: number;
  stepsPerHour: number;
  boardSpent: number;
  boardUsdPerDay: number;
  globalSpent: number;
  globalUsdPerDay: number;
  errors: number;
  lastErrorAt: number;
};
export type RateDecision =
  | { ok: true }
  | { ok: false; reason: 'night' | 'global_budget' | 'board_budget' | 'backoff' | 'hourly' | 'pace'; until: number };

const HOUR = 3_600_000;

export function nextLocalMidnight(now: number) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function backoffMs(errors: number) {
  return errors > 0 ? Math.min(15 * 60_000, 30_000 * 2 ** (errors - 1)) : 0;
}

export function activeHoursUntil(time: number, hours: AppSettings['activeHours']): number | null {
  const now = new Date(time);
  const [startHour, startMinute] = hours.start.split(':').map(Number);
  const [endHour, endMinute] = hours.end.split(':').map(Number);
  const start = new Date(now).setHours(startHour, startMinute, 0, 0);
  const end = new Date(now).setHours(endHour, endMinute, 0, 0);
  if (time < start) return start;
  if (time >= end) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, startHour, startMinute).getTime();
  return null;
}

/** Pure: may this board take a step now? */
export function rateCheck(i: RateInput): RateDecision {
  const until = activeHoursUntil(i.now, i.activeHours);
  if (until !== null) return { ok: false, reason: 'night', until };
  const overBudget = (spent: number, limit: number) => spent > 0 && spent >= limit;
  if (overBudget(i.globalSpent, i.globalUsdPerDay)) return { ok: false, reason: 'global_budget', until: nextLocalMidnight(i.now) };
  if (overBudget(i.boardSpent, i.boardUsdPerDay)) return { ok: false, reason: 'board_budget', until: nextLocalMidnight(i.now) };
  if (i.errors > 0 && i.now < i.lastErrorAt + backoffMs(i.errors)) {
    return { ok: false, reason: 'backoff', until: i.lastErrorAt + backoffMs(i.errors) };
  }
  const recent = i.steps.filter((t) => t > i.now - HOUR);
  if (recent.length >= i.stepsPerHour) return { ok: false, reason: 'hourly', until: Math.min(...recent) + HOUR };
  if (i.now < i.lastAt + i.paceSeconds * 1000) return { ok: false, reason: 'pace', until: i.lastAt + i.paceSeconds * 1000 };
  return { ok: true };
}

export type AutopilotStatus = {
  /** manual | night | running | idle | error | pace | hourly | backoff | board_budget | global_budget */
  state: string;
  until?: number;
  code?: string;
  message?: string;
  last?: string;
  stepsLastHour?: number;
  spentToday?: number;
};

type BoardState = { busy: boolean; steps: number[]; lastAt: number; errors: number; lastErrorAt: number; status: AutopilotStatus; sent: string };

export function createAutopilot(deps: { repo: Repo; engine: Engine; settings: () => AppSettings; now?: () => number; tickMs?: number }) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const states = new Map<number, BoardState>();

  function publish(boardId: number, s: BoardState, status: AutopilotStatus) {
    s.status = status;
    const json = JSON.stringify(status);
    if (json === s.sent) return; // do not repeat the same status every tick
    s.sent = json;
    engine.bus.emit(boardId, { type: 'autopilot', status });
  }

  async function tick() {
    const t = now();
    const globalSpent = repo.spentOn(null);
    const { activeHours, maxUsdPerDay } = deps.settings();
    for (const b of repo.listBoards()) {
      if (b.config.mode !== 'auto') {
        if (states.delete(b.id)) engine.bus.emit(b.id, { type: 'autopilot', status: { state: 'manual' } });
        continue;
      }
      let s = states.get(b.id);
      if (!s) {
        s = { busy: false, steps: [], lastAt: 0, errors: 0, lastErrorAt: 0, status: { state: 'idle' }, sent: '' };
        states.set(b.id, s);
      }
      if (s.busy) continue;
      s.steps = s.steps.filter((x) => x > t - HOUR);
      const boardSpent = repo.spentOn(b.id);
      const counts = { stepsLastHour: s.steps.length, spentToday: Math.round(boardSpent * 10000) / 10000 };
      const d = rateCheck({
        now: t, activeHours, steps: s.steps, lastAt: s.lastAt, paceSeconds: b.config.autopilotSeconds,
        stepsPerHour: b.config.rate.stepsPerHour, boardSpent, boardUsdPerDay: b.config.rate.usdPerDay,
        globalSpent, globalUsdPerDay: maxUsdPerDay, errors: s.errors, lastErrorAt: s.lastErrorAt,
      });
      if (!d.ok) {
        // Keep the last result visible while merely pacing.
        if (d.reason === 'pace' && (s.status.state === 'idle' || s.status.state === 'error')) continue;
        publish(b.id, s, { state: d.reason, until: d.until, last: s.status.last, ...counts });
        continue;
      }
      s.busy = true;
      publish(b.id, s, { state: 'running', last: s.status.last, ...counts });
      const st = s;
      engine
        .autoStep(b.id)
        .then((r) => {
          if (r.did !== 'idle') st.steps.push(now());
          st.lastAt = now();
          st.errors = 0;
          publish(b.id, st, {
            state: r.did === 'idle' ? 'idle' : 'pace', until: now() + b.config.autopilotSeconds * 1000,
            last: r.did === 'idle' ? r.reason : r.did, stepsLastHour: st.steps.length, spentToday: counts.spentToday,
          });
        })
        .catch((e: any) => {
          st.errors++;
          st.lastErrorAt = st.lastAt = now();
          publish(b.id, st, { state: 'error', code: e?.code ?? 'error', message: e?.message ?? String(e), until: now() + backoffMs(st.errors), ...counts });
        })
        .finally(() => {
          st.busy = false;
        });
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    tick,
    start() {
      timer ??= setInterval(() => tick().catch((e) => console.error('[autopilot]', e)), deps.tickMs ?? 1000);
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status(boardId: number): AutopilotStatus {
      return states.get(boardId)?.status ?? { state: 'manual' };
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
