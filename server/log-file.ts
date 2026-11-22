// Copies console output to logs/server.log, so a server started hidden (at logon) leaves a trace.
// The file is renamed to server.log.1 once it passes maxBytes; one old copy is kept.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export function teeConsoleToFile(file: string, maxBytes = 5 * 1024 * 1024) {
  mkdirSync(dirname(file), { recursive: true });
  const write = (level: string, args: unknown[]) => {
    try {
      try {
        if (statSync(file).size > maxBytes) {
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
        }
      } catch { /* no file yet */ }
      appendFileSync(file, `${new Date().toISOString()} ${level} ${format(...args)}\n`);
    } catch { /* logging must never break the server */ }
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level.toUpperCase(), args);
    };
  }
}
