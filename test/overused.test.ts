import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLLM, overusedWords } from '../server/llm.ts';

const titles = [
  'Grand Rounds Autopsy', 'Night-Shift Rounds Handoff', 'Receipt Delta Grand Rounds', 'OpenVINO Photo Rounds',
  'Box Score Autopsy Lab', 'Failure Autopsy Compiler', 'Autopsy Lab Live Mode', 'Household Delta Watch',
  'Household Calendar Card', 'Household Chore Wheel', 'Household Pantry List', 'Kickoff Countdown Kitchen Card',
];

test('overusedWords names words that keep coming back, not plain or rare ones', () => {
  assert.deepEqual(overusedWords(titles), ['autopsy', 'rounds']);
  assert.deepEqual(overusedWords(titles.slice(0, 3)), [], 'fewer than 4 uses is not overuse');
});

test('expand and combine prompts tell the writer which themes are worn out', async () => {
  const prompts: string[] = [];
  const llm = makeLLM(async ({ user }: any) => {
    prompts.push(user);
    return { value: { ideas: [{ title: 'T', pitch: 'P' }], title: 'T', pitch: 'P' }, costUsd: 0 };
  });
  const board = { title: 'B', goal: '', household: '' } as any;
  const flow = { system: 's', expand: 'expand', combine: 'combine' } as any;
  await llm.expand({ model: 'm', flow, board, idea: { title: 'X', pitch: '' }, existingTitles: titles });
  await llm.combine({ model: 'm', flow, board, a: { title: 'X', pitch: '' }, b: { title: 'Y', pitch: '' }, existingTitles: titles });
  for (const user of prompts) assert.match(user, /Themes already worn out on this board: autopsy, rounds\./);
  prompts.length = 0;
  await llm.expand({ model: 'm', flow, board, idea: { title: 'X', pitch: '' }, existingTitles: ['One idea'] });
  assert.doesNotMatch(prompts[0], /worn out/);
});
