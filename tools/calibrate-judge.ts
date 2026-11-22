// Paid calibration is a separate command from the fake-provider test suite.

import { makeLLM } from '../server/llm.ts';
import { makeChat } from '../server/providers.ts';
import { openSettings } from '../server/settings.ts';
import { spendLogger } from '../server/spend.ts';
import { join } from 'node:path';
import { medalFromSum } from '../public/js/score.js';

// Provisional household examples. Replace this reference set in a later stage.
const WEAK = [
  'Fire',
  'Smart home',
  'A robot that folds and puts away every kind of laundry with no setup',
  'Replace every lock and switch in the house with a custom hardware standard',
  'Use AI to make the house more organized',
  'A reminder for a once-a-year household event',
];

const STRONG = [
  'Tomorrow strip: The family calendar tablet highlights the first event and departure time tomorrow. Anyone can add a leave-by time on their Android phone.',
  'Weekly shop checklist: A page hosted on the Windows PC lets each phone add items to one shared list. The tablet shows unchecked items, and anyone can mark an item bought.',
  'Chore handoff: Each evening the calendar tablet shows who last completed the kitchen and laundry chores. Household members tap Done on the tablet or on their phones.',
  'Bin night: The family calendar tablet shows this week’s collection and which bin to put out from a local schedule file. Checking it off on a phone clears the reminder for everyone.',
  'Quiet mornings: A shared weekday schedule on the Windows PC shows departure times and lets each person flag when the bathroom is free from their Android phone.',
];

const settings = openSettings(join(import.meta.dirname, '..', 'settings.local.json')).get();
const modelArg = process.argv.indexOf('--model');
const model = modelArg > 0 ? process.argv[modelArg + 1] : settings.models.judge;
if (!model) throw new Error('Give --model a provider:model value');
const RUNS = 2;

const chat = makeChat({ log: spendLogger() });
const llm = makeLLM((request) => chat({ ...request, role: 'judge' }));
const board = { goal: '' };
const asIdea = (text: string) => {
  const [title, ...rest] = text.split(': ');
  return rest.length ? { title, pitch: rest.join(': ') } : { title: text, pitch: '' };
};

let cost = 0;
async function judgeAll(texts: string[]) {
  return Promise.all(
    texts.map(async (text) => {
      const runs = [];
      for (let r = 0; r < RUNS; r++) {
        const { judgement, costUsd } = await llm.judge({ model, board, idea: asIdea(text) });
        cost += costUsd;
        runs.push(judgement);
      }
      return { text, runs, sums: runs.map((j) => j.originality + j.feasibility + j.impact) };
    }),
  );
}

console.log(`Judge model: ${model}, ${RUNS} runs per idea\n`);
const [weak, strong] = await Promise.all([judgeAll(WEAK), judgeAll(STRONG)]);
const MEDAL = ['–', '🥉', '🥈', '🥇'];
for (const [label, rows] of [['WEAK', weak], ['STRONG', strong]] as const) {
  console.log(label);
  for (const r of rows) {
    const j = r.runs[0];
    console.log(
      `  ${r.sums.map((s) => String(s).padStart(2)).join(' ')}  ${r.sums.map((s) => MEDAL[medalFromSum(s)!]).join('')}  ` +
        `Use ${j.originality} Buildable ${j.feasibility} Fit ${j.impact}  ${r.text.slice(0, 48)}`,
    );
    console.log(`        ↳ ${j.reason}`);
  }
}

const mean = (rows: typeof weak) => rows.flatMap((r) => r.sums).reduce((a, b) => a + b, 0) / (rows.length * RUNS);
const weakMax = Math.max(...weak.flatMap((r) => r.sums));
const gap = mean(strong) - mean(weak);
const strongGold = strong.flatMap((r) => r.sums).filter((s) => s >= 13).length;
const spread = Math.max(...[...weak, ...strong].map((r) => Math.max(...r.sums) - Math.min(...r.sums)));

console.log(`\nweak mean ${mean(weak).toFixed(1)}, max ${weakMax} · strong mean ${mean(strong).toFixed(1)} · gap ${gap.toFixed(1)}`);
console.log(`strong ideas reaching gold: ${strongGold} of ${strong.length * RUNS} · largest run-to-run spread: ${spread}`);
console.log(`cost: $${cost.toFixed(4)}`);

const failures = [];
if (weakMax >= 9) failures.push(`a weak idea reached a medal (sum ${weakMax} ≥ 9)`);
if (gap < 3) failures.push(`strong and weak are only ${gap.toFixed(1)} apart (need ≥ 3)`);
if (failures.length) {
  console.log(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: weak ideas earn no medal, and the judge separates weak from strong.');
