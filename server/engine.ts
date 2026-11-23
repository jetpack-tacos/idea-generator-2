// The engine: every operation on boards and ideas, used by both the HTTP routes
// and the autopilot. New ideas are judged in the background (a small queue),
// even on boards nobody has open. Every change
// is published on a per-board bus that the browser follows over SSE.

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { activeHoursUntil } from './autopilot.ts';
import { localDay, type Repo, type Idea, type Board, type StoredFind } from './db.ts';
import { makeLLM, overusedKeywords } from './llm.ts';
import { asUrl, fetchPage as realFetchPage } from './extract.ts';
import { fetchPapers as realFetchPapers, researchLeads, xLeads } from './leads.ts';
import { writeBrief, writeProject } from './project.ts';
import { researchScores } from './scouts/filter.ts';
import { checkIdeaExists } from './exists.ts';
import { sendAlert } from './alert.ts';
import { isCrewModel, ProviderError, type AppSettings, type ChatFn, type Role } from './providers.ts';
import { fitness, isJudged, medal, scoreSum } from '../public/js/score.js';
import { nextMove } from '../public/js/evolve.js';

/** Unused seeds the autopilot keeps waiting on the board, so crosses keep bringing in new finds. */
export const FRESH_SEEDS_MIN = 3;

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

/** Pick up to 8 best judged seeds and ideas, covering >= 3 distinct sources when available. */
export function selectDeepCrossCandidates(ideas: Idea[], edges: { from: number; to: number }[]) {
  const judged = ideas
    .filter((i) => isJudged(i))
    .sort((a, b) => (scoreSum(b) ?? 0) - (scoreSum(a) ?? 0) || b.id - a.id);
  if (judged.length < 2) return [];

  const byId = new Map(ideas.map((i) => [i.id, i]));
  const parents = new Map<number, number[]>();
  for (const e of edges) {
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to)!.push(e.from);
  }
  const cache = new Map<number, Set<string>>();
  function sourcesOf(id: number): Set<string> {
    if (cache.has(id)) return cache.get(id)!;
    const out = new Set<string>();
    const seen = new Set<number>();
    const stack = [id];
    while (stack.length) {
      const curId = stack.pop()!;
      if (seen.has(curId)) continue;
      seen.add(curId);
      const item = byId.get(curId);
      if (!item) continue;
      if (item.seedSource) out.add(item.seedSource);
      else if (item.kind === 'seed' && item.generation === 0) out.add('manual');
      for (const pid of parents.get(curId) ?? []) stack.push(pid);
    }
    if (!out.size) out.add('manual');
    cache.set(id, out);
    return out;
  }

  const picked: Idea[] = [];
  const pickedIds = new Set<number>();
  const coveredSources = new Set<string>();

  // Pass 1: maximize source diversity (at least 3 sources when the board has them).
  for (const idea of judged) {
    if (picked.length >= 8) break;
    const srcs = sourcesOf(idea.id);
    const bringsNew = [...srcs].some((s) => !coveredSources.has(s));
    if (bringsNew) {
      picked.push(idea);
      pickedIds.add(idea.id);
      for (const s of srcs) coveredSources.add(s);
    }
  }

  // Pass 2: fill up to 8 with the highest-scoring remaining judged ideas.
  for (const idea of judged) {
    if (picked.length >= 8) break;
    if (pickedIds.has(idea.id)) continue;
    picked.push(idea);
    pickedIds.add(idea.id);
  }

  return picked
    .sort((a, b) => (scoreSum(b) ?? 0) - (scoreSum(a) ?? 0) || b.id - a.id)
    .map((i) => ({
      id: i.id,
      title: i.title,
      pitch: i.pitch,
      source: [...sourcesOf(i.id)].join(', '),
      sum: scoreSum(i),
    }));
}

type Deps = {
  repo: Repo;
  chat: ChatFn;
  settings: () => AppSettings;
  fetchPage?: typeof realFetchPage;
  fetchPapers?: typeof realFetchPapers;
  searchTransport?: typeof fetch;
  alertLogFile?: string;
  reveal?: (path: string) => void;
  gitInit?: boolean;
  now?: () => number;
};

export function createEngine(deps: Deps) {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
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
  /** The board plus the owner's household description, for idea prompts and the jury. */
  // wornKeywords: the keywords overused in the newest ideas, named as worn-out themes in the writing prompts.
  const withHousehold = (board: Board) => ({
    ...board,
    household: deps.settings().interests ?? '',
    wornKeywords: overusedKeywords(repo.listIdeas(board.id).sort((a, b) => a.id - b.id).map((i) => i.keywords ?? [])),
  });
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
      const day = localDay(new Date(now()));
      if (isCrewModel(request.model)) {
        const { crewCallsPerDay, crewPath } = deps.settings();
        if (!crewPath.trim()) {
          throw new ProviderError('no_crew_path', 'Set crewPath in settings.local.json to use crew models');
        }
        if (repo.crewCallsOn(day) >= crewCallsPerDay) {
          throw new ProviderError('crew_cap', `Daily crew limit (${crewCallsPerDay}) reached; resumes tomorrow`);
        }
        repo.addCrewCall(day);
      } else {
        const isFree = /:free$/i.test(request.model);
        const globalLimit = deps.settings().maxUsdPerDay;
        const globalSpent = repo.spentOn(null, day);
        if ((globalSpent > 0 && globalSpent >= globalLimit) || (globalLimit <= 0 && !isFree)) {
          throw new AppError(429, 'global_budget', 'Daily global budget reached; resumes tomorrow');
        }
        if (boardId > 0) {
          const board = repo.getBoard(boardId);
          if (board) {
            const boardLimit = board.config.rate.usdPerDay;
            const boardSpent = repo.spentOn(boardId, day);
            if ((boardSpent > 0 && boardSpent >= boardLimit) || (boardLimit <= 0 && !isFree)) {
              throw new AppError(429, 'board_budget', 'Board daily budget reached; resumes tomorrow');
            }
          }
        }
      }
      let recorded = false;
      const result = await deps.chat({
        ...request, boardId: boardId || undefined, role,
        onUsage(usage) {
          recorded = true;
          repo.addSpend(boardId, usage.costUsd, day);
        },
      });
      if (!recorded) repo.addSpend(boardId, result.costUsd, day);
      return result;
    };
    try {
      return await fn(makeLLM(chat), chat);
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      const status = e instanceof ProviderError && e.code === 'crew_cap' ? 429 : 502;
      throw new AppError(status, e instanceof ProviderError ? e.code : 'llm_failed', e?.message ?? String(e));
    }
  }

  async function sendOrQueueAlert(title: string) {
    if (activeHoursUntil(now(), deps.settings().activeHours) !== null) {
      repo.queueAlert(title, now());
      return;
    }
    await sendAlert(deps.settings().alertCommand, title, { logFile: deps.alertLogFile });
  }

  async function flushAlerts() {
    if (activeHoursUntil(now(), deps.settings().activeHours) !== null) return;
    const pending = repo.takePendingAlerts();
    for (let i = 0; i < pending.length; i++) {
      if (activeHoursUntil(now(), deps.settings().activeHours) !== null) {
        for (let j = i; j < pending.length; j++) repo.queueAlert(pending[j], now());
        break;
      }
      await sendAlert(deps.settings().alertCommand, pending[i], { logFile: deps.alertLogFile });
    }
  }

  // ---------------------------------------------------------------- judging

  function setJudging(boardId: number, ids: number[], on: boolean) {
    for (const id of ids) on ? judging.add(id) : judging.delete(id);
    bus.emit(boardId, { type: 'judging', ids, on });
  }

  async function makeProject(requested: Idea) {
    const idea = mustIdea(requested.id);
    let hasDir = false;
    try {
      hasDir = Boolean(idea.projectPath && statSync(idea.projectPath).isDirectory());
    } catch {
      hasDir = false;
    }
    if (hasDir) return { idea, path: idea.projectPath!, existed: true };
    const board = mustBoard(idea.boardId);
    const lineage = repo.lineage(idea.id);

    const { brief } = await call(board.id, 'brief', (_llm, chat) => writeBrief({ chat, model: modelFor(board, 'brief'), idea, goal: board.goal, lineage }));
    if (!repo.getIdea(idea.id)) throw new AppError(404, 'not_found', 'Idea not found');
    let path: string;
    try {
      path = await writeProject({
        root: deps.settings().projectsRoot,
        brief,
        idea,
        goal: board.goal,
        lineage,
        boardTitle: board.title,
        exists: idea.existsVerdict ? { verdict: idea.existsVerdict, url: idea.existsUrl, reason: idea.existsReason } : null,
        gitInit: deps.gitInit,
      });
    } catch (e: any) {
      throw new AppError(500, 'project_failed', e?.message ?? String(e));
    }
    const saved = repo.setProjectPath(idea.id, path);
    if (!saved) throw new AppError(404, 'not_found', 'Idea not found');
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

  const existsInProgress = new Map<number, Promise<{ idea: Idea; project?: string; projectError?: string; projectErrorCode?: string }>>();

  async function runGoldPipeline(
    board: Board,
    idea: Idea,
  ): Promise<{ idea: Idea; project?: string; projectError?: string; projectErrorCode?: string }> {
    const current = mustIdea(idea.id);
    if (current.projectPath) return { idea: current };
    if (current.existsVerdict === 'exists') return { idea: current };

    let checked = current;
    if (checked.existsVerdict === null) {
      if (checked.existsAttempts >= 3) return { idea: checked };
      try {
        const res = await call(board.id, 'exists', (_llm, chat) =>
          checkIdeaExists({
            chat,
            model: modelFor(board, 'exists'),
            idea: checked,
            goal: board.goal,
            transport: deps.searchTransport,
          }),
        );
        if (!repo.getIdea(checked.id)) throw new AppError(404, 'not_found', 'Idea not found');
        checked = repo.saveExistsResult(checked.id, { verdict: res.verdict, url: res.url, reason: res.reason })!;
        emitIdeas(board.id, [checked]);
      } catch (e: any) {
        if (e?.code === 'not_found') throw e;
        const code = e?.code ?? 'exists_failed';
        if (code === 'crew_cap') {
          bus.emit(board.id, { type: 'crew_paused', role: 'exists', message: e.message });
          return { idea: checked, projectError: e?.message ?? String(e), projectErrorCode: code };
        }
        if (code !== 'global_budget' && code !== 'board_budget') {
          checked = repo.incrementExistsAttempt(checked.id) ?? checked;
          emitIdeas(board.id, [checked]);
        }
        return { idea: checked, projectError: e?.message ?? String(e), projectErrorCode: code };
      }

      if (checked.existsVerdict === 'exists') {
        await sendOrQueueAlert(`Existing tool found: ${checked.title}`);
        return { idea: checked };
      }
    }

    if (checked.briefAttempts >= 3) return { idea: checked };
    try {
      const p = await createProject(checked);
      bus.emit(board.id, { type: 'project', ideaId: checked.id, path: p.path, byJudge: true });
      if (!p.existed) {
        await sendOrQueueAlert(`Gold idea: ${checked.title}`);
      }
      return { idea: p.idea, project: p.path };
    } catch (e: any) {
      if (e?.code === 'not_found') throw e;
      const code = e?.code ?? 'project_failed';
      if (code === 'crew_cap') {
        bus.emit(board.id, { type: 'crew_paused', role: 'brief', message: e.message });
      } else if (code !== 'global_budget' && code !== 'board_budget') {
        checked = repo.incrementBriefAttempt(checked.id) ?? checked;
        emitIdeas(board.id, [checked]);
      }
      return { idea: checked, projectError: e?.message ?? String(e), projectErrorCode: code };
    }
  }

  function handleGold(board: Board, idea: Idea) {
    let pending = existsInProgress.get(idea.id);
    if (!pending) {
      pending = runGoldPipeline(board, idea).finally(() => existsInProgress.delete(idea.id));
      existsInProgress.set(idea.id, pending);
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
          model: modelFor(board, 'judge'), board: withHousehold(board), idea,
          guidance: board.config.judgeGuidance, vocabulary: repo.keywordVocabulary(),
        }),
      );
      if (!repo.getIdea(idea.id)) throw new AppError(404, 'not_found', 'Idea not found');
      repo.saveJudgement(idea.id, judgement);
      const saved = repo.setKeywords(idea.id, judgement.keywords);
      if (!saved) throw new AppError(404, 'not_found', 'Idea not found');
      let out: { idea: Idea; project?: string; projectError?: string; projectErrorCode?: string } = { idea: saved };
      // On gold, check whether the tool already exists before creating a project folder.
      if (board.config.autoProjectOnGold && medal(out.idea) === 3 && !out.idea.projectPath) {
        out = await handleGold(board, out.idea);
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

  async function judgeSequential(ids: number[]): Promise<{ code: string; message: string } | undefined> {
    let firstError: { code: string; message: string } | undefined;
    let anyFatal: unknown;
    let anySuccess = false;
    for (const id of ids) {
      try {
        const out = await judge(id);
        anySuccess = true;
        if (out.projectError && !firstError) {
          firstError = { code: out.projectErrorCode ?? 'gold_failed', message: out.projectError };
        }
      } catch (e: any) {
        if (e?.code === 'not_found') continue;
        if (e?.code === 'crew_cap' || e?.code === 'global_budget' || e?.code === 'board_budget') {
          if (!anySuccess) throw e;
          firstError ??= { code: e.code, message: e.message };
          break;
        }
        anyFatal ??= e;
      }
    }
    if (!anySuccess && anyFatal) throw anyFatal;
    return firstError;
  }

  async function doExpand(parentId: number) {
    const parent = mustIdea(parentId);
    const board = mustBoard(parent.boardId);
    const { ideas } = await call(board.id, 'expand', (llm) =>
      llm.expand({ model: modelFor(board, 'expand'), flow: board.config.flow, board: withHousehold(board), idea: parent, existingTitles: titles(board.id) }),
    );
    const liveParent = repo.getIdea(parent.id);
    if (!liveParent) throw new AppError(404, 'not_found', 'Idea not found');
    const spots = arcPositions(liveParent, repo.parentsOf(liveParent.id)[0] ?? null, ideas.length);
    const created = ideas.map((i, n) =>
      repo.insertIdea({ boardId: board.id, ...i, kind: 'expand', x: spots[n].x, y: spots[n].y, generation: liveParent.generation + 1 }, [liveParent.id]),
    );
    const edges = created.map((c) => ({ from: liveParent.id, to: c.id }));
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
      llm.combine({ model: modelFor(board, 'combine'), flow: board.config.flow, board: withHousehold(board), a, b: c, existingTitles: titles(board.id) }),
    );
    const liveA = repo.getIdea(a.id);
    const liveC = repo.getIdea(c.id);
    if (!liveA || !liveC) throw new AppError(404, 'not_found', 'Idea not found');
    const dx = liveC.x - liveA.x, dy = liveC.y - liveA.y, len = Math.hypot(dx, dy) || 1; // midpoint, nudged off the line
    const created = repo.insertIdea(
      {
        boardId: board.id, ...idea, kind: 'combine',
        x: (liveA.x + liveC.x) / 2 + (-dy / len) * 70, y: (liveA.y + liveC.y) / 2 + (dx / len) * 70,
        generation: Math.max(liveA.generation, liveC.generation) + 1,
      },
      [liveA.id, liveC.id],
    );
    const edges = [{ from: liveA.id, to: created.id }, { from: liveC.id, to: created.id }];
    emitIdeas(board.id, [created]);
    bus.emit(board.id, { type: 'edges', edges });
    return { idea: created, edges };
  }

  async function deepCross(boardId: number): Promise<{ ideas: Idea[]; edges: { from: number; to: number }[]; error?: { code: string; message: string } }> {
    const board = mustBoard(boardId);
    const allIdeas = repo.listIdeas(board.id);
    const allEdges = repo.listEdges(board.id);
    const candidates = selectDeepCrossCandidates(allIdeas, allEdges);
    if (candidates.length < 2) return { ideas: [], edges: [] };

    const { ideas } = await call(board.id, 'deep', (llm) =>
      llm.deepCross({
        model: modelFor(board, 'deep'),
        board: withHousehold(board),
        candidates,
        existingTitles: titles(board.id),
      }),
    );

    if (!repo.getBoard(board.id)) return { ideas: [], edges: [] };
    const liveById = new Map(repo.listIdeas(board.id).map((i) => [i.id, i]));
    const created: Idea[] = [];
    const edges: { from: number; to: number }[] = [];
    ideas.forEach((item, idx) => {
      const liveParentIds = item.parents.filter((pid) => liveById.has(pid));
      const parentIdeas = liveParentIds.map((pid) => liveById.get(pid)!);
      if (parentIdeas.length < 2) return;
      const cx = parentIdeas.reduce((s, p) => s + p.x, 0) / parentIdeas.length;
      const cy = parentIdeas.reduce((s, p) => s + p.y, 0) / parentIdeas.length;
      const angle = (Math.PI * 2 * idx) / Math.max(ideas.length, 1);
      const maxGen = Math.max(...parentIdeas.map((p) => p.generation));
      const idea = repo.insertIdea(
        {
          boardId: board.id,
          title: item.title,
          pitch: item.pitch,
          kind: 'combine',
          x: cx + Math.cos(angle) * 90,
          y: cy + Math.sin(angle) * 90,
          generation: maxGen + 1,
        },
        liveParentIds,
      );
      created.push(idea);
      for (const pid of liveParentIds) edges.push({ from: pid, to: idea.id });
    });

    repo.setDeepCrossDay(board.id, localDay(new Date(now())));
    emitIdeas(board.id, created);
    if (edges.length) bus.emit(board.id, { type: 'edges', edges });

    const error = created.length ? await judgeSequential(created.map((c) => c.id)) : undefined;
    return { ideas: created, edges, ...(error ? { error } : {}) };
  }

  return {
    bus,
    judging,
    idle,
    queueJudge,
    modelFor,
    deepCross,
    flushAlerts,

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
          llm.distill({ model: modelFor(board, 'distill'), flow, board: withHousehold(board), text: [page.title, page.text].filter(Boolean).join('\n\n'), url }),
        );
        ({ title, pitch } = idea);
        sourceUrl = url;
      } else if (text.length > 160) {
        const { idea } = await call(board.id, 'distill', (llm) =>
          llm.distill({ model: modelFor(board, 'distill'), flow, board: withHousehold(board), text }));
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
      let isDir = false;
      try {
        isDir = Boolean(idea.projectPath && statSync(idea.projectPath).isDirectory());
      } catch {
        isDir = false;
      }
      if (!isDir) throw new AppError(404, 'no_project', 'The project folder is gone');
      reveal(idea.projectPath!);
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

    seedFind(boardId: number, id: number, at: { x?: number; y?: number }, manual = true, pitch?: string) {
      mustBoard(boardId);
      if (!repo.getFind(id)) throw new AppError(404, 'not_found', 'Find not found');
      const result = repo.seedFind(boardId, id, seedPosition(boardId, at), pitch);
      if (!result) throw new AppError(409, 'already_seeded', 'This find has already been seeded');
      emitIdeas(boardId, [result.idea]);
      if (manual) {
        publishFinds();
        queueJudge([result.idea.id]);
      }
      return result;
    },

    /**
     * One autopilot step: retry failed gold exists checks, judge what is unjudged,
     * otherwise breed (combine by tournament selection) or mutate (expand a strong idea).
     * Awaits its own judgements so the next step sees the scores.
     */
    async autoStep(boardId: number): Promise<{ did: 'idle' | 'judge' | 'expand' | 'combine'; reason?: string; ids?: number[]; error?: { code: string; message: string } }> {
      const board = mustBoard(boardId);
      let ideas = repo.listIdeas(boardId);
      if (!ideas.length) return { did: 'idle', reason: 'empty' };

      const day = localDay(new Date(now()));
      const crewCap = deps.settings().crewCallsPerDay;
      const crewAtCap = repo.crewCallsOn(day) >= crewCap;

      if (board.config.autoProjectOnGold) {
        const existsCrewBlocked = crewAtCap && isCrewModel(modelFor(board, 'exists'));
        if (!existsCrewBlocked) {
          const pendingExists = ideas.find(
            (i) => medal(i) === 3 && !i.projectPath && i.existsVerdict === null && i.existsAttempts < 3 && !judging.has(i.id),
          );
          if (pendingExists) {
            const out = await handleGold(board, pendingExists);
            return {
              did: 'judge',
              ids: [pendingExists.id],
              ...(out.projectError ? { error: { code: out.projectErrorCode ?? 'gold_failed', message: out.projectError } } : {}),
            };
          }
        }
        const briefCrewBlocked = crewAtCap && isCrewModel(modelFor(board, 'brief'));
        if (!briefCrewBlocked) {
          const pendingBrief = ideas.find(
            (i) => medal(i) === 3 && !i.projectPath && (i.existsVerdict === 'partial' || i.existsVerdict === 'new') && i.briefAttempts < 3 && !judging.has(i.id),
          );
          if (pendingBrief) {
            const out = await handleGold(board, pendingBrief);
            return {
              did: 'judge',
              ids: [pendingBrief.id],
              ...(out.projectError ? { error: { code: out.projectErrorCode ?? 'gold_failed', message: out.projectError } } : {}),
            };
          }
        }
      }

      // Keep new material on the board (topic-spread fix, owner's yes 2026-11-23 3:41 AM). Finds became seeds only
      // right after a scout round, so by 3 AM 512 good finds waited while the board bred from itself. Now, whenever
      // fewer than FRESH_SEEDS_MIN unused seeds are waiting, the next good find is seeded (judged on the next step).
      const parented = new Set(repo.listEdges(boardId).map((e) => e.from));
      const waitingSeeds = ideas.filter((i) => i.kind === 'seed' && !i.generation && !parented.has(i.id)).length;
      if (waitingSeeds < FRESH_SEEDS_MIN) {
        const s = deps.settings();
        // Take the source used least among the last 8 seeds: asked for one find, seedableFinds always gave the
        // best-scoring source (the first real run seeded four GitHub repos in a row).
        const recentSources = ideas.filter((i) => i.kind === 'seed' && !i.generation).sort((a, b) => b.id - a.id)
          .slice(0, 8).map((i) => i.seedSource);
        const used = (source: string) => recentSources.filter((x) => x === source).length;
        const find = repo.seedableFinds(s.seedThreshold, 50)
          .reduce<ReturnType<typeof repo.seedableFinds>[number] | undefined>((best, f) => (!best || used(f.source) < used(best.source) ? f : best), undefined);
        const seeded = find ? repo.seedFind(boardId, find.id, seedPosition(boardId, {})) : null;
        if (seeded) {
          emitIdeas(boardId, [seeded.idea]);
          publishFinds();
          ideas = repo.listIdeas(boardId);
        }
      }

      const judgeIsCrew = isCrewModel(modelFor(board, 'judge'));
      const unjudged = ideas.filter((i) => !isJudged(i) && i.medalOverride == null && !judging.has(i.id)).slice(0, 3);
      if (unjudged.length) {
        if (crewAtCap && judgeIsCrew) {
          throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
        }
        const err = await judgeSequential(unjudged.map((i) => i.id));
        return { did: 'judge', ids: unjudged.map((i) => i.id), ...(err ? { error: err } : {}) };
      }
      const edges = repo.listEdges(boardId);
      let move = nextMove(ideas, edges, { busy: judging });
      if (!move) return { did: 'idle', reason: 'nothing_to_do' };

      if (crewAtCap && judgeIsCrew) {
        throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
      }
      const expandIsCrew = isCrewModel(modelFor(board, 'expand'));
      const combineIsCrew = isCrewModel(modelFor(board, 'combine'));
      if (crewAtCap && move.type === 'expand' && expandIsCrew) {
        if (!combineIsCrew) {
          const alt = nextMove(ideas, edges, { busy: judging, mutationRate: 0 });
          if (alt?.type === 'combine') move = alt;
          else throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
        } else {
          throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
        }
      } else if (crewAtCap && move.type === 'combine' && combineIsCrew) {
        if (!expandIsCrew) {
          const alt = nextMove(ideas, edges, { busy: judging, mutationRate: 1 });
          if (alt?.type === 'expand') move = alt;
          else throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
        } else {
          throw new AppError(429, 'crew_cap', `Daily crew limit (${crewCap}) reached; resumes tomorrow`);
        }
      }

      if (move.type === 'expand') {
        const r = await doExpand(move.idea.id);
        const err = await judgeSequential(r.ideas.map((i) => i.id));
        return { did: 'expand', ids: r.ideas.map((i) => i.id), ...(err ? { error: err } : {}) };
      }
      const r = await doCombine(boardId, move.a.id, move.b.id);
      const err = await judgeSequential([r.idea.id]);
      return { did: 'combine', ids: [r.idea.id], ...(err ? { error: err } : {}) };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
