# Simulator report: world map tuning

## 2026-10-25: Gaussian rally and roadshow, rally = 20x roadshow, rally cooldown

**Verdict in one paragraph.** The new maths does what it was meant to do (a roadshow now holds exactly the seat it lands in, rallies no longer flood the map), and roadshow-only play is about 3x better off than before (22% -> 30% of seats in a duel, 12% -> 21% with 3 players). But the game is still **not balanced for 2 to 5 players**: an all-rally player wins 100% / 86% / 71% of 2 / 3 / 5-player games (fair 50 / 33 / 20%), as before (96 / 91 / 74%). The cause is unchanged in kind: a seat nobody visited goes to whoever has the most rallies (the 0.25 floor is 88% of a rally's total effect), and a 125-roadshow budget can visit only 25% of the 500 seats. 10-player games are healthy (every strategy 8.5 to 11% of seats, PATCH 13%, no landslides), except that patch-defending play (PATCH) wins 46% of them (fair 10%). The rally cooldown has no measurable effect on balance (6 rallies per budget never come near 20 per campaign). **Suggested fix (not applied): double the budget to `budget=100_000`** (12 rallies or 250 roadshows, same 20x ratio): the best strategy then wins at most 1.8 to 1.9x its fair share at 2, 3 and 5 players (mixed play on top) instead of 1.9x / 2.8x / 4.0x.

### What was run
`npx tsx src/run.ts --mode full` (seed `hp`, 200 games per cell, random strategy per seat from the default pool, phases 1/3/5; tables below use 3 polling phases unless said) on the **BEFORE** state (git HEAD 67acbe8: rally 2,000, y 3.0, c 0.1, long cap-0.5 spill; reproduced in a scratch copy of the repo with the current bots) and on the **AFTER** state (working copy: Gaussian kernels, rally 8,000, cooldown 30 s). Extra runs: `field` with an extended pool incl. `AGENT*`, `evolve`, `crowd`, and `field --set ...` variants for the suggestions. `--verify` passes: max |incremental - engine| effect difference 3.6e-15.

| | BEFORE | AFTER |
|---|---|---|
| Rally price / roadshow price | 2,000 / 400 (5x): 25 rallies or 125 roadshows | 8,000 / 400 (20x): **6 rallies** or 125 roadshows |
| Rally: peak, spill, floor | 3.0; 50% of peak within 1,000 km, capped at 0.5 x peak up to 3,000 km; global 0.1 | 10; Gaussian, 6.1 at 100 km, 1.35 at 200 km, 0 beyond 400 km; global **0.25** |
| Roadshow: peak, spill | 4.0; 40% cap, half-distance 40 km, 0 beyond 200 km | 6; Gaussian, 2.8 at 50 km, 0.36 at 100 km, 0 beyond 160 km (one seat in practice) |
| Floor of a full-budget rally player | 2.5 (25 rallies x 0.1) | 1.5 (6 rallies x 0.25) = a quarter of one roadshow's 6 |
| Time multiplier, first-mover bonus | 1.0 -> 1.1, +0.2 / +0.2 | 1.0 -> 1.05, +0.2 / +0.2 |
| Rally cooldown | none | 30 s per player (`cooldowns.rallyMs`) |
| Seats a rally lifts by >= 0.5 of its peak (mean other seats) | 24.9 | 0.33 |
| Seats that nobody's local effect reaches ("pure-c", 3 players) | 6.5% | 46% |

### How the sim handles the cooldown
- `game.ts`: `ctx.rally` follows the server's order (frozen seat = `rejected`, then cooldown, then cost) using the shared `rallyAvailableAt(lastRallyTs, cfg)`; a refused rally is counted in the new `cooled` counter (printed as "rally cooldown refusals" and kept apart from "actions rejected (frozen seat)"), costs nothing, and does not move the player's last-rally time. `ctx.rallyReady()` tells a bot whether a rally now would pass.
- Plan bots (`planBot`): rally times are first re-spaced at plan time (>= 30 s + 2 ticks apart, still before each seat's phase closes). At run time a due rally that cannot go yet waits in a queue and is retried on the next tick (earliest-closing seat first; if its seat froze meanwhile it moves to the nearest open seat), so no rally is lost. Dynamic bots (ADAPTIVE, ADAPTIVE_G, BLIND) deal their 40% rally share out over the phases (a per-phase floor would round to 0 rallies at 8,000 each) and retry refused rallies. SNIPER only roadshows. CLUSTER keeps its seeds >= 400 km apart (the rally's reach). Tests assert every strategy ends with `cooled = 0`, `rejected = 0`, the budget identity, and that RALLY/MIX plans play all their affordable rallies at 1 to 5 phases.
- Rally counts are now small integers (budget 50,000): MIX10 = 0 rallies (same as ROADSHOW), MIX20/MIX30 = 1, MIX50 = 3, MIX70 = 4, MIX100 = 6; AGENT = 2, AGENT_R10 = 0, AGENT_R60 = 3. So the MIX levels are coarser than the old 25-rally scale.
- `--mode checks` now prints the Gaussian profile table, the 141.3 / 6.28 = y 22.5 total-effect ratio (price ratio 20 = 0.89 y) and whether the cooldown can bind.

### Strategy results, 3 polling phases (seats% / win%, BEFORE -> AFTER; fair win = 100 / players)
| Strategy | 2 players | 3 players | 5 players | 10 players |
|---|---|---|---|---|
| RALLY_EARLY (6 rallies, first minutes) | 84/96 -> 76/100 | 65/91 -> 54/86 | 43/74 -> 30/71 | 20/46 -> 10/9 |
| RALLY | 76/87 -> 67/81 | 62/75 -> 51/80 | 41/59 -> 28/61 | 19/43 -> 9/5 |
| MIX50 (3 rallies + 65 roadshows) | 65/78 -> 63/78 | 41/50 -> 39/50 | 22/27 -> 20/28 | 10/3 -> 10/7 |
| CLUSTER | 60/67 -> 57/67 | 40/50 -> 39/50 | 19/20 -> 18/20 | 9/2 -> 9/8 |
| ADAPTIVE | 47/55 -> 51/55 | 29/28 -> 33/32 | 15/7 -> 17/8 | 8/1 -> 9/5 |
| LATE | 42/33 -> 47/51 | 23/17 -> 29/22 | 12/2 -> 17/3 | 7/0 -> 10/7 |
| MIX30 | 50/56 -> 47/39 | 22/18 -> 25/7 | 13/5 -> 18/3 | 8/1 -> 11/9 |
| PATCH | 35/20 -> 37/18 | 22/3 -> 23/5 | 15/2 -> 18/2 | 10/4 -> 13/46 |
| SNIPER | 24/9 -> 29/6 | 16/0 -> 21/0 | 10/0 -> 16/1 | 6/0 -> 10/3 |
| ROADSHOW (125 random roadshows) | 22/11 -> 30/13 | 12/4 -> 21/4 | 7/0 -> 16/0 | 5/0 -> 10/5 |

Average win rate in all 2-player duels (head to head, 3 phases): RALLY_EARLY 97.6 -> 99.2%, RALLY 91.3 -> 89.7%, MIX50 77.6 -> 77.5%, CLUSTER 66.8 -> 66.9%, ADAPTIVE 53.2 -> 55.7%, LATE 31.8 -> 41.7%, MIX30 45.2 -> 33.2%, PATCH 25.4 -> 25.1%, ROADSHOW 7.0 -> 7.4%, SNIPER 4.1 -> 3.7%.

Rally-share sweep (`--mode mix`, one player of that mix vs the default pool, 3 phases; seats%/win%): 3 players: RS 21/2, MIX10 21/2, MIX20 27/13, MIX30 25/7, MIX50 39/55, MIX70 46/65, MIX100E 57/93, RALLY_EARLY 56/92 (before: 11/2, 14/4, 19/6, 23/15, 41/50, 53/66, 71/97, 67/88). 5 players: 16/0, 16/1, 18/5, 17/2, 21/29, 24/43, 32/88, 30/75 (before 7/0, 9/1, 11/1, 14/6, 23/32, 32/43, 51/86, 45/72). 10 players: 9/2, 9/2, 11/8, 11/8, 10/10, 10/10, 10/14, 10/10 (before 5/0 ... 22/57, 19/48).

Seat balance (all phases pooled; > 80% share / median margin pts / margin < 10 pts), BEFORE -> AFTER:
| Players | Landslides (> 80%) | Median margin | Close seats (< 10 pts) |
|---|---|---|---|
| 2 | 39.1% -> 52.5% | 45.7 -> 62.5 | 15.6% -> 14.7% |
| 3 | 10.6% -> 25.9% | 21.5 -> 37.4 | 28.0% -> 22.1% |
| 5 | 0.8% -> 7.3% | 11.4 -> 21.7 | 45.5% -> 33.4% |
| 10 | 0.0% -> 0.1% | 7.0 -> 9.5 | 61.9% -> 51.2% |

### Answers to the questions
**(a) Rally-heavy vs roadshow-heavy vs mixed.** Win rate still rises monotonically with the number of rallies (table above), so at 2 to 5 players the sensible-looking strategy is "as many rallies as possible", exactly as before. Mixed play (MIX50, 3 rallies + 65 roadshows) is a solid second (50% win at 3 players, fair 33%), pure roadshow play is the worst (4% win at 3 players). Replicator dynamics (14 rounds, 150 games): 3 players 95% RALLY_EARLY (before 95%), 5 players 63% RALLY_EARLY with SNIPER 14% and a spread of cheap mixes (before 95% RALLY_EARLY), 10 players a flat mixture MIX20 23% / MIX50 20% / MIX30 20% / RALLY_EARLY 13% / MIX70 13% (before 95% RALLY_EARLY). So the new maths made 5 and 10-player games genuinely mixed, but not 2 and 3-player ones. In 10-player games no pure strategy wins more than 14% (RALLY_EARLY now only 9% of the games it was 46% before). **Degenerate: PATCH wins 46% of 10-player games and 34% in the extended pool (fair 10%)**; it plays roadshows on its own committed patch (patch-defence is worth more than the floor at 10 players). This is not new (it was 36% in the 23 Oct run) and no price change I tried moves it (3.5 to 4.3x in all variants).
**(b) First mover and time bonus.** They only break near-ties. Removing the first-mover bonus (+0.2) changes the winner of 0.2% / 0.5% / 1.5% / 3.8% of seats with 2 / 3 / 5 / 10 players (same seeds, same bot actions); removing the time multiplier (1.0 -> 1.05) changes 1.3 / 1.4 / 1.5 / 1.4%; removing both 1.2 / 2.2 / 2.1 / 2.6%. No strategy's win rate moves by more than 4 points in any player count (e.g. AGENT 63 -> 67% at 2 players). Against a peak of 6 to 10 and a floor of 0.25 per rally, +0.2 is small; it matters only in seats where two players act and are otherwise level, mostly in 10-player games.
**(c) Roadshow-only vs rally player.** A roadshow lands in exactly one seat: 115 of 125 roadshows of a lone ROADSHOW player (nobody else has local effect there) win that seat 99.7% of the time (before: 8 lone seats per game, 95 to 98%, because every rally's long spill reached them). So a roadshow-only player holds **about as many seats as roadshows he plays, 25% of the map at most** (21 to 31% in practice), and cannot win a duel against a rally player: ROADSHOW v RALLY_EARLY ends 127 to 373 seats (before 31 to 469) with the roadshow side winning 0%. A 6-rally player holds 54 / 30 / 10% of the seats in 3 / 5 / 10-player games from just 6 rally seats. The floor of 6 rallies (1.5) is only a quarter of one roadshow (6), so a visited seat is never at risk from rallies, but 75% of the map is never visited.
**(d) AGENT bots** (extended pool, 3 phases, seats%/win%; AGENT = 2 rallies + 85 roadshows on own patch, R10 = 0 rallies + 125 roadshows, R60 = 3 rallies + 65 roadshows): 3 players AGENT 31/22 (before 28/22), R10 18/0 (18/6), R60 37/42 (42/50); 5 players AGENT 19/10 (18/8), R10 14/0 (11/0), R60 22/32 (26/29); 10 players AGENT 11.6/21 (10/4), R10 11.2/16 (8/0), R60 10/7 (12/14). The AGENT style is a weak player at 3 to 5 players (0.5 to 0.7x its fair win share) and strong at 10 (2.1x fair, together with PATCH).
**Cooldown.** Switching it off (`--set cooldowns.rallyMs=0`) changes no win rate by more than 1 point; it only delays the ex-"first 10% of the campaign" rallies to a ~150 s spread (6 x 30 s). It binds only if the budget buys more than ~7 rallies in a short window: with `budget=100000` (12 rallies) RALLY_EARLY plays about 11 of its 12 at 3 phases (12 rallies need 360 s at 30 s apart, and the early phases close before the last ones are allowed).

### Suggested constant changes (NOT applied; `game.properties` untouched)
All from `field --set ...` runs, extended pool, 3 phases, 200 games per player count; "best" = highest win/fair of any strategy.
| Variant | Best strategy and its win/fair at 2 / 3 / 5 / 10 players | RALLY_EARLY win at 2 / 3 / 5 |
|---|---|---|
| Current | RALLY_EARLY 1.9x / 2.8x / 4.0x / PATCH 3.5x | 95 / 93 / 80% |
| **`budget=100_000`** (= 12 rallies or 250 roadshows, same 20x ratio; or `costs.roadshow=200` + `costs.rally=4000`) | MIX70 1.8x / MIX70 1.9x / PATCH 1.9x / PATCH 3.7x | 81 / 61 / 19% |
| `costs.roadshow=200` only (250 roadshows, rally 8,000 = 40x) | MIX70 1.8x / 1.9x / PATCH 2.2x / PATCH 3.8x | 65 / 52 / 13% |
| `costs.roadshow=300` | RALLY_EARLY 1.9x / 2.8x / 3.6x / PATCH 4.3x | 95 / 93 / 72% |
| `costs.rally=12000` (4 rallies) | RALLY_EARLY 1.9x / 2.8x / 4.0x / PATCH 3.5x | 95 / 93 / 80% |
| `effects.rally.global` 0.10 or 0.15, `effects.rally.local=6`, `effects.roadshow.local=9`, `voting.randomMaxPercent` 20 or 40, `voting.influenceMaxPercent=100` | no change (+-1 point) | 95 / 93 / 80% |
Reading: the global floor's size does not matter (the vote is a ratio, so who holds more rallies wins unvisited seats whatever c is), and neither do peaks or randomness. What matters is **how many seats a roadshow budget can visit** against how many a rally player can floor: that is the roadshow count. The original tuning (see below) had 250 roadshows; the 20 Oct budget doubling at an unchanged 400 roadshow price cut it to 125 and that is what makes all-rally dominant. `budget=100_000` keeps the designer's 20x price ratio (and the y = 22.5 derivation) and brings the count back to 250 (analyst reports become half as expensive relative to the budget; with 12 rallies the 30 s cooldown starts to bind a little for all-early plans). A 2-player game stays lopsided in every variant (the best strategy still wins 80 to 90% of duels, a rock-paper-scissors between all-rally and spread roadshows that all-rally slightly wins): the old advice R1 below still stands (recommend 3+ players, or cap how many rallies count towards the floor).

### Files
`sim/src/game.ts` (cooldown, `cooled`), `sim/src/bots.ts` (`rallyReady`, `spaceRallies`, `planBot` queue, adaptive rally share, cluster reach), `sim/src/metrics.ts`, `sim/src/run.ts` (checks mode, refusals line), `sim/test/smoke.test.ts` (cooldown, kernel and rally-plan tests); `e2e/bots.ts`, `e2e/player2.ts`, `e2e/README.md`.

## 2026-10-23: committed voters, influence and randomness

New vote model (see `FEATURE REQUIREMENTS.docx`, "Committed voters"): each party gets a committed patch (6 bands, 87 seats: 30% x5, 25% x7, 20% x10, 15% x15, 10% x20, 5% x30, seat cap 60%), dealt sequentially at game start by a breadth-first walk from a random core seat; votes = committed + influence (extra 0..40% of the committed voters) + randomness (0..5% of the uncommitted voters to random parties) + the rest split by reputation (effect ratio, random where nobody has any). The old `randomSwing` is gone.

**What changed in the sim:** `game.ts` deals committed sets per game (seeded `<seed>:deal`), builds the matrix and passes it to `pollSeats` and `analystReport`. Bots get their own private patch (`ctx.ownCommitted(i)`, factory arg `own`). New strategy `PATCH` (30% of the budget on greedy rallies near its core seat, roadshows on its own patch seats from the weakest band outwards, then the nearest seats). `--verify` still passes (max effect diff 8.9e-16). Field mode prints the new balance metrics per cell and per player count (`== BALANCE players=P`). `--set` already handles array indices: `--set committed.bands.0.percent=0` (0-based).

**Run:** `npx tsx src/run.ts --mode full` (seed `hp`, 200 games per cell, random strategy per seat from the default pool incl. PATCH, phases 1/3/5 pooled, 300,000 seats per player count).
"Before" = the same run with all six band percents, `voting.influenceMaxPercent` and `voting.randomMaxPercent` set to 0 (pure reputation voting, no swing). This approximates the old rules; the old `randomSwing` itself no longer exists so it cannot be reproduced exactly.

### Seat balance, before vs after
| Players | Seats won with > 80% share (before -> after) | Median margin, winner minus runner-up (before -> after) | Seats with margin < 10 pts (before -> after) |
|---|---|---|---|
| 2 | 54.5% -> 50.9% | 68.8 -> 61.3 pts | 12.0% -> 11.8% |
| 3 | 38.8% -> 32.3% | 44.5 -> 38.5 pts | 17.9% -> 18.2% |
| 5 | 30.4% -> 19.5% | 28.4 -> 24.9 pts | 20.5% -> 23.4% |
| 10 | 12.1% -> 3.5% | 17.4 -> 14.2 pts | 23.4% -> 35.7% |

Reading: committed voters cut landslides most at high player counts (10 players: 12% -> 3.5%) and make more seats close (margin < 10 pts: 23% -> 36%). With 2 players the effect is small because the global rally effect still decides most seats; 50% of seats are still won with > 80%. Margins stay large for 2-3 players.

### Strategy seat share after the change (3 polling phases; seats% of 500, win% = sole most seats; fair win = 100/players)
| Strategy | 2p seats% / win% | 3p | 5p | 10p |
|---|---|---|---|---|
| RALLY_EARLY | 70.3 / 100 | 49.0 / 91.1 | 27.3 / 71.1 | 8.7 / 1.5 |
| RALLY | 63.8 / 81.1 | 45.1 / 75.0 | 24.7 / 49.6 | 7.6 / 2.0 |
| CLUSTER | 58.3 / 66.7 | 39.3 / 50.0 | 19.4 / 21.0 | 9.1 / 5.1 |
| ADAPTIVE | 49.9 / 52.4 | 31.6 / 30.0 | 16.5 / 3.9 | 7.4 / 0.0 |
| LATE | 43.4 / 27.9 | 26.6 / 9.4 | 15.9 / 0.0 | 8.4 / 0.5 |
| PATCH (new) | 37.0 / 24.5 | 24.3 / 10.9 | 17.2 / 2.7 | 12.9 / 35.6 |
| ROADSHOW | 34.9 / 15.6 | 26.4 / 4.1 | 21.0 / 10.1 | 14.1 / 43.0 |
| SNIPER | 32.4 / 2.9 | 23.5 / 0.0 | 17.6 / 2.4 | 10.6 / 9.0 |

Before (same cells): RALLY_EARLY 70.8/100, 50.3/91.1, 29.2/73.3, 9.3/4.3; ROADSHOW 35.0/15.6, 26.6/4.1, 21.2/5.3, 15.8/62.5; PATCH 37.2/24.5, 24.3/14.1, 16.4/4.4, 11.7/7.8.

### Does one strategy dominate?
- The ranking is essentially unchanged by the committed layer: all-rally (`RALLY_EARLY`, then `RALLY`) still dominates at 2 to 5 players (100% / 91% / 71% win at 2/3/5 players; fair is 50/33/20%), and the roadshow-heavy strategies (`ROADSHOW`, `PATCH`) win at 10 players. This is the pre-existing pattern (see the sections below) and was not caused by this change; the committed layer did not fix it. It also was not re-tuned after the 20 Oct budget doubling and first-mover change, so the RALLY_EARLY dominance at 2-5 players is worth a separate look.
- With 10 players the change made it more even: ROADSHOW win share fell from 62.5% to 43% (fair 10%), because a roadshow-only spread no longer wins unopposed seats once committed voters and randomness hold ~15-20% of each patch seat. The new `PATCH` strategy rose from 7.8% to 35.6% win at 10 players, so a patch-focused roadshow plan is now as good as plain ROADSHOW there, but it is weaker than all-rally at 2-5 players. `PATCH` is only a modest heuristic, not an optimised strategy.
- Committed voters are worth defending mostly in big games; in small games the global rally effect still outweighs a base of ~15% of the voters in 87 seats.

Produced by Agent E (19 Oct 2026) with `game/sim`. The values now live in `game/config/game.properties` (read by `WORLD_CONFIG`).

> **Update 20 Oct 2026:** the budget was doubled and all money amounts were rescaled to round numbers (÷10,000: budget W₹50,000, rally 2,000, roadshow 400, seat report 800→1,800, global 2,800→6,200), and a first mover's advantage was added (`effects.firstMover.*`). The tables below "Original tuning" are the ORIGINAL run (W₹ in crore, no first mover, budget 100 crore) and are kept as history only; the current numbers are in the 25 Oct section at the top.

Run everything from `game/sim` with `npx tsx src/run.ts --mode full` (about 8 min at 200 games per cell). Other modes: `field`, `mix`, `h2h --pool A,B`, `evolve`, `crowd`, `lone`, `checks`. Flags: `--games N --players 2,3,5,10 --phases 1,3,5 --seed S --set effects.rally.global=0.02 --verify`.

## Method
- **Engine:** the real engine (`buildTimeline`, `computeEffects`, `pollSeats`, `analystReport`, `analystPrice`) runs on the real map package.
- **Campaign:** 10 minutes in 2-second ticks, with each phase polled at its close.
- **What bots see:** only public rallies, their own actions and noisy purchased reports.
- **Speed:** bots read an incremental copy of the effect arithmetic. It matches the engine to within 3.6e-15 (`--verify`).
- **Sample size:** 200–400 seeded games per cell, for 2/3/5/10 players and k = 1/3/5 phases.

**Strategies:**
- `RALLY`: all-rally, random seats.
- `RALLY_EARLY`: all-rally in the first 10% of the campaign.
- `ROADSHOW`: 250 random distinct seats.
- `MIX10…MIX70`: that share of the budget on clustered rallies, the rest on roadshows.
- `MIX100E`: smart all-rally (clustered, early).
- `CLUSTER`: 10 dense clusters, 40/60 split.
- `SNIPER`: late roadshows on seats with the least public rival rally effect.
- `LATE`: MIX30, acting only in the last third of each phase.
- `ADAPTIVE`: about 2 seat reports per phase, plus top-ups and sniping.
- `BLIND`: ADAPTIVE without reports.

## Current values (`config/game.properties`, 25 Oct 2026)
| Value | Setting | Notes |
|---|---|---|
| Budget | W₹50,000 | 6 rallies or 125 roadshows (see the 25 Oct suggestion: 100,000) |
| Roadshow cost | W₹400 | |
| Rally cost | W₹8,000 | 20x a roadshow = 0.89 y, y = 22.5 = total effect of a rally (141.3) / of a roadshow (6.28) over all seats |
| Rally effect | 10 in its own seat + exp(-0.5 x²) spill (x = distance / 100 km; 6.1 at 100 km, 1.35 at 200 km, 0.11 at 300 km, 0 beyond 400 km) + 0.25 in EVERY seat | the floor is 88% of a rally's total effect |
| Roadshow effect | 6 in its own seat + exp(-2.8 x²) spill (2.98 at 50 km, 0.36 at 100 km, 0 beyond 160 km); no global part | |
| Rally cooldown | 30 s between one player's rallies | roadshows have none |
| Time multiplier | 1.0 → 1.05 | |
| First mover | +0.2 (rally or roadshow), in the seat itself | |
| Seat report | W₹800 → 1,800 | 2.0 → 4.5 roadshows |
| Global report | W₹2,800 → 6,200 | 7.0 → 15.5 roadshows |
| Reputation shown to the player | round(effect x 4) | the 0.25 floor shows as 1, a rally in its own seat as 41 |

## Original tuning (19 Oct 2026; historical, superseded: money in W₹ crore, linear-capped spill)
The sections from here to "Engine note" describe the ORIGINAL tuning run (budget 100 crore, 50 rallies at 5x a roadshow, long cap-0.5 rally spill). The old spill rules were: rally half-distance 150 km, max 800 km, cap 0.5 x peak (50% of y within ~150 km, 25% at 300 km, 6% at 600 km, 0 beyond 800 km); roadshow half-distance 40 km, max 200 km, cap 0.4 x peak. They were replaced by the Gaussian kernels above and none of the numbers below describe the current game.

| Value | Setting | Reason |
|---|---|---|
| Budget | W₹100 crore (1,000,000,000) | only ratios matter |
| Roadshow cost | W₹0.4 crore (4,000,000) | 250 actions max; at 200, all-rally dominates 2-player games |
| Rally cost | W₹2 crore (20,000,000) | 50 rallies max, 5× a roadshow |
| y (rally local) | 1.0 | reference unit |
| c (rally global) | 0.01 | 50 rallies give c×R = 0.5 per seat |
| s (roadshow local) | 3.0 | 3× y |
| Rally decay | half 150 km, max 800 km, cap 0.5 | 50% of y within ~150 km, 25% at 300 km, 6% at 600 km, 0 beyond 800 km |
| Roadshow decay | half 40 km, max 200 km, cap 0.4 | 40% of s within ~40 km, 18% at 100 km, 0 beyond 200 km |
| Time multiplier | 1.0 → 1.1 | designer's decision (see risk R3) |
| Seat report | W₹0.8 → 1.8 crore | 2.0 → 4.5 roadshows; the price rises 2.25× over the campaign |
| Global report | W₹2.8 → 6.2 crore | 7.0 → 15.5 roadshows; the price rises 2.2× |
| Analyst noise | 0.07 (seat-share std) | useful but not exact |
| Random swing | 0.02 | 0.01–0.03 makes no measurable difference |

## Requirement checks
| # | Requirement | Result | Verdict |
|---|---|---|---|
| 1 | A lone roadshow beats an all-rally opponent's global effect by ≥ 1.5× | s/(c·R) = 6.0× (5.45× with the time bonus); the roadshow won 100% of about 81 lone seats per game | PASS |
| 2a | All-rally doesn't dominate | 3 players: 29–32% of seats (fair 33); 5: 11–13% (fair 20); 10: about 1.7% (fair 10) | PASS for 3+ players |
| 2b | All-roadshow doesn't dominate | 2 players: 42–43%; 3: 31%; 5: 19%; 10: 7% | PASS |
| 2c | A sensible mix is best or near-best | MIX50 is best or within about 1 point of best for 3, 5 and 10 players at every k | PASS for 3+ players |
| 2d | The same holds with 2 players | the smart all-rally bot gets 61.6% of seats and 83% of games; MIX50 gets 58.3% and 72% | **PARTIAL (R1)** |
| 3 | Crowded regions cancel out, neglected seats are cheap | one cluster player gets 29% of seats with 10 players, falling to 8% when 9 crowd in; a lone roadshow player among them gets 29% | PASS |
| 4 | Playability (100–250 actions) | 250 roadshows or 50 rallies max; MIX50 makes about 150 actions | PASS, at the limits |
| 5 | Analyst price and noise | see the values above | PASS |
| 6 | Spill-over | Dhaka City → Dhaka Outer: rally 50% of y, roadshow 40% of s; Siberia East → West (2,351 km) gets 0 | PASS |
| 7 | Whole-number currency | all prices are integers | PASS |
| 8 | Speed | 5–37 ms per simulated game | PASS |

## Key results (seat % of the field; fair share = 100 / players)
| Strategy | 2 players (k=3) | 3 players | 5 players | 10 players |
|---|---|---|---|---|
| RALLY | 53.0 | 29.7 | 11.3 | 1.6 |
| ROADSHOW | 43.1 | 30.6 | 18.9 | 7.2 |
| MIX50 | 58.3 | 38.8 | 23.8 | 14.0 |
| CLUSTER | 50.5 | 35.5 | 24.5 | 18.2 |
| SNIPER | 44.0 | 34.2 | 22.4 | 8.9 |
| LATE | 48.6 | 34.4 | 24.9 | 15.5 |
| ADAPTIVE | 47.5 | 31.1 | 20.3 | 12.1 |

**Seats decided by the global effect alone** (nobody campaigned there): 16–18% with 2 players, 9% with 3, 2–3% with 5, and 0.1% with 10.

**Stable strategy mix (replicator dynamics):**
- 3 players: MIX70 47%, SNIPER 21%, RALLY_EARLY 16%.
- 5 players: MIX70, SNIPER, LATE and CLUSTER, each about 20–33%.
- 10 players: MIX70 35%, CLUSTER 31%, with smaller shares of the rest.
- 2 players: smart all-rally, with ROADSHOW and SNIPER as equally good alternatives.

## Risks for the designer
- **R1. Two-player games are a "global-effect war".**
  - Any seat that nobody roadshowed goes to whoever held more rallies.
  - It's rock-paper-scissors (spread roadshows beat all-rally), but smart all-rally is the strongest single strategy with 2 players.
  - The problem disappears from 3 players up.
  - Fixes if 2-player games matter: cap the number of rallies that count towards the global effect, make it grow sub-linearly, or recommend 3+ players.
- **R2. With 5+ players, all-rally is weak and the global effect is nearly cosmetic** (it decides 0.1% of seats with 10 players). Raising c makes R1 worse.
- **R3. Acting late wins ties.**
  - The time multiplier (up to 1.1×) is much larger than the random swing (0.02), so the later of two equal roadshows wins.
  - Expect last-minute rushes before each phase closes.
  - The fix is to lower the end multiplier to about 1.05; the random swing doesn't help.
- **R4. City-heavy play wins only while it's rare.** Once several players copy it, the edge disappears and remote seats become the cheap wins.
- **R5. Analyst reports buy information, not seats.**
  - At 2–4.5 roadshows each, about five seat reports cost about 5 seats.
  - They break even at about 0.25–0.5 roadshows per report.
  - They're still worth buying for hedging and coalition planning; price them at about 1 roadshow or less if they should pay for themselves.
- **R6. The budget sits at the playability limits** (250 roadshows, 50 rallies). To reduce the number of clicks, lower the rally cost rather than raising the roadshow cost.
- **R7. Results barely depend on the other settings.** The ranking never changed across y 0.7–2, c 0.005–0.05, s 2.5–6, or the decay settings. The 250/50 action counts, the cost ratio and the ratio-based vote rule drive the balance.

## Engine note
`computeEffects` still lets an action held in an already-polled seat spread its global effect and spill-over to open seats. This follows the engine brief. The server rejects such actions (`SEAT_POLLED`, no charge), and the bot end-to-end test checks this, so it can't happen in a real game.
