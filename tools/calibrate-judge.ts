// Paid calibration is a separate command from the fake-provider test suite.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLLM } from '../server/llm.ts';
import { makeChat } from '../server/providers.ts';
import { openSettings } from '../server/settings.ts';
import { SPEND_FILE, spendLogger } from '../server/spend.ts';
import { medalFromSum } from '../public/js/score.js';

type RefIdea = { title: string; pitch: string };

const BUILTIN_WEAK: RefIdea[] = [
  { title: 'Fire', pitch: '' },
  { title: 'Smart home', pitch: '' },
  { title: 'Laundry folding robot', pitch: 'A robot that folds and puts away every kind of laundry with no setup.' },
  { title: 'Custom hardware locks', pitch: 'Replace every lock and switch in the house with a custom hardware standard.' },
  { title: 'AI organized house', pitch: 'Use AI to make the house more organized.' },
  { title: 'Annual reminder', pitch: 'A reminder for a once-a-year household event.' },
];

const BUILTIN_STRONG: RefIdea[] = [
  { title: 'Tomorrow strip', pitch: 'The family calendar tablet highlights the first event and departure time tomorrow. Anyone can add a leave-by time on their Android phone.' },
  { title: 'Weekly shop checklist', pitch: 'A page hosted on the Windows PC lets each phone add items to one shared list. The tablet shows unchecked items, and anyone can mark an item bought.' },
  { title: 'Chore handoff', pitch: 'Each evening the calendar tablet shows who last completed the kitchen and laundry chores. Household members tap Done on the tablet or on their phones.' },
  { title: 'Bin night', pitch: 'The family calendar tablet shows this week’s collection and which bin to put out from a local schedule file. Checking it off on a phone clears the reminder for everyone.' },
  { title: 'Quiet mornings', pitch: 'A shared weekday schedule on the Windows PC shows departure times and lets each person flag when the bathroom is free from their Android phone.' },
];

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx > 0 ? process.argv[idx + 1] : undefined;
}

function loadReferenceSet(): { source: string; strong: RefIdea[]; weak: RefIdea[] } {
  const refPath = join(import.meta.dirname, '..', 'reference.local.json');
  if (!existsSync(refPath)) {
    return { source: 'built-in examples', strong: BUILTIN_STRONG, weak: BUILTIN_WEAK };
  }
  const raw = JSON.parse(readFileSync(refPath, 'utf8').replace(/^\uFEFF/, ''));
  const toList = (xs: unknown, label: string): RefIdea[] => {
    if (!Array.isArray(xs) || !xs.length) throw new Error(`reference.local.json missing ${label} array`);
    return xs.map((item: any, idx: number) => ({
      title: String(item?.title ?? `${label} ${idx + 1}`).trim(),
      pitch: String(item?.pitch ?? '').trim(),
    }));
  };
  return {
    source: 'reference.local.json',
    strong: toList(raw?.strong, 'strong'),
    weak: toList(raw?.weak, 'weak'),
  };
}

function spendLogCostSince(file: string, offset: number): number {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean).slice(offset);
  let total = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (typeof row?.costUsd === 'number' && Number.isFinite(row.costUsd)) total += row.costUsd;
    } catch {
      /* ignore partial line */
    }
  }
  return total;
}

const settings = openSettings(join(import.meta.dirname, '..', 'settings.local.json')).get();
const model = argValue('--model') ?? settings.models.judge;
if (!model) throw new Error('Give --model a provider:model value');
const runsRaw = argValue('--runs');
const RUNS = runsRaw === undefined ? 2 : Number(runsRaw);
if (!Number.isSafeInteger(RUNS) || RUNS < 1 || RUNS > 20) {
  throw new Error('--runs must be an integer between 1 and 20');
}

const { source, strong: STRONG, weak: WEAK } = loadReferenceSet();
const initialSpendLines = existsSync(SPEND_FILE) ? readFileSync(SPEND_FILE, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;

const chat = makeChat({ log: spendLogger(SPEND_FILE), settings: () => settings });
const llm = makeLLM((request) => chat({ ...request, role: 'judge' }));
const board = { goal: '' };

async function judgeAll(ideas: RefIdea[]) {
  return Promise.all(
    ideas.map(async (idea) => {
      const runs = [];
      for (let r = 0; r < RUNS; r++) {
        const { judgement } = await llm.judge({ model, board, idea });
        runs.push(judgement);
      }
      return {
        title: idea.title,
        runs,
        sums: runs.map((j) => j.originality + j.feasibility + j.impact),
      };
    }),
  );
}

console.log(`Judge model: ${model}, ${RUNS} runs per idea (source: ${source})\n`);
const [weak, strong] = await Promise.all([judgeAll(WEAK), judgeAll(STRONG)]);
const MEDAL = ['–', '🥉', '🥈', '🥇'];

for (const [label, rows] of [['WEAK', weak], ['STRONG', strong]] as const) {
  console.log(label);
  for (const r of rows) {
    const j = r.runs[0];
    const spread = Math.max(...r.sums) - Math.min(...r.sums);
    console.log(
      `  ${r.sums.map((s) => String(s).padStart(2)).join(' ')}  ${r.sums.map((s) => MEDAL[medalFromSum(s)!]).join('')}  ` +
        `spread ${spread}  Use ${j.originality} Buildable ${j.feasibility} Fit ${j.impact}  ${r.title}`,
    );
  }
}

const mean = (rows: typeof weak) => rows.flatMap((r) => r.sums).reduce((a, b) => a + b, 0) / (rows.length * RUNS);
const weakAll = weak.flatMap((r) => r.sums);
const strongAll = strong.flatMap((r) => r.sums);
const weakMax = Math.max(...weakAll);
const strongMin = Math.min(...strongAll);
const weakMean = mean(weak);
const strongMean = mean(strong);
const gap = strongMean - weakMean;
const maxSpread = Math.max(...[...weak, ...strong].map((r) => Math.max(...r.sums) - Math.min(...r.sums)));
const spendCost = spendLogCostSince(SPEND_FILE, initialSpendLines);

console.log(`\nPass rule:`);
console.log(`  1. Every strong total > every weak total - 1: min strong ${strongMin} > max weak ${weakMax} - 1 (${strongMin > weakMax - 1 ? 'OK' : 'FAIL'})`);
console.log(`  2. Mean strong >= mean weak + 4: ${strongMean.toFixed(2)} >= ${(weakMean + 4).toFixed(2)} (gap ${gap.toFixed(2)}) (${gap >= 4 ? 'OK' : 'FAIL'})`);
console.log(`  3. No weak idea reaches silver (11): max weak ${weakMax} < 11 (${weakMax < 11 ? 'OK' : 'FAIL'})`);
console.log(`  4. Run-to-run spread <= 2 per idea: max spread ${maxSpread} <= 2 (${maxSpread <= 2 ? 'OK' : 'FAIL'})`);
console.log(`Spend log cost: $${spendCost.toFixed(6)}`);

const failures: string[] = [];
if (!(strongMin > weakMax - 1)) failures.push(`strong min ${strongMin} is not > weak max ${weakMax} - 1`);
if (gap < 4) failures.push(`mean gap ${gap.toFixed(2)} < 4`);
if (weakMax >= 11) failures.push(`weak max ${weakMax} reached silver (>= 11)`);
if (maxSpread > 2) failures.push(`max run-to-run spread ${maxSpread} > 2`);

if (failures.length) {
  console.log(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: all 4 calibration rules satisfied.');
