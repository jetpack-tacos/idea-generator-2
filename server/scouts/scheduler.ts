import { activeHoursUntil } from '../autopilot.ts';
import { localDay, type Repo } from '../db.ts';
import type { Engine } from '../engine.ts';
import type { AppSettings } from '../providers.ts';
import { judgeMany } from './filter.ts';
import type { Scout } from './http.ts';
import { fetchSessionWishes, type SessionFind } from './sessions.ts';
import { scouts, type PublicScoutSource, type ScoutSource } from './sources.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function createScoutScheduler(deps: {
  repo: Repo;
  engine: Engine;
  settings: () => AppSettings;
  now?: () => number;
  sources?: Partial<Record<PublicScoutSource, Scout>>;
  sessionsScout?: () => Promise<SessionFind[]>;
  log?: (message: string) => void;
}) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const sources = Object.entries(deps.sources ?? scouts) as [PublicScoutSource, Scout][];
  const busy = new Set<ScoutSource>();
  const pending = new Set<Promise<void>>();
  let readyAt = Infinity;
  let nextCleanup = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function round(due: [PublicScoutSource, Scout][], runSessions: boolean, settings: AppSettings) {
    const batches = await Promise.all(due.map(async ([source, fetch]) => {
      try {
        const result = await fetch();
        repo.clearScoutError(source);
        return result;
      } catch (error: any) {
        const msg = error?.message ?? String(error);
        repo.recordScoutError(source, msg, now());
        log(`[scouts] ${source} failed, retry on its next round: ${msg}`);
        return [];
      }
    }));

    let sessionFinds: SessionFind[] = [];
    if (runSessions) {
      try {
        sessionFinds = deps.sessionsScout
          ? await deps.sessionsScout()
          : await fetchSessionWishes({
              sessionsPath: settings.sessionsPath,
              judgeManyPath: settings.judgeManyPath,
              now: now(),
              seen: (id) => repo.hasSeenSession(id),
              markSeen: (ids) => repo.markSeenSessions(ids, now()),
              log,
            });
        repo.clearScoutError('sessions');
      } catch (error: any) {
        const msg = error?.message ?? String(error);
        repo.recordScoutError('sessions', msg, now());
        // Try again in an hour instead of waiting the full interval.
        repo.retryScoutAt('sessions', now() - (settings.scoutIntervalsHours.sessions ?? 12) * HOUR + HOUR);
        log(`[scouts] sessions failed, retry in an hour: ${msg}`);
      }
    }

    // From here through insertion there is no await, so overlapping rounds cannot score the same find.
    const t = now();
    const added = repo.addFinds(batches.flat(), t);
    // Also retry finds from the last 24 hours whose scoring failed or was cut off.
    const addedIds = new Set(added.map((f) => f.id));
    const finds = [...added, ...repo.unscoredFinds(t - DAY).filter((f) => !addedIds.has(f.id) && f.source !== 'sessions')];
    if (sessionFinds.length) {
      // Session finds are already privately scored (wish >= 0.7) and must NEVER reach --public or cloud models.
      repo.addFinds(sessionFinds, t);
    }

    const boards = repo.listBoards();
    const board = boards.find((b) => b.config.mode === 'auto') ?? boards[0];
    const context = [board?.goal ? `Board goal: ${board.goal}` : '', settings.interests].filter(Boolean).join('\n\n');
    if (finds.length && settings.judgeManyPath && activeHoursUntil(now(), deps.settings().activeHours) === null) {
      log(`[scouts] judge_many filter for ${finds.length} new finds`);
      try {
        repo.saveFindScores(await judgeMany(settings.judgeManyPath, context, finds));
      } catch (error: any) {
        log(`[scouts] judge_many filter failed: ${error.message ?? error}`);
      }
    }
    const unscored = finds.filter((find) => find.source !== 'sessions' && repo.getFind(find.id)?.score === null);
    if (unscored.length && activeHoursUntil(now(), deps.settings().activeHours) === null) {
      log(`[scouts] research model filter for ${unscored.length} new finds`);
    }
    for (let i = 0; i < unscored.length; i += 10) {
      const currentSettings = deps.settings();
      if (activeHoursUntil(now(), currentSettings.activeHours) !== null) {
        log('[scouts] research model filter paused outside active hours');
        break;
      }
      const day = localDay(new Date(now()));
      const { maxUsdPerDay } = currentSettings;
      if (repo.spentOn(null, day) >= maxUsdPerDay || (board && repo.spentOn(board.id, day) >= board.config.rate.usdPerDay)) {
        log('[scouts] research model filter skipped remaining finds at the daily budget');
        break;
      }
      try {
        repo.saveFindScores(await engine.scoreFinds(board, context, unscored.slice(i, i + 10)));
      } catch (error: any) {
        log(`[scouts] research model filter failed: ${error.message ?? error}`);
        break;
      }
    }
    if (activeHoursUntil(now(), deps.settings().activeHours) === null) {
      for (const b of repo.listBoards()) {
        if (b.config.mode !== 'auto') continue;
        for (const find of repo.seedableFinds(settings.seedThreshold, settings.seedsPerRound)) {
          engine.seedFind(b.id, find.id, {}, false);
        }
      }
    }
    engine.publishFinds();
  }

  function tick() {
    const time = now();
    if (time < readyAt) return Promise.resolve();
    if (time >= nextCleanup) {
      const removed = repo.pruneFinds(time - 90 * DAY);
      repo.pruneSeenSessions(time - 4 * DAY);
      nextCleanup = time + DAY;
      if (removed) engine.publishFinds();
    }
    const settings = deps.settings();
    if (activeHoursUntil(time, settings.activeHours) !== null) return Promise.resolve();
    void engine.flushAlerts?.();
    const due = sources.filter(([source]) => !busy.has(source) &&
      repo.claimScout(source, time, settings.scoutIntervalsHours[source] * HOUR));
    const sessionsEnabled = Boolean(deps.sessionsScout || (settings.sessionsPath && settings.judgeManyPath));
    const runSessions = sessionsEnabled && !busy.has('sessions') &&
      repo.claimScout('sessions', time, (settings.scoutIntervalsHours.sessions ?? 12) * HOUR);
    if (!due.length && !runSessions) return Promise.resolve();
    for (const [source] of due) busy.add(source);
    if (runSessions) busy.add('sessions');
    const done = round(due, runSessions, settings)
      .catch((error) => log(`[scouts] round failed: ${error.message ?? error}`))
      .finally(() => {
        for (const [source] of due) busy.delete(source);
        if (runSessions) busy.delete('sessions');
        pending.delete(done);
      });
    pending.add(done);
    return done;
  }

  return {
    tick,
    async waitIdle() {
      while (pending.size) await Promise.all([...pending]);
    },
    start() {
      if (timer) return;
      readyAt = now() + 120_000;
      timer = setInterval(() => {
        try {
          void tick();
        } catch (error: any) {
          log(`[scouts] scheduler failed: ${error.message ?? error}`);
        }
      }, 1000);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      readyAt = Infinity;
      await Promise.all(pending);
    },
  };
}
