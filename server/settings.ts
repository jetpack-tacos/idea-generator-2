import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DEFAULT_APP_SETTINGS, ROLES, parseModel, type AppSettings } from './providers.ts';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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
    if (!isAbsolute(root) && !root.startsWith('~/')) throw new Error('Projects root must be absolute or start with ~/');
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
  if (raw.judgeManyPath !== undefined) {
    if (typeof raw.judgeManyPath !== 'string' || (raw.judgeManyPath.trim() && !isAbsolute(raw.judgeManyPath.trim()))) {
      throw new Error('judgeManyPath must be empty or an absolute path');
    }
    out.judgeManyPath = raw.judgeManyPath.trim();
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
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' });
        renameSync(temp, file);
        settings = validated;
      } finally {
        rmSync(temp, { force: true });
      }
    },
  };
}
