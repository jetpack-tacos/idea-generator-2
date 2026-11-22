// Dry run: compresses one active day into a fast unattended local run using
// temporary DB/settings, fake scouts, fake judge_many, fake LLM, fake crew,
// fake GitHub/HN search, and fake alert command. No network, no spend.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.ts';
import type { Find } from '../server/scouts/http.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'ideagen-dry-'));
process.env.DEEPSEEK_API_KEY = 'dry-run';
process.env.ZAI_API_KEY = 'dry-run';
const t0 = Date.now();
const timeline: string[] = [];
let simNow = (() => {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  return d.getTime();
})();

const stamp = () => {
  const d = new Date(simNow);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1).padStart(4);
  return `[sim ${hh}:${mm} | +${elapsed}s]`;
};
const logStep = (msg: string) => {
  const line = `${stamp()} ${msg}`;
  timeline.push(line);
  console.log(line);
};

// Write fake Python scripts into tempDir
const fakeJudgeManyPath = join(tempDir, 'fake_judge_many.py');
writeFileSync(fakeJudgeManyPath, `
import argparse, json
parser = argparse.ArgumentParser()
parser.add_argument('--questions', required=True)
parser.add_argument('--items', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--public', action='store_true')
parser.add_argument('--task', default='')
parser.add_argument('--context-file', default='')
args = parser.parse_args()

with open(args.items, 'r', encoding='utf-8') as f:
    items = [json.loads(line) for line in f if line.strip()]

with open(args.out, 'w', encoding='utf-8') as out:
    for idx, item in enumerate(items):
        if args.public:
            row = {'id': item['id'], 'ok': True, 'answers': {'fit': {'noul': round(0.9 - idx * 0.02, 2)}}}
        else:
            row = {'id': item['id'], 'ok': True, 'answers': {'wish': {'noul': 0.85}, 'personal': {'noul': 0.05}}}
        out.write(json.dumps(row) + '\\n')
`, 'utf8');

const fakeCrewPath = join(tempDir, 'fake_crew.py');
writeFileSync(fakeCrewPath, `
import argparse, json, re
parser = argparse.ArgumentParser()
parser.add_argument('worker')
parser.add_argument('--task', required=True)
parser.add_argument('--dir', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--effort', required=True)
parser.add_argument('--timeout', required=True)
args = parser.parse_args()

with open(args.task, 'r', encoding='utf-8') as f:
    task = f.read()

if '(deep_cross)' in task:
    ids = [int(x) for x in re.findall(r'\\[id:(\\d+)\\]', task)]
    p1 = ids[:2]
    p2 = ids[1:3] if len(ids) >= 3 else ids[:2]
    p3 = [ids[0], ids[-1]] if len(ids) >= 2 else ids[:2]
    payload = {
        'ideas': [
            {'title': 'Household Fridge Radar', 'pitch': 'Combines local pantry barcode scans with shared calendar reminders so groceries are flagged before dinner.', 'parents': p1},
            {'title': 'Silent Chore Pulse', 'pitch': 'Uses local Wi-Fi presence and the wall tablet to rotate weekly home maintenance tasks cleanly.', 'parents': p2},
            {'title': 'Workshop Tool Finder', 'pitch': 'Tracks shared garage tools via phone NFC taps and warns before project starts.', 'parents': p3},
        ]
    }
else:
    payload = {
        'name': 'Household Fridge Radar',
        'slug': 'household-fridge-radar',
        'oneLiner': 'Local pantry tracker connected to the household calendar tablet.',
        'problem': 'Family members buy duplicate groceries and forget expiring items.',
        'audience': 'One household on a Windows PC, Android phones, and a wall tablet.',
        'mvp': ['Scan items from phone browser', 'Show expiring list on wall tablet', 'Sync shopping checklist'],
        'outOfScope': ['Cloud accounts', 'Receipt OCR'],
        'stack': 'Node 24 + SQLite + plain HTML/JS',
        'firstSteps': ['Create SQLite schema', 'Build phone capture form', 'Render tablet view'],
        'openQuestions': ['Barcode DB source?'],
        'risks': ['Manual entry friction'],
    }

with open(args.out, 'w', encoding='utf-8') as f:
    fence = chr(96) * 3
    f.write('Reasoning done.\\n\\n' + fence + 'json\\n' + json.dumps(payload, indent=2) + '\\n' + fence + '\\n')
`, 'utf8');

const alertsFile = join(tempDir, 'alerts-received.txt');
const fakeAlertPath = join(tempDir, 'fake_alert.py');
writeFileSync(fakeAlertPath, `
import json, sys
with open(${JSON.stringify(alertsFile)}, 'a', encoding='utf-8') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
`, 'utf8');

const sessionsDir = join(tempDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, 'recent.jsonl'), [
  JSON.stringify({ role: 'user', content: 'I really wish I had a simple local tool to remind me when garage tools are borrowed and not put back.' }),
  JSON.stringify({ role: 'assistant', content: 'Here is how you could build that.' }),
].join('\n') + '\n', 'utf8');

const projectsRoot = join(tempDir, 'projects');
const settingsFile = join(tempDir, 'settings.local.json');
const dbFile = join(tempDir, 'ideas.db');
const spendFile = join(tempDir, 'spend.jsonl');
const alertLogFile = join(tempDir, 'alerts.log');

writeFileSync(settingsFile, JSON.stringify({
  models: {
    distill: 'deepseek:deepseek-flash',
    expand: 'deepseek:deepseek-flash',
    combine: 'deepseek:deepseek-flash',
    judge: 'deepseek:deepseek-flash',
    summary: 'deepseek:deepseek-flash',
    research: 'zai:glm-5.3-flash',
    x: '',
    brief: 'crew:neon:medium',
    deep: 'crew:neon:medium',
    exists: 'deepseek:deepseek-flash',
  },
  projectsRoot,
  maxUsdPerDay: 1,
  activeHours: { start: '08:00', end: '22:00' },
  scoutIntervalsHours: {
    'github-trending': 6,
    'github-new': 12,
    hackernews: 3,
    lobsters: 6,
    papers: 24,
    'google-news': 6,
    sessions: 12,
  },
  judgeManyPath: fakeJudgeManyPath,
  crewPath: fakeCrewPath,
  crewCallsPerDay: 10,
  alertCommand: ['python', '-I', fakeAlertPath, '{title}'],
  sessionsPath: sessionsDir,
  interests: 'household tools, local automation, sensors',
  seedThreshold: 0.6,
  seedsPerRound: 3,
}, null, 2), 'utf8');

// Fake LLM HTTP server
let llmCount = 0;
const llmServer = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const schemaName = body?.response_format?.json_schema?.name ?? '';
  const userMsg = body?.messages?.[1]?.content ?? '';
  llmCount++;

  let content: unknown;
  if (schemaName === 'judgement') {
    const isGoldCandidate = /Household Fridge Radar/i.test(userMsg);
    content = isGoldCandidate
      ? { reason: 'Used weekly by the whole family and fits existing devices.', originality: 5, feasibility: 4, impact: 4, keywords: ['household', 'tablet'] }
      : { reason: 'Useful local spark that could be adapted.', originality: 4, feasibility: 3, impact: 3, keywords: ['local'] };
  } else if (schemaName === 'expand') {
    content = {
      ideas: [
        { title: `Expanded Spark A${llmCount}`, pitch: 'A household variant on the Windows PC.' },
        { title: `Expanded Spark B${llmCount}`, pitch: 'A phone shortcut tied to the wall tablet.' },
        { title: `Expanded Spark C${llmCount}`, pitch: 'An offline local sensor log.' },
      ],
    };
  } else if (schemaName === 'combine') {
    content = { title: `Crossed Idea ${llmCount}`, pitch: 'Joins two household tools into one local dashboard.' };
  } else if (schemaName === 'exists_queries') {
    content = { queries: ['household fridge radar', 'local pantry tablet tracker'] };
  } else if (schemaName === 'exists_verdict') {
    content = { verdict: 'new', url: '', reason: 'No matching household pantry tablet tool exists on GitHub or HN.' };
  } else {
    content = { title: 'Seed Idea', pitch: 'A practical household tool.' };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 }, // zero tokens: the app prices tokens itself, and a dry run spends nothing
  }));
});

await new Promise<void>((r) => llmServer.listen(0, '127.0.0.1', r));
const llmBase = `http://127.0.0.1:${(llmServer.address() as any).port}`;

const fakeScouts: Record<string, () => Promise<Find[]>> = {
  'github-trending': async () => [{ source: 'github-trending', externalId: 'gh-1', title: 'local-pantry-sync', url: 'https://github.com/example/local-pantry-sync', summary: 'Offline pantry inventory helper.' }],
  'github-new': async () => [{ source: 'github-new', externalId: 'ghn-1', title: 'tablet-kiosk-frame', url: 'https://github.com/example/tablet-kiosk-frame', summary: 'Lightweight Android wall-tablet dashboard.' }],
  hackernews: async () => [{ source: 'hackernews', externalId: 'hn-1', title: 'Show HN: NFC tool pegboard tracker', url: 'https://example.com/nfc-pegboard', summary: 'Track borrowed tools with NFC tags.' }],
  lobsters: async () => [{ source: 'lobsters', externalId: 'lob-1', title: 'Wi-Fi presence without cloud', url: 'https://example.com/wifi-presence', summary: 'Local ARP presence watcher.' }],
  papers: async () => [{ source: 'papers', externalId: 'pap-1', title: 'Tiny acoustic event detection', url: 'https://huggingface.co/papers/2601.00001', summary: 'Low-power household audio alerts.' }],
  'google-news': async () => [{ source: 'google-news', externalId: 'gn-1', title: 'DIY smart home calendars', url: 'https://example.com/diy-calendars', summary: 'Families repurposing old tablets.' }],
};

let searchCalls = 0;
const fakeSearchFetch: typeof fetch = async (input) => {
  searchCalls++;
  const url = String(input);
  if (url.includes('api.github.com')) {
    return new Response(JSON.stringify({
      items: [{ full_name: 'example/unrelated-repo', html_url: 'https://github.com/example/unrelated-repo', stargazers_count: 42, description: 'Unrelated demo' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    hits: [{ objectID: '12345', title: 'Show HN: Something else', url: 'https://example.com/other', points: 15 }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { server, repo, engine, autopilot, scoutScheduler } = startServer({
  port: 0,
  dbFile,
  settingsFile,
  spendFile,
  alertLogFile,
  baseUrls: { deepseek: llmBase, zai: llmBase },
  now: () => simNow,
  scoutSources: fakeScouts,
  searchTransport: fakeSearchFetch,
  crewTimeoutMs: 30_000,
  gitInit: false,
  autopilotTickMs: 50,
});

await new Promise<void>((r) => server.once('listening', r));
const port = (server.address() as any).port;
const appBase = `http://127.0.0.1:${port}`;

async function apiJson(method: string, path: string, body?: unknown) {
  const res = await fetch(`${appBase}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
}

const waitIdle = async () => {
  for (let i = 0; i < 500; i++) {
    await engine.idle();
    if (autopilot.status(boardId).state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
};

let boardId = 0;
const steps: [string, boolean, string][] = [];
const record = (name: string, ok: boolean, detail: string) => steps.push([name, ok, detail]);

try {
  logStep('Started server and fake local services');
  const created = await apiJson('POST', '/api/boards', { title: 'Household Lab', goal: 'Practical tools for our home PC, phones, and wall tablet' });
  boardId = created.board.id;
  await apiJson('PATCH', `/api/boards/${boardId}`, { config: { mode: 'auto', autopilotSeconds: 5 } });
  logStep(`Created auto board #${boardId}`);

  // 08:03 — Scout round + scoring + seeding
  simNow += 3 * 60_000;
  await scoutScheduler.tick();
  await scoutScheduler.waitIdle();
  const finds = repo.latestFinds();
  const sourcesFound = new Set(finds.map((f) => f.source));
  const scoredCount = finds.filter((f) => f.score !== null).length;
  const seededCount = repo.listIdeas(boardId).length;
  logStep(`Scout round finished: ${finds.length} finds from ${sourcesFound.size} sources, ${scoredCount} scored, ${seededCount} seeded`);
  record('scout rounds', sourcesFound.size === 7, `${sourcesFound.size}/7 sources (${[...sourcesFound].join(', ')})`);
  record('scoring', scoredCount === finds.length && scoredCount > 0, `${scoredCount}/${finds.length} scored`);
  record('seeding', seededCount >= 3, `${seededCount} seeded on auto board`);

  // 08:10..08:40 — Autopilot judging, expanding, crossing
  for (let m = 1; m <= 6; m++) {
    simNow += 5 * 60_000;
    await autopilot.tick();
    await waitIdle();
  }
  const midIdeas = repo.listIdeas(boardId);
  const judgedCount = midIdeas.filter((i) => i.judgedAt !== null).length;
  const crossedCount = midIdeas.filter((i) => i.kind === 'combine').length;
  logStep(`Morning evolution: ${midIdeas.length} ideas, ${judgedCount} judged, ${crossedCount} crossed`);
  record('judging', judgedCount >= 3, `${judgedCount} ideas judged`);
  record('crossing', crossedCount >= 1, `${crossedCount} combine idea(s)`);

  // 09:05 — Daily deep cross (1h after 08:00 start)
  const d0905 = new Date(simNow);
  d0905.setHours(9, 5, 0, 0);
  simNow = d0905.getTime();
  await autopilot.tick();
  await waitIdle();
  const afterDeep = repo.listIdeas(boardId);
  const boardAfterDeep = repo.getBoard(boardId)!;
  const deepChildren = afterDeep.filter((i) => i.kind === 'combine' && repo.parentsOf(i.id).length >= 2);
  logStep(`Daily deep cross ran (${boardAfterDeep.deepCrossDay}): ${afterDeep.length} total ideas, ${deepChildren.length} multi-parent combines`);
  record('deep cross', Boolean(boardAfterDeep.deepCrossDay) && deepChildren.length >= 1, `day=${boardAfterDeep.deepCrossDay}, children=${afterDeep.length - midIdeas.length}`);

  // Check gold idea, exists check, project folder, and alert
  const goldIdeas = afterDeep.filter((i) => (i.originality ?? 0) + (i.feasibility ?? 0) + (i.impact ?? 0) >= 13);
  const checkedGold = goldIdeas.find((i) => i.existsVerdict !== null);
  const projectGold = goldIdeas.find((i) => i.projectPath && existsSync(i.projectPath));
  const alertLines = existsSync(alertsFile) ? readFileSync(alertsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  const statusJson = await apiJson('GET', '/api/status');

  logStep(`Gold=${goldIdeas.length}, existsSearchCalls=${searchCalls}, project=${projectGold?.projectPath ?? 'none'}, alerts=${alertLines.length}, spend=$${statusJson.spentTodayUsd}`);
  record('gold idea', goldIdeas.length >= 1, `${goldIdeas.length} gold idea(s)`);
  record('exists check', Boolean(checkedGold) && searchCalls >= 2, `verdict=${checkedGold?.existsVerdict}, searchCalls=${searchCalls}`);
  record('project folder', Boolean(projectGold && existsSync(join(projectGold.projectPath!, 'NOTES.md'))), projectGold?.projectPath ?? 'missing');
  record('alert', alertLines.length >= 1 && alertLines.some((l) => l.includes('Gold idea:')), alertLines[0] ?? 'none');
  record('no spend', statusJson.spentTodayUsd === 0 && statusJson.crewCallsToday >= 2, `usd=$${statusJson.spentTodayUsd}, crewCalls=${statusJson.crewCallsToday}`);
} catch (error: any) {
  logStep(`ERROR: ${error?.stack ?? error}`);
  record('runtime', false, error?.message ?? String(error));
} finally {
  autopilot.stop();
  await scoutScheduler.stop();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => llmServer.close(() => r()));
  repo.close();
  rmSync(tempDir, { recursive: true, force: true });
}

const cleaned = !existsSync(tempDir);
record('cleanup', cleaned, cleaned ? 'temp files removed' : `${tempDir} still exists`);

console.log('\n=== DRY RUN SUMMARY ===');
let allOk = true;
for (const [name, ok, detail] of steps) {
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}
process.exit(allOk ? 0 : 1);
