> NOTE (2026-10-20): historical brief from the first agent pass. Paths below predate the move to `maps/world-500/source/`; `output/seats_input.csv` was deleted (superseded by the master CSV `world_parliament_500_T_K_v2.csv`).

# World Parliament — constituency definition brief (read fully before starting)

## Goal
The world (~8.3 billion people, 2026) is split into 500 parliament seats of roughly equal population (target ≈ 16.6 million each, i.e. ~1.65–1.66 crore).
A starting list of 500 seats exists in `D:\Projects\world-parliament\output\seats_input.csv` (columns: seat, short_name_B, constituency_C, continent_D, original_coverage_E, pop_K_old, coverage_T_old, status_U_old).
The old coverage is vague/approximate (e.g. "India — Uttar Pradesh" repeated for 16 seats). Your job: for the seats assigned to you, define **exactly** which ADM0 / ADM1 / ADM2 units (and ADM3 only if unavoidable) each seat contains, and compute a corrected 2026 population.

You own a **group** of seats plus a fixed **scope** of countries/territories (given in your prompt). Every unit in your scope must be assigned to exactly one of your seats (a clean partition: no gaps, no overlaps). Do NOT include territory outside your scope (other agents own it).

## Freedom you have ("redraw within group")
- Keep the seat numbers. The seat count for your group is fixed.
- You may move territory between seats inside your group, and rename a seat (short_name_B / constituency_C) when its boundary changes materially. Log it in `changes_vs_old`.
- Seats should be roughly 16.6m. The accepted band is **12.5m – 20.8m (±25%)**. Deviation is fine when geography/culture justify it, but do not distort populations deliberately. Any seat outside 12.5–20.8m must be flagged (`pop_flag` = LOW/HIGH + reason).
- Do not over-engineer population balance: stay roughly 15–18m where you cleanly can.

## Unavoidable out-of-band seats (user instruction, added later)
If, while obeying the hard rules below, a seat cannot reach 12.5–20.8m (e.g. Taiwan ≈ 23m: a single country/territory that is too big and cannot be split or paired without breaking a rule), DO NOT break a rule or contort the map to fix it. Keep the most natural seat, set `pop_flag` to `HIGH`/`LOW` with `UNAVOIDABLE:` + reason, and list it in your reply. The user will revisit these later. (Splitting a too-big place into 2 seats is only OK when your group's seat count genuinely allows it and the pieces are natural; otherwise flag.)

## Hard rules
1. Never join only a *part* of one country with only a *part* of another country (e.g. no half-Italy + half-Switzerland seat).
2. Small countries may be clubbed into a block with each other (e.g. several Caribbean states) — keep them culturally/regionally coherent.
3. One *entire* small country may be combined with a *part* of a neighbouring country, but only if culturally relevant, not merely adjacent (e.g. never Trinidad & Tobago + part of Venezuela). The old sheet already made several such choices (e.g. Laos + Isan Thailand, Togo + Volta region Ghana, Timor-Leste + Lesser Sundas); keep them unless they clearly break a rule or wreck population balance.
4. Every seat must be contiguous: sharing a land border, OR connected by an easy, established sea route (ferry/short crossing). Not far-apart places (no Antarctica + South Africa). If you must accept a long ocean link (remote islands), say so in `notes`.
5. Disputed territories: follow the old sheet's choices (Taiwan separate seat; Crimea in Ukraine; Kashmir/Ladakh as in sheet; Gaza & West Bank as in sheet; Somaliland in Somalia; W. Sahara with Morocco; no sovereignty statement implied).

## Column T format (recursive, exact)
- Entire country: `Laos [entire ADM0]`
- Country with parts, countries separated by `; `:
  `B (X1 [entire ADM1], X2 [entire ADM1], X3 (Y1, Y2 ADM2 only))`
  = in country B: all of ADM1 X1 and X2, plus only ADM2 districts Y1 and Y2 of ADM1 X3.
- Several whole countries: `A [entire ADM0]; C [entire ADM0]; B (X1 [entire ADM1], ...)`
- If an ADM2 district itself has to be split (population balancing), go to ADM3 and list it like
  `X3 (Y1, Y2 [entire ADM2], Y3 (Z1, Z2 ADM3 only))`, and set `beyond_ADM2` = YES (see below).
- Always list what is **included** (positive list), never "all except".
- If a unit is a whole ADM1 use `[entire ADM1]`; never list its ADM2 children individually in that case.
- Use the admin level names of the geoBoundaries dataset (ADM1 = state/province/region, ADM2 = district/county/prefecture-level unit; e.g. China ADM2 = prefecture-level city, ADM3 = county/district; India ADM2 = district; USA ADM2 = county). For countries with no ADM2 in geoBoundaries use the next level and say so in `notes`.
- Use common English names consistently; a reader must be able to match every unit to the official admin list.
- For tiny/special territories (e.g. Réunion, Gibraltar, Falkland Islands) just write them as `[entire ADM0]` (or ADM1 of the sovereign) as appropriate.

## Population (column K)
- 2026 estimate, in people (integer). Method: latest census/official projection per ADM unit, grown to 2026, scaled so that the sum over all units of a country equals the UN WPP 2026 country total (the old sheet used the same scaling). Seat K = sum of its units.
- Use your knowledge first; use web search/fetch only to fill gaps (budget your effort — a good, honest estimate beats perfect precision). Do not spend huge effort on a single seat.
- `pop_confidence`: High / Medium / Low (Low = guessed split inside a unit, outdated census, etc.).
- Do not invent precision you do not have: round K to the nearest 10,000 (or 100,000 if Low confidence).

## Going beyond ADM2
Avoid it. Only if an ADM2 unit is so large (e.g. a megacity district of 20m+) or the arithmetic otherwise breaks a seat's band badly. If you use ADM3 (or subdivisions below the lowest GIS level), set `beyond_ADM2` = YES and explain in `beyond_ADM2_detail` which unit is split and why. The user wants these flagged.

## Output (UTF-8 with BOM, written with Python's csv module so commas/quotes are escaped)
Write `D:\Projects\world-parliament\output\groups\<GROUP_ID>.csv` with exactly these columns in this order:

seat, short_name_B, constituency_C, continent_D, original_coverage_E, pop_K, pop_millions, coverage_T, status_U, beyond_ADM2, beyond_ADM2_detail, pop_flag, pop_confidence, changes_vs_old, notes

- `short_name_B`, `constituency_C`, `continent_D`: keep unless you renamed.
- `original_coverage_E`: write an updated one-line plain-language description of coverage (2nd source of truth after T).
- `pop_K` integer people; `pop_millions` = pop_K/1e6 rounded to 2 dp.
- `status_U`: `RESOLVED — ADM0 only`, `RESOLVED — ADM1`, `RESOLVED — ADM2`, or `RESOLVED — ADM3 needed` (use the deepest level used).
- `beyond_ADM2`: YES/NO. `beyond_ADM2_detail`: blank if NO.
- `pop_flag`: blank, or `LOW`/`HIGH` + short reason when outside 12.5–20.8m.
- `changes_vs_old`: blank, or what changed (renamed, boundary moved, old seat-vs-state allocation fixed ...). Keep it brief.
- `notes`: contiguity caveats, data caveats, cultural reasoning for any cross-country block. Brief.

Also write `D:\Projects\world-parliament\output\groups\<GROUP_ID>_audit.md` (short) with:
1. Partition check: list every ADM0 in your scope and, for each, the seats it appears in (and for split countries: every ADM1 and the seats it appears in). State explicitly that nothing is missing or double-counted.
2. Sum of your seats' K vs your own estimate of the scope's total population (should match within ~1%).
3. Flagged seats (beyond ADM2, pop outside band, long sea links).

Verify your CSV by re-reading it with Python before finishing (row count = seats in group; K sums; no empty T).

## Final reply to the caller (≤ 200 words)
Only: file paths written, seat count, mean/min/max seat pop, list of flagged seats (beyond ADM2 + out-of-band) with one-line reasons, any assumption the user should know. No full tables.
