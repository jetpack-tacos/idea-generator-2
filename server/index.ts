import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { makeChat } from './providers.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createScoutScheduler } from './scouts/scheduler.ts';
import { createHandler } from './app.ts';
import { openSettings } from './settings.ts';
import { SPEND_FILE, spendLogger } from './spend.ts';

const root = join(import.meta.dirname, '..');

export function startServer({
  port = Number(process.env.PORT ?? 8300),
  dbFile = process.env.DB_FILE ?? join(root, 'data', 'ideas.db'),
  settingsFile = join(root, 'settings.local.json'),
  spendFile = SPEND_FILE,
  alertLogFile,
  baseUrls,
  now,
  scoutSources,
  sessionsScout,
  searchTransport,
  crewTimeoutMs,
  gitInit,
  autopilotTickMs,
}: {
  port?: number;
  dbFile?: string;
  settingsFile?: string;
  spendFile?: string;
  alertLogFile?: string;
  baseUrls?: NonNullable<Parameters<typeof makeChat>[0]>['baseUrls'];
  now?: () => number;
  scoutSources?: Parameters<typeof createScoutScheduler>[0]['sources'];
  sessionsScout?: Parameters<typeof createScoutScheduler>[0]['sessionsScout'];
  searchTransport?: typeof fetch;
  crewTimeoutMs?: number;
  gitInit?: boolean;
  autopilotTickMs?: number;
} = {}) {
  const runtime = openSettings(settingsFile);
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  const repo = openDb(dbFile);
  const chat = makeChat({ baseUrls, log: spendLogger(spendFile), settings: runtime.get, crewTimeoutMs });
  const engine = createEngine({
    repo, chat, settings: runtime.get, now, searchTransport, alertLogFile, gitInit,
  });
  const autopilot = createAutopilot({ repo, engine, settings: runtime.get, now, tickMs: autopilotTickMs });
  const scoutScheduler = createScoutScheduler({ repo, engine, settings: runtime.get, now, sources: scoutSources, sessionsScout });
  const server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(root, 'public'), now }));
  server.once('listening', () => {
    autopilot.start();
    scoutScheduler.start();
  });
  server.once('close', () => {
    autopilot.stop();
    void scoutScheduler.stop();
  });
  return { server: server.listen(port, '127.0.0.1'), repo, engine, autopilot, scoutScheduler, runtime };
}

if (import.meta.main) {
  const { server } = startServer();
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`Idea Generator: http://localhost:${address.port}`);
  });
}
