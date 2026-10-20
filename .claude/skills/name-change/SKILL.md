---
name: name-change
description: Rename a world-parliament constituency. Takes the seat number or current name plus the new name. maps/<map>/site/data/seats.json (default map world-500) is the single source of truth for seat names, so this only edits that file. Use when the user asks to rename/change the name of a seat or constituency.
---

# name-change

Renames one seat. `maps/world-500/site/data/seats.json` is the **only** place seat names live now (one such file per map under `maps/<id>/`): the website reads names from it, and `maps/world-500/source/build/05_build_site_data.py` preserves the names already in it when regenerating the file. The CSV `short_name_B` column is no longer authoritative.

## Input
- Existing seat identifier: a seat number (e.g. `453`) or the exact current name (e.g. `California South`).
- The new name.

If either is missing or ambiguous, ask the user. Do not guess a seat from a partial name.

## Run
```
python -I .claude/skills/name-change/rename_seat.py [--map world-500] "<seat number or current name>" "<new name>"
```
Run from the project root. `--map <id>` picks the folder under `maps/` (default `world-500`). `--dry-run` previews. The script errors on 0 or >1 matches and warns if the new name is already used by another seat.

No rebuild is needed; the user just hard-refreshes the page (Ctrl+F5). Editing the `name` field in `seats.json` by hand has exactly the same effect.

## Not touched
The CSVs (`short_name_B`, `constituency_C`), the xlsx and geometry.
