import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import {
  DEFAULT_APP_SETTINGS, extractLastJson, makeChat, parseModel, ProviderError, type ChatRequest,
} from '../server/providers.ts';

test('crew model parsing and last-JSON extraction', () => {
  assert.deepEqual(parseModel('crew:neon'), { provider: 'crew', model: 'neon:medium' });
  assert.deepEqual(parseModel('crew:hydrogen:xhigh'), { provider: 'crew', model: 'hydrogen:xhigh' });
  assert.throws(() => parseModel('crew:other'), ProviderError);
  assert.throws(() => parseModel('crew:neon:turbo'), ProviderError);

  const md = [
    '<think>draft {"wrong": 1}</think>',
    '```json\n{"step": 1}\n```',
    'Final answer below:',
    '{"step": 2, "nested": {"ok": true}}',
    'Trailing note.',
  ].join('\n');
  assert.deepEqual(extractLastJson(md), { step: 2, nested: { ok: true } });

  const fencedLast = '{"old": true}\n```json\n{"final": "yes"}\n```\n';
  assert.deepEqual(extractLastJson(fencedLast), { final: 'yes' });
});

test('crew provider: CLI args, task.md, exit codes (1, 3, 4), timeout kill, and 1-at-a-time queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-crew-test-'));
  try {
    const logFile = join(dir, 'invocations.jsonl');
    const lockFile = join(dir, 'active.lock');
    const crewScript = join(dir, 'fake_crew.py');

    writeFileSync(crewScript, `
import json, os, sys, time
args = sys.argv[1:]
worker = args[0]
def get_arg(flag):
    return args[args.index(flag) + 1]
task_path = get_arg('--task')
work_dir = get_arg('--dir')
out_path = get_arg('--out')
effort = get_arg('--effort')
timeout = get_arg('--timeout')

with open(task_path, 'r', encoding='utf-8') as f:
    task_text = f.read()

if 'MODE:HANG' in task_text:
    time.sleep(10)
    sys.exit(0)
if 'MODE:FAIL1' in task_text:
    sys.stderr.write('worker crashed')
    sys.exit(1)
if 'MODE:SIGNIN3' in task_text:
    sys.stderr.write('Please run auth login again')
    sys.exit(3)
if 'MODE:TIMEOUT4' in task_text:
    sys.exit(4)

if os.path.exists(${JSON.stringify(lockFile)}):
    sys.stderr.write('CONCURRENT CREW CALL DETECTED')
    sys.exit(2)
with open(${JSON.stringify(lockFile)}, 'w') as lf:
    lf.write(worker)
try:
    time.sleep(0.08)
    with open(${JSON.stringify(logFile)}, 'a', encoding='utf-8') as logf:
        logf.write(json.dumps({
            'worker': worker, 'effort': effort, 'timeout': timeout,
            'has_dir': os.path.isdir(work_dir),
            'has_system': 'SYS_TOKEN' in task_text,
            'has_user': 'USR_TOKEN' in task_text,
            'has_schema': '"title"' in task_text,
        }) + '\\n')
    with open(out_path, 'w', encoding='utf-8') as outf:
        fence = chr(96) * 3
        outf.write('Prose {"ignored": 1}\\n' + fence + 'json\\n{"title": "From ' + worker + '"}\\n' + fence + '\\n')
finally:
    os.remove(${JSON.stringify(lockFile)})
`, 'utf8');

    const chat = makeChat({
      crewPath: () => crewScript,
      crewTimeoutMs: 250,
    });
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    const req = (model: string, user: string): ChatRequest => ({
      model, system: 'SYS_TOKEN', user, schemaName: 'test_schema', schema, temperature: 0.5,
    });

    // Concurrent calls are serialized by the queue
    const [a, b] = await Promise.all([
      chat(req('crew:neon:high', 'USR_TOKEN A')),
      chat(req('crew:hydrogen', 'USR_TOKEN B')),
    ]);
    assert.equal(a.costUsd, 0);
    assert.deepEqual(a.value, { title: 'From neon' });
    assert.deepEqual(b.value, { title: 'From hydrogen' });

    const rows = readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].effort, 'high');
    assert.equal(rows[1].effort, 'medium');
    assert.ok(rows[0].has_dir && rows[0].has_system && rows[0].has_user && rows[0].has_schema);

    await assert.rejects(chat(req('crew:neon', 'MODE:FAIL1')), (e: any) => e instanceof ProviderError && e.code === 'provider_error');
    await assert.rejects(chat(req('crew:neon', 'MODE:SIGNIN3')), (e: any) => e instanceof ProviderError && e.code === 'crew_signin' && /auth login/i.test(e.message));
    await assert.rejects(chat(req('crew:neon', 'MODE:TIMEOUT4')), (e: any) => e instanceof ProviderError && e.code === 'crew_timeout');
    await assert.rejects(chat(req('crew:neon', 'MODE:HANG')), (e: any) => e instanceof ProviderError && e.code === 'crew_timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crew_signin surfaces to autopilot status; crewCallsPerDay pauses crew roles while other roles go on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-crew-cap-'));
  const repo = openDb(':memory:');
  try {
    const crewScript = join(dir, 'crew_signin.py');
    writeFileSync(crewScript, `
import sys
sys.stderr.write('Session expired, sign in required')
sys.exit(3)
`, 'utf8');

    let now = Date.parse('2026-11-10T10:00:00');
    const settings = () => ({
      ...DEFAULT_APP_SETTINGS,
      crewPath: crewScript,
      crewCallsPerDay: 1,
      models: {
        ...DEFAULT_APP_SETTINGS.models,
        judge: 'deepseek:deepseek-flash',
        expand: 'deepseek:deepseek-flash',
        combine: 'deepseek:deepseek-flash',
        deep: 'crew:neon:medium',
      },
    });

    // 1) crew_signin surfaces to autopilot status when a board step uses crew
    const chatRealCrew = makeChat({ settings });
    const engCrew = createEngine({ repo, chat: chatRealCrew, settings, now: () => now, gitInit: false });
    const b1 = repo.createBoard({
      title: 'CrewBoard',
      config: { mode: 'auto', autopilotSeconds: 5, models: { judge: 'crew:neon:medium' } },
    });
    repo.insertIdea({ boardId: b1.id, title: 'Seed', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    const ap1 = createAutopilot({ repo, engine: engCrew, settings, now: () => now });
    await ap1.tick();
    for (let i = 0; i < 200 && ap1.status(b1.id).state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(ap1.status(b1.id).state, 'error');
    assert.equal(ap1.status(b1.id).code, 'crew_signin');

    // 2) Over crewCallsPerDay: crew roles pause until tomorrow while non-crew roles go on
    repo.updateBoard(b1.id, { config: { mode: 'manual' } });
    let llmCalls = 0;
    const chatFake = async (r: ChatRequest) => {
      llmCalls++;
      if (r.schemaName === 'judgement') {
        return { value: { reason: 'ok', originality: 3, feasibility: 3, impact: 3, keywords: ['home'] }, costUsd: 0 };
      }
      if (r.schemaName === 'expand') {
        return { value: { ideas: [1, 2, 3].map((k) => ({ title: `E${llmCalls}.${k}`, pitch: 'p' })) }, costUsd: 0 };
      }
      if (r.schemaName === 'deep_cross') {
        throw new Error('deep_cross should be paused over crewCallsPerDay');
      }
      return { value: { title: `C${llmCalls}`, pitch: 'p' }, costUsd: 0 };
    };
    const eng = createEngine({ repo, chat: chatFake, settings, now: () => now, gitInit: false });
    const b2 = repo.createBoard({ title: 'MixedBoard', config: { mode: 'auto', autopilotSeconds: 5 } });
    const s1 = repo.insertIdea({ boardId: b2.id, title: 'S1', pitch: 'p', kind: 'seed', seedSource: 'hackernews', x: 0, y: 0, generation: 0 });
    const s2 = repo.insertIdea({ boardId: b2.id, title: 'S2', pitch: 'p', kind: 'seed', seedSource: 'lobsters', x: 100, y: 0, generation: 0 });
    repo.saveJudgement(s1.id, { originality: 4, feasibility: 4, impact: 3, reason: 'ok' });
    repo.saveJudgement(s2.id, { originality: 4, feasibility: 3, impact: 3, reason: 'ok' });
    // Cap is already reached (1/1 used earlier by b1)
    assert.equal(repo.crewCallsOn('2026-11-10'), 1);

    const ap2 = createAutopilot({ repo, engine: eng, settings, now: () => now });
    await ap2.tick();
    for (let i = 0; i < 200 && ap2.status(b2.id).state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(ap2.status(b2.id).crewPaused, true);
    assert.ok(repo.listIdeas(b2.id).length > 2, 'non-crew expand/combine roles continued running');
    assert.equal(repo.getBoard(b2.id)!.deepCrossDay, null, 'deep cross paused until tomorrow');
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
