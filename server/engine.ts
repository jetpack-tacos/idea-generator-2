// The engine: every operation on boards and ideas, used by both the HTTP routes
// and the autopilot. New ideas are judged in the background (a small queue),
// even on boards nobody has open. Every change
// is published on a per-board bus that the browser follows over SSE.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Repo, Idea, Board, StoredFind } from './db.ts';
import { makeLLM } from './llm.ts';
import { asUrl, fetchPage as realFetchPage } from './extract.ts';
import { fetchPapers as realFetchPapers, researchLeads, xLeads } from './leads.ts';
import { writeBrief, writeProject } from './project.ts';
import { researchScores } from './scouts/filter.ts';
import { ProviderError, type AppSettings, type ChatFn, type Role } from './providers.ts';
import { fitness, isJudged, medal, scoreSum } from '../public/js/score.js';
import { nextMove } from '../public/js/evolve.js';

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type BoardEvent = { type: string; [k: string]: unknown };
export function createBus() {
  const subs = new Map<number, Set<(e: BoardEvent) => void>>();
  return {
    on(boardId: number, fn: (e: BoardEvent) => void) {
      if (!subs.has(boardId)) subs.set(boardId, new Set());
      subs.get(boardId)!.add(fn);
      return () => subs.get(boardId)?.delete(fn);
    },
    emit(boardId: number, e: BoardEvent) {
      for (const fn of subs.get(boardId) ?? []) {
        try {
          fn(e);
        } catch {
          /* a dead subscriber must not break the others */
        }
      }
    },
  };
}

/** Arc of n children pointing away from where the parent came from. */
export function arcPositions(parent: Idea, grandparent: Idea | null, n: number) {
  const dir = grandparent ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x) : Math.random() * Math.PI * 2;
  const spread = grandparent ? (Math.PI * 2) / 3 : Math.PI * 2;
  return Array.from({ length: n }, (_, i) => {
    const a = grandparent ? dir - spread / 2 + (spread * (i + 0.5)) / n : dir + (spread * i) / n;
    return { x: parent.x + Math.cos(a) * 190, y: parent.y + Math.sin(a) * 190 };
  });
}

/** Where a lead lands: just right of what is already on the board. */
function besideBoard(ideas: Idea[]) {
  if (!ideas.length) return { x: 0, y: 0 };
  const maxX = Math.max(...ideas.map((i) => i.x));
  const meanY = ideas.reduce((s, i) => s + i.y, 0) / ideas.length;
  return { x: maxX + 240, y: meanY + (Math.random() - 0.5) * 160 };
}

type Deps = {
  repo: Repo;
  chat: ChatFn;
  settings: () => AppSettings;
  fetchPage?: typeof realFetchPage;
  fetchPapers?: typeof realFetchPapers;
  reveal?: (path: string) => void;
  gitInit?: boolean;
};

export function createEngine(deps: Deps) {
  const { repo } = deps;
  const fetchPage = deps.fetchPage ?? realFetchPage;
  const fetchPapers = deps.fetchPapers ?? realFetchPapers;
  const reveal = deps.reveal ?? ((p: string) => {
    const command = { win32: 'explorer.exe', darwin: 'open' }[process.platform as 'win32' | 'darwin'] ?? 'xdg-open';
    execFile(command, [p], () => {});
  });
  const bus = createBus();
  const judging = new Set<number>();

  const mustBoard = (id: number) => {
    const b = repo.getBoard(id);
    if (!b) throw new AppError(404, 'not_found', 'Board not found');
    return b;
  };
  const mustIdea = (id: number) => {
    const i = repo.getIdea(id);
    if (!i) throw new AppError(404, 'not_found', 'Idea not found');
    return i;
  };
  const modelFor = (board: Board, role: Role) => board.config.models[role] || deps.settings().models[role];
  const titles = (boardId: number) => repo.listIdeas(boardId).map((i) => i.title);
  const emitIdeas = (boardId: number, ideas: Idea[]) => ideas.length && bus.emit(boardId, { type: 'ideas', ideas });
  const seedPosition = (boardId: number, at: { x?: number; y?: number }) =>
    Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x!, y: at.y! } : besideBoard(repo.listIdeas(boardId));

  function publishFinds() {
    const finds = repo.latestFinds();
    for (const board of repo.listBoards()) bus.emit(board.id, { type: 'finds', finds });
  }

  async function call<T>(boardId: number, role: Role, fn: (llm: ReturnType<typeof makeLLM>, chat: ChatFn) => Promise<T>): Promise<T> {
    const chat: ChatFn = async (request) => {
      let recorded = false;
      const result = await deps.chat({
        ...request, boardId: boardId || undefined, role,
        onUsage(usage) {
          recorded = true;
          repo.addSpend(boardId, usage.costUsd);
        },
      });
      if (!recorded) repo.addSpend(boardId, result.costUsd);
      return result;
    };
    try {
      return await fn(makeLLM(chat), chat);
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, e instanceof ProviderError ? e.code : 'llm_failed', e?.message ?? String(e));
    }
  }

  // ---------------------------------------------------------------- judging

  function setJudging(boardId: number, ids: number[], on: boolean) {
    for (const id of ids) on ? judging.add(id) : judging.delete(id);
    bus.emit(boardId, { type: 'judging', ids, on });
  }

  async function makeProject(requested: Idea) {
    const idea = mustIdea(requested.id);
    if (idea.projectPath && existsSync(idea.projectPath)) return { idea, path: idea.projectPath, existed: true };
    const board = mustBoard(idea.boardId);
    const lineage = repo.lineage(idea.id);

    const { brief } = await call(board.id, 'brief', (_llm, chat) => writeBrief({ chat, model: modelFor(board, 'brief'), idea, goal: board.goal, lineage }));
    let path: string;
    try {
      path = await writeProject({ root: deps.settings().projectsRoot, brief, idea, goal: board.goal, lineage, boardTitle: board.title, gitInit: deps.gitInit });
    } catch (e: any) {
      throw new AppError(500, 'project_failed', e?.message ?? String(e));
    }
    const saved = repo.setProjectPath(idea.id, path)!;
    emitIdeas(board.id, [saved]);
    return { idea: saved, path, existed: false };
  }

  const projectsInProgress = new Map<number, ReturnType<typeof makeProject>>();
  function createProject(idea: Idea) {
    let pending = projectsInProgress.get(idea.id);
    if (!pending) {
      pending = makeProject(idea).finally(() => projectsInProgress.delete(idea.id));
      projectsInProgress.set(idea.id, pending);
    }
    return pending;
  }

  async function judge(ideaId: number) {
    const idea = mustIdea(ideaId);
    const board = mustBoard(idea.boardId);
    setJudging(board.id, [idea.id], true);
    try {
      const { judgement } = await call(board.id, 'judge', (llm) =>
        llm.judge({
          model: modelFor(board, 'judge'), board, idea,
          guidance: board.config.judgeGuidance, vocabulary: repo.keywordVocabulary(),
        }),
      );
      repo.saveJudgement(idea.id, judgement);
      const out: { idea: Idea; project?: string; projectError?: string } = { idea: repo.setKeywords(idea.id, judgement.keywords)! };
      // The judge itself turns gold into a Claude Code project, if the board allows it.
      if (board.config.autoProjectOnGold && medal(out.idea) === 3 && !out.idea.projectPath) {
        try {
          const p = await createProject(out.idea);
          out.idea = p.idea;
          out.project = p.path;
          bus.emit(board.id, { type: 'project', ideaId: idea.id, path: p.path, byJudge: true });
        } catch (e: any) {
          out.projectError = e?.message ?? String(e);
        }
      }
      emitIdeas(board.id, [out.idea]);
      return out;
    } finally {
      setJudging(board.id, [idea.id], false);
    }
  }

  // Background queue: at most three judgements at once.
  const queue: number[] = [];
  let active = 0;
  let idleWaiters: (() => void)[] = [];
  function pump() {
    while (active < 3 && queue.length) {
      const id = queue.shift()!;
      active++;
      judge(id)
        .catch((e: any) => {
          const boardId = repo.getIdea(id)?.boardId;
          if (boardId) bus.emit(boardId, { type: 'error', code: e?.code ?? 'judge_failed', message: e?.message ?? String(e), ideaId: id });
        })
        .finally(() => {
          active--;
          pump();
          if (!active && !queue.length) {
            idleWaiters.forEach((f) => f());
            idleWaiters = [];
          }
        });
    }
  }
  function queueJudge(ids: number[]) {
    for (const id of ids) if (!judging.has(id) && !queue.includes(id)) queue.push(id);
    pump();
  }
  /** Resolves when no judgement is queued or running (tests, shutdown). */
  const idle = () => (active || queue.length ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve());

  // ---------------------------------------------------------------- creating ideas

  async function doExpand(parentId: number) {
    const parent = mustIdea(parentId);
    const board = mustBoard(parent.boardId);
    const { ideas } = await call(board.id, 'expand', (llm) =>
        llm.expand({ model: modelFor(board, 'expand'), flow: board.config.flow, board, idea: parent, existingTitles: titles(board.id) }),
    );
    const spots = arcPositions(parent, repo.parentsOf(parent.id)[0] ?? null, ideas.length);
    const created = ideas.map((i, n) =>
      repo.insertIdea({ boardId: board.id, ...i, kind: 'expand', x: spots[n].x, y: spots[n].y, generation: parent.generation + 1 }, [parent.id]),
    );
    const edges = created.map((c) => ({ from: parent.id, to: c.id }));
    emitIdeas(board.id, created);
    bus.emit(board.id, { type: 'edges', edges });
    return { ideas: created, edges };
  }

  async function doCombine(boardId: number, aId: number, bId: number) {
    const board = mustBoard(boardId);
    if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId === bId) throw new AppError(400, 'bad_pair', 'Pick two different ideas');
    const a = mustIdea(aId);
    const c = mustIdea(bId);
    if (a.boardId !== board.id || c.boardId !== board.id) throw new AppError(400, 'bad_pair', 'Ideas belong to another board');
    const { idea } = await call(board.id, 'combine', (llm) =>
        llm.combine({ model: modelFor(board, 'combine'), flow: board.config.flow, board, a, b: c, existingTitles: titles(board.id) }),
    );
    const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy) || 1; // midpoint, nudged off the line
    const created = repo.insertIdea(
      {
        boardId: board.id, ...idea, kind: 'combine',
        x: (a.x + c.x) / 2 + (-dy / len) * 70, y: (a.y + c.y) / 2 + (dx / len) * 70,
        generation: Math.max(a.generation, c.generation) + 1,
      },
      [a.id, c.id],
    );
    const edges = [{ from: a.id, to: created.id }, { from: c.id, to: created.id }];
    emitIdeas(board.id, [created]);
    bus.emit(board.id, { type: 'edges', edges });
    return { idea: created, edges };
  }

  return {
    bus,
    judging,
    idle,
    queueJudge,
    modelFor,

    async seed(boardId: number, b: { text: string; x?: number; y?: number }) {
      const board = mustBoard(boardId);
      const text = String(b.text ?? '').trim().slice(0, 20_000);
      if (!text) throw new AppError(400, 'empty', 'Write an idea or paste a link');

      const flow = board.config.flow;
      const url = asUrl(text);
      let title = text.slice(0, 120);
      let pitch = '';
      let sourceUrl: string | null = null;
      if (url) {
        let page;
        try {
          page = await fetchPage(url);
        } catch (e: any) {
          throw new AppError(422, 'url_unreadable', `${url}: ${e?.message ?? e}`);
        }
        if (page.text.length < 80) throw new AppError(422, 'url_no_text', `${url}: too little readable text`);
        const { idea } = await call(board.id, 'distill', (llm) =>
        llm.distill({ model: modelFor(board, 'distill'), flow, board, text: [page.title, page.text].filter(Boolean).join('\n\n'), url }),
        );
        ({ title, pitch } = idea);
        sourceUrl = url;
      } else if (text.length > 160) {
        const { idea } = await call(board.id, 'distill', (llm) =>
        llm.distill({ model: modelFor(board, 'distill'), flow, board, text }));
        ({ title, pitch } = idea);
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const idea = repo.insertIdea({ boardId: board.id, title, pitch, kind: 'seed', sourceUrl, x: num(b.x), y: num(b.y), generation: 0 });
      emitIdeas(board.id, [idea]);
      queueJudge([idea.id]);
      return { idea };
    },

    async expand(ideaId: number) {
      const out = await doExpand(ideaId);
      queueJudge(out.ideas.map((i) => i.id));
      return out;
    },

    async combine(boardId: number, aId: number, bId: number) {
      const out = await doCombine(boardId, aId, bId);
      queueJudge([out.idea.id]);
      return out;
    },

    judge,
    createProject: (ideaId: number) => createProject(mustIdea(ideaId)),

    reveal(ideaId: number) {
      const idea = mustIdea(ideaId);
      if (!idea.projectPath || !existsSync(idea.projectPath)) throw new AppError(404, 'no_project', 'The project folder is gone');
      reveal(idea.projectPath);
      return { ok: true };
    },

    setMedal(ideaId: number, m: unknown) {
      mustIdea(ideaId);
      if (m !== null && !(Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 3)) {
        throw new AppError(400, 'bad_request', 'medalOverride is 0–3 or null');
      }
      const idea = repo.setMedalOverride(ideaId, m as number | null)!;
      emitIdeas(idea.boardId, [idea]);
      return { idea };
    },

    deleteIdea(ideaId: number) {
      const idea = repo.getIdea(ideaId);
      const ok = repo.deleteIdea(ideaId);
      if (idea) bus.emit(idea.boardId, { type: 'removed', ids: [ideaId] });
      return { ok };
    },

    /** Spin an idea off into its own board, to refine it in its own context. */
    spinoff(ideaId: number) {
      const idea = mustIdea(ideaId);
      const parent = mustBoard(idea.boardId);
      const goal = (idea.pitch ? `${idea.title}: ${idea.pitch}` : idea.title).slice(0, 600);
      const board = repo.createBoard({ title: idea.title.slice(0, 120), goal, config: { ...parent.config, mode: 'manual' }, originIdeaId: idea.id });
      const root = repo.insertIdea({
        boardId: board.id, title: idea.title, pitch: idea.pitch, kind: 'seed', sourceUrl: idea.sourceUrl, seedSource: idea.seedSource,
        x: 0, y: 0, generation: 0, originIdeaId: idea.id, originBoardId: idea.boardId,
      });
      bus.emit(parent.id, { type: 'spinoff', ideaId: idea.id, boardId: board.id, title: board.title });
      queueJudge([root.id]);
      return { board: repo.getBoard(board.id), idea: root };
    },

    updateBoard(boardId: number, patch: { title?: string; goal?: string; config?: unknown }) {
      mustBoard(boardId);
      const board = repo.updateBoard(boardId, patch)!;
      bus.emit(boardId, { type: 'board', board });
      return { board };
    },

    async summarize(boardId: number) {
      const board = mustBoard(boardId);
      const ideas = repo
        .listIdeas(board.id)
        .sort((x, y) => (fitness(y) ?? -1) - (fitness(x) ?? -1))
        .map((i) => ({ title: i.title, pitch: i.pitch, kind: i.kind, sum: scoreSum(i), reason: i.reason }));
      if (ideas.length < 2) throw new AppError(400, 'too_few', 'A summary needs at least two ideas');

      const { summary } = await call(board.id, 'summary', (llm) =>
        llm.summarize({ model: modelFor(board, 'summary'), board, ideas }));
      const saved = repo.setSummary(board.id, { ...summary, ideaCount: ideas.length, createdAt: new Date().toISOString() })!;
      bus.emit(board.id, { type: 'board', board: saved });
      return { board: saved };
    },

    /** The report's conclusions across every board, saved so the window opens instantly. */
    async synthesize(days: number) {
      const report = repo.report(days);
      const boards = report.boards.filter((b) => b.ideaCount);
      if (!boards.length) throw new AppError(400, 'too_few', 'There are no ideas to report on yet');
      const { synthesis } = await call(0, 'summary', (llm) =>
        llm.synthesize({
          model: deps.settings().models.summary, days,
          boards: boards.map((b) => ({
            title: b.title, goal: b.goal, summary: b.summary?.headline ?? '',
            best: b.best.map((i) => ({ title: i.title, pitch: i.pitch, sum: i.sum })),
            projects: b.projects.map((p) => p.title),
          })),
        }),
      );
      repo.saveSynthesis(days, synthesis);
      return repo.report(days);
    },

    // ---- leads: each board's own researchers
    async refreshLeads(boardId: number, source: 'x' | 'research') {
      const board = mustBoard(boardId);

      const focus = board.config.researchers[source].focus;
      const topic = [board.goal, focus].filter(Boolean).join(' — ');
      let r: { leads: any[]; dropped?: number };
      if (source === 'x') {
        if (!modelFor(board, 'x')) throw new AppError(400, 'scout_disabled', 'Choose an X scout model first');
        r = await call(board.id, 'x', (_llm, chat) => xLeads({ chat, model: modelFor(board, 'x'), goal: topic }));
      } else {
        let papers;
        try {
          papers = await fetchPapers(focus || board.goal);
        } catch (e: any) {
          throw new AppError(502, 'research_failed', e?.message ?? String(e));
        }
        r = await call(board.id, 'research', (_llm, chat) => researchLeads({ chat, model: modelFor(board, 'research'), goal: topic, papers }));
      }
      // Nothing verified: keep the old leads rather than wiping the panel.
      const leads = r.leads.length ? repo.replaceLeads(board.id, source, r.leads) : repo.listLeads(board.id).filter((l) => l.source === source);
      bus.emit(board.id, { type: 'leads', source, leads });
      return { leads, dropped: r.dropped ?? 0, empty: !r.leads.length };
    },

    seedLead(leadId: number, at: { x?: number; y?: number }) {
      const lead = repo.getLead(leadId);
      if (!lead) throw new AppError(404, 'not_found', 'Lead not found');
      const pos = seedPosition(lead.boardId, at);
      const idea = repo.insertIdea({
        boardId: lead.boardId, title: lead.title, pitch: [lead.summary, lead.hook].filter(Boolean).join(' ').slice(0, 600),
        kind: 'seed', sourceUrl: lead.url, seedSource: lead.source === 'research' ? 'papers' : lead.source,
        ...pos, generation: 0,
      });
      const used = repo.markLeadUsed(lead.id, idea.id)!;
      emitIdeas(lead.boardId, [idea]);
      bus.emit(lead.boardId, { type: 'leads', source: lead.source, leads: repo.listLeads(lead.boardId).filter((l) => l.source === lead.source) });
      queueJudge([idea.id]);
      return { idea, lead: used };
    },

    publishFinds,

    scoreFinds(board: Board | undefined, context: string, finds: StoredFind[]) {
      const model = board ? modelFor(board, 'research') : deps.settings().models.research;
      return call(board?.id ?? 0, 'research', (_llm, chat) => researchScores(chat, model, context, finds));
    },

    seedFind(boardId: number, id: number, at: { x?: number; y?: number }, manual = true) {
      mustBoard(boardId);
      if (!repo.getFind(id)) throw new AppError(404, 'not_found', 'Find not found');
      const result = repo.seedFind(boardId, id, seedPosition(boardId, at));
      if (!result) throw new AppError(409, 'already_seeded', 'This find has already been seeded');
      emitIdeas(boardId, [result.idea]);
      if (manual) {
        publishFinds();
        queueJudge([result.idea.id]);
      }
      return result;
    },

    /**
     * One autopilot step: judge what is unjudged, otherwise breed (combine by
     * tournament selection) or mutate (expand a strong idea). Awaits its own
     * judgements so the next step sees the scores.
     */
    async autoStep(boardId: number): Promise<{ did: 'idle' | 'judge' | 'expand' | 'combine'; reason?: string; ids?: number[] }> {
      mustBoard(boardId);
      const ideas = repo.listIdeas(boardId);
      if (!ideas.length) return { did: 'idle', reason: 'empty' };
      const judgeAll = async (ids: number[]) => {
        const results = await Promise.allSettled(ids.map((id) => judge(id)));
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
      };
      const unjudged = ideas.filter((i) => !isJudged(i) && i.medalOverride == null && !judging.has(i.id)).slice(0, 3);
      if (unjudged.length) {
        await judgeAll(unjudged.map((i) => i.id));
        return { did: 'judge', ids: unjudged.map((i) => i.id) };
      }
      const move = nextMove(ideas, repo.listEdges(boardId), { busy: judging });
      if (!move) return { did: 'idle', reason: 'nothing_to_do' };
      if (move.type === 'expand') {
        const r = await doExpand(move.idea.id);
        await judgeAll(r.ideas.map((i) => i.id));
        return { did: 'expand', ids: r.ideas.map((i) => i.id) };
      }
      const r = await doCombine(boardId, move.a.id, move.b.id);
      await judgeAll([r.idea.id]);
      return { did: 'combine', ids: [r.idea.id] };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
