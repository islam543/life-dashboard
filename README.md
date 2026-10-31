# Life dashboard

One local screen that answers "what needs me right now?" and "how is my life going?".
It runs only on this PC: a small Node server collects data into `data/` and serves an API
plus the web app on `http://127.0.0.1:4317`. Nothing listens on any other address.

Product thinking: `PLAN.md`. How it is built: `docs/ARCHITECTURE.md`.

## Install

Needs Node 24 or newer.

```sh
npm install
```

## Run

| Command | What it does |
|---|---|
| `npm run dev` | API server (auto restarts on change) plus the Vite dev server. Open http://127.0.0.1:5173 |
| `npm run build` | Builds the web app into `web/dist` |
| `npm start` | Runs the server, which also serves `web/dist`. Open http://127.0.0.1:4317 (run `npm run build` first) |
| `npm run collect` | Runs every collector once, saves `data/snapshot.json`, prints each source's status, exits |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | TypeScript check for server, shared contract and web app |

While the server runs, collectors refresh on start and every 30 minutes, and the AI
"next moves" run every 3 hours. The refresh button in the app runs collectors right away.

If the server says port 4317 is already in use, another copy is running. Stop it first.

## Connect your sources

Copy `.env.example` to `.env` (it is gitignored) and fill it in.

### Jira

1. Go to id.atlassian.com, then Security, then API tokens, and create a token.
2. In `.env` set `JIRA_EMAIL` to your Atlassian login email and `JIRA_API_TOKEN` to the token.
   `JIRA_SITE` defaults to `qicbizdev.atlassian.net`.
3. Restart the server. Until both values are set, the Jira panel shows "not connected".

The token stays in `.env` on this PC. The server never logs it and never sends it to the web app.

### GitHub

The GitHub collector uses the `gh` CLI. If it reports an error, run `gh auth login` in a terminal.

### Claude (AI next moves)

Next moves run `claude -p` with your normal Claude Code login, so there is no separate API key.
If the panel says you are not logged in, open a terminal, run `claude`, complete the login,
then press "run" in the Next moves panel.

### Learning, sessions, vault

`LEARNING_DIR`, `VAULT_DIR` and `CLAUDE_PROJECTS_DIR` in `.env` point at local folders.
The defaults match this PC; change them only if the folders move.

### Notes

Notes written in the dashboard are markdown files in `NOTES_DIR` (default `VAULT_DIR/notes`,
so Obsidian sees them). Sections are folders. Deleting a note moves it to `NOTES_DIR/.trash`;
nothing is deleted for good. If the folder (or the vault above it) is missing, the Notes view
says "not connected" and names the folder it looked for.

## Data

Everything the server collects is saved as JSON in `data/` (gitignored): `snapshot.json`,
`checkins.json`, `next-moves.json`, and `projects.json` (the project tracker, seeded on first
run from your Claude session time). Writes are atomic. A corrupt file is copied aside as
`<name>.corrupt-<time>` and the app carries on with empty data.

## Views

`#/` Home, `#/projects` project tracker (`#/projects/<id>` one project), `#/notes` notes
(`#/notes/<path>` one note), `#/map` Life map. The API routes are listed in `docs/ARCHITECTURE.md`.
