---
name: name-change
description: Rename a world-parliament constituency. Takes the seat number or current name plus the new name. site/data/seats.json is the single source of truth for seat names, so this only edits that file. Use when the user asks to rename/change the name of a seat or constituency.
---

# name-change

Renames one seat. `site/data/seats.json` is the **only** place seat names live now: the website reads names from it, and `build/05_build_site_data.py` preserves the names already in it when regenerating the file. The CSV `short_name_B` column is no longer authoritative.

## Input
- Existing seat identifier: a seat number (e.g. `453`) or the exact current name (e.g. `California South`).
- The new name.

If either is missing or ambiguous, ask the user. Do not guess a seat from a partial name.

## Run
```
python -I .claude/skills/name-change/rename_seat.py "<seat number or current name>" "<new name>"
```
Run from the project root. `--dry-run` previews. The script errors on 0 or >1 matches and warns if the new name is already used by another seat.

No rebuild is needed; the user just hard-refreshes the page (Ctrl+F5). Editing the `name` field in `seats.json` by hand has exactly the same effect.

## Not touched
The CSVs (`short_name_B`, `constituency_C`), the xlsx and geometry.
