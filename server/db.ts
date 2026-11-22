// SQLite through Node's built-in node:sqlite. No ORM, no dependencies.
//
// Every board is self-contained: its goal, its own creation flow (prompts),
// its jury guidance, its researchers, its autopilot pace. Templates only seed
// a new board's flow; editing a board never changes another board.
import { DatabaseSync } from 'node:sqlite';
import { parseModel, ROLES, type Role } from './providers.ts';
import type { Find } from './scouts/http.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  expand TEXT NOT NULL,
  combine TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  origin_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  summary TEXT,
  deep_cross_day TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('seed', 'expand', 'combine')),
  source_url TEXT,
  seed_source TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  originality INTEGER,
  feasibility INTEGER,
  impact INTEGER,
  reason TEXT,
  judged_at TEXT,
  medal_override INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  project_path TEXT,
  exists_verdict TEXT,
  exists_url TEXT,
  exists_reason TEXT,
  exists_attempts INTEGER NOT NULL DEFAULT 0,
  exists_checked_at TEXT,
  origin_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  origin_board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ideas_board ON ideas(board_id);
CREATE UNIQUE INDEX IF NOT EXISTS ideas_origin_once ON ideas(board_id, origin_idea_id) WHERE origin_idea_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS edges (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('x', 'research')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS leads_board ON leads(board_id);
CREATE TABLE IF NOT EXISTS finds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  score REAL CHECK (score BETWEEN 0 AND 1),
  -- Keep the original ID as a seeded marker even if its idea is deleted.
  seeded_idea_id INTEGER,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS finds_recent ON finds(source, first_seen DESC, id DESC);
CREATE INDEX IF NOT EXISTS finds_age ON finds(first_seen);
CREATE INDEX IF NOT EXISTS finds_seedable ON finds(score DESC, id) WHERE seeded_idea_id IS NULL;
CREATE TABLE IF NOT EXISTS scout_runs (
  source TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_error TEXT
);
-- Keywords come from the judge, in one canonical form, so trends can be counted across boards.
CREATE TABLE IF NOT EXISTS idea_keywords (
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  PRIMARY KEY (idea_id, keyword)
);
CREATE INDEX IF NOT EXISTS idea_keywords_kw ON idea_keywords(keyword);
-- Saved cross-board syntheses for the report window (latest one is shown).
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  days INTEGER NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Spend ledger per board and local calendar day; the rate limiter reads it.
-- board_id 0 = spend that belongs to no board.
CREATE TABLE IF NOT EXISTS spend (
  board_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, day)
);
-- Crew call counter per local calendar day across all boards.
CREATE TABLE IF NOT EXISTS crew_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
`;

// Templates for a board's creation flow. The prompts are in English; the
// output language is decided per request (same language as the seed).
export const DEFAULT_TEMPLATES = [
  {
    name: 'Inventor',
    system:
      'You are a brilliant, practical inventor. You think in mechanisms: what exactly happens, for whom, and why it works. You avoid buzzwords.',
    expand:
      'Generate 3 new ideas that grow out of the concept. Make them clearly different from each other: one close variation that sharpens it, one that borrows a mechanism from a completely different field, and one bold leap.',
    combine:
      'Fuse the two ideas into ONE new concept that neither could be alone. Name the specific mechanism that connects them; do not just list both.',
  },
  {
    name: 'Sustainability',
    system:
      'You are a systems thinker working on sustainability and local communities. You favour solutions that cut resource use and that ordinary people and municipalities can start with today.',
    expand:
      'Generate 3 ideas that grow out of the concept and make it more sustainable socially, ecologically or economically. Make them differ in scale: household, organisation, and region.',
    combine:
      'Combine the two ideas into ONE solution where the sustainability gain of one multiplies the other. Be concrete about what changes.',
  },
  {
    name: 'Wild card',
    system:
      'You are a playful, fearless provocateur. You turn assumptions upside down and find the idea nobody dares say out loud, but every idea must still be explainable in two sentences and possible to actually try.',
    expand:
      'Generate 3 surprising, unconventional ideas that grow out of the concept. Each must break at least one obvious assumption.',
    combine:
      'Crash the two ideas together into ONE unexpected concept. The stranger the connection the better, as long as it can actually be done.',
  },
];

export type Flow = { system: string; expand: string; combine: string };
const LEGACY_TEMPLATE_NAMES = new Map([
  ['Uppfinnaren · Inventor', 'Inventor'],
  ['Omställaren · Sustainability', 'Sustainability'],
  ['Galningen · Wild card', 'Wild card'],
]);

function legacyFlow(name: string, flow: Flow) {
  if (name === 'Affärsstrategen · Business' && flow.system.startsWith('You are a sharp business strategist')) {
    const { name, system, expand, combine } = DEFAULT_TEMPLATES[0];
    return { name, flow: { system, expand, combine } };
  }
  return { name: LEGACY_TEMPLATE_NAMES.get(name) ?? name, flow };
}

export type BoardConfig = {
  flowName: string;
  flow: Flow;
  judgeGuidance: string;
  researchers: { x: { enabled: boolean; focus: string }; research: { enabled: boolean; focus: string } };
  /** manual: people drive. auto: the server evolves the board on its own, within the limits below. */
  mode: 'manual' | 'auto';
  /** Seconds between autopilot steps (pace). */
  autopilotSeconds: number;
  rate: { stepsPerHour: number; usdPerDay: number };
  autoProjectOnGold: boolean;
  /** Per-role model overrides ("provider:model"); empty = the app-wide setting. */
  models: Partial<Record<Role, string>>;
};

export function defaultConfig(template = DEFAULT_TEMPLATES[0]): BoardConfig {
  return {
    flowName: template.name,
    flow: { system: template.system, expand: template.expand, combine: template.combine },
    judgeGuidance: '',
    researchers: { x: { enabled: true, focus: '' }, research: { enabled: true, focus: '' } },
    mode: 'manual',
    autopilotSeconds: 10,
    rate: { stepsPerHour: 60, usdPerDay: 1 },
    autoProjectOnGold: true,
    models: {},
  };
}

/** Merge an untrusted partial config onto a valid one, keeping only well-typed values. */
export function mergeConfig(base: BoardConfig, raw: any): BoardConfig {
  const s = (v: unknown, max: number, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
  const nonEmpty = (v: unknown, max: number, fallback: string) => s(v, max, fallback) || fallback;
  const b = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const r = raw && typeof raw === 'object' ? raw : {};
  const rx = r.researchers?.x ?? {};
  const rr = r.researchers?.research ?? {};
  const secs = Number(r.autopilotSeconds);
  const sph = Number(r.rate?.stepsPerHour);
  const usd = Number(r.rate?.usdPerDay);
  const models: BoardConfig['models'] = { ...base.models };
  for (const role of ROLES) {
    if (typeof r.models?.[role] === 'string') {
      const v = r.models[role].trim().slice(0, 200);
      try {
        parseModel(v);
        models[role] = v;
      } catch {
        delete models[role];
      }
    }
  }
  const { name, flow } = legacyFlow(nonEmpty(r.flowName, 80, base.flowName), {
    system: nonEmpty(r.flow?.system, 4000, base.flow.system),
    expand: nonEmpty(r.flow?.expand, 4000, base.flow.expand),
    combine: nonEmpty(r.flow?.combine, 4000, base.flow.combine),
  });
  return {
    flowName: name,
    flow,
    judgeGuidance: s(r.judgeGuidance, 4000, base.judgeGuidance),
    researchers: {
      x: { enabled: b(rx.enabled, base.researchers.x.enabled), focus: s(rx.focus, 300, base.researchers.x.focus) },
      research: {
        enabled: b(rr.enabled, base.researchers.research.enabled),
        focus: s(rr.focus, 300, base.researchers.research.focus),
      },
    },
    mode: r.mode === 'auto' || r.mode === 'manual' ? r.mode : base.mode,
    autopilotSeconds: Number.isFinite(secs) ? Math.min(3600, Math.max(3, Math.round(secs))) : base.autopilotSeconds,
    rate: {
      stepsPerHour: Number.isFinite(sph) ? Math.min(3600, Math.max(1, Math.round(sph))) : base.rate.stepsPerHour,
      usdPerDay: Number.isFinite(usd) ? Math.min(1000, Math.max(0, Math.round(usd * 100) / 100)) : base.rate.usdPerDay,
    },
    autoProjectOnGold: b(r.autoProjectOnGold, base.autoProjectOnGold),
    models,
  };
}

export type ExistsVerdict = 'exists' | 'partial' | 'new';

export type Idea = {
  id: number;
  boardId: number;
  title: string;
  pitch: string;
  kind: 'seed' | 'expand' | 'combine';
  sourceUrl: string | null;
  seedSource: string | null;
  x: number;
  y: number;
  originality: number | null;
  feasibility: number | null;
  impact: number | null;
  reason: string | null;
  judgedAt: string | null;
  medalOverride: number | null;
  generation: number;
  projectPath: string | null;
  existsVerdict: ExistsVerdict | null;
  existsUrl: string | null;
  existsReason: string | null;
  existsAttempts: number;
  existsCheckedAt: string | null;
  originIdeaId: number | null;
  originBoardId: number | null;
  originBoardTitle: string | null;
  keywords: string[];
  createdAt: string;
};

export type Board = {
  id: number; title: string; goal: string; config: BoardConfig; createdAt: string; updatedAt: string;
  /** Spin-off boards: the idea this board grew from, and where that idea lives. */
  originIdeaId: number | null; originIdeaTitle: string | null; originBoardId: number | null; originBoardTitle: string | null;
  summary: BoardSummary | null;
  deepCrossDay: string | null;
};
export type BoardSummary = {
  headline: string;
  themes: { name: string; insight: string; ideas: string[] }[];
  strongest: { title: string; why: string }[];
  gaps: string[];
  nextSteps: string[];
  ideaCount: number;
  createdAt: string;
};
export type Template = { id: number; name: string; system: string; expand: string; combine: string; sort: number };
export type Lead = {
  id: number; boardId: number; source: 'x' | 'research'; title: string; summary: string; hook: string;
  url: string | null; meta: Record<string, unknown>; ideaId: number | null; fetchedAt: string;
};

export type StoredFind = Omit<Find, 'publishedAt'> & { id: number; firstSeen: number; score: number | null; seededIdeaId: number | null };

const findFromRow = (r: any): StoredFind => ({
  id: r.id, source: r.source, externalId: r.external_id, title: r.title, url: r.url, summary: r.summary,
  firstSeen: r.first_seen, score: r.score, seededIdeaId: r.seeded_idea_id,
});

const IDEA_SELECT = `SELECT i.*, ob.title AS origin_board_title,
  (SELECT group_concat(keyword, '|') FROM (SELECT keyword FROM idea_keywords k WHERE k.idea_id = i.id ORDER BY keyword)) AS keywords
  FROM ideas i LEFT JOIN boards ob ON ob.id = i.origin_board_id`;

const ideaFromRow = (r: any): Idea => ({
  id: r.id,
  boardId: r.board_id,
  title: r.title,
  pitch: r.pitch,
  kind: r.kind === 'expand' || r.kind === 'combine' ? r.kind : 'seed',
  sourceUrl: r.source_url,
  seedSource: r.seed_source,
  x: r.x,
  y: r.y,
  originality: r.originality,
  feasibility: r.feasibility,
  impact: r.impact,
  reason: r.reason,
  judgedAt: r.judged_at,
  medalOverride: r.medal_override,
  generation: r.generation,
  projectPath: r.project_path,
  existsVerdict: r.exists_verdict ?? null,
  existsUrl: r.exists_url ?? null,
  existsReason: r.exists_reason ?? null,
  existsAttempts: r.exists_attempts ?? 0,
  existsCheckedAt: r.exists_checked_at ?? null,
  originIdeaId: r.origin_idea_id,
  originBoardId: r.origin_board_id,
  originBoardTitle: r.origin_board_title ?? null,
  keywords: r.keywords ? String(r.keywords).split('|') : [],
  createdAt: r.created_at,
});

const parseJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

const BOARD_SELECT = `SELECT b.*, oi.title AS origin_idea_title, oi.board_id AS origin_board_id, ob.title AS origin_board_title
  FROM boards b LEFT JOIN ideas oi ON oi.id = b.origin_idea_id LEFT JOIN boards ob ON ob.id = oi.board_id`;

const boardFromRow = (r: any): Board => ({
  id: r.id,
  title: r.title,
  goal: r.goal,
  config: mergeConfig(defaultConfig(), parseJson(r.config)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  originIdeaId: r.origin_idea_id ?? null,
  originIdeaTitle: r.origin_idea_title ?? null,
  originBoardId: r.origin_board_id ?? null,
  originBoardTitle: r.origin_board_title ?? null,
  summary: r.summary ? parseJson(r.summary) : null,
  deepCrossDay: r.deep_cross_day ?? null,
});

const leadFromRow = (r: any): Lead => ({
  id: r.id,
  boardId: r.board_id,
  source: r.source,
  title: r.title,
  summary: r.summary,
  hook: r.hook,
  url: r.url,
  meta: parseJson(r.meta),
  ideaId: r.idea_id,
  fetchedAt: r.fetched_at,
});

function templateFromRow(template: Template): Template {
  const { name, flow } = legacyFlow(template.name, template);
  return { ...template, ...flow, name };
}

export function openDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  if ((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as any).n === 0) {
    const ins = db.prepare('INSERT INTO templates (name, system, expand, combine, sort) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_TEMPLATES.forEach((t, i) => ins.run(t.name, t.system, t.expand, t.combine, i));
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const hasCol = (table: string, col: string) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === col);

  if (!hasCol('ideas', 'seed_source')) {
    tx(() => {
      db.exec(`ALTER TABLE ideas ADD COLUMN seed_source TEXT;
        UPDATE ideas SET seed_source = (
          SELECT CASE source WHEN 'research' THEN 'papers' ELSE source END
          FROM leads WHERE idea_id = ideas.id ORDER BY id DESC LIMIT 1
        ) WHERE kind = 'seed';`);
    });
  }
  for (const [col, def] of [
    ['exists_verdict', 'TEXT'],
    ['exists_url', 'TEXT'],
    ['exists_reason', 'TEXT'],
    ['exists_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['exists_checked_at', 'TEXT'],
  ] as const) {
    if (!hasCol('ideas', col)) db.exec(`ALTER TABLE ideas ADD COLUMN ${col} ${def};`);
  }
  if (!hasCol('boards', 'deep_cross_day')) db.exec('ALTER TABLE boards ADD COLUMN deep_cross_day TEXT;');
  if (!hasCol('scout_runs', 'last_error')) db.exec('ALTER TABLE scout_runs ADD COLUMN last_error TEXT;');

  function insertIdeaRow(i: {
    boardId: number; title: string; pitch: string; kind: Idea['kind']; sourceUrl?: string | null; seedSource?: string | null;
    x: number; y: number; generation: number; originIdeaId?: number | null; originBoardId?: number | null;
  }, parentIds: number[]): Idea {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO ideas (board_id, title, pitch, kind, source_url, seed_source, x, y, generation, origin_idea_id, origin_board_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(i.boardId, i.title, i.pitch, i.kind, i.sourceUrl ?? null, i.seedSource ?? null, i.x, i.y, i.generation,
      i.originIdeaId ?? null, i.originBoardId ?? null);
    const id = Number(lastInsertRowid);
    const edge = db.prepare('INSERT OR IGNORE INTO edges (board_id, from_id, to_id) VALUES (?, ?, ?)');
    for (const p of parentIds) edge.run(i.boardId, p, id);
    repo.touchBoard(i.boardId);
    return repo.getIdea(id)!;
  }

  const repo = {
    close: () => db.close(),

    // ---- boards
    listBoards() {
      return db
        .prepare(
          `SELECT * FROM (${BOARD_SELECT}) b2 ORDER BY b2.updated_at DESC, b2.id DESC`,
        )
        .all()
        .map((r: any) => ({
          ...boardFromRow(r),
          ideaCount: (db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE board_id = ?').get(r.id) as any).n,
        }));
    },
    getBoard(id: number): Board | null {
      const r = db.prepare(`${BOARD_SELECT} WHERE b.id = ?`).get(id);
      return r ? boardFromRow(r) : null;
    },
    createBoard(b: { title: string; goal?: string; templateId?: number | null; config?: unknown; originIdeaId?: number | null }): Board {
      const template = repo.getTemplate(b.templateId ?? null);
      const config = mergeConfig(defaultConfig(template), b.config);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO boards (title, goal, config, origin_idea_id) VALUES (?, ?, ?, ?)')
        .run(b.title, b.goal ?? '', JSON.stringify(config), b.originIdeaId ?? null);
      return repo.getBoard(Number(lastInsertRowid))!;
    },
    updateBoard(id: number, patch: { title?: string; goal?: string; config?: unknown }) {
      const cur = repo.getBoard(id);
      if (!cur) return null;
      const config = patch.config === undefined ? cur.config : mergeConfig(cur.config, patch.config);
      db.prepare(`UPDATE boards SET title = ?, goal = ?, config = ?, updated_at = datetime('now') WHERE id = ?`).run(
        patch.title ?? cur.title,
        patch.goal ?? cur.goal,
        JSON.stringify(config),
        id,
      );
      return repo.getBoard(id);
    },
    setSummary(id: number, summary: BoardSummary) {
      db.prepare('UPDATE boards SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
      return repo.getBoard(id);
    },
    setDeepCrossDay(id: number, day: string) {
      db.prepare('UPDATE boards SET deep_cross_day = ? WHERE id = ?').run(day, id);
      return repo.getBoard(id);
    },
    touchBoard(id: number) {
      db.prepare(`UPDATE boards SET updated_at = datetime('now') WHERE id = ?`).run(id);
    },
    /** Boards spun off from ideas on this board: idea id → [{boardId, title}]. */
    spinoffs(boardId: number) {
      return db
        .prepare('SELECT b.id AS board_id, b.title, b.origin_idea_id FROM boards b JOIN ideas i ON i.id = b.origin_idea_id WHERE i.board_id = ? ORDER BY b.id')
        .all(boardId)
        .map((r: any) => ({ ideaId: r.origin_idea_id, boardId: r.board_id, title: r.title }));
    },
    deleteBoard(id: number) {
      return db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0;
    },

    // ---- ideas
    listIdeas(boardId: number): Idea[] {
      return db.prepare(`${IDEA_SELECT} WHERE i.board_id = ? ORDER BY i.id`).all(boardId).map(ideaFromRow);
    },
    getIdea(id: number): Idea | null {
      const r = db.prepare(`${IDEA_SELECT} WHERE i.id = ?`).get(id);
      return r ? ideaFromRow(r) : null;
    },
    /** Insert an idea and the edges from its parents in one transaction. */
    insertIdea(i: Parameters<typeof insertIdeaRow>[0], parentIds: number[] = []): Idea {
      return tx(() => insertIdeaRow(i, parentIds));
    },
    saveJudgement(id: number, j: { originality: number; feasibility: number; impact: number; reason: string }) {
      db.prepare(
        `UPDATE ideas SET originality = ?, feasibility = ?, impact = ?, reason = ?, judged_at = datetime('now') WHERE id = ?`,
      ).run(j.originality, j.feasibility, j.impact, j.reason, id);
      return repo.getIdea(id);
    },
    saveExistsResult(id: number, r: { verdict: ExistsVerdict; url: string | null; reason: string }) {
      db.prepare(
        `UPDATE ideas SET exists_verdict = ?, exists_url = ?, exists_reason = ?, exists_checked_at = datetime('now') WHERE id = ?`,
      ).run(r.verdict, r.url, r.reason, id);
      return repo.getIdea(id);
    },
    incrementExistsAttempt(id: number) {
      db.prepare('UPDATE ideas SET exists_attempts = exists_attempts + 1 WHERE id = ?').run(id);
      return repo.getIdea(id);
    },
    setKeywords(id: number, keywords: string[]) {
      tx(() => {
        db.prepare('DELETE FROM idea_keywords WHERE idea_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO idea_keywords (idea_id, keyword) VALUES (?, ?)');
        for (const k of keywords) ins.run(id, k);
      });
      return repo.getIdea(id);
    },
    /** The keywords in use, most common first, so the judge can reuse them. */
    keywordVocabulary(limit = 80): string[] {
      return db
        .prepare('SELECT keyword, COUNT(*) AS n FROM idea_keywords GROUP BY keyword ORDER BY n DESC, keyword LIMIT ?')
        .all(limit)
        .map((r: any) => r.keyword);
    },
    setMedalOverride(id: number, medal: number | null) {
      db.prepare('UPDATE ideas SET medal_override = ? WHERE id = ?').run(medal, id);
      return repo.getIdea(id);
    },
    setProjectPath(id: number, path: string) {
      db.prepare('UPDATE ideas SET project_path = ? WHERE id = ?').run(path, id);
      return repo.getIdea(id);
    },
    savePositions(boardId: number, positions: { id: number; x: number; y: number }[]) {
      tx(() => {
        const up = db.prepare('UPDATE ideas SET x = ?, y = ? WHERE id = ? AND board_id = ?');
        for (const p of positions) up.run(p.x, p.y, p.id, boardId);
      });
    },
    deleteIdea(id: number) {
      return db.prepare('DELETE FROM ideas WHERE id = ?').run(id).changes > 0;
    },

    // ---- edges and lineage
    listEdges(boardId: number) {
      return db
        .prepare('SELECT from_id, to_id FROM edges WHERE board_id = ? ORDER BY rowid')
        .all(boardId)
        .map((r: any) => ({ from: r.from_id, to: r.to_id }));
    },
    parentsOf(id: number): Idea[] {
      return db
        .prepare(`${IDEA_SELECT} JOIN edges e ON i.id = e.from_id WHERE e.to_id = ? ORDER BY i.id`)
        .all(id)
        .map(ideaFromRow);
    },
    /** Ancestors, nearest first. Spin-off roots link back to the original idea. */
    lineage(id: number, max = 12): Idea[] {
      const out: Idea[] = [];
      const seen = new Set([id]);
      const queue = [id];
      while (queue.length && out.length < max) {
        const cur = repo.getIdea(queue.shift()!);
        if (!cur) continue;
        const next = [...repo.parentsOf(cur.id)];
        if (cur.originIdeaId) {
          const origin = repo.getIdea(cur.originIdeaId);
          if (origin) next.push(origin);
        }
        for (const p of next) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
          queue.push(p.id);
        }
      }
      return out.slice(0, max);
    },

    // ---- scouts
    claimScout(source: string, time: number, interval: number) {
      return db.prepare(`
        INSERT INTO scout_runs (source, started_at) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET started_at = excluded.started_at WHERE started_at <= ?
      `).run(source, time, time - interval).changes > 0;
    },
    recordScoutError(source: string, error: string, time: number) {
      db.prepare(`
        INSERT INTO scout_runs (source, started_at, last_error) VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET last_error = excluded.last_error
      `).run(source, time, error.slice(0, 300));
    },
    clearScoutError(source: string) {
      db.prepare('UPDATE scout_runs SET last_error = NULL WHERE source = ?').run(source);
    },
    listScoutRuns(): { source: string; startedAt: number; lastError: string | null }[] {
      return db.prepare('SELECT source, started_at, last_error FROM scout_runs ORDER BY source').all().map((r: any) => ({
        source: r.source,
        startedAt: r.started_at,
        lastError: r.last_error ?? null,
      }));
    },
    addFinds(drafts: (Find & { score?: number })[], time: number): StoredFind[] {
      const insert = db.prepare(`
        INSERT INTO finds (source, external_id, title, url, summary, first_seen, score) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, external_id) DO NOTHING RETURNING *
      `);
      return tx(() => {
        const added: StoredFind[] = [];
        for (const draft of drafts) {
          const urlOk = draft.source === 'sessions' ? typeof draft.url === 'string' : /^https?:\/\//i.test(draft.url);
          if (!draft.externalId || !draft.title || !urlOk) continue;
          const score = typeof draft.score === 'number' && Number.isFinite(draft.score) && draft.score >= 0 && draft.score <= 1
            ? draft.score
            : null;
          const row = insert.get(draft.source, draft.externalId, draft.title, draft.url, draft.summary.slice(0, 1200), time, score);
          if (row) added.push(findFromRow(row));
        }
        return added;
      });
    },
    /** Finds still unscored (a failed or interrupted filter run) first seen at or after `since`. */
    unscoredFinds(since: number): StoredFind[] {
      return db.prepare(`
        SELECT * FROM finds WHERE score IS NULL AND source != 'sessions' AND first_seen >= ? ORDER BY id
      `).all(since).map(findFromRow);
    },
    getFind(id: number): StoredFind | null {
      const row = db.prepare('SELECT * FROM finds WHERE id = ?').get(id);
      return row ? findFromRow(row) : null;
    },
    latestFinds(): StoredFind[] {
      return db.prepare(`
        SELECT * FROM (
          SELECT finds.*, ROW_NUMBER() OVER (PARTITION BY source ORDER BY first_seen DESC, id DESC) AS rank
          FROM finds
        ) WHERE rank <= 30 ORDER BY source, first_seen DESC, id DESC
      `).all().map(findFromRow);
    },
    saveFindScores(scores: Map<number, number>) {
      const update = db.prepare('UPDATE finds SET score = ? WHERE id = ? AND score IS NULL');
      tx(() => {
        for (const [id, score] of scores) update.run(score, id);
      });
    },
    pruneFinds(cutoff: number) {
      return db.prepare('DELETE FROM finds WHERE first_seen <= ?').run(cutoff).changes;
    },
    seedableFinds(threshold: number, count: number): StoredFind[] {
      // Best find of each source first, then each source's second best, and so on,
      // so one strong source cannot fill every seed slot (cross-pollination needs variety).
      // Each source's single best find also counts from SOURCE_BEST_FLOOR, so a source whose finds
      // rarely clear the threshold (news) still takes part.
      return db.prepare(`
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY score DESC, id) AS rank_in_source
          FROM finds WHERE score >= ? AND seeded_idea_id IS NULL
        ) WHERE score >= ? OR rank_in_source = 1
        ORDER BY rank_in_source, score DESC, id LIMIT ?
      `).all(Math.min(threshold, SOURCE_BEST_FLOOR), threshold, count).map(findFromRow);
    },
    seedFind(boardId: number, id: number, at: { x: number; y: number }) {
      return tx(() => {
        const find = repo.getFind(id);
        if (!find || find.seededIdeaId !== null) return null;
        const idea = insertIdeaRow({
          boardId, title: find.title, pitch: find.summary.slice(0, 600), kind: 'seed',
          sourceUrl: find.url || null, seedSource: find.source, generation: 0, ...at,
        }, []);
        db.prepare('UPDATE finds SET seeded_idea_id = ? WHERE id = ?').run(idea.id, id);
        return { idea, find: { ...find, seededIdeaId: idea.id } };
      });
    },

    // ---- leads
    listLeads(boardId: number): Lead[] {
      return db.prepare('SELECT * FROM leads WHERE board_id = ? ORDER BY source, id').all(boardId).map(leadFromRow);
    },
    getLead(id: number): Lead | null {
      const r = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
      return r ? leadFromRow(r) : null;
    },
    /** A refresh replaces the unused leads of that source; used ones stay as history. */
    replaceLeads(boardId: number, source: Lead['source'], drafts: { title: string; summary: string; hook: string; url: string; meta: object }[]) {
      tx(() => {
        db.prepare('DELETE FROM leads WHERE board_id = ? AND source = ? AND idea_id IS NULL').run(boardId, source);
        const ins = db.prepare('INSERT INTO leads (board_id, source, title, summary, hook, url, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const d of drafts) ins.run(boardId, source, d.title, d.summary, d.hook, d.url, JSON.stringify(d.meta ?? {}));
      });
      return repo.listLeads(boardId).filter((l) => l.source === source);
    },
    markLeadUsed(id: number, ideaId: number) {
      db.prepare('UPDATE leads SET idea_id = ? WHERE id = ?').run(ideaId, id);
      return repo.getLead(id);
    },
    deleteLead(id: number) {
      return db.prepare('DELETE FROM leads WHERE id = ?').run(id).changes > 0;
    },

    // ---- templates
    listTemplates(): Template[] {
      return (db.prepare('SELECT * FROM templates ORDER BY sort, id').all() as Template[]).map(templateFromRow);
    },
    getTemplate(id: number | null): Template {
      const r = id == null ? null : db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
      return templateFromRow((r ?? db.prepare('SELECT * FROM templates ORDER BY sort, id LIMIT 1').get()) as Template);
    },
    createTemplate(t: Omit<Template, 'id' | 'sort'>): Template {
      const sort = ((db.prepare('SELECT MAX(sort) AS s FROM templates').get() as any).s ?? 0) + 1;
      const { lastInsertRowid } = db
        .prepare('INSERT INTO templates (name, system, expand, combine, sort) VALUES (?, ?, ?, ?, ?)')
        .run(t.name, t.system, t.expand, t.combine, sort);
      return repo.getTemplate(Number(lastInsertRowid));
    },
    updateTemplate(id: number, t: Omit<Template, 'id' | 'sort'>) {
      db.prepare('UPDATE templates SET name = ?, system = ?, expand = ?, combine = ? WHERE id = ?').run(t.name, t.system, t.expand, t.combine, id);
      return repo.getTemplate(id);
    },
    deleteTemplate(id: number) {
      if ((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as any).n <= 1) return false;
      return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
    },

    // ---- report: insights, ideas and projects across all boards
    /**
     * Everything the report window shows for the last `days` days: totals,
     * every Claude Code project, and per board its goal, summary, best ideas.
     */
    report(days = 30) {
      const since = `-${days} days`;
      const boards = repo.listBoards();
      const ideas = (db.prepare(`${IDEA_SELECT} ORDER BY i.id`).all() as any[]).map(ideaFromRow);
      const recentIds = new Set(
        (db.prepare(`SELECT id FROM ideas WHERE created_at >= datetime('now', ?)`).all(since) as any[]).map((r) => r.id),
      );
      const sum = (i: Idea) => (i.originality == null ? null : i.originality + i.feasibility! + i.impact!);
      const medalOf = (i: Idea) => {
        if (i.medalOverride != null) return i.medalOverride;
        const s = sum(i);
        return s == null ? null : s >= 13 ? 3 : s >= 11 ? 2 : s >= 9 ? 1 : 0;
      };
      const rank = (x: Idea, y: Idea) => (sum(y) ?? -1) - (sum(x) ?? -1) || y.id - x.id;
      const brief = (i: Idea) => ({ id: i.id, boardId: i.boardId, title: i.title, pitch: i.pitch, sum: sum(i), medal: medalOf(i), reason: i.reason, kind: i.kind, originality: i.originality, feasibility: i.feasibility, impact: i.impact });
      const title = new Map(boards.map((b) => [b.id, b.title]));
      const projects = ideas
        .filter((i) => i.projectPath)
        .map((i) => ({ ...brief(i), boardTitle: title.get(i.boardId) ?? '', path: i.projectPath! }));
      const medals = { gold: 0, silver: 0, bronze: 0 };
      for (const i of ideas) {
        const m = medalOf(i);
        if (m === 3) medals.gold++;
        else if (m === 2) medals.silver++;
        else if (m === 1) medals.bronze++;
      }
      const spent: any = db.prepare(`SELECT SUM(usd) AS usd FROM spend WHERE day >= ?`).get(localDay(new Date(Date.now() - (days - 1) * 86_400_000)));
      const latest: any = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get();
      return {
        days,
        totals: {
          boards: boards.length,
          ideas: ideas.length,
          newIdeas: recentIds.size,
          judged: ideas.filter((i) => i.judgedAt).length,
          medals,
          projects: projects.length,
          spentUsd: Math.round((spent?.usd ?? 0) * 10000) / 10000,
        },
        projects,
        boards: boards.map((b) => {
          const own = ideas.filter((i) => i.boardId === b.id);
          return {
            id: b.id, title: b.title, goal: b.goal, mode: b.config.mode,
            ideaCount: own.length, newIdeas: own.filter((i) => recentIds.has(i.id)).length,
            best: own.filter((i) => sum(i) != null || i.medalOverride != null).sort(rank).slice(0, 3).map(brief),
            summary: b.summary ? { ...b.summary, stale: b.summary.ideaCount !== own.length } : null,
            projects: projects.filter((p) => p.boardId === b.id),
          };
        }),
        synthesis: latest ? { ...parseJson(latest.content), days: latest.days, createdAt: latest.created_at } : null,
      };
    },
    saveSynthesis(days: number, content: object) {
      db.prepare('INSERT INTO reports (days, lang, content) VALUES (?, ?, ?)').run(days, 'en', JSON.stringify(content));
    },

    // ---- spend ledger (per board, per local day)
    addSpend(boardId: number, usd: number, day = localDay()) {
      db.prepare(
        `INSERT INTO spend (board_id, day, usd, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT(board_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      ).run(boardId, day, usd > 0 ? usd : 0);
    },
    spentOn(boardId: number | null, day = localDay()): number {
      const r: any =
        boardId == null
          ? db.prepare('SELECT SUM(usd) AS usd FROM spend WHERE day = ?').get(day)
          : db.prepare('SELECT usd FROM spend WHERE board_id = ? AND day = ?').get(boardId, day);
      return r?.usd ?? 0;
    },
    spentTotal(): { usd: number; calls: number } {
      const r: any = db.prepare('SELECT SUM(usd) AS usd, SUM(calls) AS calls FROM spend').get();
      return { usd: r?.usd ?? 0, calls: r?.calls ?? 0 };
    },

    // ---- crew daily call quota
    addCrewCall(day = localDay()) {
      db.prepare(
        `INSERT INTO crew_usage (day, calls) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET calls = calls + 1`,
      ).run(day);
    },
    crewCallsOn(day = localDay()): number {
      const r: any = db.prepare('SELECT calls FROM crew_usage WHERE day = ?').get(day);
      return r?.calls ?? 0;
    },
  };
  return repo;
}

export type Repo = ReturnType<typeof openDb>;

/** YYYY-MM-DD in local time: budgets reset at local midnight. */
/** A source's best unseeded find may seed from this score even below the seed threshold. */
export const SOURCE_BEST_FLOOR = 0.4;

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
