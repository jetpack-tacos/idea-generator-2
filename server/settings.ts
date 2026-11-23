import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { DEFAULT_APP_SETTINGS, ROLES, parseModel, type AppSettings } from './providers.ts';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isLocalAbsolute(p: string): boolean {
  if (!p) return false;
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return isAbsolute(p);
}

export function mergeAppSettings(raw: any, base = DEFAULT_APP_SETTINGS): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object');
  const out = structuredClone(base);
  for (const role of ROLES) {
    const value = raw.models?.[role];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 200) throw new Error(`Invalid ${role} model`);
    const ref = value.trim();
    if (ref || role !== 'x') parseModel(ref);
    out.models[role] = ref;
  }
  if (raw.projectsRoot !== undefined) {
    const root = typeof raw.projectsRoot === 'string' ? raw.projectsRoot.trim() : '';
    if (!isLocalAbsolute(root) && root !== '~' && !root.startsWith('~/') && !root.startsWith('~\\')) {
      throw new Error('Projects root must be absolute or start with ~/');
    }
    out.projectsRoot = root;
  }
  if (raw.maxUsdPerDay !== undefined) {
    const max = raw.maxUsdPerDay;
    if (!Number.isFinite(max) || max < 0 || max > 1000) throw new Error('Global daily budget must be between $0 and $1000');
    out.maxUsdPerDay = max;
  }
  if (raw.activeHours !== undefined) {
    const { start, end } = raw.activeHours ?? {};
    if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !TIME.test(end) || start >= end) {
      throw new Error('Active hours must use HH:MM with start before end');
    }
    out.activeHours = { start, end };
  }
  if (raw.scoutIntervalsHours !== undefined) {
    const intervals = raw.scoutIntervalsHours;
    if (!intervals || typeof intervals !== 'object' || Array.isArray(intervals)) throw new Error('Scout intervals must be an object');
    for (const source of Object.keys(out.scoutIntervalsHours) as (keyof AppSettings['scoutIntervalsHours'])[]) {
      const hours = intervals[source];
      if (hours === undefined) continue;
      if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000)) {
        throw new Error(`Invalid scout interval for ${source}`);
      }
      out.scoutIntervalsHours[source] = hours;
    }
  }
  for (const key of ['judgeManyPath', 'crewPath', 'sessionsPath'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || (raw[key].trim() && !isLocalAbsolute(raw[key].trim()))) {
        throw new Error(`${key} must be empty or an absolute path`);
      }
      out[key] = raw[key].trim();
    }
  }
  if (raw.claudeFallback !== undefined) {
    const f = raw.claudeFallback ?? {};
    const headlessPath = typeof f.headlessPath === 'string' ? f.headlessPath.trim() : '';
    if (typeof f.until !== 'string' || (f.until && !Number.isFinite(Date.parse(f.until))) ||
      (headlessPath && !isLocalAbsolute(headlessPath)) || (f.model !== undefined && !/^[a-z0-9.-]*$/.test(String(f.model)))) {
      throw new Error('claudeFallback needs until (ISO time or empty), model and an absolute headlessPath');
    }
    out.claudeFallback = { until: f.until, model: String(f.model ?? 'sonnet'), headlessPath };
  }
  if (raw.creditRun !== undefined) {
    const c = raw.creditRun ?? {};
    if (typeof c.until !== 'string' || (c.until && !Number.isFinite(Date.parse(c.until))) ||
      !Number.isFinite(c.maxUsd) || c.maxUsd < 0 || c.maxUsd > 500 || !c.models || typeof c.models !== 'object') {
      throw new Error('creditRun needs until (ISO time or empty), maxUsd (0 to 500) and models');
    }
    const models: Record<string, string> = {};
    for (const role of ROLES) {
      if (typeof c.models[role] !== 'string' || !c.models[role].trim()) continue;
      parseModel(c.models[role].trim());
      models[role] = c.models[role].trim();
    }
    out.creditRun = { until: c.until, maxUsd: c.maxUsd, models };
  }
  if (raw.crewCallsPerDay !== undefined) {
    const cap = raw.crewCallsPerDay;
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 10000) {
      throw new Error('crewCallsPerDay must be a nonnegative integer');
    }
    out.crewCallsPerDay = cap;
  }
  if (raw.alertCommand !== undefined) {
    if (!Array.isArray(raw.alertCommand) || raw.alertCommand.some((x: unknown) => typeof x !== 'string' || !x.trim() || x.length > 500)) {
      throw new Error('alertCommand must be an array of non-empty strings');
    }
    out.alertCommand = raw.alertCommand.map((x: string) => x.trim());
  }
  if (raw.interests !== undefined) {
    if (typeof raw.interests !== 'string') throw new Error('Interests must be text');
    out.interests = raw.interests;
  }
  if (raw.seedThreshold !== undefined) {
    if (!Number.isFinite(raw.seedThreshold) || raw.seedThreshold < 0 || raw.seedThreshold > 1) {
      throw new Error('Seed threshold must be between 0 and 1');
    }
    out.seedThreshold = raw.seedThreshold;
  }
  if (raw.seedsPerRound !== undefined) {
    if (!Number.isSafeInteger(raw.seedsPerRound) || raw.seedsPerRound < 0) {
      throw new Error('Seeds per round must be a nonnegative integer');
    }
    out.seedsPerRound = raw.seedsPerRound;
  }
  return out;
}

export function openSettings(file: string) {
  let settings = structuredClone(DEFAULT_APP_SETTINGS);
  try {
    settings = mergeAppSettings(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw new Error('Invalid settings.local.json', { cause: error });
  }
  return {
    get: () => settings,
    set(next: AppSettings) {
      const validated = mergeAppSettings(next);
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' });
        for (let attempt = 0; ; attempt++) {
          try {
            renameSync(temp, file);
            break;
          } catch (err: any) {
            if ((err?.code === 'EPERM' || err?.code === 'EBUSY') && attempt < 4) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
              continue;
            }
            throw err;
          }
        }
        settings = validated;
      } finally {
        rmSync(temp, { force: true });
      }
    },
  };
}
