---
name: name-change
description: Rename a world-parliament constituency everywhere (master CSV, its group CSV, site/data/seats.json, ISSUES_TO_DISCUSS.md). Takes the seat number or current name plus the new name. Use when the user asks to rename/change the name of a seat or constituency.
---

# name-change

Renames one seat consistently in every place the short name appears.

## Input
- Existing seat identifier: a seat number (e.g. `453`) or the exact current `short_name_B` (e.g. `California South`).
- The new name.

If either is missing or ambiguous, ask the user. Do not guess a seat from a partial name.

## Run
```
python -I .claude/skills/name-change/rename_seat.py "<seat number or current name>" "<new name>"
```
Run from the project root (`D:\Projects\world-parliament`). Use `--dry-run` first if the target is unclear.

The script:
1. Resolves the seat (number, or exact case-insensitive match of `short_name_B`; errors if 0 or >1 matches).
2. Updates `short_name_B` in `output/world_parliament_500_T_K_v2.csv` (master) and in the matching `output/groups/<group>.csv`, keeping UTF-8 BOM.
3. Updates `name` in `site/data/seats.json` (pretty-printed, 2-space indent preserved).
4. Replaces the old name in `output/ISSUES_TO_DISCUSS.md` lines that name this seat (`Seat <n> — <old name>`).
5. Prints every file changed with old -> new.

It does not touch `constituency_C` (the longer descriptive name), the older v1 CSV, the xlsx, or geometry. Tell the user if they also want `constituency_C` changed; the map needs no rebuild for a name change, only a browser hard refresh (Ctrl+F5).

## After running
Report the files changed in one short line. If the user also wants other columns changed, do that by hand in the master CSV and re-run `python -I build/05_build_site_data.py` (note: that regenerates seats.json from the CSV, so keep the CSV as the source of truth).
