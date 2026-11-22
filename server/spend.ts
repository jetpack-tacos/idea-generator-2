import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatAttempt } from './providers.ts';

export const SPEND_FILE = join(import.meta.dirname, '..', 'logs', 'spend.jsonl');

export function spendLogger(file = SPEND_FILE) {
  return (attempt: ChatAttempt) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...attempt }) + '\n');
  };
}

export function todaySpend(file = SPEND_FILE, now = new Date()) {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const day = now.toDateString();
  const totals = new Map<string, { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const line of contents.trimEnd().split('\n')) {
    if (!line) continue;
    const row: ChatAttempt & { time: string } = JSON.parse(line);
    if (new Date(row.time).toDateString() !== day) continue;
    const total = totals.get(row.model) ?? { model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    total.calls++;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.costUsd += row.costUsd;
    totals.set(row.model, total);
  }
  return [...totals.values()].sort((a, b) => a.model.localeCompare(b.model));
}
