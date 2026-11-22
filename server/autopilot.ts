// Server-side autopilot for boards in automatic mode, with a rate limiter.
//
// Limits, checked in this order before every step:
//   1. global dollars per local day (app setting, across all boards)
//   2. the board's dollars per local day
//   3. error backoff (30 s, doubling, max 15 min)
//   4. the board's steps per hour (sliding window)
//   5. the board's pace (seconds between steps)

import { localDay, type Board, type Idea, type Repo } from './db.ts';
import type { Engine } from './engine.ts';
import { isCrewModel, ROLES, type AppSettings } from './providers.ts';
import { isJudged } from '../public/js/score.js';

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

export function deepCrossDue(
  time: number,
  hours: AppSettings['activeHours'],
  board: Pick<Board, 'deepCrossDay'>,
  ideas: Pick<Idea, 'originality' | 'feasibility' | 'impact'>[],
): boolean {
  if (activeHoursUntil(time, hours) !== null) return false;
  const [startHour, startMinute] = hours.start.split(':').map(Number);
  const start = new Date(time).setHours(startHour, startMinute, 0, 0);
  if (time < start + HOUR) return false;
  const today = localDay(new Date(time));
  if (board.deepCrossDay === today) return false;
  return ideas.filter((i) => isJudged(i)).length >= 2;
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
  /** manual | night | running | idle | error | pace | hourly | backoff | board_budget | global_budget | crew_cap */
  state: string;
  until?: number;
  code?: string;
  message?: string;
  last?: string;
  stepsLastHour?: number;
  spentToday?: number;
  crewPaused?: boolean;
};

type BoardState = {
  busy: boolean;
  steps: number[];
  lastAt: number;
  errors: number;
  lastErrorAt: number;
  crewPausedDay?: string;
  crewPausedMsg?: string;
  status: AutopilotStatus;
  sent: string;
};

export function createAutopilot(deps: { repo: Repo; engine: Engine; settings: () => AppSettings; now?: () => number; tickMs?: number }) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const states = new Map<number, BoardState>();
  const deepPausedDay = new Map<number, string>();
  const pending = new Set<Promise<void>>();
  let stopped = false;

  function publish(boardId: number, s: BoardState, status: AutopilotStatus) {
    s.status = status;
    const json = JSON.stringify(status);
    if (json === s.sent) return; // do not repeat the same status every tick
    s.sent = json;
    engine.bus.emit(boardId, { type: 'autopilot', status });
  }

  async function tick() {
    if (stopped) return;
    const t = now();
    const day = localDay(new Date(t));
    const settings = deps.settings();
    const { activeHours, maxUsdPerDay, crewCallsPerDay } = settings;
    if (activeHoursUntil(t, activeHours) === null) {
      await engine.flushAlerts?.();
    }

    for (const b of repo.listBoards()) {
      if (stopped) return;
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
      const globalSpent = repo.spentOn(null, day);
      const boardSpent = repo.spentOn(b.id, day);
      const crewCallsToday = typeof repo.crewCallsOn === 'function' ? repo.crewCallsOn(day) : 0;
      const crewAtCap = crewCallsToday >= crewCallsPerDay;
      if (!crewAtCap) {
        s.crewPausedDay = undefined;
        s.crewPausedMsg = undefined;
        deepPausedDay.delete(b.id);
      }
      const deepModel = b.config.models.deep || settings.models.deep || '';
      const boardUsesCrew = (curBoard: Board, curSettings: AppSettings) =>
        ROLES.some((role) => isCrewModel(curBoard.config.models[role] || curSettings.models[role] || ''));
      const crewPaused = crewAtCap && boardUsesCrew(b, settings);
      const freshCounts = (st: BoardState) => {
        const curTime = now();
        const curDay = localDay(new Date(curTime));
        const curSettings = deps.settings();
        const curBoard = repo.getBoard(b.id) ?? b;
        const curSpent = repo.spentOn(b.id, curDay);
        const curCrew = (typeof repo.crewCallsOn === 'function' ? repo.crewCallsOn(curDay) : 0) >= curSettings.crewCallsPerDay;
        const paused = curCrew && boardUsesCrew(curBoard, curSettings);
        return {
          stepsLastHour: st.steps.length,
          spentToday: Math.round(curSpent * 10000) / 10000,
          ...(paused ? { crewPaused: true } : {}),
        };
      };
      const counts = { stepsLastHour: s.steps.length, spentToday: Math.round(boardSpent * 10000) / 10000, ...(crewPaused ? { crewPaused: true } : {}) };
      const d = rateCheck({
        now: t, activeHours, steps: s.steps, lastAt: s.lastAt, paceSeconds: b.config.autopilotSeconds,
        stepsPerHour: b.config.rate.stepsPerHour, boardSpent, boardUsdPerDay: b.config.rate.usdPerDay,
        globalSpent, globalUsdPerDay: maxUsdPerDay, errors: s.errors, lastErrorAt: s.lastErrorAt,
      });
      if (!d.ok) {
        // Keep the last result visible while merely pacing.
        if (d.reason === 'pace' && (s.status.state === 'idle' || s.status.state === 'error' || s.status.state === 'crew_cap')) continue;
        publish(b.id, s, { state: d.reason, until: d.until, last: s.status.last, ...counts });
        continue;
      }
      if (crewAtCap && s.crewPausedDay === day) {
        publish(b.id, s, {
          state: 'crew_cap',
          code: 'crew_cap',
          message: s.crewPausedMsg ?? `Daily crew limit (${crewCallsPerDay}) reached; resumes tomorrow`,
          until: nextLocalMidnight(t),
          last: s.status.last,
          ...counts,
          crewPaused: true,
        });
        continue;
      }

      const handleFailure = (st: BoardState, code: string, message: string) => {
        const curTime = now();
        const curDay = localDay(new Date(curTime));
        if (code === 'crew_cap') {
          st.crewPausedDay = curDay;
          st.crewPausedMsg = message || 'Daily crew limit reached; resumes tomorrow';
          st.lastAt = curTime;
          publish(b.id, st, {
            state: 'crew_cap', code: 'crew_cap', message: st.crewPausedMsg,
            until: nextLocalMidnight(curTime), ...freshCounts(st), crewPaused: true,
          });
        } else if (code === 'global_budget' || code === 'board_budget') {
          st.lastAt = curTime;
          publish(b.id, st, {
            state: code, code, message,
            until: nextLocalMidnight(curTime), ...freshCounts(st),
          });
        } else {
          st.errors++;
          st.lastErrorAt = st.lastAt = curTime;
          publish(b.id, st, {
            state: 'error', code, message,
            until: curTime + backoffMs(st.errors), ...freshCounts(st),
          });
        }
      };

      // Check daily deep cross first (1h after activeHours.start, once per local day per auto board).
      if (typeof engine.deepCross === 'function' && deepPausedDay.get(b.id) !== day) {
        const ideas = repo.listIdeas(b.id);
        if (deepCrossDue(t, activeHours, b, ideas)) {
          if (crewAtCap && isCrewModel(deepModel)) {
            deepPausedDay.set(b.id, day);
          } else {
            s.busy = true;
            publish(b.id, s, { state: 'running', last: s.status.last, ...counts });
            const st = s;
            const task = engine
              .deepCross(b.id)
              .then((r) => {
                st.steps.push(now());
                if (r?.error) {
                  handleFailure(st, r.error.code, r.error.message);
                  return;
                }
                st.lastAt = now();
                st.errors = 0;
                publish(b.id, st, {
                  state: 'pace', until: now() + b.config.autopilotSeconds * 1000,
                  last: 'deep', ...freshCounts(st),
                });
              })
              .catch((e: any) => {
                if (e?.code === 'crew_cap') {
                  deepPausedDay.set(b.id, day);
                  st.lastAt = now();
                  publish(b.id, st, {
                    state: 'pace', until: now() + b.config.autopilotSeconds * 1000,
                    last: st.status.last, ...freshCounts(st), crewPaused: true,
                  });
                } else {
                  handleFailure(st, e?.code ?? 'error', e?.message ?? String(e));
                }
              })
              .finally(() => {
                st.busy = false;
                pending.delete(task);
              });
            pending.add(task);
            continue;
          }
        }
      }

      s.busy = true;
      publish(b.id, s, { state: 'running', last: s.status.last, ...counts });
      const st = s;
      const task = engine
        .autoStep(b.id)
        .then((r) => {
          if (r.did !== 'idle') st.steps.push(now());
          if (r.error) {
            handleFailure(st, r.error.code, r.error.message);
            return;
          }
          st.lastAt = now();
          st.errors = 0;
          publish(b.id, st, {
            state: r.did === 'idle' ? 'idle' : 'pace', until: now() + b.config.autopilotSeconds * 1000,
            last: r.did === 'idle' ? r.reason : r.did, ...freshCounts(st),
          });
        })
        .catch((e: any) => {
          handleFailure(st, e?.code ?? 'error', e?.message ?? String(e));
        })
        .finally(() => {
          st.busy = false;
          pending.delete(task);
        });
      pending.add(task);
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    tick,
    start() {
      stopped = false;
      timer ??= setInterval(() => tick().catch((e) => console.error('[autopilot]', e)), deps.tickMs ?? 1000);
      return this;
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      while (pending.size) await Promise.all([...pending]);
    },
    status(boardId: number): AutopilotStatus {
      const st = states.get(boardId);
      if (st) return st.status;
      return repo.getBoard(boardId)?.config.mode === 'auto' ? { state: 'idle' } : { state: 'manual' };
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
