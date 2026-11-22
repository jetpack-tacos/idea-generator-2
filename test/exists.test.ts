import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

test('exists check on gold: exists skips folder & alerts; new writes folder with NOTES.md & alerts; never checks twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-exists-'));
  const repo = openDb(':memory:');
  try {
    const projectsRoot = join(dir, 'projects');
    const alertsFile = join(dir, 'alerts.txt');
    const alertScript = join(dir, 'alert.py');
    writeFileSync(alertScript, `
import sys
with open(${JSON.stringify(alertsFile)}, 'a', encoding='utf-8') as f:
    f.write(sys.argv[1] + '\\n')
`, 'utf8');

    const settings = () => ({
      ...DEFAULT_APP_SETTINGS,
      projectsRoot,
      alertCommand: ['python', '-I', alertScript, '{title}'],
      models: { ...DEFAULT_APP_SETTINGS.models, brief: 'zai:glm-5.3-flash' },
    });

    const seenHeaders: Record<string, string>[] = [];
    const searchTransport: typeof fetch = async (input, init) => {
      const url = String(input);
      seenHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (url.includes('api.github.com/search/repositories')) {
        return new Response(JSON.stringify({
          items: [{ full_name: 'owner/existing-tool', html_url: 'https://github.com/owner/existing-tool', stargazers_count: 250, description: 'Already does this' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        hits: [{ objectID: '42', title: 'Show HN: Existing Tool', url: 'https://news.ycombinator.com/item?id=42', points: 50 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    let mode: 'exists' | 'new' = 'exists';
    let existsJudgeCalls = 0;
    const chat = async (r: ChatRequest) => {
      if (r.schemaName === 'judgement') {
        return { value: { reason: 'Gold!', originality: 5, feasibility: 4, impact: 4, keywords: ['tool'] }, costUsd: 0 };
      }
      if (r.schemaName === 'exists_queries') {
        return { value: { queries: ['existing tool query', 'second query'] }, costUsd: 0 };
      }
      if (r.schemaName === 'exists_verdict') {
        existsJudgeCalls++;
        return mode === 'exists'
          ? { value: { verdict: 'exists', url: 'https://github.com/owner/existing-tool', reason: 'owner/existing-tool already solves this.' }, costUsd: 0 }
          : { value: { verdict: 'new', url: '', reason: 'Nothing equivalent on GitHub or HN.' }, costUsd: 0 };
      }
      return {
        value: {
          name: 'Novel Tool', slug: 'novel-tool', oneLiner: 'One liner', problem: 'Problem', audience: 'Household',
          mvp: ['A'], outOfScope: ['B'], stack: 'Node', firstSteps: ['1'], openQuestions: ['Q'], risks: ['R'],
        },
        costUsd: 0,
      };
    };

    const engine = createEngine({
      repo, chat, settings, searchTransport, alertLogFile: join(dir, 'alerts.log'), gitInit: false,
      now: () => Date.parse('2026-11-10T12:00:00'),
    });
    const board = repo.createBoard({ title: 'B' });

    // Case 1: verdict = exists
    const idea1 = repo.insertIdea({ boardId: board.id, title: 'Clone Tool', pitch: 'Existing', kind: 'seed', x: 0, y: 0, generation: 0 });
    const r1 = await engine.judge(idea1.id);
    assert.equal(r1.idea.existsVerdict, 'exists');
    assert.equal(r1.idea.existsUrl, 'https://github.com/owner/existing-tool');
    assert.equal(r1.idea.projectPath, null);
    assert.equal(existsSync(projectsRoot), false, 'no project folder created when tool exists');
    assert.ok(seenHeaders.some((h) => h['user-agent'] === 'idea-generator'));

    // Re-judging never runs a second exists check
    await engine.judge(idea1.id);
    assert.equal(existsJudgeCalls, 1, 'never more than one check per idea');

    // Case 2: verdict = new
    mode = 'new';
    const idea2 = repo.insertIdea({ boardId: board.id, title: 'Novel Tool', pitch: 'Fresh', kind: 'seed', x: 0, y: 0, generation: 0 });
    const r2 = await engine.judge(idea2.id);
    assert.equal(r2.idea.existsVerdict, 'new');
    assert.ok(r2.project && existsSync(r2.project));
    const notes = readFileSync(join(r2.project!, 'NOTES.md'), 'utf8');
    assert.match(notes, /Verdict: new/);
    assert.match(notes, /Nothing equivalent on GitHub or HN/);

    const alerts = readFileSync(alertsFile, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(alerts, ['Existing tool found: Clone Tool', 'Gold idea: Novel Tool']);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exists check failures retry on later rounds at most 3 times', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-exists-retry-'));
  const repo = openDb(':memory:');
  try {
    const projectsRoot = join(dir, 'projects');
    const settings = () => ({
      ...DEFAULT_APP_SETTINGS,
      projectsRoot,
      models: { ...DEFAULT_APP_SETTINGS.models, brief: 'zai:glm-5.3-flash' },
    });

    let searchAttempts = 0;
    const failingSearch: typeof fetch = async () => {
      searchAttempts++;
      return new Response('rate limited', { status: 429 });
    };
    const chat = async (r: ChatRequest) => {
      if (r.schemaName === 'judgement') {
        return { value: { reason: 'Gold!', originality: 5, feasibility: 4, impact: 4, keywords: ['tool'] }, costUsd: 0 };
      }
      if (r.schemaName === 'exists_queries') {
        return { value: { queries: ['q1'] }, costUsd: 0 };
      }
      throw new Error('unexpected call: ' + r.schemaName);
    };

    const engine = createEngine({ repo, chat, settings, searchTransport: failingSearch, gitInit: false });
    const board = repo.createBoard({ title: 'B' });
    const idea = repo.insertIdea({ boardId: board.id, title: 'Retry Idea', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });

    // Attempt 1 on judge
    await engine.judge(idea.id);
    assert.equal(repo.getIdea(idea.id)!.existsAttempts, 1);
    assert.equal(repo.getIdea(idea.id)!.projectPath, null);

    // Attempts 2 and 3 on later rounds
    await engine.autoStep(board.id);
    assert.equal(repo.getIdea(idea.id)!.existsAttempts, 2);
    await engine.autoStep(board.id);
    assert.equal(repo.getIdea(idea.id)!.existsAttempts, 3);

    // 4th round must NOT retry exists check again (3 attempts max)
    const callsBefore = searchAttempts;
    // With the retries used up, the round moves on to ordinary work (expanding the pool),
    // which this fake model does not serve; only the absence of a fourth search matters here.
    await assert.rejects(engine.autoStep(board.id), /unexpected call: expand/);
    assert.equal(searchAttempts, callsBefore);
    assert.equal(repo.getIdea(idea.id)!.existsAttempts, 3);
    assert.equal(existsSync(projectsRoot) ? readdirSync(projectsRoot).length : 0, 0);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judgeExistingTool ignores hallucinated URLs, search runs sequentially, and alerts defer outside activeHours', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-exists-hallu-'));
  const repo = openDb(':memory:');
  try {
    const projectsRoot = join(dir, 'projects');
    const alertsFile = join(dir, 'alerts.txt');
    const alertScript = join(dir, 'alert.py');
    writeFileSync(alertScript, `
import sys
with open(${JSON.stringify(alertsFile)}, 'a', encoding='utf-8') as f:
    f.write(sys.argv[1] + '\\n')
`, 'utf8');

    let now = Date.parse('2026-11-10T22:05:00'); // outside 08:00-22:00 activeHours
    const settings = () => ({
      ...DEFAULT_APP_SETTINGS,
      projectsRoot,
      alertCommand: ['python', '-I', alertScript, '{title}'],
      models: { ...DEFAULT_APP_SETTINGS.models, brief: 'zai:glm-5.3-flash' },
    });

    let activeSearch = 0;
    let maxConcurrentSearch = 0;
    const searchTransport: typeof fetch = async (input) => {
      activeSearch++;
      maxConcurrentSearch = Math.max(maxConcurrentSearch, activeSearch);
      await new Promise((r) => setTimeout(r, 15));
      activeSearch--;
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({
          items: [{ full_name: 'real/repo', html_url: 'https://github.com/real/repo', stargazers_count: 5, description: 'Real' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const chat = async (r: ChatRequest) => {
      if (r.schemaName === 'judgement') {
        return { value: { reason: 'Gold!', originality: 5, feasibility: 4, impact: 4, keywords: ['tool'] }, costUsd: 0 };
      }
      if (r.schemaName === 'exists_queries') {
        return { value: { queries: ['q1', 'q2'] }, costUsd: 0 };
      }
      if (r.schemaName === 'exists_verdict') {
        // Model hallucinates a URL not in results and says exists
        return { value: { verdict: 'exists', url: 'https://github.com/fake/hallucinated', reason: 'Claimed match' }, costUsd: 0 };
      }
      return {
        value: {
          name: 'Real Tool', slug: 'real-tool', oneLiner: 'L', problem: 'P', audience: 'H',
          mvp: ['A'], outOfScope: ['B'], stack: 'Node', firstSteps: ['1'], openQuestions: ['Q'], risks: ['R'],
        },
        costUsd: 0,
      };
    };

    const engine = createEngine({
      repo, chat, settings, searchTransport, alertLogFile: join(dir, 'alerts.log'), gitInit: false, now: () => now,
    });
    const board = repo.createBoard({ title: 'B' });
    const idea = repo.insertIdea({ boardId: board.id, title: 'Hallucinated Check', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    const res = await engine.judge(idea.id);

    assert.ok(maxConcurrentSearch <= 2, 'only one query (1 GH + 1 HN) runs at a time, not all queries in parallel');
    assert.equal(res.idea.existsUrl, null, 'hallucinated URL is stripped');
    assert.equal(res.idea.existsVerdict, 'partial', 'unverified exists verdict is downgraded so folder is still created');
    assert.ok(res.project && existsSync(res.project));
    assert.equal(existsSync(alertsFile), false, 'alert must not fire outside activeHours');

    // Inside activeHours next morning, deferred alert flushes
    now = Date.parse('2026-11-11T08:05:00');
    await engine.flushAlerts();
    const sent = readFileSync(alertsFile, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(sent, ['Gold idea: Hallucinated Check']);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
