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
| Config file + first mover (20 Oct 2026) | agent main | done — all game constants moved to `config/game.properties` (generated into `shared/src/config.generated.ts` by `npm run gen:config`, run by pretest/build/predev); budget W₹50,000, costs 2,000/400 (SUPERSEDED 2026-10-25: rally 8,000, roadshow 400), report prices 800–1,800 / 2,800–6,200 (plain numbers, no crore); first mover's advantage added to `computeEffects` (`effects.firstMover.rally/roadshow`). Sim not re-tuned |
| E Simulator + tuning | agent E | done — WORLD_CONFIG tuned (rally W₹2 cr, roadshow W₹0.4 cr, s=3, c=0.01, …) (SUPERSEDED 2026-10-25: old effect maths; retune with the new rules in sim/REPORT.md); risks R1 (2-player c-war), R3 (late wins ties), R5 (reports unprofitable) await designer |
| F Server handlers (core + AWS adapters + local dev server :8787) | agent F | done — 44 tests pass, tsc clean, all 8 handlers bundle; hello sent after client's first message; OPEN QUESTION markers in core/gameService.ts |
| G Wiring web↔server + bot & browser e2e (game/e2e) | agent G | done — web runs on real server (`?server=local`); bots e2e PASS (2/3/4/6 players), browser e2e PASS; server tests 173, engine 60 |

## Next (not started)
- Deploy to AWS dev stage (needs the user's AWS credentials; `cdk bootstrap` + `cdk deploy -c stage=dev`), then run e2e/bots.ts against it.
- Designer decisions pending: R1/R3/R5 (docx comment), disconnect-after-polling rule.
- Settled (21 Oct 2026): a government is confirmed only once every seat is declared (or on acceptance later in post-counting) and the game then finishes at once; a government can never include every party; chat is one group chat open from the campaign start (flag `messaging.opensAt`, `messaging.mode`); offers stay private. e2e (bots.ts, browser.ts, README) updated; not yet re-run.
- Small UI: disable campaign buttons during the 5 s start lead-in.
| H DynamoRepo/AWS adapter tests with in-memory DDB fake | agent H | done — server suite 172 tests; fixed 3 aws/ bugs (report SK collision, broadcast to pending, schedule Conflict); residual risks listed in progress/agent-H.md |
| R Repo restructure: `maps/` + `game/` | agent R | done (2026-10-20) — site/build/data/output moved to `maps/world-500/{site,source}`; map id `world` → `world-500` everywhere; generic map registry (`npm run gen:maps`, MAP_MANIFESTS / GAME_PACKAGES, `configForMap`); web serves/copies `/maps/<id>/...`; CDK Web stack no longer deploys separate map data; workflows retargeted. See progress/agent-R.md |
| T Tests / TDD / CI | agent T | done (2026-10-20) - coverage-gap script, ~1000 new tests (shared, server, agent, sim, maps pytest), `npm run build/test:e2e/verify`, `.github/workflows/ci.yml`, pre-push hook; see progress/agent-T.md |
| N Global reports by news agencies (Oct 2026) | core + server + web + mock/tour/agent agents | core (`shared/src/engine/newsAgencies.ts`, `news.*` config, `globalReports` message) done; mock (`net/mock.ts`), tour (`net/tour.ts` scripted series that moves toward the practice result, one extra point per action, plus tour step `global-reports`), agent tool `get_global_reports` + RULES section 5a + README, FR docx section "Global reports by news agencies" done with tests; server handler, web modal and bot/browser e2e are owned by other agents; integration build + e2e still to run by the coordinator |
| N2 Global reports review fixes (Oct 2026) | 1 agent | done - noise seeds now mix in a server-only per-game `GameRecord.newsSecret` (made at creation, lazily for older games, never sent; engine input `GlobalReportsInput.secret`; the analyst / poll / committed seeds `${gameId}:analyst|poll|committed...` are still reproducible from the public game id: out of scope, flagged); free button renamed **News agencies** (the paid one stays "Global report (price)"); `GameService` cache of the built reports (key = game, secret, last sample time, contenders, eliminated, actions up to that time, closed poll results; counter `newsBuilds`; no per-player rate limit: no pattern for free reads, API Gateway throttles); modal polls just after each sample-grid time in server time (`web/src/lib/newsPoll.ts`) and stops at the campaign end; `news.errorWobbleMin/Max` configurable; FR docx: panel is on the campaign screen, frozen series stays available to the agent tool / server; earlier points can change only when a player leaves / is eliminated |
| Committed voters + new vote model (2026-10-23) | coordinator + 4 agents | done - 6 bands per party (30/25 HIGH, 20/15 MEDIUM, 10/5 LOW; 5/7/10/15/20/30 seats = 87), dealt at admission by a breadth-first walk from a distinct random core (`engine/committed.ts`, 60% per-seat cap, `committedSeq` guard); votes = committed + influence (0-40% of committed) + randomness (0-5% of uncommitted) + reputation (`engine/votes.ts`, `randomSwing` removed, every seat has a winner); own bands only in `PrivateState.committed`, shaded on the campaign map, "~30% · HIGH" in the seat panel, in the agent tools and RULES.md. Sim: landslides (>80%) 2p 54->51%, 3p 39->32%, 5p 30->20%, 10p 12->4%; all-rally still dominates 2-5 players (this was under the old effect rules, see the 2026-10-25 entry) |
| Own reputation shown (2026-10-23) | 1 agent | done - each player sees their OWN reputation among swing voters (`reputationView` in `engine/effects.ts` = round(effect x `display.reputationScale`, default 10 at the time; now 4, see the 2026-10-25 entry), zeros omitted): party-coloured badge with the number on every campaign-map seat (0 at start, only grows), "Reputation N among swing voters" in the seat panel, `PrivateState.reputation` + `actionAck.reputation` (own only, hidden-info audit extended), agent `get_seat` -> `my_reputation` + RULES.md |

## Log

### 2026-10-26 - Report switches, guided tour, reputation smoke, coalition fix
- **Reports switched off.** `analyst.seatReport.enabled` / `analyst.globalReport.enabled` (both `false`) in `config/game.properties`; gen-config now supports booleans (exactly `true`/`false`). Server refuses with `FORBIDDEN`; web hides Local report and the Analyst card; agent `buy_report` prechecks; RULES.md renders "currently switched off"; e2e bots/sim skip reports. Tests that buy reports turn them on (`server/test/helpers.ts`, `agent/test/reportsFlag.ts`, `web/test/fakeMap.ts`).
- **Bug: coalition with a no-portfolio partner never formed.** `validateGovernment` counted only portfolio holders, so an accepted offer that needed a partner "invited without a portfolio" was rejected by `formGovernment`, and the game waited for the end of post-counting and ended with no government. It now takes `extraMembers` (the offer's partners); regression tests in `server/test/governmentTiming.test.ts`.
- **Reputation smoke.** `store.repGain` (deltas of the shown reputation on a rally/roadshow ack) → `lib/repSmoke.ts` `selectSmoke` (rally: seats inside the Gaussian kernel get their own "+N", the rest one "Every other seat +G" label) → `SeatMap` `gains` prop (CSS animation in `SeatMap.css`).
- **Guided tour** (`?tour`, "Take a tour" on Home, opens a new tab): offline `net/tour.ts` `TourTransport` (real engine, 9 parties, 0:00 clocks, scripted result 249 / you 110 / 30 28 25 20 17 12 9 scaled by seat count, count pauses until you offer posts to all 7 smaller parties) + `tour/` overlay with 20 steps (numbers from the config). Requirements docx updated (Guided tour section, reputation smoke, report switches, partners without a portfolio).

### 2026-10-25 - Invite link + mobile-safe copy
- Lobby "Copy code" now works on phones: `web/src/net/share.ts` `copyText` (async Clipboard API, then hidden-textarea `execCommand` fallback for http/iOS), "Copied!"/"Copy failed" feedback, and it copies the displayed code (was `''` when the store `joinCode` was null).
- Invite link `…/?join=CODE` (`buildJoinLink`, keeps `server`/`mock`, drops `as`): "Copy invite link" + a "Share" button where `navigator.share` exists. Home prefills the code and shows an invite banner (nickname still required); `?join` is cleared after joining. `resumeSession` skips a saved game when the link is for a different one (the saved session is replaced on a successful join). Requirements docx updated (Game setup).

### 2026-10-25 - Gaussian spread, rally cooldown, new costs and display scale
Rules are in `../FEATURE REQUIREMENTS.docx` (updated in the body); numbers in `config/game.properties`. Code, tests and UI for these rules are being changed by other agents, so check `git log` and their notes before relying on any of it.
- **Spread (replaces the exponential half-distance decay).** x = distance between seat centres / `effects.distanceUnitKm` (100 km).
  - Rally: every seat gets `effects.rally.global` (0.25); the held seat and nearby seats get `effects.rally.local` x exp(-`effects.rally.decay.spread` x x^2) (10, spread 0.5), zero beyond `effects.rally.decay.maxKm` (400 km). The held seat reads 10.25.
  - Roadshow: `effects.roadshow.local` x exp(-`effects.roadshow.decay.spread` x x^2) (6, spread 2.8), zero beyond `effects.roadshow.decay.maxKm` (160 km). No global part.
  - Removed: `capRatio` and `halfDistanceKm` (a Gaussian never exceeds its peak, so no cap is needed).
  - Changed values: rally global 0.1 -> 0.25; rally local 3 -> 10; rally maxKm 3000 -> 400; roadshow local 4 -> 6; roadshow maxKm 200 -> 160.
- **Costs.** `costs.rally` 2,000 -> 8,000; `costs.roadshow` stays 400; budget 50,000 gives up to 6 rallies or 125 roadshows. Derivation (real seat centres, every seat as the home seat, summed over the 500 seats): rally = 0.25 x 500 + 16.27 = 141.3; roadshow = 6.28; one rally = 22.5 roadshows. The designer chose 20 roadshows (8,000), which is 0.89 of 22.5 and just above the 0.80-0.85 band (7,190-7,640 at a roadshow of 400); 7,500 would sit in the band. About 89% of a rally's total comes from the 0.25 floor. The time multiplier cancels out of the ratio.
- **Rally cooldown.** `cooldowns.rallyMs` = 30,000: one player may rally at most once every 30 s, because the leader must be present. Roadshows have no cooldown. An early rally is refused and costs nothing (HTTP 429 `RATE_LIMITED`).
- **Display.** `display.reputationScale` 10 -> 4: a player's own reputation = round(effect x 4), so the 0.25 floor shows as 1 and a rally in its own seat as 41.
- **Unchanged.** Time bonus (1.0 -> 1.05), first-mover bonus (`effects.firstMover.rally/roadshow` = 0.2 each), analyst prices, committed voters, voting model.
- **Retune.** Balance results under the new rules are in `game/sim/REPORT.md` (written by another agent); read that file rather than the old numbers above.

