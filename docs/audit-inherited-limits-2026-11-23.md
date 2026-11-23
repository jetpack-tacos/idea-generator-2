# What holds the board back: prompts, limits and rules (audit 2026-11-23 1:10 AM)

Asked by Jer, 2026-11-23 1:08 AM: "Who is making these initial decisions like this? What else is in there sabotaging us from the inside?"
Read-only audit by a helper, spot-checked here (llm.ts:136 goal line, leads.ts:120 household wording, seedThreshold 0.6, db.ts:149 "close variation", evolve.js seed handling: all as reported).
"Upstream" = Anders Bjarby's fork, commit 27cebd8 (2026-11-02) or earlier. "Ours" = this fork, 2026-11-22 on.

Board at the time: 982 judged ideas, sums 4 to 12, never a gold (13). Only 25 of them are seeds; 957 are bred from other bred ideas.

## Fixed already
- llm.ts JUDGE_SYSTEM: "strict jury", "Most ideas land around 2-3", "Fewer than one in ten should score 13 or higher" (upstream). Rewritten 1:10 AM with 1-to-5 steps for every score. Top-30 rejudge on Opus: 1 gold (13), most still 11-12.

## Findings, worst first

1. **Judge scale, criteria text** (llm.ts, ours). Buildable 5 = "one or two agent sessions", 3 = "a multi-week project": any ambitious idea is capped at 3. New 5 and Worth having 5 are described so high that a strong idea rarely meets them. Change: Buildable 4 = about a week, 5 = a few sessions; examples of a real 5 on New and Worth having.
2. **Fit bonus decides gold** (llm.ts:175 withFitBonus, ours). +1 on Worth having when an idea fits his interests. One point is the gap between silver 12 and gold 13, so fitting ideas get gold and equally good non-fitting ones do not. Change: keep the bonus out of the score sum (sort or tie-break only), or never let it cross the gold line.
3. **Seeds are judged like finished ideas and almost never bred again** (engine.ts:818, evolve.js:41-48 and :107, upstream design). Seeds average 6.5 against about 10 for bred ideas, so tournament selection almost never picks raw finds after the first rounds. The board breeds its own offspring: 957 bred ideas against 25 seeds. Change: give seeds a neutral fitness (for example the bred median), or reserve part of every round for crosses with a fresh seed.
4. **Weak selection, mutation that adds nothing new** (evolve.js:91 k = 3, mutationRate 0.2, upstream). On a flat 9-11 pool, parents are close to random, and "mutation" only expands the best bred idea. Change: a "fresh material" move that crosses a bred idea with an unused seed.
5. **The existence check can kill a gold for good** (exists.ts:102-183, ours). "exists" ends the gold path: no brief, no project. It searches GitHub by stars (most famous, not closest) and 5 HN stories, compares one-line descriptions, and asks whether a tool does what the idea describes, not whether one does the whole combination. A failed search 3 times stalls the gold forever. Change: "exists" only when one tool covers the whole combination; a failed search proceeds; always write the brief and attach the verdict.
6. **Every idea is forced toward the goal text** (llm.ts:136, upstream). "Every idea must serve this goal ... steer it toward the goal." Change: "The goal is a direction, not a filter."
7. **The long interests list is in every writing prompt** (engine.ts:176 withHousehold, llm.ts:98-102, ours). Labelled "a plus, never a requirement", but a long list of his gear in every prompt reads as the target, hence the NFC and home-automation pull. Change: show it only to the judge (for the fit flag), or 2-3 random items per writing call.
8. **Sustainability template** (db.ts:158, upstream wording kept): "differ in scale: household, organisation, and region". Not used by the live board. Change: "individual, organisation and region", or drop.
9. **Paper scout aims at households** (leads.ts:120, ours): "explains to makers and households". Change: "explains to builders".
10. **News and Lobsters are mostly shut out** (filter.ts:12-18, seedThreshold 0.6, db.ts SOURCE_BEST_FLOOR 0.4, ours). Google News 303 below 0.6 against 44 above, Lobsters 25 against 2. The "false" list includes "a product announcement", a fine ingredient for a cross. Change: seedThreshold about 0.45; ask "Could this be a raw ingredient for a combination?"; drop "product announcement".
11. **Session wishes limited to recurring chores** (filter.ts:23-28 wish question, wish >= 0.7, ours). Change: any wish for something that does not exist yet; gate 0.6.
12. **Scout filter context includes the whole interests list** (scheduler.ts:92-95, ours). Extra pull on every find's score. Change: board goal only.
13. **Too few seeds** (seedsPerRound 12, rounds only when a scout is due, ours). Seeds are 2.6% of the board. Change: 20-30 a round, plus item 3.
14. **Pitch squeezed to 40 words** (llm.ts:33, :251-254, upstream). The jury sees a compressed idea and the "vague, at most 2" rule bites. Change: about 70 words, saying what happens step by step.
15. **Repeat check sees only the newest 40 titles** (llm.ts:141, upstream). Repeats of older ideas slip through. Change: a similarity check across the whole board.
16. **Daily deep cross uses only top scorers** (engine.ts:70-137, llm.ts:300, 8 candidates, maxTokens 2000). Always bred ideas; seeds never get in; 2000 tokens is tight for 3 ideas. Change: add the best fresh seed per source; raise maxTokens.
17. **Medal lines** (score.js MEDAL_MIN_SUM 9/11/13, upstream). Fine in themselves, but gold needs the judge to give 5s. Keep 13 if the judge rewrite lets strong ideas reach it.
18. **Existence check runs on a lighter model than the judge** (exists not in creditRun). Change: add exists to the Opus list during the credit run. Also crewCallsPerDay 10 limits briefs and deep crosses after the credit run.
19. **A third of every expand is a "close variation"** (db.ts:149 Inventor flow, upstream). These score New 3 by the scale's own words. Change: "a sharper, more specific version that could stand on its own", or three divergent ones.
20. **No variety in the writing prompt** (llm.ts:248 temperature 0.9, upstream). Same prompt every call, so motifs repeat (NFC, rounds, autopsy, promise, census). Change: a random "borrow from field X" per call.
21. **Judge has no anchor examples** (engine.ts:818, llm.ts judge). Change: show the judge 3-4 scored examples, including a real 13.
22. **Hand-made seeds count as no source** (evolve.js:78-81). They fall out of the cross-source rule. Change: treat them as source "manual".
23. Brief prompt (project.ts:101-104): fine.
24. **Existence check searches only GitHub and HN** (exists.ts). A commercial app counts as new. Low priority.

## Checked and fine
Language rule, schemas, summary prompts, score clamping and medals in code, evolve bookkeeping, autopilot rate limiter and backoff, gold pipeline order (apart from item 5), alerts, seen list and pruning, README in seeds, seedableFinds round-robin, Inventor system prompt, Wild card template, the credit run.
