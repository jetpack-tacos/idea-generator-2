import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatAttempt } from './providers.ts';

export const SPEND_FILE = join(import.meta.dirname, '..', 'logs', 'spend.jsonl');

export function spendLogger(file = SPEND_FILE) {
  return (attempt: ChatAttempt) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...attempt }) + '\n');
    } catch (error: any) {
      console.error('[spend]', error?.message ?? error);
    }
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
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: ChatAttempt & { time: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.model !== 'string' || typeof row.time !== 'string') continue;
    if (new Date(row.time).toDateString() !== day) continue;
    const total = totals.get(row.model) ?? { model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    total.calls++;
    total.inputTokens += Number(row.inputTokens) || 0;
    total.outputTokens += Number(row.outputTokens) || 0;
    total.costUsd += Number(row.costUsd) || 0;
    totals.set(row.model, total);
  }
  return [...totals.values()].sort((a, b) => a.model.localeCompare(b.model));
}
