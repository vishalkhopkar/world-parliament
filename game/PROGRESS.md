# HUNG PARLIAMENT — build progress

Rules source of truth: `../FEATURE REQUIREMENTS.docx`. Technical plan: see CLAUDE.md "Game feature" section and the plan below.

## Layout
- `shared/` — contract (types.ts, protocol.ts, mapConfig.ts, presets.ts) + engine (`src/engine/`). Pure TS, no AWS.
- `server/` — Lambda handlers + DynamoDB repo.
- `web/` — React + Vite + d3 SeatMap.
- `infra/` — AWS CDK (ap-south-1).
- `sim/` — balance simulator (tunes WORLD_CONFIG).
- `../maps/<id>/source/build/07_game_map.py` → `../maps/<id>/site/data/game.json` (centroids, neighbours, phase groupings k=1..5). Maps live in `../maps/<id>/` (manifest `map.json`); `npm run gen:maps` (scripts/gen-maps.ts) validates them and writes `shared/src/maps.generated.ts` (MAP_MANIFESTS) + `server/src/maps.generated.ts` (GAME_PACKAGES).
- Per-agent notes: `progress/<agent>.md`.

## Rules for agents
- Do NOT run `npm install` (deps are pre-installed at `game/`); if a package is missing, say so in your report.
- Do NOT change `shared/src/{types,protocol,mapConfig,presets}.ts` or engine signatures in `shared/src/engine/index.ts` without the coordinator; propose changes in your report.
- **Test-driven (designer's rule):** write the tests first for every rule / route / action / map-data change; `npm run build` (runs gen:maps, typecheck, every workspace's tests, pytest over `../maps`, web build) must pass before you report done, `npm run test:e2e` for anything that touches the protocol or the UI. New workspaces need a `test` script (`vitest run`) and a `typecheck` script. CI (`.github/workflows/ci.yml`) runs the same on every push.
- Do not commit. Map files live in `../maps/<id>/` (study site in `site/`, editing toolkit in `source/`); don't edit them from game work except via the pipeline.

## Status
| Step | Owner | Status |
|---|---|---|
| 0 Contract, workspace, deps, docx decisions | coordinator | done (2026-10-19) |
| A Engine + tests | agent A | done — 60 vitest tests pass, tsc clean; perf: kernels ~25 ms, 5000 actions ~15 ms |
| B Map package (07_game_map.py) | agent B | done — validation passes; 10 ferry links incl. explicit North Atlantic 463–403; groups k=1..5 balanced (±1) & contiguous, ordered east→west |
| C Infra (CDK) | agent C | done — synth OK dev/prod (stacks Data, Web, Api[+orchestration]; optional GithubOidcStack); see infra/README.md. phase-close gets 1-based phase; env SCHEDULE_GROUP added |
| D Web scaffold | agent D | done — all screens on mock transport (src/net/mock.ts); tsc + build OK; real transport plugs in via setTransport() in src/net/client.ts |
| E Simulator + tuning | agent E | done — WORLD_CONFIG tuned (rally W₹2 cr, roadshow W₹0.4 cr, s=3, c=0.01, …); see sim/REPORT.md; risks R1 (2-player c-war), R3 (late wins ties), R5 (reports unprofitable) await designer |
| F Server handlers (core + AWS adapters + local dev server :8787) | agent F | done — 44 tests pass, tsc clean, all 8 handlers bundle; hello sent after client's first message; OPEN QUESTION markers in core/gameService.ts |
| G Wiring web↔server + bot & browser e2e (game/e2e) | agent G | done — web runs on real server (`?server=local`); bots e2e PASS (2/3/4/6 players), browser e2e PASS; server tests 173, engine 60 |

## Next (not started)
- Deploy to AWS dev stage (needs the user's AWS credentials; `cdk bootstrap` + `cdk deploy -c stage=dev`), then run e2e/bots.ts against it.
- Designer decisions pending: R1/R3/R5 (docx comment), early finish once a government forms, chat history on reconnect, disconnect-after-polling rule.
- Small UI: disable campaign buttons during the 5 s start lead-in.
| H DynamoRepo/AWS adapter tests with in-memory DDB fake | agent H | done — server suite 172 tests; fixed 3 aws/ bugs (report SK collision, broadcast to pending, schedule Conflict); residual risks listed in progress/agent-H.md |
| R Repo restructure: `maps/` + `game/` | agent R | done (2026-10-20) — site/build/data/output moved to `maps/world-500/{site,source}`; map id `world` → `world-500` everywhere; generic map registry (`npm run gen:maps`, MAP_MANIFESTS / GAME_PACKAGES, `configForMap`); web serves/copies `/maps/<id>/...`; CDK Web stack no longer deploys separate map data; workflows retargeted. See progress/agent-R.md |
| T Tests / TDD / CI | agent T | done (2026-10-20) - coverage-gap script, ~1000 new tests (shared, server, agent, sim, maps pytest), `npm run build/test:e2e/verify`, `.github/workflows/ci.yml`, pre-push hook; see progress/agent-T.md |
