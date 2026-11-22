# Idea Generator

The server runs TypeScript directly on Node 24.11.1 or newer. The frontend uses vanilla ES modules. SQLite is provided by `node:sqlite`.

- `npm start` serves the app on `127.0.0.1:8300` by default and starts autopilot. `PORT` and `DB_FILE` are optional overrides.
- `npm test` uses fake providers, fake scripts, fake HTTP transports, and temporary databases.
- `npm run dry` runs a full compressed active day on a temporary DB and settings with fakes (no network, no spend) and cleans up afterward.
- `npm run spend` shows today's per-model usage from `logs/spend.jsonl`.
- `npm run calibrate -- --model provider:model --runs 2` runs paid jury checks against `reference.local.json` (if present) or built-in examples.

## Server and browser

- `server/settings.ts` loads `settings.local.json` on startup and atomically replaces it when Settings is saved. Defaults come from `settings.example.json` (machine-specific paths/commands default empty in code). Keys come from environment variables.
- `server/providers.ts` routes DeepSeek, Z.ai, OpenRouter, Anthropic, OpenAI, and `crew` (`crew:<worker>[:<effort>]`). DeepSeek and Z.ai try a JSON Schema first and retry with JSON object mode plus the schema in the system prompt when a 400 rejects `response_format`. GLM uses low reasoning effort. DeepSeek uses peak rates for budget accounting. `crew` runs `python -I <crewPath>` one call at a time with a 15-minute default timeout, parses the last JSON object from `out.md`, records `$0`, and maps exit code 3 to `crew_signin` and exit code 4 / timeout to `crew_timeout`.
- `server/autopilot.ts` and `server/engine.ts` evolve automatic boards. The scheduler checks local active hours, recorded USD budgets, and `crewCallsPerDay` (default 10; pauses crew roles until tomorrow while other roles continue). Once per local day per auto board, one hour after `activeHours.start`, autopilot runs a daily deep cross (`deep` role, default `crew:neon:medium`) across up to 8 best judged ideas from >= 3 sources when available, creating 3 multi-parent `combine` ideas and judging them.
- `server/exists.ts` and `server/alert.ts`: on gold (`autoProjectOnGold`), the `exists` role (`deepseek:deepseek-flash`) writes 2–3 queries, searches GitHub and HN Algolia, and returns `exists | partial | new` (retrying failures up to 3 times on later rounds, max 1 check per idea). `exists` marks the idea without creating a folder and alerts `Existing tool found: <title>`; `partial`/`new` creates the project folder (`brief` defaults to `crew:neon:medium`), records the check in `NOTES.md`, and alerts `Gold idea: <title>`. Alerts run `alertCommand` with no shell (120 s timeout) and log to `logs/alerts.log`.
- `server/app.ts` validates the loopback Host header, requires JSON and a same-origin Origin header when present on writes, exposes `GET /api/status`, and publishes board changes over SSE.
- `server/scouts/` runs the six public scouts plus the optional `sessions` scout (`sessionsPath`, off by default). Public scouts try `judge_many --public` first and can fall back to the research model; `sessions` reads recent `*.jsonl` user plain-text messages, runs `judge_many` without `--public` (`wish >= 0.7`, `personal < 0.2`, trimmed to 300 chars), and skips the round without any cloud model fallback if `judge_many` is unavailable.
- `server/leads.ts` contains the manual Hugging Face research workflow and optional OpenRouter X scout.
- `server/project.ts` creates uniquely named project folders. Gold folders include the request stub and jury, exists-check, and source notes.
- `public/js/app.js` and `public/js/report.js` render the English interface, including the header status strip (per-board autopilot state, spend & crew calls, last scout round per source, and plain-text errors) and "Already exists" markers.
- `scripts/install-startup.ps1`, `scripts/uninstall-startup.ps1`, and `scripts/Open idea generator.url` manage the Windows login scheduled task (`conhost.exe --headless`) and local shortcut.

## Jury and compatibility

`server/llm.ts` asks the jury to score the stated idea against the board goal. Use means weekly household use. Buildable means a first version in one or two agent sessions. Fit means using the household's current devices and tools. Keep the existing SQLite columns `originality`, `feasibility`, and `impact` for those three scores. `public/js/score.js` awards bronze at 9, silver at 11, and gold at 13.

Keep score ranges in the schema descriptions and clamp scores in code. Idea generation, judging reasons, and project brief content use the idea's language with English as the fallback.
