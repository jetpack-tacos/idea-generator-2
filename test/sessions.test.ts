import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';
import { createScoutScheduler } from '../server/scouts/scheduler.ts';
import { MAX_ITEMS_PER_ROUND, extractUserMessageText, fetchSessionWishes } from '../server/scouts/sessions.ts';

test('sessions scout skips app-written text and helper threads, and caps each round at the newest messages', async () => {
  const typed = (text: string, extra: object = {}) => ({ type: 'user', entrypoint: 'claude-desktop', message: { role: 'user', content: text }, ...extra });
  assert.equal(extractUserMessageText(typed('I wish the dishwasher told me when it finished.')), 'I wish the dishwasher told me when it finished.');
  for (const row of [
    typed('Stop hook feedback: I wish this check was quieter today.'),
    typed('I wish a meta row was a wish.', { isMeta: true }),
    typed('I wish helper threads counted.', { isSidechain: true }),
    typed('Reply with only the word ok, I want a tool.', { entrypoint: 'sdk-cli' }),
    typed('<system-reminder>Codebase and user instructions, I want this</system-reminder>'),
    typed('<task-notification><task-id>x</task-id> I want a tool</task-notification>'),
    typed('Base directory for this skill: C:/skills/x. I want a tool.'),
    typed('Background (from the session that started this one): I want a tool.'),
  ]) assert.equal(extractUserMessageText(row), null, JSON.stringify(row).slice(0, 80));
  const mixed = { type: 'user', message: { role: 'user', content: [
    { type: 'text', text: 'I wish the porch light knew sunset.' },
    { type: 'text', text: '<system-reminder>private CLAUDE.md text</system-reminder>' },
  ] } };
  assert.equal(extractUserMessageText(mixed), 'I wish the porch light knew sunset.');
  assert.equal(extractUserMessageText(typed('I wish this worked <system-reminder>private</system-reminder> every night.')), 'I wish this worked every night.');
  assert.equal(extractUserMessageText(typed('[SCHEDULED TASK - AUTOMATED FIRING] I want a daily tool.')), null);
  assert.equal(extractUserMessageText(typed('[Image: original 2568x444, displayed at 2000x346.]')), null);
  assert.equal(
    extractUserMessageText(typed('The user sent a new message while you were working: I wish the porch light knew sunset. This is how Claude Code surfaces messages the user sends mid-turn.')),
    'I wish the porch light knew sunset.',
  );

  const dir = mkdtempSync(join(tmpdir(), 'ideagen-sessions-cap-'));
  try {
    const root = join(dir, 'projects');
    mkdirSync(join(root, 'p', 'abc', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'p', 'abc', 'subagents', 'agent-1.jsonl'), JSON.stringify(typed('I wish subagent text was read.')) + '\n');
    const older = join(root, 'p', 'older.jsonl');
    writeFileSync(older, Array.from({ length: 50 }, (_, i) => JSON.stringify(typed(`older wish number ${i} for the house`))).join('\n') + '\n');
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(older, hourAgo, hourAgo);
    writeFileSync(join(root, 'p', 'newer.jsonl'), Array.from({ length: MAX_ITEMS_PER_ROUND }, (_, i) => JSON.stringify(typed(`newer wish number ${i} for the house`))).join('\n') + '\n');
    let sent: { id: string; text: string }[] = [];
    await fetchSessionWishes({
      sessionsPath: root,
      judgeManyPath: 'unused',
      judgeSessions: async (_path, items) => { sent = items; return new Map(); },
    });
    assert.equal(sent.length, MAX_ITEMS_PER_ROUND);
    assert.ok(sent.every((item) => item.text.startsWith('newer')), 'the newest messages are kept');

    // A forked session repeats its parent's messages; each text is judged once.
    const forkRoot = join(dir, 'forks');
    mkdirSync(forkRoot);
    for (const name of ['parent.jsonl', 'fork.jsonl']) {
      writeFileSync(join(forkRoot, name), [typed('I wish the garage door told me it was open.'), typed(`only in ${name}, I want a tool`)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    await fetchSessionWishes({
      sessionsPath: forkRoot,
      judgeManyPath: 'unused',
      judgeSessions: async (_path, items) => { sent = items; return new Map(); },
    });
    assert.equal(sent.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions scout reads recent user jsonl, calls judge_many WITHOUT --public, filters wish/personal, trims 300 chars, and never falls back to LLM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-sessions-'));
  const repo = openDb(':memory:');
  try {
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const longPrefix = 'A'.repeat(220) + ' ';
    const longWish = longPrefix + 'I really wish there was a lightweight local tool to automatically archive my scanned receipts without cloud sync.' + ' ' + 'B'.repeat(220);

    const recentFile = join(sessionsDir, 'today.jsonl');
    const hugeAssistantLine = JSON.stringify({ role: 'user', content: 'I wish ' + 'Z'.repeat(600 * 1024) });
    writeFileSync(recentFile, [
      JSON.stringify({ role: 'user', content: longWish }),
      JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'I wish assistant text must be ignored even if type is user.' } }),
      hugeAssistantLine,
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'My friend Alice at 123 Main St needs help paying her bank account bill.' }, { type: 'tool_result', text: 'ignored' }] }),
      JSON.stringify({ role: 'assistant', content: 'I wish I could help build a tool for that!' }),
      JSON.stringify({ role: 'user', content: 'Please fix the typo on line 42.' }),
    ].join('\n') + '\n', 'utf8');

    const oldFile = join(sessionsDir, 'old.jsonl');
    writeFileSync(oldFile, JSON.stringify({ role: 'user', content: 'I wish I had an old tool from last month.' }) + '\n', 'utf8');
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    utimesSync(oldFile, fiveDaysAgo, fiveDaysAgo);

    const judgeScript = join(dir, 'fake_judge_many.py');
    const seenArgsFile = join(dir, 'judge_args.json');
    writeFileSync(judgeScript, `
import json, sys
with open(${JSON.stringify(seenArgsFile)}, 'w', encoding='utf-8') as af:
    json.dump(sys.argv[1:], af)

args = sys.argv[1:]
assert '--public' not in args, 'sessions must NEVER pass --public'
items_path = args[args.index('--items') + 1]
out_path = args[args.index('--out') + 1]
q_path = args[args.index('--questions') + 1]
with open(q_path, 'r', encoding='utf-8') as qf:
    qs = json.load(qf)
assert 'wish' in qs and 'personal' in qs

with open(items_path, 'r', encoding='utf-8') as f:
    items = [json.loads(line) for line in f if line.strip()]

with open(out_path, 'w', encoding='utf-8') as out:
    for it in items:
        t = it['text']
        if 'scanned receipts' in t:
            ans = {'wish': {'noul': 0.88}, 'personal': {'noul': 0.05}}
        elif 'Alice' in t:
            ans = {'wish': {'noul': 0.85}, 'personal': {'noul': 0.90}}
        else:
            ans = {'wish': {'noul': 0.10}, 'personal': {'noul': 0.0}}
        out.write(json.dumps({'id': it['id'], 'ok': True, 'answers': ans}) + '\\n')
`, 'utf8');

    const finds = await fetchSessionWishes({ sessionsPath: sessionsDir, judgeManyPath: judgeScript });
    assert.equal(finds.length, 1, 'only wish >= 0.7 and personal < 0.2 kept; old file and assistant ignored');
    assert.equal(finds[0].source, 'sessions');
    assert.ok(finds[0].summary.length <= 300);
    assert.ok(finds[0].summary.includes('wish') && finds[0].summary.includes('scanned receipts'));

    // When judge_many is unavailable, sessions scout skips cleanly without calling any LLM
    let llmCalled = false;
    let now = Date.now();
    const engine = createEngine({
      repo,
      chat: async () => { llmCalled = true; throw new Error('must not call LLM'); },
      settings: () => ({ ...DEFAULT_APP_SETTINGS, sessionsPath: sessionsDir, judgeManyPath: join(dir, 'missing.py') }),
      now: () => now,
      gitInit: false,
    });
    const scheduler = createScoutScheduler({
      repo,
      engine,
      settings: () => ({ ...DEFAULT_APP_SETTINGS, sessionsPath: sessionsDir, judgeManyPath: join(dir, 'missing.py') }),
      sources: {},
      now: () => now,
    });
    scheduler.start();
    now += 130_000;
    await scheduler.tick();
    await scheduler.stop();
    assert.equal(llmCalled, false);
    assert.equal(repo.latestFinds().length, 0);
    assert.ok(repo.listScoutRuns().find((r) => r.source === 'sessions')?.lastError, 'judge_many failure surfaces in scout_runs');
    assert.equal(repo.listScoutRuns().find((r) => r.source === 'sessions')?.startedAt, now - 11 * 3_600_000, 'a failed sessions round retries in an hour');

    // And when judge_many succeeds via scheduler, finds are stored with score and never sent to LLM
    let t = now + 20 * 3_600_000;
    const engineOk = createEngine({
      repo,
      chat: async () => { llmCalled = true; throw new Error('must not call LLM'); },
      settings: () => ({ ...DEFAULT_APP_SETTINGS, sessionsPath: sessionsDir, judgeManyPath: judgeScript }),
      now: () => t,
      gitInit: false,
    });
    const schedulerOk = createScoutScheduler({
      repo,
      engine: engineOk,
      settings: () => ({ ...DEFAULT_APP_SETTINGS, sessionsPath: sessionsDir, judgeManyPath: judgeScript }),
      sources: {},
      now: () => t,
    });
    schedulerOk.start();
    t += 130_000;
    await schedulerOk.tick();
    await schedulerOk.stop();
    assert.equal(llmCalled, false);
    assert.equal(repo.listScoutRuns().find((r) => r.source === 'sessions')?.lastError, null, 'cleared once judge_many succeeds');
    const stored = repo.latestFinds();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'sessions');
    assert.equal(stored[0].score, 0.88);

    // Second round 13h later must NOT re-send already-seen messages to judge_many
    const schedulerDedupe = createScoutScheduler({
      repo,
      engine: engineOk,
      settings: () => ({ ...DEFAULT_APP_SETTINGS, sessionsPath: sessionsDir, judgeManyPath: judgeScript }),
      sources: {},
      sessionsScout: undefined,
      now: () => t,
    });
    // Replace judgeScript with one that records invocation count
    writeFileSync(judgeScript, `
import sys
with open(${JSON.stringify(seenArgsFile + '.count')}, 'a', encoding='utf-8') as cf:
    cf.write('1\\n')
sys.exit(0)
`, 'utf8');
    schedulerDedupe.start();
    t += 13 * 3_600_000;
    await schedulerDedupe.tick();
    await schedulerDedupe.stop();
    const { existsSync: exists } = await import('node:fs');
    assert.equal(exists(seenArgsFile + '.count'), false, 'already-seen session messages are not re-sent to judge_many');
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
