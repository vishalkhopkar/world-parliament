# Legacy inputs (kept for reference, not read by any script)

These are the first-pass working files from before the master CSV (`../world_parliament_500_T_K_v2.csv`) was the source
of truth. They hold derivations and extra attributes that are not all in the master CSV, so they are kept.

- `world_parliament_500_with_population_2026.csv` - the original 500-seat table: original constituency names and coverage,
  2026 population estimate per seat and how it was estimated (UN WPP scaling, sources, quality), plus a historical
  reference party per seat (state-wide / national result, NOT a seat result).
- `world_parliament_500_adm0_adm1_adm2_working.xlsx` - the same table plus the working ADM0 -> ADM1 -> ADM2 coverage
  specification, a revision log (seat moves with population before/after), a coverage audit, the ADM-assignment queue and a
  list of seats needing sub-ADM2 (ADM3) splits (China).

The per-group agent outputs (`../groups/<GROUP>.csv` + `<GROUP>_audit.md`, `../groups.json`) are the second pass: each audit
documents the partition check and the per-district population derivation (2011/2021 census scaled to seat totals) for a
group of seats. They record how the per-ADM2 population estimates were derived; the master CSV only stores seat totals.
Older, superseded copies of the master CSV (`T_K.csv`, `seats_input.csv`, `*.bakN.csv`) were deleted; the master's history
is in git.
