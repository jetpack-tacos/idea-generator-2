// The whole HTTP API against an in-memory database and a fake LLM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEMPLATES, openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type AppSettings, type ChatRequest } from '../server/providers.ts';

const calls: ChatRequest[] = [];
let judgeScores = { originality: 3, feasibility: 3, impact: 3 };
let judgeKeywords = ['Public Space', 'sound'];
let failNext: Error | null = null;
let xCitations: string[] = [];

// Fake chat: answers by schema name, records every request.
async function fakeChat(r: ChatRequest) {
  calls.push(r);
  if (failNext) {
    const e = failNext;
    failNext = null;
    throw e;
  }
  const n = calls.length;
  const value =
    r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `"Barn ${n}.${k}."`, pitch: `Pitch ${k}` })) }
    : r.schemaName === 'judgement' ? { reason: 'Stark mekanism, oklar kund.', ...judgeScores, keywords: judgeKeywords }
    : r.schemaName === 'summary' ? { headline: 'Tavlan rör sig mot ljud.', themes: [{ name: 'Ljud', insight: 'Allt låter.', ideas: ['Lånecyklar'] }], strongest: [{ title: 'Korsning', why: 'Konkret.' }], gaps: ['Ingen tänker på natten.'], nextSteps: ['Korsa A och B.'] }
    : r.schemaName === 'synthesis' ? { headline: 'Bänkarna dominerar.', insights: ['i1', 'i2', 'i3'], standouts: [{ title: 'Sjungande parkbänk', board: 'X', why: 'w' }], opportunities: ['o1', 'o2'], nextSteps: ['n1', 'n2'] }
    : r.schemaName === 'brief' ? { name: 'Sjungande bänk', slug: 'Sjungande Bänk!', oneLiner: 'En bänk som sjunger.', problem: 'P', audience: 'A', mvp: ['m1', 'm2'], outOfScope: ['o'], stack: 's', firstSteps: ['f1', 'f2'], openQuestions: ['q1'], risks: ['r1'] }
    : r.schemaName === 'exists_queries' ? { queries: ['singing bench'] }
    : r.schemaName === 'exists_verdict' ? { verdict: 'new', url: '', reason: 'Nothing close was found.' }
    : r.schemaName === 'leads' ? { leads: [
        { title: 'Trend A', summary: 'S', hook: 'H', url: 'https://x.com/a/status/1' },
        { title: 'Trend B', summary: 'S', hook: 'H', url: 'https://twitter.com/b/status/2?s=20' },
        { title: 'Made up', summary: 'S', hook: 'H', url: 'https://x.com/fake/status/3' },
      ] }
    : r.schemaName === 'research' ? { leads: [
        { id: '2610.1', title: 'Rumsljud', summary: 'S', hook: 'H' },
        { id: '9999.9', title: 'Påhittad', summary: 'S', hook: 'H' },
      ] }
    : { title: r.schemaName === 'seed' ? 'Destillerat frö' : 'Korsning', pitch: 'En kombinerad pitch.' };
  return { value, costUsd: 0.001, citations: r.schemaName === 'leads' ? xCitations : [] };
}

const projectsRoot = mkdtempSync(join(tmpdir(), 'ideagen-projects-'));
// Crew models (the brief role's default) need a crew script path; the fake chat never runs it.
let settings: AppSettings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot, crewPath: join(projectsRoot, 'fake-crew.py') };
const runtime = { get: () => settings, set: (next: AppSettings) => { settings = next; } };

const repo = openDb(':memory:');
const revealed: string[] = [];
const pages: Record<string, { title: string; text: string }> = {
  'https://example.com/artikel': { title: 'Artikel', text: 'Lång artikeltext om lånecyklar. '.repeat(10) },
  'https://example.com/tom': { title: '', text: 'kort' },
};
const engine = createEngine({
  repo, chat: fakeChat, settings: () => settings, gitInit: false,
  // The already-exists check searches GitHub and Hacker News; here both find nothing.
  searchTransport: (async (url: string | URL | Request) =>
    new Response(String(url).includes('api.github.com') ? '{"items":[]}' : '{"hits":[]}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  fetchPage: async (url) => {
    if (!pages[url]) throw new Error('HTTP 404');
    return pages[url];
  },
  fetchPapers: async () => [
    { id: '2610.1', title: 'Spatial audio', summary: 'sum', published: '2026-10-30', upvotes: 9 },
    { id: '2610.2', title: 'Other', summary: 'sum', published: '2026-10-29', upvotes: 1 },
  ],
  reveal: (p) => revealed.push(p),
});
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
let server: Server;
let base = '';

before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await engine.idle();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repo.close();
  rmSync(projectsRoot, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const newBoard = async (extra: object = {}) => (await api('POST', '/api/boards', extra)).data.board;
const seed = async (boardId: number, text: string) => (await api('POST', `/api/boards/${boardId}/seed`, { text })).data.idea;
const lastCall = (schema: string) => [...calls].reverse().find((c) => c.schemaName === schema)!;

test('the board API lists scored finds and a dropped find seeds exactly once across boards', async () => {
  const board = await newBoard({ title: 'TEST find board' });
  const other = await newBoard({ title: 'TEST other find board' });
  const [find] = repo.addFinds([{
    source: 'lobsters', externalId: 'test-drop', title: 'TEST drop', url: 'https://example.test/drop', summary: 'TEST summary',
  }], Date.now());
  repo.saveFindScores(new Map([[find.id, 0.75]]));
  const before = await api('GET', `/api/boards/${board.id}`);
  assert.equal(before.data.finds.find((row: typeof find) => row.id === find.id).score, 0.75);
  const seeded = await api('POST', `/api/boards/${board.id}/finds/${find.id}/seed`, { x: 33, y: -49 });
  assert.equal(seeded.status, 200);
  const { idea } = seeded.data;
  assert.deepEqual([idea.title, idea.kind, idea.generation, idea.sourceUrl, idea.seedSource, idea.x, idea.y],
    ['TEST drop', 'seed', 0, 'https://example.test/drop', 'lobsters', 33, -49]);
  assert.equal((await api('POST', `/api/boards/${other.id}/finds/${find.id}/seed`, {})).status, 409);
  const after = await api('GET', `/api/boards/${other.id}`);
  assert.equal(after.data.finds.find((row: typeof find) => row.id === find.id).seededIdeaId, idea.id);
  assert.equal(after.data.ideas.length, 0);
  await engine.idle();
  assert.ok(repo.getIdea(idea.id)?.judgedAt);
});

test('full loop: seed → background judge → expand → combine → export', async () => {
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  const board = await newBoard({ goal: 'Färre bilresor i staden' });
  assert.equal(board.title, 'New board');
  assert.equal(board.config.mode, 'manual');
  assert.equal(board.config.flowName, 'Inventor', 'the first template seeds the flow');

  const before = calls.length;
  const s = await seed(board.id, 'Lånecyklar');
  assert.equal(s.title, 'Lånecyklar');
  await engine.idle();
  assert.equal(calls.length, before + 1, 'a short seed needs no LLM call, only the judge');
  assert.match(lastCall('judgement').system, /NEW .*\nIs the combination genuinely new/);
  assert.match(lastCall('judgement').system, /BUILDABLE[\s\S]*?one or two sessions/);
  assert.match(lastCall('judgement').system, /WORTH HAVING[\s\S]*?FITS[\s\S]*?never lower a score/);
  assert.match(lastCall('judgement').user, /Färre bilresor i staden/, 'the judge sees the goal');
  const judged = repo.getIdea(s.id)!;
  assert.equal(judged.originality, 3);
  assert.deepEqual(judged.keywords, ['public space', 'sound'], 'keywords are normalised');

  const { data: e } = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(e.ideas.length, 3);
  assert.match(e.ideas[0].title, /^Barn \d+\.1$/, 'quotes and trailing period are stripped');
  assert.match(lastCall('expand').user, /language of the source ideas or seed text/);
  assert.match(lastCall('expand').user, /a direction, not a filter/);
  assert.match(lastCall('expand').user, /- Lånecyklar/, 'existing titles reach the prompt');
  await engine.idle();
  assert.ok(e.ideas.every((i: any) => repo.getIdea(i.id)!.judgedAt), 'children are judged in the background');

  const [c1, c2] = e.ideas;
  const { data: c } = await api('POST', `/api/boards/${board.id}/combine`, { a: c1.id, b: c2.id });
  assert.equal(c.idea.generation, 2);
  await engine.idle();
  judgeScores = { originality: 9, feasibility: 0, impact: 4 }; // out of range on purpose
  const { data: j } = await api('POST', `/api/ideas/${c.idea.id}/judge`, {});
  assert.deepEqual([j.idea.originality, j.idea.feasibility, j.idea.impact], [5, 1, 4], 'scores are clamped');

  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md`);
  assert.match(md, /^# New board/);
  assert.match(md, /> Färre bilresor i staden/);
  assert.match(md, /## 🥉 Korsning — 10\/15/, '10/15 is bronze');
  assert.match(md, /New 5 · Buildable 1 · Worth having 4/);
  assert.match(md, /`public space` `sound`/);
  assert.ok(repo.spentOn(board.id) > 0, 'spend lands on the board');
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('each role uses its own model: app-wide setting, overridden per board', async () => {
  const pushed = await api('PUT', '/api/runtime-settings', {
    ...settings, models: { ...settings.models, expand: 'zai:glm-5.3-flash' }, keys: { openrouter: 'sk-or-secret-123' },
  });
  assert.ok(!JSON.stringify(pushed.data).includes('sk-or-secret-123'), 'keys are never echoed back');
  assert.equal((await api('GET', '/api/runtime-settings')).data.models.expand, 'zai:glm-5.3-flash');

  const board = await newBoard();
  const s = await seed(board.id, 'Rot');
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'zai:glm-5.3-flash');

  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: 'anthropic:claude-opus-5-5' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'anthropic:claude-opus-5-5', 'board override wins');
  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: '' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'zai:glm-5.3-flash', 'an empty override falls back to the app setting');
  await engine.idle();
  settings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot, crewPath: join(projectsRoot, 'fake-crew.py') };
});

test('board config is validated and clamped', async () => {
  const board = await newBoard();
  const { data } = await api('PATCH', `/api/boards/${board.id}`, {
    config: { mode: 'chaos', rate: { stepsPerHour: 0, usdPerDay: -3 }, autopilotSeconds: 1, flow: { system: '' }, lang: 'de' },
  });
  const c = data.board.config;
  assert.equal(c.mode, 'manual');
  assert.equal(c.rate.stepsPerHour, 1);
  assert.equal(c.rate.usdPerDay, 0);
  assert.equal(c.autopilotSeconds, 3);
  assert.ok(c.flow.system.length > 20, 'an empty prompt keeps the old one');
  assert.equal(c.lang, undefined);
});

test('the judge turns gold into a Claude Code project; a board can switch that off', async () => {
  judgeScores = { originality: 5, feasibility: 4, impact: 5 };
  const board = await newBoard({ goal: 'Ljud i offentliga rum' });
  const s = await seed(board.id, 'Sjungande parkbänk');
  await engine.idle();
  const gold = repo.getIdea(s.id)!;
  assert.ok(gold.projectPath, 'gold → project');
  assert.ok(gold.projectPath!.startsWith(projectsRoot));
  assert.match(gold.projectPath!, /sjungande-bank$/, 'slug is ASCII');
  const claude = readFileSync(join(gold.projectPath!, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Sjungande bänk/);
  assert.match(claude, /Ljud i offentliga rum/);
  assert.match(claude, /14\/15 🥇/);
  assert.ok(existsSync(join(gold.projectPath!, 'vault', 'Home.md')));
  assert.match(readFileSync(join(gold.projectPath!, '.gitignore'), 'utf8'), /^vault\/$/m);

  const again = await api('POST', `/api/ideas/${s.id}/project`, {});
  assert.equal(again.data.existed, true, 'one project per idea');
  await api('POST', `/api/ideas/${s.id}/reveal`, {});
  assert.deepEqual(revealed, [gold.projectPath]);

  const off = await newBoard();
  await api('PATCH', `/api/boards/${off.id}`, { config: { autoProjectOnGold: false } });
  const s2 = await seed(off.id, 'Ännu en guldidé');
  await engine.idle();
  assert.equal(repo.getIdea(s2.id)!.projectPath, null);
  const briefCallsBefore = calls.filter((call) => call.schemaName === 'brief').length;
  const createProject = () => api('POST', `/api/ideas/${s2.id}/project`, {});
  const [first, second] = await Promise.all([createProject(), createProject()]);
  assert.equal(first.status, 200);
  assert.equal(second.data.path, first.data.path, 'overlapping requests share one project');
  assert.equal(calls.filter((call) => call.schemaName === 'brief').length, briefCallsBefore + 1);
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('spin-off: a new board grown from one idea, refined in its own context', async () => {
  const parent = await newBoard({ title: 'Mor', goal: 'Allt' });
  await api('PATCH', `/api/boards/${parent.id}`, { config: { judgeGuidance: 'Belöna lokalt.', mode: 'auto' } });
  const idea = await seed(parent.id, 'Ljudande busshållplats');
  const { data } = await api('POST', `/api/ideas/${idea.id}/spinoff`, {});
  assert.equal(data.board.goal, 'Ljudande busshållplats');
  assert.equal(data.board.config.judgeGuidance, 'Belöna lokalt.', 'config is copied');
  assert.equal(data.board.config.mode, 'manual', 'but it starts manual');
  assert.equal(data.board.originBoardTitle, 'Mor');
  assert.equal(data.idea.originIdeaId, idea.id);
  const { data: p } = await api('GET', `/api/boards/${parent.id}`);
  assert.deepEqual(p.spinoffs, [{ ideaId: idea.id, boardId: data.board.id, title: 'Ljudande busshållplats' }]);
  await api('PATCH', `/api/boards/${parent.id}`, { config: { mode: 'manual' } });
  await engine.idle();
});

test('leads: X keeps only search-cited posts; research keeps only real paper ids', async () => {
  const board = await newBoard({ goal: 'Interaktivt ljus' });
  assert.equal((await api('POST', `/api/boards/${board.id}/leads/x`, {})).data.code, 'scout_disabled');
  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { x: 'openrouter:x-ai/grok-4.3' } } });
  xCitations = ['https://x.com/a/status/1', 'https://x.com/b/status/2'];
  const { data: x } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.deepEqual(x.leads.map((l: any) => l.title), ['Trend A', 'Trend B']);
  assert.equal(x.dropped, 1, 'the uncited post is dropped');
  assert.deepEqual(lastCall('leads').plugins, [{ id: 'web', engine: 'native', max_results: 12 }]);
  assert.equal(lastCall('leads').model, 'openrouter:x-ai/grok-4.3');

  const { data: r } = await api('POST', `/api/boards/${board.id}/leads/research`, {});
  assert.deepEqual(r.leads.map((l: any) => l.url), ['https://huggingface.co/papers/2610.1']);
  assert.match(lastCall('research').user, /Interaktivt ljus/);

  const { data: s } = await api('POST', `/api/leads/${x.leads[0].id}/seed`, {});
  assert.equal(s.idea.sourceUrl, 'https://x.com/a/status/1');
  assert.equal(s.lead.ideaId, s.idea.id);

  xCitations = [];
  const { data: x2 } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.equal(x2.empty, true);
  assert.equal(x2.leads.length, 2, 'nothing verified: old leads stay');
  await engine.idle();
});

test('summary of a board, kept on the board and in the export', async () => {
  const board = await newBoard();
  assert.equal((await api('POST', `/api/boards/${board.id}/summary`, {})).status, 400, 'needs two ideas');
  await seed(board.id, 'Lånecyklar');
  await seed(board.id, 'Korsning');
  await engine.idle();
  const { data } = await api('POST', `/api/boards/${board.id}/summary`, {});
  assert.equal(data.board.summary.headline, 'Tavlan rör sig mot ljud.');
  assert.equal(data.board.summary.ideaCount, 2);
  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md`);
  assert.match(md, /## Summary\n\nTavlan rör sig mot ljud\./);
});

test('live events: a browser following a board sees what happens', async () => {
  const board = await newBoard();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/boards/${board.id}/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const seen: any[] = [];
  const pump = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  await seed(board.id, 'Live');
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  await pump;
  const types = seen.map((e) => e.type);
  assert.equal(types[0], 'hello');
  assert.ok(types.includes('ideas') && types.includes('judging'), types.join(','));
});

test('provider failures surface with their code, and nothing is half-saved', async () => {
  const board = await newBoard();
  const s = await seed(board.id, 'Frö');
  await engine.idle();
  failNext = new ProviderError('no_key', 'OpenRouter: no API key');
  const r = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'no_key');
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('invalid jury output leaves the last valid score intact', async () => {
  const board = await newBoard();
  const idea = await seed(board.id, 'TEST verdict validation');
  await engine.idle();
  const before = repo.getIdea(idea.id);
  const scores = judgeScores;
  try {
    judgeScores = { originality: NaN, feasibility: 5, impact: 5 };
    const result = await api('POST', `/api/ideas/${idea.id}/judge`, {});
    assert.equal(result.status, 502);
    assert.match(result.data.error, /numeric scores/);
    assert.deepEqual(repo.getIdea(idea.id), before);
  } finally {
    judgeScores = scores;
  }
});

test('links: fetched and distilled; unreadable links are an error, not a silent text seed', async () => {
  const board = await newBoard();
  const ok = await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/artikel' });
  assert.equal(ok.data.idea.title, 'Destillerat frö');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/nej' })).data.code, 'url_unreadable');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/tom' })).data.code, 'url_no_text');
  await engine.idle();
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('templates: three defaults, editable, the last one stays', async () => {
  const { data } = await api('GET', '/api/templates');
  assert.equal(data.templates.length, 3);
  assert.equal((await api('POST', '/api/templates', { name: 'X' })).status, 400);
  const { data: n } = await api('POST', '/api/templates', { name: 'Ny', system: 's', expand: 'e', combine: 'c' });
  const board = await newBoard({ templateId: n.template.id });
  assert.equal(board.config.flowName, 'Ny');
  const all = (await api('GET', '/api/templates')).data.templates;
  for (const t of all.slice(0, -1)) assert.equal((await api('DELETE', `/api/templates/${t.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/templates/${all.at(-1).id}`)).data.code, 'last_template');
});

test('retired endpoints are gone and the provider catalog is trimmed', async () => {
  for (const route of ['/api/dashboard', '/api/keywords/test/ideas', '/js/dashboard.js']) {
    assert.equal((await api('GET', route)).status, 404);
  }
  assert.equal((await api('POST', '/api/ideas/1/announce', {})).status, 404);
  const { data } = await api('GET', '/api/providers');
  assert.deepEqual(data.providers.map((p: any) => p.id).sort(), ['anthropic', 'deepseek', 'openai', 'openrouter', 'zai']);
});

test('static files, path traversal, unknown routes', async () => {
  const res = await fetch(base + '/js/score.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /javascript/);
  assert.ok([403, 404].includes((await fetch(base + '/%2e%2e/package.json')).status));
  assert.equal((await api('GET', '/api/nope')).status, 404);
});

test('report: totals, every project, per-board insights, saved conclusions, Markdown', async () => {
  const { data: before } = await api('GET', '/api/report?days=30');
  assert.ok(before.totals.ideas > 0 && before.totals.boards > 0);
  assert.ok(before.projects.some((p: any) => p.title === 'Sjungande parkbänk'), 'the gold project from earlier is listed');
  assert.ok(before.boards.every((b: any) => Array.isArray(b.best) && b.best.length <= 3));
  const withSummary = before.boards.find((b: any) => b.summary);
  assert.ok(withSummary && typeof withSummary.summary.stale === 'boolean');
  assert.equal(before.synthesis, null);

  const synthCall = (r: ChatRequest) => r.schemaName === 'synthesis';
  const { data: after } = await api('POST', '/api/report/synthesis', { days: 30 });
  const call = calls.filter(synthCall).at(-1)!;
  assert.match(call.user, /Sjungande parkbänk/, 'the synthesis sees the boards’ best ideas');
  assert.match(call.user, /Claude Code projects:/);
  assert.equal(call.model, DEFAULT_APP_SETTINGS.models.summary);
  assert.equal(typeof after.synthesis.headline, 'string');
  assert.equal(after.synthesis.days, 30);

  const { data: md } = await api('GET', '/api/report.md?days=30');
  assert.match(md, /^# Report · \d{4}-\d{2}-\d{2}/);
  assert.match(md, /## Conclusions/);
  assert.match(md, /New 5 · Buildable 4 · Worth having 5/);
  assert.match(md, /cd ".*sjungande-bank" && claude/);
});

test('loopback Host, same-origin writes, JSON media type and English page', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /lang-btn|exhibit-btn|dashboard-btn/);

  const spoofed = await new Promise<number | undefined>((resolve, reject) => {
    request(base, { headers: { Host: 'rebound.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(spoofed, 403);

  const boards = repo.listBoards().length;
  const write = (origin: string, contentType: string) => fetch(base + '/api/boards', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': contentType }, body: '{"title":"TEST local board"}',
  });
  for (const [origin, mediaType] of [
    ['https://other.example', 'text/plain'],
    ['https://other.example', 'application/json'],
    [base, 'text/plain'],
  ]) {
    const result = await write(origin, mediaType);
    assert.equal(result.status, 403);
    assert.equal(typeof (await result.json()).error, 'string');
  }
  assert.equal(repo.listBoards().length, boards);
  assert.equal((await write(base, 'application/json; charset=utf-8')).status, 200);
  assert.equal(repo.listBoards().length, boards + 1);
});

test('HTTP edge cases: HEAD static files, non-object JSON rejected with 400, reveal checks directory, example/prompt hygiene', async () => {
  const head = await fetch(base + '/js/score.js', { method: 'HEAD' });
  assert.equal(head.status, 200);

  for (const invalidBody of ['null', '[]', '"text"', '42']) {
    const res = await fetch(base + '/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: invalidBody,
    });
    assert.equal(res.status, 400, `body ${invalidBody} must return 400, not 500`);
  }

  // reveal must reject a projectPath pointing to a file rather than a directory
  const board = await newBoard({ title: 'RevealCheck' });
  const idea = await seed(board.id, 'FilePathCheck');
  await engine.idle();
  const fakeFile = join(projectsRoot, 'not-a-dir.bat');
  writeFileSync(fakeFile, '@echo off', 'utf8');
  repo.setProjectPath(idea.id, fakeFile);
  const rev = await api('POST', `/api/ideas/${idea.id}/reveal`, {});
  assert.equal(rev.status, 404);

  const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'settings.example.json'), 'utf8'));
  assert.equal(example.judgeManyPath, 'C:/path/to/judge_many.py');
  assert.ok(!DEFAULT_TEMPLATES.some((t) => /economically/i.test(t.expand)));
});
