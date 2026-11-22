# Idea Generator

The server runs TypeScript directly on Node 24.11.1 or newer. The frontend uses vanilla ES modules. SQLite is provided by `node:sqlite`.

- `npm start` serves the app on `127.0.0.1:8300` by default and starts autopilot. `PORT` and `DB_FILE` are optional overrides.
- `npm test` uses fake providers and temporary databases.
- `npm run spend` shows today's per-model usage from `logs/spend.jsonl`.
- `npm run calibrate -- --model provider:model` runs paid jury checks against provisional household examples.

## Server and browser

- `server/settings.ts` loads `settings.local.json` on startup and atomically replaces it when Settings is saved. Defaults come from `settings.example.json`. Keys come from environment variables.
- `server/providers.ts` routes DeepSeek, Z.ai, OpenRouter, Anthropic, and OpenAI. DeepSeek and Z.ai try a JSON Schema first and retry with JSON object mode plus the schema in the system prompt when a 400 rejects `response_format`. GLM uses low reasoning effort. DeepSeek uses peak rates for budget accounting.
- `server/autopilot.ts` and `server/engine.ts` evolve automatic boards. The scheduler checks local active hours and recorded budgets before each step. `server/spend.ts` logs provider attempts, including retries.
- `server/app.ts` validates the loopback Host header, requires JSON and a same-origin Origin header when present on writes, and publishes board changes over SSE.
- `server/scouts/` runs the six public scouts independently of autopilot. The scheduler persists source cadence and a 90-day seen list, tries the local Python judge first, and seeds eligible automatic boards. `npm run scouts:once` checks the six sources without writing to the database.
- `server/leads.ts` contains the manual Hugging Face research workflow and optional OpenRouter X scout. The X scout has no default model and keeps only cited posts.
- `server/project.ts` creates uniquely named project folders. Gold folders include the request stub and jury and source notes.
- `public/js/app.js` and `public/js/report.js` render the English interface. Model text goes into the DOM as text nodes.

## Jury and compatibility

`server/llm.ts` asks the jury to score the stated idea against the board goal. Use means weekly household use. Buildable means a first version in one or two agent sessions. Fit means using the household's current devices and tools. Keep the existing SQLite columns `originality`, `feasibility`, and `impact` for those three scores. `public/js/score.js` awards bronze at 9, silver at 11, and gold at 13.

Keep score ranges in the schema descriptions and clamp scores in code. Idea generation, judging reasons, and project brief content use the idea's language with English as the fallback.
