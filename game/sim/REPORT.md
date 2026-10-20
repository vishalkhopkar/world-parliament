# Simulator report: world map tuning

Produced by Agent E (19 Oct 2026) with `game/sim`. The final values are in `WORLD_CONFIG` (`game/shared/src/mapConfig.ts`).

Run everything from `game/sim` with `npx tsx src/run.ts --mode full` (3–4 min). Other modes: `field`, `mix`, `h2h --pool A,B`, `evolve`, `crowd`, `lone`, `checks`. Flags: `--games N --players 2,3,5,10 --phases 1,3,5 --seed S --set effects.rally.global=0.02 --verify`.

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

## Final values
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
