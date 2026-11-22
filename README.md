# Idea Generator

Idea Generator evolves ideas for a household. Give a board a goal and seed it with an idea, a link, or a scout lead. Branch an idea, drag one idea onto another to combine them, or spin an idea off into its own board. The interface is in English. Generated ideas, jury reasons, and project brief content follow the source language when clear.

## Run on Windows

Use Node 24.11.1 or newer. Node executes TypeScript directly.

```powershell
npm install
npm start
npm test
npm run dry
npm run spend
```

Open http://localhost:8300 (or copy `scripts/Open idea generator.url` to your desktop) to use the board. The server binds to `127.0.0.1`. Set `PORT` or `DB_FILE` to override the port or database file. Incoming requests must use the local Host header. Writes require JSON and, when an Origin is sent, the same origin as the app.

To start the server automatically at Windows login (hidden, restarts up to 3 times on failure, below-normal priority):

```powershell
powershell -File scripts\install-startup.ps1
```

To remove the scheduled task:

```powershell
powershell -File scripts\uninstall-startup.ps1
```

Copy `settings.example.json` to `settings.local.json` to customize startup. The Settings screen edits non-path settings in the same file; paths and commands (`judgeManyPath`, `crewPath`, `alertCommand`, `sessionsPath`) must be edited in `settings.local.json`. Defaults are a $1 daily global budget, active hours from 08:00 through 21:59 local time, `crewCallsPerDay: 10`, and `~/Coding/idea-projects`. DeepSeek Flash handles distilling, branching, crossing, judging, summaries, and already-exists checks. GLM-5.3-Flash handles research. `crew:neon:medium` handles project briefs and daily deep crosses. The X role starts empty.

Give the Node process the environment variables for the providers you use:

| Provider | Environment variable |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Z.ai | `ZAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

For `crew:<worker>` or `crew:<worker>:<effort>` (`neon` or `hydrogen`, effort `low|medium|high|xhigh`), set `crewPath` in `settings.local.json` to the absolute path of your crew runner script. Crew calls run one at a time across the app with a 15-minute default timeout, record `$0` spend, and respect `crewCallsPerDay` (default 10 across all boards). When the cap is reached, roles using crew pause until tomorrow while other roles continue.

Automatic boards resume after startup without a browser connection. The header status strip shows autopilot state per board, today's spend in dollars and crew calls used, last scout round time per source, and any errors. Provider calls are logged in `logs/spend.jsonl`, and `npm run spend` totals today's calls, tokens, and USD by model. Settings, `reference.local.json`, and logs are gitignored.

## Boards, scouts, deep cross, and gold checks

- Each board has its own goal, creation prompts, model overrides, limits, and jury guidance.
- After two minutes, the server starts due scouts during active hours. Defaults under `scoutIntervalsHours` are 6 h for GitHub Trending, 12 h for new GitHub repos, 3 h for Hacker News, 6 h for Lobsters, 24 h for Hugging Face daily papers, 6 h for Google News, and 12 h for local sessions. To check the six public sources once, run `npm run scouts:once`. GitHub search accepts an optional `GITHUB_TOKEN`.
- Set `judgeManyPath` in `settings.local.json` to an absolute path such as `C:/path/to/judge_many.py` and describe household interests in `interests`. Public finds are scored via `judge_many --public` with fallback to the research model.
- **Sessions scout (off by default):** Set `sessionsPath` in `settings.local.json` to scan `*.jsonl` files modified in the last 3 days for plain-text user messages. It sends them to `judge_many` without `--public` (questions `wish` and `personal`), keeping `wish >= 0.7` and `personal < 0.2` trimmed to 300 characters around the wish. It never falls back to a cloud model if `judge_many` is unavailable.
- **Daily deep cross:** Once per local day per automatic board, one hour after `activeHours.start`, autopilot picks up to 8 of the board's best judged ideas across at least 3 sources (when available), asks the `deep` role (`crew:neon:medium`) for 3 ideas joining two or more of them, adds them as `combine` ideas with edges to all parents, and judges them normally.
- **Already-exists check & alerts:** Before creating a project folder for a gold idea, the `exists` role queries GitHub and HN Algolia and returns `exists`, `partial`, or `new` (at most once per idea; failures retry up to 3 times on later rounds). `exists` marks the idea without creating a folder and runs `alertCommand` with `Existing tool found: <title>`. `partial` or `new` creates the project folder (`CLAUDE.md`, `README.md`, `idea.json`, `JER-ASKED.md`, `NOTES.md` with check results, and `vault/`) and runs `alertCommand` with `Gold idea: <title>`. `alertCommand` is an argv array in `settings.local.json` (empty disables alerts), e.g. `["python", "-I", "C:/path/to/send_alert.py", "{title}"]`, run with no shell and logged to `logs/alerts.log`.
- **Judge calibration:** Run `npm run calibrate -- --model provider:model --runs 2`. Reads `reference.local.json` (`{strong, weak}`) if present or built-in examples, and checks all 4 pass criteria plus spend-log cost.

## License

MIT
