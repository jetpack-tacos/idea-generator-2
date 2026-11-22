// Evolution autopilot: decides the next move. Pure, no DOM, no network.
//
// Not random merging: parents are picked by tournament selection on the
// judge's score, so strong ideas get more children. Now and then it "mutates"
// instead, expanding a strong idea that has not been expanded yet, which
// brings new material into the pool.

import { fitness } from './score.js';

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Ideas that can breed: judged or hand-medalled. */
export function population(ideas) {
  return ideas.filter((i) => fitness(i) != null);
}

/** Pairs that must not be bred again: already combined, or parent and child. */
export function usedPairs(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const parentsOf = new Map();
  const used = new Set();
  for (const e of edges) {
    used.add(pairKey(e.from, e.to));
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  for (const [child, parents] of parentsOf) {
    if (kindOf.get(child) === 'combine' && parents.length === 2) used.add(pairKey(parents[0], parents[1]));
  }
  return used;
}

/** Ideas that already have expand-children. */
export function expandedIds(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const out = new Set();
  for (const e of edges) if (kindOf.get(e.to) === 'expand') out.add(e.from);
  return out;
}

function tournament(pool, k, rng, tieBreak = () => false) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!best || fitness(c) > fitness(best) || (fitness(c) === fitness(best) && tieBreak(c, best))) best = c;
  }
  return best;
}

function lineageSources(ideas, edges) {
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  const parents = new Map();
  for (const { from, to } of edges) {
    if (!parents.has(to)) parents.set(to, []);
    parents.get(to).push(from);
  }
  const cache = new Map();
  return function sourcesOf(id) {
    if (cache.has(id)) return cache.get(id);
    const sources = new Set();
    const visited = new Set();
    const stack = [id];
    while (stack.length) {
      const parentId = stack.pop();
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const ancestor = byId.get(parentId);
      if (ancestor?.kind === 'seed' && ancestor.generation === 0 && ancestor.seedSource) {
        sources.add(ancestor.seedSource);
      }
      for (const parent of parents.get(parentId) ?? []) stack.push(parent);
    }
    cache.set(id, sources);
    return sources;
  };
}

function crossesSources(a, b) {
  if (!a.size || !b.size) return false;
  return [...b].some((s) => !a.has(s));
}

/**
 * @param {Array} ideas  ideas on the board (with id, kind, scores)
 * @param {Array} edges  {from, to}
 * @param {object} opts  rng, busy (Set of ids being worked on), inFlight (Set of pair keys),
 *                       mutationRate, k (tournament size)
 * @returns {{type:'combine', a, b} | {type:'expand', idea} | null}
 */
export function nextMove(ideas, edges, opts = {}) {
  const { rng = Math.random, busy = new Set(), inFlight = new Set(), mutationRate = 0.2, k = 3 } = opts;
  const pool = population(ideas).filter((i) => !busy.has(i.id));
  const expanded = expandedIds(ideas, edges);
  const used = usedPairs(ideas, edges);

  const bestUnexpanded = () =>
    [...pool].sort((a, b) => fitness(b) - fitness(a)).find((i) => !expanded.has(i.id));

  if (pool.length < 3 || rng() < mutationRate) {
    const idea = bestUnexpanded();
    if (idea) return { type: 'expand', idea };
  }

  if (pool.length >= 2) {
    const sourcesOf = lineageSources(ideas, edges);
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = tournament(pool, k, rng);
      const rest = pool.filter((i) => i.id !== a.id);
      const aSources = sourcesOf(a.id);
      const crosses = (idea) => crossesSources(aSources, sourcesOf(idea.id));
      // Cross-pollination is the point (Jer 2026-11-22 2:32 PM): the partner comes from a different
      // source whenever one exists. As a mere tie-break, 9 of the first 13 crosses stayed within one source.
      const crossing = rest.filter(crosses);
      const b = tournament(crossing.length ? crossing : rest, k, rng);
      const key = pairKey(a.id, b.id);
      if (used.has(key) || inFlight.has(key)) continue;
      return { type: 'combine', a, b };
    }
  }

  const idea = bestUnexpanded();
  return idea ? { type: 'expand', idea } : null;
}

/**
 * Has quality moved? Mean fitness of the first and the latest `window` bred
 * ideas (seeds are excluded because bare topics score low), plus the best so far.
 */
export function evolutionStats(ideas, window = 8) {
  const bred = ideas
    .filter((i) => i.kind !== 'seed' && fitness(i) != null)
    .sort((a, b) => a.id - b.id);
  const mean = (xs) => (xs.length ? xs.reduce((s, i) => s + fitness(i), 0) / xs.length : null);
  const generation = ideas.reduce((g, i) => Math.max(g, i.generation || 0), 0);
  return {
    count: bred.length,
    generation,
    first: mean(bred.slice(0, window)),
    latest: bred.length > window ? mean(bred.slice(-window)) : null,
    best: bred.length ? Math.max(...bred.map(fitness)) : null,
  };
}
