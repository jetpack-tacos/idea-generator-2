import { activeHoursUntil } from '../autopilot.ts';
import { localDay, type Repo } from '../db.ts';
import type { Engine } from '../engine.ts';
import type { AppSettings } from '../providers.ts';
import { judgeMany } from './filter.ts';
import type { Scout } from './http.ts';
import { scouts, type ScoutSource } from './sources.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function createScoutScheduler(deps: {
  repo: Repo;
  engine: Engine;
  settings: () => AppSettings;
  now?: () => number;
  sources?: Partial<Record<ScoutSource, Scout>>;
  log?: (message: string) => void;
}) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const sources = Object.entries(deps.sources ?? scouts) as [ScoutSource, Scout][];
  const busy = new Set<ScoutSource>();
  const pending = new Set<Promise<void>>();
  let readyAt = Infinity;
  let nextCleanup = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function round(due: [ScoutSource, Scout][], settings: AppSettings) {
    const batches = await Promise.all(due.map(async ([source, fetch]) => {
      try {
        return await fetch();
      } catch (error: any) {
        log(`[scouts] ${source} failed, retry on its next round: ${error.message ?? error}`);
        return [];
      }
    }));
    // From here through insertion there is no await, so overlapping rounds cannot score the same find.
    const finds = repo.addFinds(batches.flat(), now());
    const boards = repo.listBoards();
    const board = boards.find((b) => b.config.mode === 'auto') ?? boards[0];
    const context = [board?.goal ? `Board goal: ${board.goal}` : '', settings.interests].filter(Boolean).join('\n\n');
    if (finds.length && settings.judgeManyPath) {
      log(`[scouts] judge_many filter for ${finds.length} new finds`);
      try {
        repo.saveFindScores(await judgeMany(settings.judgeManyPath, context, finds));
      } catch (error: any) {
        log(`[scouts] judge_many filter failed: ${error.message ?? error}`);
      }
    }
    const unscored = finds.filter((find) => repo.getFind(find.id)?.score === null);
    if (unscored.length) log(`[scouts] research model filter for ${unscored.length} new finds`);
    for (let i = 0; i < unscored.length; i += 10) {
      const day = localDay(new Date(now()));
      const { maxUsdPerDay } = deps.settings();
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
      nextCleanup = time + DAY;
      if (removed) engine.publishFinds();
    }
    const settings = deps.settings();
    if (activeHoursUntil(time, settings.activeHours) !== null) return Promise.resolve();
    const due = sources.filter(([source]) => !busy.has(source) &&
      repo.claimScout(source, time, settings.scoutIntervalsHours[source] * HOUR));
    if (!due.length) return Promise.resolve();
    for (const [source] of due) busy.add(source);
    const done = round(due, settings)
      .catch((error) => log(`[scouts] round failed: ${error.message ?? error}`))
      .finally(() => {
        for (const [source] of due) busy.delete(source);
        pending.delete(done);
      });
    pending.add(done);
    return done;
  }

  return {
    tick,
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
