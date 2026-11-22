import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine, selectDeepCrossCandidates } from '../server/engine.ts';
import { createAutopilot, deepCrossDue } from '../server/autopilot.ts';
import { DEFAULT_APP_SETTINGS, makeChat, type ChatRequest } from '../server/providers.ts';

test('selectDeepCrossCandidates chooses up to 8 best ideas covering >= 3 sources', () => {
  const repo = openDb(':memory:');
  try {
    const board = repo.createBoard({ title: 'B' });
    const addSeed = (title: string, seedSource: string, sum: number) => {
      const i = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', seedSource, x: 0, y: 0, generation: 0 });
      const o = Math.min(5, Math.max(1, Math.floor(sum / 3)));
      const f = Math.min(5, Math.max(1, Math.floor((sum - o) / 2)));
      const im = Math.min(5, Math.max(1, sum - o - f));
      return repo.saveJudgement(i.id, { originality: o, feasibility: f, impact: im, reason: 'r' })!;
    };
    // 8 top-scoring items from only 2 sources, plus 2 items from a 3rd source with slightly lower score
    for (let k = 0; k < 5; k++) addSeed(`GH ${k}`, 'github-trending', 12);
    for (let k = 0; k < 5; k++) addSeed(`HN ${k}`, 'hackernews', 11);
    addSeed('Paper 1', 'papers', 9);
    addSeed('Lob 1', 'lobsters', 8);

    const candidates = selectDeepCrossCandidates(repo.listIdeas(board.id), repo.listEdges(board.id));
    assert.equal(candidates.length, 8);
    const sources = new Set(candidates.map((c) => c.source));
    assert.ok(sources.size >= 3, `expected >= 3 sources, got ${[...sources].join(', ')}`);
    assert.ok(sources.has('papers'));
    assert.ok(sources.has('lobsters'));
  } finally {
    repo.close();
  }
});

test('daily deep cross runs once per day 1h after activeHours.start via fake crew, adds 3 multi-parent combines, and judges them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-deep-'));
  const repo = openDb(':memory:');
  try {
    const crewScript = join(dir, 'fake_crew.py');
    writeFileSync(crewScript, `
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
ids = [int(x) for x in re.findall(r'\\[id:(\\d+)\\]', task)]
payload = {
    'ideas': [
        {'title': 'Deep Idea 1', 'pitch': 'Joins first two.', 'parents': [ids[0], ids[1]]},
        {'title': 'Deep Idea 2', 'pitch': 'Joins all three.', 'parents': [ids[0], ids[1], ids[2]]},
        {'title': 'Deep Idea 3', 'pitch': 'Joins outer two.', 'parents': [ids[1], ids[2]]},
    ]
}
with open(args.out, 'w', encoding='utf-8') as f:
    f.write(json.dumps(payload))
`, 'utf8');

    const settings = () => ({
      ...DEFAULT_APP_SETTINGS,
      crewPath: crewScript,
      activeHours: { start: '08:00', end: '22:00' },
      models: { ...DEFAULT_APP_SETTINGS.models, deep: 'crew:neon:medium', judge: 'deepseek:deepseek-flash' },
    });

    const crewChat = makeChat({ settings });
    let judgeCalls = 0;
    const chat = async (r: ChatRequest) => {
      if (r.model.startsWith('crew:')) return crewChat(r);
      judgeCalls++;
      return { value: { reason: 'Solid deep cross', originality: 4, feasibility: 4, impact: 3, keywords: ['cross'] }, costUsd: 0 };
    };

    let now = Date.parse('2026-11-10T08:30:00');
    const engine = createEngine({ repo, chat, settings, now: () => now, gitInit: false });
    const board = repo.createBoard({ title: 'DeepBoard', config: { mode: 'auto', autopilotSeconds: 5 } });
    for (const [title, src] of [['S1', 'github-trending'], ['S2', 'hackernews'], ['S3', 'papers']] as const) {
      const s = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', seedSource: src, x: 0, y: 0, generation: 0 });
      repo.saveJudgement(s.id, { originality: 4, feasibility: 4, impact: 3, reason: 'good' });
    }

    // 08:30 is < 1h after 08:00 start
    assert.equal(deepCrossDue(now, settings().activeHours, repo.getBoard(board.id)!, repo.listIdeas(board.id)), false);

    // 09:05 is >= 1h after 08:00 start
    now = Date.parse('2026-11-10T09:05:00');
    assert.equal(deepCrossDue(now, settings().activeHours, repo.getBoard(board.id)!, repo.listIdeas(board.id)), true);

    const ap = createAutopilot({ repo, engine, settings, now: () => now });
    await ap.tick();
    for (let i = 0; i < 200 && ap.status(board.id).state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const ideas = repo.listIdeas(board.id);
    assert.equal(ideas.length, 6, '3 deep cross combine ideas added');
    const created = ideas.slice(3);
    assert.ok(created.every((i) => i.kind === 'combine' && i.judgedAt !== null), 'all 3 added as combine and judged normally');
    assert.equal(repo.parentsOf(created[1].id).length, 3, 'lineage edges to all parents saved');
    assert.equal(judgeCalls, 3);
    assert.equal(repo.getBoard(board.id)!.deepCrossDay, '2026-11-10');
    assert.equal(deepCrossDue(now, settings().activeHours, repo.getBoard(board.id)!, ideas), false, 'does not run twice same day');

    // Next day at 09:05 it becomes eligible again
    now = Date.parse('2026-11-11T09:05:00');
    assert.equal(deepCrossDue(now, settings().activeHours, repo.getBoard(board.id)!, ideas), true);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an idea or parent while deepCross or judge is in flight does not crash with FK error', async () => {
  const repo = openDb(':memory:');
  try {
    const board = repo.createBoard({ title: 'DeleteRace', config: { autoProjectOnGold: false } });
    const s1 = repo.insertIdea({ boardId: board.id, title: 'P1', pitch: 'p', kind: 'seed', seedSource: 'hackernews', x: 0, y: 0, generation: 0 });
    const s2 = repo.insertIdea({ boardId: board.id, title: 'P2', pitch: 'p', kind: 'seed', seedSource: 'lobsters', x: 10, y: 0, generation: 0 });
    const s3 = repo.insertIdea({ boardId: board.id, title: 'P3', pitch: 'p', kind: 'seed', seedSource: 'papers', x: 20, y: 0, generation: 0 });
    repo.saveJudgement(s1.id, { originality: 4, feasibility: 4, impact: 3, reason: 'ok' });
    repo.saveJudgement(s2.id, { originality: 4, feasibility: 4, impact: 3, reason: 'ok' });
    repo.saveJudgement(s3.id, { originality: 4, feasibility: 4, impact: 3, reason: 'ok' });

    const chat = async (r: ChatRequest) => {
      if (r.schemaName === 'deep_cross') {
        // Delete s3 while deepCross is in flight
        repo.deleteIdea(s3.id);
        return {
          value: {
            ideas: [
              { title: 'Survives', pitch: 'Joins s1 and s2', parents: [s1.id, s2.id] },
              { title: 'PartialDeleted', pitch: 'Had deleted s3', parents: [s1.id, s2.id, s3.id] },
              { title: 'TooFewLeft', pitch: 'Only s1 + deleted s3', parents: [s1.id, s3.id] },
            ],
          },
          costUsd: 0,
        };
      }
      if (r.schemaName === 'judgement') {
        return { value: { reason: 'ok', originality: 3, feasibility: 3, impact: 3, keywords: ['k'] }, costUsd: 0 };
      }
      return { value: {}, costUsd: 0 };
    };
    // The deep role defaults to a crew model, which needs a crew path; the fake chat never runs it.
    const eng = createEngine({ repo, chat, settings: () => ({ ...DEFAULT_APP_SETTINGS, crewPath: 'C:/fake/crew.py' }), gitInit: false });
    const out = await eng.deepCross(board.id);
    assert.equal(out.ideas.length, 2, 'ideas with >= 2 surviving parents still succeed; 1-parent survivor skipped');

    // Deleting an idea while judge() is in flight throws AppError not_found instead of SQLite FK error
    const doomed = repo.insertIdea({ boardId: board.id, title: 'Doomed', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    const engJudge = createEngine({
      repo,
      chat: async () => {
        repo.deleteIdea(doomed.id);
        return { value: { reason: 'ok', originality: 3, feasibility: 3, impact: 3, keywords: ['k'] }, costUsd: 0 };
      },
      settings: () => DEFAULT_APP_SETTINGS,
      gitInit: false,
    });
    await assert.rejects(engJudge.judge(doomed.id), (e: any) => e.code === 'not_found');
  } finally {
    repo.close();
  }
});
