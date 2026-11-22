import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';
import { createScoutScheduler } from '../server/scouts/scheduler.ts';
import { fetchSessionWishes } from '../server/scouts/sessions.ts';

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
