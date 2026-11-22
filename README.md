# Idea Generator

Idea Generator evolves ideas for a household. Give a board a goal and seed it with an idea, a link, or a scout lead. Branch an idea, drag one idea onto another to combine them, or spin an idea off into its own board. The interface is in English. Generated ideas, jury reasons, and project brief content follow the source language when clear.

## Run on Windows

Use Node 24.11.1 or newer. Node executes TypeScript directly.

```powershell
npm install
npm start
npm test
npm run spend
```

Open http://localhost:8300 to use the board. The server binds to `127.0.0.1`. Set `PORT` or `DB_FILE` to override the port or database file. Incoming requests must use the local Host header. Writes require JSON and, when an Origin is sent, the same origin as the app.

Copy `settings.example.json` to `settings.local.json` to customize startup. The Settings screen edits the same file. The defaults are a $1 daily global budget, active hours from 08:00 through 21:59 local time, and the project root `~/Coding/idea-projects`. DeepSeek Flash handles distilling, branching, crossing, judging, and summaries. GLM-5.3-Flash handles research and project briefs. The X role starts empty.

Give the Node process the environment variables for the providers you use.

| Provider | Environment variable |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Z.ai | `ZAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

Automatic boards with seeds resume after startup without a browser connection. Set a board to Automatic and leave the server running. Autopilot checks active hours, board and global recorded spend, error backoff, hourly steps, and pace before starting each step. In-flight steps may finish after the end time or take spend past the threshold. Manual requests remain available. Provider calls are logged in `logs/spend.jsonl`, and `npm run spend` totals today's calls, tokens, and USD by model. Unknown prices are recorded as zero. Settings and spend logs are gitignored.

## Boards, scouts and jury

- Each board has its own goal, creation prompts, model overrides, limits, and jury guidance.
- The research scout ranks Hugging Face papers against the board's goal. To enable the optional X scout, configure an OpenRouter Grok model for the X role. The scout keeps posts backed by search citations.
- The jury scores **Use**, **Buildable**, and **Fit** from 1 to 5 each. Bronze starts at 9, silver at 11, and gold at 13. The default judge is provisional. Run `npm run calibrate` or pass `-- --model provider:model` to check your chosen judge against the provisional reference ideas. Calibration makes paid calls.
- Board summaries and the cross-board report can be exported as Markdown.
- A gold idea can generate a project folder automatically. It includes a brief in `CLAUDE.md`, `README.md`, `idea.json`, `JER-ASKED.md`, `NOTES.md`, and a gitignored `vault/`. Existing folders are preserved and name collisions get numbered suffixes.

## License

MIT
