// Every prompt in the app. Which model answers is decided per call (per role,
// optionally per board); providers.ts routes "provider:model" to the right API.
//
// Schemas avoid integer minimum/maximum (Anthropic rejects them), so ranges
// live in descriptions and are clamped in code.

import { clampScore } from '../public/js/score.js';
import type { ChatFn } from './providers.ts';
export type { ChatFn, ChatRequest } from './providers.ts';

type Pitch = { title: string; pitch: string };
type Flow = { system: string; expand: string; combine: string };
/** household: the owner's description of the household (from settings.interests), shared with every idea prompt and the jury. */
type BoardCtx = { goal: string; household?: string };
export type Judgement = { originality: number; feasibility: number; impact: number; reason: string; keywords: string[] };

/** One canonical form so "Public Spaces" and "public space" count as one trend. */
export function normalizeKeywords(raw: unknown): string[] {
  const out: string[] = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    const w = String(k).toLowerCase().replace(/[^\p{L}\p{N} &+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (w && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- schemas

const PITCH_PROPS = {
  title: { type: 'string', description: 'A concrete name for the idea, 2–6 words. No quotes, no trailing period.' },
  pitch: {
    type: 'string',
    description: 'One or two sentences, at most 40 words: what it is, for whom, and the mechanism that makes it work.',
  },
};
const PITCH_SCHEMA = { type: 'object', properties: PITCH_PROPS, required: ['title', 'pitch'], additionalProperties: false };
const EXPAND_SCHEMA = {
  type: 'object',
  properties: {
    ideas: { type: 'array', description: 'Exactly 3 ideas.', items: PITCH_SCHEMA },
  },
  required: ['ideas'],
  additionalProperties: false,
};
const DEEP_CROSS_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      description: 'Exactly 3 original ideas, each joining two or more parent ideas from the list in a non-obvious way.',
      items: {
        type: 'object',
        properties: {
          ...PITCH_PROPS,
          parents: {
            type: 'array',
            description: 'Integer IDs of the 2 or more parent ideas from the list that this idea joins.',
            items: { type: 'integer' },
          },
        },
        required: ['title', 'pitch', 'parents'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};
// The reason comes first so the model argues before it scores.
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One sentence, at most 25 words, in the language of the idea, explaining New, Buildable and Worth having.',
    },
    originality: { type: 'integer', description: 'New, integer 1–5.' },
    feasibility: { type: 'integer', description: 'Buildable, integer 1–5.' },
    impact: { type: 'integer', description: 'Worth having, integer 1–5.' },
    fits: { type: 'boolean', description: "True only if the idea clearly uses or serves something on the owner's interests list." },
    keywords: {
      type: 'array',
      description: '2–4 keywords for what the idea is about: English, lowercase, singular, 1–2 words each. Reuse a keyword from the vocabulary when one fits.',
      items: { type: 'string' },
    },
  },
  required: ['reason', 'originality', 'feasibility', 'impact', 'fits', 'keywords'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- prompts

const LANGUAGE_RULE = 'Write in the language of the source ideas or seed text. If unclear or mixed, write in English.';


// The owner's interests steer the search but never limit an idea (owner's choice, 2026-11-22: a great
// idea is one they would use anyway). Do not assume devices the list does not name.
function householdText(board: BoardCtx) {
  const h = board.household?.trim();
  return h ? `The owner's interests and gear (a plus when an idea touches them, never a requirement; do not assume devices that are not named here):
${h}` : '';
}

const PLAIN_WORDS = new Set([
  'household', 'with', 'from', 'that', 'this', 'your', 'into', 'idea', 'ideas', 'home', 'family',
  'the', 'and', 'for', 'via', 'you', 'new', 'one', 'all', 'any', 'out', 'own', 'its', 'per', 'two', 'use', 'app', 'not', 'can',
]);

/**
 * Words that keep coming back in the board's titles. Seen 2026-11-22: "rounds" in 10 of 50 titles,
 * "autopsy" in 6, because each new idea borrowed the theme its parent had borrowed. Three-letter
 * words count too: after the fresh start "NFC" was in 6 of the first 8 titles and went unnoticed.
 * Only the newest 60 titles count (Jer 2026-11-23 12:22 AM: "yes, fix the theme check"): across all 540
 * titles a new theme needed about 44 uses before it was named, so "promise" and "census" spread unchecked.
 */
export const RECENT_TITLES = 60;
export function overusedWords(allTitles: string[], max = 10): string[] {
  const titles = allTitles.slice(-RECENT_TITLES);
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const word of new Set(title.toLowerCase().match(/[a-z]{3,}/g) ?? [])) {
      if (!PLAIN_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const floor = Math.max(4, Math.ceil(titles.length * 0.08));
  return [...counts].filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([word]) => word);
}

function context(board: BoardCtx, existingTitles: string[]) {
  const parts: string[] = [];
  const household = householdText(board);
  if (household) parts.push(household);
  if (board.goal.trim())
    parts.push(
      `The board's goal (the general direction): ${board.goal.trim()}\nEvery idea must serve this goal. Keep the source idea's substance, but steer it toward the goal.`,
    );
  if (existingTitles.length)
    parts.push(
      `Ideas already on the board (do not repeat or lightly reword them):\n${existingTitles
        .slice(-40)
        .map((t) => `- ${t}`)
        .join('\n')}`,
    );
  const overused = overusedWords(existingTitles);
  if (overused.length)
    parts.push(
      `Themes already worn out on this board: ${overused.join(', ')}. Do not use these words in the title, and do not borrow a metaphor or field the board has already used (for example hospital rounds or autopsies when "rounds" or "autopsy" is listed). If you borrow a mechanism, take it from a field none of these ideas came from.`,
    );
  return parts.join('\n\n');
}

const fmtIdea = (i: Pitch) => (i.pitch ? `${i.title}: ${i.pitch}` : i.title);

// Rewritten 2026-11-23 (Jer 1:08 AM: "What else is in there sabotaging us from the inside? Yes, send the judge fix.").
// The upstream wording ("strict jury", "Most ideas land around 2–3", "Fewer than one in ten should score 13 or
// higher") anchored every score to the middle: of 950 judged crosses none got New 5, two got Worth having 5, and
// none reached the gold sum of 13. Gold stays rare through the scale's own wording, not through a quota.
export const JUDGE_SYSTEM = `You are the jury for new things to build. Judge the idea as written, without inventing missing details. Use integers 1–5 on these three criteria and use the whole scale. Score each criterion on its own merits against the descriptions below; do not aim for an average or hold back top marks. A 5 means the idea really meets that description, which a strong idea can.

NEW (return under originality)
Is the combination genuinely new, something that does not already exist and that neither ingredient does alone?
1: Already exists, or an obvious mash-up. 2: A small tweak on something common. 3: A fresh twist on a known kind of thing. 4: Clearly new; a combination that makes you look twice. 5: A combination nobody has made that opens something new.

BUILDABLE (return under feasibility)
Could coding agents build a first working version in one or two sessions on a Windows PC with phones and common hardware nearby?
1: Requires research breakthroughs or major hardware. 2: Months of work or special equipment. 3: A multi-week project. 4: A few agent sessions. 5: One or two agent sessions.

WORTH HAVING (return under impact)
Would a thoughtful, tech-minded person really want this and keep using it once it exists?
1: A curiosity nobody would keep. 2: Fun once, then forgotten. 3: Handy now and then. 4: Something a person would reach for every week. 5: People would want it, use it often, and miss it if it were gone.

FITS (return under fits)
True only if the idea clearly uses or serves something on the owner's interests list. It is a small bonus, so never lower a score because an idea does not fit.

A bare topic or single word is not an idea. Give it New 1 and at most 2 on Buildable and Worth having. If the idea is vague about what happens, score Buildable and Worth having at most 2. Explain the three scores in one concise sentence, with the main strength and weakness.`;

/** Fitting the owner's interests adds one point to Worth having, never above 5: a bonus, never a gate. */
export function withFitBonus(worthHaving: number, fits: unknown) {
  return fits === true ? Math.min(5, worthHaving + 1) : worthHaving;
}


const list = (description: string) => ({ type: 'array', description, items: { type: 'string' } });
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: where the board stands right now.' },
    themes: {
      type: 'array',
      description: '2–5 themes the ideas cluster into.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Theme name, 1–4 words.' },
          insight: { type: 'string', description: 'What the ideas in this theme have in common and what they reveal, 1–2 sentences.' },
          ideas: list('Titles of the ideas in this theme, exactly as given.'),
        },
        required: ['name', 'insight', 'ideas'],
        additionalProperties: false,
      },
    },
    strongest: {
      type: 'array',
      description: 'The 1–3 strongest ideas.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title exactly as given.' },
          why: { type: 'string', description: 'Why it stands out, one sentence.' },
        },
        required: ['title', 'why'],
        additionalProperties: false,
      },
    },
    gaps: list('2–4 directions toward the goal that no idea explores yet.'),
    nextSteps: list('2–4 concrete next moves on this board, e.g. which ideas to cross or expand.'),
  },
  required: ['headline', 'themes', 'strongest', 'gaps', 'nextSteps'],
  additionalProperties: false,
};

/** Every function takes `model`: a "provider:model" string chosen per role. */
const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One or two sentences: what the idea work as a whole has produced so far.' },
    insights: list('3–6 insights that hold across boards: patterns, recurring weaknesses, what the jury rewards.'),
    standouts: {
      type: 'array',
      description: 'The 1–5 ideas most worth pursuing, across all boards.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title exactly as given.' },
          board: { type: 'string', description: 'Board title exactly as given.' },
          why: { type: 'string', description: 'Why it stands out, one sentence.' },
        },
        required: ['title', 'board', 'why'],
        additionalProperties: false,
      },
    },
    opportunities: list('2–4 opportunities: boards whose ideas should cross-breed, or directions nobody has explored.'),
    nextSteps: list('2–4 concrete next steps, including which Claude Code projects to start on first.'),
  },
  required: ['headline', 'insights', 'standouts', 'opportunities', 'nextSteps'],
  additionalProperties: false,
};

export function makeLLM(chat: ChatFn) {
  const gen = async (model: string, system: string, user: string, schemaName: string, schema: object) => {
    return chat({ model, system, user, schemaName, schema, temperature: 0.9 });
  };

  const tidy = (p: any): Pitch => ({
    title: String(p?.title ?? '').trim().replace(/^["'«»“”]+|["'«»“”.]+$/g, '').slice(0, 120),
    pitch: String(p?.pitch ?? '').trim().slice(0, 600),
  });

  return {
    async expand(a: { model: string; flow: Flow; board: BoardCtx; idea: Pitch; existingTitles: string[] }) {
      const user = [
        a.flow.expand,
        `The concept:\n${fmtIdea(a.idea)}`,
        context(a.board, a.existingTitles),
        LANGUAGE_RULE,
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'expand', EXPAND_SCHEMA);
      const ideas = (Array.isArray(value?.ideas) ? value.ideas : []).map(tidy).filter((i: Pitch) => i.title);
      if (!ideas.length) throw new Error('The model returned no ideas');
      return { ideas: ideas.slice(0, 3), costUsd };
    },

    async combine(a: { model: string; flow: Flow; board: BoardCtx; a: Pitch; b: Pitch; existingTitles: string[] }) {
      const user = [
        a.flow.combine,
        `Idea 1:\n${fmtIdea(a.a)}`,
        `Idea 2:\n${fmtIdea(a.b)}`,
        context(a.board, a.existingTitles),
        LANGUAGE_RULE,
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'combine', PITCH_SCHEMA);
      const idea = tidy(value);
      if (!idea.title) throw new Error('The model returned no idea');
      return { idea, costUsd };
    },

    async deepCross(a: {
      model: string;
      board: BoardCtx;
      candidates: { id: number; title: string; pitch: string; source: string; sum: number | null }[];
      existingTitles: string[];
    }) {
      const listText = a.candidates
        .map((c) => `[id:${c.id}] (${c.source}${c.sum != null ? `, jury ${c.sum}/15` : ''}) ${fmtIdea(c)}`)
        .join('\n');
      const user = [
        'Below are the strongest seeds and ideas on this board from different sources.',
        `Candidates:\n${listText}`,
        'Generate exactly 3 original ideas that each join two or more of these candidates in a non-obvious, fertile way. Name the concrete mechanism that links the parents. For each idea, list the parent integer IDs it joins in `parents` (at least 2 IDs from the candidates above).',
        context(a.board, a.existingTitles),
        LANGUAGE_RULE,
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: 'You are an inventive cross-pollinator who finds unexpected, practical mechanisms connecting disparate tools, papers and real needs.',
        user,
        schemaName: 'deep_cross',
        schema: DEEP_CROSS_SCHEMA,
        temperature: 0.9,
        maxTokens: 2000,
      });
      const validIds = new Set(a.candidates.map((c) => c.id));
      const byTitle = new Map(a.candidates.map((c) => [c.title.toLowerCase(), c.id]));
      const rawIdeas = Array.isArray(value?.ideas) ? value.ideas : [];
      const ideas: { title: string; pitch: string; parents: number[] }[] = [];
      for (const item of rawIdeas) {
        const cleaned = tidy(item);
        if (!cleaned.title) continue;
        const parents: number[] = [];
        for (const rawParent of Array.isArray(item?.parents) ? item.parents : []) {
          const n = typeof rawParent === 'number' ? rawParent : Number(String(rawParent).replace(/^id:/i, '').trim());
          const resolved = Number.isInteger(n) && validIds.has(n)
            ? n
            : byTitle.get(String(rawParent ?? '').trim().toLowerCase());
          if (resolved != null && !parents.includes(resolved)) parents.push(resolved);
        }
        if (parents.length < 2) continue;
        ideas.push({ ...cleaned, parents });
        if (ideas.length === 3) break;
      }
      if (!ideas.length) throw new Error('The deep cross returned no valid multi-parent ideas');
      return { ideas, costUsd };
    },

    /** Turn a long text or a fetched web page into one seed idea. */
    async distill(a: { model: string; flow: Flow; board: BoardCtx; text: string; url?: string }) {
      const user = [
        'Distill the source below into ONE seed idea for a brainstorm: the most promising concept, problem or opportunity in it. Do not summarise the whole text.',
        a.url ? `Source: ${a.url}` : '',
        `---\n${a.text}\n---`,
        context(a.board, []),
        LANGUAGE_RULE,
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'seed', PITCH_SCHEMA);
      const idea = tidy(value);
      if (!idea.title) throw new Error('The model returned no idea');
      return { idea, costUsd };
    },

    /** A synthesis of everything on a board. ideas: sorted strongest first. */
    async summarize(a: {
      model: string; board: BoardCtx;
      ideas: { title: string; pitch: string; kind: string; sum: number | null; reason: string | null }[];
    }) {
      const lines = a.ideas
        .slice(0, 120)
        .map((i) => `- ${fmtIdea(i)}${i.sum != null ? ` [jury ${i.sum}/15${i.reason ? `: ${i.reason}` : ''}]` : ' [not judged]'}`)
        .join('\n');
      const user = [
        a.board.goal.trim() ? `The board's goal: ${a.board.goal.trim()}` : 'The board has no stated goal.',
        `The ${a.ideas.length} ideas on the board, strongest first:\n${lines}`,
        'Summarise the board for the people working on it: the themes, the strongest ideas, the gaps toward the goal, and what to do next. Be specific and honest; do not praise.',
        'Use the language of the ideas when clear and consistent, otherwise English. Keep idea titles exactly as given.',
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: 'You are a facilitator who has watched a whole brainstorm and now sums it up crisply for the team.',
        user,
        schemaName: 'summary',
        schema: SUMMARY_SCHEMA,
        temperature: 0.4,
        maxTokens: 2500,
      });
      const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : []);
      const summary = {
        headline: String(value?.headline ?? '').trim(),
        themes: (Array.isArray(value?.themes) ? value.themes : []).slice(0, 6).map((t: any) => ({
          name: String(t?.name ?? '').trim(), insight: String(t?.insight ?? '').trim(), ideas: strs(t?.ideas, 30),
        })),
        strongest: (Array.isArray(value?.strongest) ? value.strongest : []).slice(0, 3).map((s: any) => ({
          title: String(s?.title ?? '').trim(), why: String(s?.why ?? '').trim(),
        })),
        gaps: strs(value?.gaps, 5),
        nextSteps: strs(value?.nextSteps, 5),
      };
      return { summary, costUsd };
    },

    /** The report's conclusions: one synthesis across every board. */
    async synthesize(a: {
      model: string; days: number;
      boards: { title: string; goal: string; summary: string; best: { title: string; pitch: string; sum: number | null }[]; projects: string[] }[];
    }) {
      const blocks = a.boards
        .map((b) =>
          [
            `## ${b.title}`,
            b.goal ? `Goal: ${b.goal}` : 'No goal.',
            b.summary ? `Board summary: ${b.summary}` : '',
            b.best.length ? `Best ideas:\n${b.best.map((i) => `- ${fmtIdea(i)}${i.sum != null ? ` [jury ${i.sum}/15]` : ''}`).join('\n')}` : 'No judged ideas yet.',
            b.projects.length ? `Claude Code projects: ${b.projects.join('; ')}` : '',
          ].filter(Boolean).join('\n'),
        )
        .join('\n\n');
      const user = [
        `These are the idea boards and what they produced (the report covers the last ${a.days} days):`,
        blocks,
        'Write the conclusions of the report for the people running the boards: what holds across boards, which ideas are most worth pursuing, where boards should cross-breed, and what to do next. Be specific and honest; do not praise.',
        'Write in English. Keep idea and board titles exactly as given.',
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: 'You are an innovation lead who reads the results of several idea boards and writes the conclusions of a short report.',
        user,
        schemaName: 'synthesis',
        schema: SYNTHESIS_SCHEMA,
        temperature: 0.4,
        maxTokens: 2500,
      });
      const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : []);
      return {
        synthesis: {
          headline: String(value?.headline ?? '').trim(),
          insights: strs(value?.insights, 8),
          standouts: (Array.isArray(value?.standouts) ? value.standouts : []).slice(0, 5).map((s: any) => ({
            title: String(s?.title ?? '').trim(), board: String(s?.board ?? '').trim(), why: String(s?.why ?? '').trim(),
          })),
          opportunities: strs(value?.opportunities, 6),
          nextSteps: strs(value?.nextSteps, 6),
        },
        costUsd,
      };
    },

    /** guidance: the board's own jury instructions, on top of the fixed scale. */
    async judge(a: { model: string; board: BoardCtx; idea: Pitch; guidance?: string; vocabulary?: string[] }) {
      const guidance = (a.guidance ?? '').trim();
      const system = guidance ? `${JUDGE_SYSTEM}\n\nAdditional guidance from this board's facilitator:\n${guidance}` : JUDGE_SYSTEM;
      const user = [
        a.board.goal.trim() ? `The board's goal (the general direction): ${a.board.goal.trim()}` : '',
        householdText(a.board),
        `The idea:\n${fmtIdea(a.idea)}`,
        'Write the reason in the language of the idea, or English if unclear.',
        a.vocabulary?.length ? `Keyword vocabulary in use (reuse when one fits): ${a.vocabulary.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system,
        user,
        schemaName: 'judgement',
        schema: JUDGE_SCHEMA,
        temperature: 0.2,
        maxTokens: 2500, // DeepSeek used 1167 tokens on one verdict; 400 cut it off mid-answer (2026-11-22)
      });
      if (typeof value?.reason !== 'string' || !value.reason.trim() ||
          ![value.originality, value.feasibility, value.impact].every(Number.isFinite)) {
        throw new Error('The jury response needs three numeric scores and a reason');
      }
      const judgement: Judgement = {
        originality: clampScore(value?.originality),
        feasibility: clampScore(value?.feasibility),
        impact: withFitBonus(clampScore(value?.impact), value?.fits),
        reason: String(value?.reason ?? '').trim().slice(0, 400),
        keywords: normalizeKeywords(value?.keywords),
      };
      return { judgement, costUsd };
    },
  };
}

export type LLM = ReturnType<typeof makeLLM>;
