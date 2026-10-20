# World Parliament

The world split into parliament seats of roughly equal population (500 seats of ~16.6 m people each today), and a
multiplayer mock-election game played on those maps.

## Two main folders

- **`maps/`** - one folder per map. `maps/world-500/` is the current map. Each map has
  - `site/` - the static study website (seat names, population, internal divisions covered, zoomable map),
  - `map.json` + `thumbnail.jpg` - manifest and picture used by the game,
  - `source/` - the editing toolkit (master seat CSV, pipeline scripts, boundary data, reference files) - not needed to view the map.

  See [`maps/README.md`](maps/README.md) (what a map folder must contain, how the game finds maps, how to add one) and
  [`maps/world-500/source/README.md`](maps/world-500/source/README.md) (how to edit seats / geometry and rebuild).
- **`game/`** - HUNG PARLIAMENT, the election game (npm workspaces: `shared` engine + contract, `server`, `web`, `infra` AWS CDK, `sim`, `agent`, `e2e`).
  It reads maps from `maps/` generically. Status: [`game/PROGRESS.md`](game/PROGRESS.md); rules: `FEATURE REQUIREMENTS.docx`.

Other root files: `CLAUDE.md` (project guide), `.claude/` (skills, e.g. `/name-change`), `.github/workflows/` (Pages + game deploy).

## Run

- Study website: `cd maps/world-500/site && python -m http.server 8000` -> http://localhost:8000
  (live: https://vishalkhopkar.github.io/world-parliament/, deployed from `maps/world-500/site/` by `.github/workflows/pages.yml`).
- Game, local: from `game/`: `npm run gen:maps`, then `cd server && npm run dev` (REST :8787, WS /ws) and `cd web && npx vite`
  -> http://localhost:5173/?server=local (`?mock` = offline mock). Tests: `npm test` in `game/` (see "Tests and builds" below).
  Map files are served by Vite at `/maps/<mapId>/...`.

## Tests and builds (test-driven development)

Rule of the project: **write the tests first, and every build runs all of them** - locally and in GitHub Actions.
Every change to rules, server, agent tools, simulator or map data needs a failing test first, then the fix.

| Command (from `game/`) | What it does |
|---|---|
| `npm test` | `gen:maps` (map registry), then the unit + integration tests of every workspace: `shared` (engine), `server` (GameService, REST, WebSocket, lifecycle, AWS adapters, dev server), `web` (React), `agent` (MCP/CLI tools), `sim` (simulator smoke) |
| `npm run test:maps` | pytest over **every** `maps/<id>/` folder: manifest, seats.json, game package (neighbours, phase groups), topojson ids, master CSV, step 01 parser; tests that need the big git-ignored boundary data (`source/GEO`, `source/data/ne0`) run locally and **skip themselves** in CI |
| `npm run typecheck` | `tsc` in every workspace + `scripts/` + `e2e/` |
| `npm run build` | `gen:maps` -> `typecheck` -> `npm test` -> `test:maps` -> web production build. **A build always runs the tests first.** |
| `npm run test:e2e` | end-to-end: bot clients (2 and 3 players, own dev server on a free port, short timings), then the browser test (headless Chrome through the real UI) |
| `npm run verify` | `build` + `test:e2e` (everything CI does) |
| `npm run test:gaps` / `npm run check:gaps` | list of public functions / error codes / routes / actions that no test mentions; `check:gaps` fails on any (part of `build` and CI) |
| `npm run check:maps` | fails if the committed map registry (`maps.generated.ts`) is stale |

Coverage: `@vitest/coverage-v8` is not installed, so there are no line-coverage numbers; `npm run test:gaps` is the substitute.

**Run the tests before every push automatically** (once per clone; nothing global is changed):
`git config core.hooksPath .githooks` - the `pre-push` hook runs `npm run build` (add `HP_PREPUSH_E2E=1` to include the e2e run;
skip in an emergency with `git push --no-verify`).

**GitHub Actions** (`.github/workflows/ci.yml`, on every push and pull request): job `test` = registry stale-check, typecheck, all
workspace tests, pytest maps, web build, `cdk synth`; job `e2e` (needs `test`) = bots + browser test on the runner's Google Chrome,
screenshots uploaded as an artifact when it fails. `game-deploy.yml` calls CI first and deploys only if it passes;
`pages.yml` (static map site) is gated by the maps pytest suite.

## Maps in a nutshell

- Rename a seat: edit `name` in `maps/world-500/site/data/seats.json` (or the `/name-change` skill). No rebuild.
- Change territory or geometry: edit `maps/world-500/source/output/world_parliament_500_T_K_v2.csv`, then run the pipeline in
  `maps/world-500/source/build/` (needs the third-party boundary data in `source/GEO/` and `source/data/ne0/`, git-ignored).
- Add a map: new `maps/<id>/` folder with `map.json`, then `cd game && npm run gen:maps`.
