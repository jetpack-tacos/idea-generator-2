import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDay } from '../server/db.ts';
import { fetchPapers, normalizeUrl } from '../server/leads.ts';
import { expandHome, renderClaudeMd, slugify, writeProject, type Brief } from '../server/project.ts';

test('URLs compare loosely: www, twitter.com = x.com, query and trailing slash ignored', () => {
  assert.equal(normalizeUrl('https://twitter.com/a/status/1?s=20'), normalizeUrl('https://x.com/a/status/1/'));
  assert.equal(normalizeUrl('https://www.x.com/a/status/1'), 'x.com/a/status/1');
  assert.equal(normalizeUrl('not a url'), null);
});

test('papers: goal matches first, only from the last year, no duplicates', async () => {
  const recent = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    const body = url.includes('/search')
      ? [{ paper: { id: 's1', title: 'Spatial audio', ai_summary: 'AI sum', publishedAt: recent, upvotes: 3 } },
         { paper: { id: 'old', title: 'Old', summary: 'x', publishedAt: old } },
         { paper: { id: 'd1', title: 'Dup', summary: 'x', publishedAt: recent } }]
      : [{ paper: { id: 'd1', title: 'Daily', summary: 'sum', publishedAt: recent, upvotes: 7 } }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const papers = await fetchPapers('ljud i offentliga rum', fake);
  assert.deepEqual(papers.map((p) => p.id), ['s1', 'd1']);
  assert.equal(papers[0].summary, 'AI sum', 'prefers the short AI summary');
  assert.ok(urls.some((u) => u.includes('q=ljud%20i%20offentliga%20rum')));
  assert.deepEqual((await fetchPapers('', fake)).map((p) => p.id), ['d1'], 'no goal: daily papers only');
});

test('slugs are ASCII; ~ expands to home', () => {
  assert.equal(slugify('Sjungande Bänk på Öland!'), 'sjungande-bank-pa-oland');
  assert.equal(slugify('!!!'), 'idea');
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('/abs'), '/abs');
});

const brief: Brief = {
  name: 'Bänk', slug: 'bank', oneLiner: 'En bänk.', problem: 'P', audience: 'A', mvp: ['m'], outOfScope: ['o'],
  stack: 's', firstSteps: ['f1', 'f2'], openQuestions: ['q'], risks: ['r'],
};
const idea = {
  id: 1, title: 'Bänk', pitch: 'Sjunger.', kind: 'combine', sourceUrl: null, originality: 5, feasibility: 4, impact: 4,
  reason: 'Bra.', medalOverride: null,
};

test('CLAUDE.md: verdict, goal, numbered steps, and source lineage', () => {
  const md = renderClaudeMd({
    brief, idea, goal: 'Ljud', date: '2026-11-02',
    lineage: [{ ...idea, id: 2, title: 'Source seed', pitch: 'Source pitch', kind: 'seed', sourceUrl: 'https://example.com/source' }],
  });
  assert.match(md, /Use 5 · Buildable 4 · Fit 4 = 13\/15 🥇/);
  assert.match(md, /## Board goal\n\nLjud/);
  assert.match(md, /1\. f1\n2\. f2/);
  assert.ok(md.includes("- Seed: **Source seed** Source pitch (source: https://example.com/source)"));
});

test('gold project files, literal Windows-safe paths and no overwrites', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ideagen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { ...idea, id: 2, title: 'TEST source', kind: 'seed', sourceUrl: 'https://example.com/seed' };
  const input = { root, brief, idea, goal: '', lineage: [source], boardTitle: 'TEST board', gitInit: false };
  const a = await writeProject(input);
  writeFileSync(join(a, 'NOTES.md'), 'Existing working notes');
  const b = await writeProject(input);
  assert.deepEqual([a, b].map((p) => p.slice(root.length + 1)), ['bank', 'bank-2']);
  assert.deepEqual(readdirSync(b).sort(), ['.gitignore', 'CLAUDE.md', 'JER-ASKED.md', 'NOTES.md', 'README.md', 'idea.json', 'vault']);
  assert.ok(readFileSync(join(a, 'README.md'), 'utf8').includes(`cd "${a}"\nclaude`));
  assert.equal(readFileSync(join(a, 'NOTES.md'), 'utf8'), 'Existing working notes');
  assert.equal(readFileSync(join(b, 'JER-ASKED.md'), 'utf8'),
    `# Bänk\n\nRuns on: not decided yet\nNo requests yet: this idea came from the idea generator on ${localDay()}, board "TEST board".\n`);
  const notes = readFileSync(join(b, 'NOTES.md'), 'utf8');
  assert.match(notes, /Gold 🥇\nUse 5\/5 · Buildable 4\/5 · Fit 4\/5 \(13\/15\)\nBra\./);
  assert.ok(notes.includes('https://example.com/seed'));
  const ordinary = await writeProject({ ...input, brief: { ...brief, slug: 'con' }, idea: { ...idea, impact: 1 } });
  assert.equal(ordinary.slice(root.length + 1), 'idea-con');
  assert.ok(!readdirSync(ordinary).includes('JER-ASKED.md'));
  await assert.rejects(writeProject({ ...input, root: 'relative' }), /absolute/);
});
