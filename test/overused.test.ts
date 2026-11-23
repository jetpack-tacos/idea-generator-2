import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLLM, overusedKeywords, overusedWords } from '../server/llm.ts';

const titles = [
  'Grand Rounds Autopsy', 'Night-Shift Rounds Handoff', 'Receipt Delta Grand Rounds', 'OpenVINO Photo Rounds',
  'Box Score Autopsy Lab', 'Failure Autopsy Compiler', 'Autopsy Lab Live Mode', 'Household Delta Watch',
  'Household Calendar Card', 'Household Chore Wheel', 'Household Pantry List', 'Kickoff Countdown Kitchen Card',
];

test('overusedWords names words that keep coming back, not plain or rare ones', () => {
  assert.deepEqual(overusedWords(titles), ['autopsy', 'rounds']);
  assert.deepEqual(overusedWords(titles.slice(0, 3)), [], 'fewer than 4 uses is not overuse');
});

test('overusedWords catches three-letter themes like NFC (fresh board, 2026-11-22)', () => {
  const fresh = [
    'NFC Media Drive Sorter', 'NFC Desk Sentry Toggle', 'Telegram Safe Video Archiver', 'NFC Shell Posture Cards',
    'Command-Not-Found Concierge', 'NFC Prompt Envelope Binder', 'NFC Decision Memory Router', 'Decision-Sealed NFC Envelopes',
    'The App for All of You', 'The App for One', 'The App for Two', 'The App for Any',
  ];
  assert.deepEqual(overusedWords(fresh), ['nfc'], 'NFC is named; everyday short words are not');
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

test('overusedWords looks only at the newest titles, so a new theme is named early on a big board', () => {
  const old = Array.from({ length: 500 }, (_, i) => `Old Idea Number ${i} Alpha${i}`);
  // A word of its own for each filler title: digits spelled as letters (3 -> "ddd"), so no filler word repeats.
  const own = (i: number) => String(i + 100).replace(/\d/g, (d) => 'abcdefghij'[Number(d)].repeat(3));
  const recent = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? `Promise Census ${i}` : own(i)));
  assert.deepEqual(overusedWords([...old, ...recent]), ['census', 'promise'], '6 of the last 60 is worn out');
  assert.ok(!overusedWords([...old, ...recent]).includes('old'), 'old themes no longer count once they stop');
});

test('overusedKeywords names a method that fills the pitches but not the titles', () => {
  const lists = [
    ...Array.from({ length: 40 }, (_, n) => [`old${n % 3}`]),
    ...Array.from({ length: 60 }, (_, n) => (n % 7 === 0 ? ['capture-recapture', `t${n}`] : [`t${n}`])),
  ];
  assert.deepEqual(overusedKeywords(lists), ['capture-recapture'], '9 of the last 60 is worn out; older ideas do not count');
  assert.deepEqual(overusedKeywords(lists.slice(0, 3)), [], 'fewer than 4 uses is not overuse');
});
