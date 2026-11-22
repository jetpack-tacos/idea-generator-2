import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { makeChat } from './providers.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createHandler } from './app.ts';
import { openSettings } from './settings.ts';
import { SPEND_FILE, spendLogger } from './spend.ts';

const root = join(import.meta.dirname, '..');

export function startServer({
  port = Number(process.env.PORT ?? 8300),
  dbFile = process.env.DB_FILE ?? join(root, 'data', 'ideas.db'),
  settingsFile = join(root, 'settings.local.json'),
  spendFile = SPEND_FILE,
  baseUrls,
  now,
}: {
  port?: number;
  dbFile?: string;
  settingsFile?: string;
  spendFile?: string;
  baseUrls?: NonNullable<Parameters<typeof makeChat>[0]>['baseUrls'];
  now?: () => number;
} = {}) {
  const runtime = openSettings(settingsFile);
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  const repo = openDb(dbFile);
  const engine = createEngine({ repo, chat: makeChat({ baseUrls, log: spendLogger(spendFile) }), settings: runtime.get });
  const autopilot = createAutopilot({ repo, engine, settings: runtime.get, now });
  const server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(root, 'public') }));
  server.once('listening', () => autopilot.start());
  server.once('close', () => autopilot.stop());
  return { server: server.listen(port, '127.0.0.1'), repo, engine, autopilot };
}

if (import.meta.main) {
  const { server } = startServer();
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`Idea Generator: http://localhost:${address.port}`);
  });
}
