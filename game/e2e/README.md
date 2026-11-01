# End-to-end tests

**One command: `npm run test:e2e`** (from `game/`). It runs everything below with no manual server handling:

1. `e2e/bots.ts` for **2 players and 3 players in parallel**, each against its own freshly started dev server on a free port
   (pre-campaign 15 s for 3+ players, campaign 45 s, counting 20 s, post-counting 15 s, lead-in 2 s) - about 90 s;
2. `e2e/browser.ts` (headless Chrome through the real UI; it starts its own dev server on :8787 and Vite on :5173, so both ports must be free, or set `E2E_API_PORT` / `E2E_WEB_PORT`; pre-campaign 45 s) - about 130 s.

`scripts/e2e.ts` starts and stops only the processes it started (by PID, whole process tree; never by image name) and exits 0 only
if everything passed. Options: `--players=2,3`, `--phases=2`, `--skip-bots`, `--skip-browser`; env `CHROME_PATH` (auto-detected:
Windows Chrome, `/usr/bin/google-chrome`, chromium, macOS Chrome), `VERBOSE=1`. It runs in CI as job `e2e` of `.github/workflows/ci.yml`
(screenshots in `e2e/shots/` are uploaded as an artifact when it fails). `npm run verify` = `npm run build` + `npm run test:e2e`.

Unit and integration tests (`npm test`, `npm run test:maps`) are described in the root README, section "Tests and builds".

---

The scripts can also be run by hand (below). Both run from `game/` with `npx tsx` (no extra packages; they use Node 24 `WebSocket`, `playwright-core` and the local Chrome).

## 1. Bot clients (`bots.ts`) - protocol/rules test

Connects N scripted clients to a **running** server over REST + WebSocket and asserts the rules and the hidden-information
invariants (no budget/roadshow/report data of others, overspending and polled-seat actions rejected, every seat declared,
points = `finalResult` rules, opposition scores 0, reconnect restores state, offers only to participants).

Pre-campaign (3+ players, `HP_PRECAMPAIGN_MS`): lobby -> `preCampaign` (budget = `CFG.budget`) -> `campaign`. Checked: rally / minor rally /
roadshow / reports / news agencies are `WRONG_PHASE` during it; `field` and `withdraw` answer the sender with `fieldAck` (budget -/+ `costs.candidate` per
seat) and everybody else with `fieldingUpdate` (carrying contestedSeats and majority); bad input is `BAD_REQUEST`; seats already fielded or never
fielded are skipped without a broadcast; the chat is one-to-one. Then every bot fields every seat except two VACANT ones, so the server must announce
`contestedSeats` = seats - 2 and `majority` = floor(contested / 2) + 1 (also in a reconnect hello), `tally.total` and the declared seats equal the contested
seats, vacant seats are never declared, points use the contested seats, `field` / `withdraw` during the campaign are `WRONG_PHASE` and a rally, minor
rally or roadshow in a vacant seat is `NOT_FIELDED` and free. A separate 3-party game on the same server checks elimination: the party that fields
nothing (it fields a seat and withdraws it for a refund) is eliminated at the deadline, stays connected, can chat but not act (`FORBIDDEN`), the contested
seats / majority follow what the others fielded, and the game does not end. A 2-player game has no pre-campaign: it starts in `campaign` on
`fullyFieldedBudget(CFG)` with every seat fielded by both parties (`fieldingUpdate` per party), and Play again lands in `preCampaign` (3+) or `campaign` (2).
The minor rally has no cooldown (two in a row, and right after a rally, are acked), costs `costs.minorRally`, and never reaches the news or another
player's messages (the raw-string leak check covers `minorRally` like `roadshow`).

Government flow it checks (3+ players): the chat follows `Chat.Campaigning` (default: the one group chat is open from the campaign start) and from counting always one-to-one (only the recipient gets a message, a recipient is required) (2 players: `NEGOTIATION_DISABLED`);
proposals are `WRONG_PHASE` before counting; an all-parties government is rejected with `INVALID_GOVERNMENT` ("At least one party must stay out");
the bots then wait until every seat is declared, form the smallest majority coalition that leaves at least one party out (if only
an everyone-coalition would reach a majority they assert that no government forms), and the government is confirmed on acceptance
and the game finishes at once: `government` then `result` arrive immediately (no waiting for the end of post-counting); later
`proposeGovernment` is `WRONG_PHASE`, `withdrawOffer` is `OFFER_NOT_FOUND`; the left-out parties score the opposition points.

Rally cooldown and budget (from `WORLD_CONFIG`, `config/game.properties`; the numbers are read from the config, not fixed here): a player may rally
only `cooldowns.rallyMs` after their previous accepted rally; roadshows and minor rallies have no cooldown. The e2e clients run on real time against a local server, so they pace themselves: every bot sends a rally only when
`Date.now() >= nextRallyAt + 600 ms`, taking `nextRallyAt` from the previous `actionAck` (or `retryAt` of a `RATE_LIMITED` error), and
plays roadshows in between, so every action is acked. Each bot's first rally is followed at once by a second one, which `bots.ts` asserts is `RATE_LIMITED` with a `retryAt` about `cooldowns.rallyMs` ahead.
Bot 0's pre-drain stream plays roadshows only, so its final "rally with an empty purse" still gets `INSUFFICIENT_FUNDS` (the cooldown
check would come first if it had rallied within the cooldown). `player2.ts` follows the same pacing (a rally every ~5th action but never
inside the cooldown; with 3+ players it first fields every seat). The browser test clicks one rally then one roadshow per party; the UI shows the rally button as a cooldown after use.

```bash
# terminal 1: local server with a short game (pre-campaign 15 s, campaign 45 s, counting 20 s, post-counting 15 s)
cd game/server
HP_PRECAMPAIGN_MS=15000 HP_CAMPAIGN_MS=45000 HP_COUNTING_MS=20000 HP_POST_MS=15000 HP_START_DELAY_MS=2000 npm run dev
# (PowerShell: $env:HP_CAMPAIGN_MS=45000; ... ; npm run dev)

# terminal 2
cd game
npx tsx e2e/bots.ts --players 3                  # takes ~85 s
npx tsx e2e/bots.ts --players 6 --phases 3
npx tsx e2e/bots.ts http://localhost:8787 --ws ws://localhost:8787/ws --players 4 --phases 2 --seed 42
```

Options: first positional = REST base URL (default `http://localhost:8787`), `--ws` (default: base with `/ws`),
`--players` 2-10 (default 3), `--phases` 1-5 (default 2; the polled-seat check needs >= 2), `--seed` (random choices).
Exit code 0 = PASS, 1 = failed checks (listed). The map package is read from `maps/world-500/site/data/game.json`;
costs and points come from `WORLD_CONFIG`, so run it against a server using the same config.

## 2. Browser test (`browser.ts`) - the real UI

Starts its own dev server (:8787, short timings) and Vite (:5173) as child processes, opens three headless-Chrome contexts
and plays a game through the UI with `?server=local` (create / join / admit / party / start, then the **pre-campaign**: real mouse strokes paint candidates (brush cursor, red -50 smoke, figures, live counts and budget), a click on a fielded seat opens the panel, Withdraw (green +50 smoke) and Field switch it while it stays open, a one-to-one chat that only the recipient reads, the chat filling the side panel, a phone context (touch: no brush, tap a seat, Field), a reload back into the pre-campaign; then the campaign with seats the party fielded only (a seat without a candidate is dimmed and its actions say "No candidate here"; minor rally, roadshow, major rally checked through the budget, minor rally not in the news, the My actions panel hidden), rallies, roadshows, reports,
page reload rejoin, campaign-phase group chat with an @ tag (the tagged party sees its tag highlighted), counting with one-to-one chats (a message reaches only its recipient), an all-parties offer blocked by the UI (Send disabled + "At least one party must stay out of the government."), a two-party coalition offer (the third party stays in opposition) once every seat is declared, accept, and the Result screen ("Coalition government") that replaces the Counting screen at once). Only the processes it started are killed.

```bash
cd game
npx tsx e2e/browser.ts            # ~110 s; ports 8787 and 5173 must be free
VERBOSE=1 npx tsx e2e/browser.ts  # also print server / vite output
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npx tsx e2e/browser.ts
```

Screenshots go to `e2e/shots/` (git-ignored): `01-home`, `02-lobby-admin`, ... `05a-precampaign-painted`, `05b-precampaign-panel`, `05c-precampaign-phone`, `08c-counting-chat-phone`, `09a-offer-everyone-blocked`, `09-offer`, `09b-offer-phone`, `11-result-admin`, `12-result-c`, `13-play-again-admin` (there is no longer a "Government formed" shot: the game finishes immediately); Play again lands everybody in a fresh pre-campaign where they field again;
`fail-A/B/C.png` are written when a step fails.

## Web app against a server by hand

```bash
cd game/server && npm run dev                  # API + WebSocket on :8787
cd game/web && npx vite --port 5173            # open http://localhost:5173/?server=local
```

`?mock` forces the in-browser mock; `?as=name` keeps a separate saved session per name (several players in one browser
profile: `?server=local&as=ben`). Deployments set `VITE_API_URL` / `VITE_WS_URL` (see `web/.env.example`).
