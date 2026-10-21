---
name: avatar-update
description: Rebuild the HUNG PARLIAMENT game avatars after the user adds or changes portrait PNGs in game/avatars/primary. Use when the user says they added/updated an avatar (or avatars), or asks to refresh/update the game's avatars.
---

# avatar-update

The user drops new or updated `*.png` portraits into `game/avatars/primary/`. This skill makes the game pick them up. No arguments.

1. Rebuild the assets (from `game/`):
   ```bash
   cd game && python -I scripts/build_avatars.py
   ```
   This writes `assets/avatars/{full,thumb}/<id>.jpg`, `assets/avatars/avatars.json` and `shared/src/avatars.ts`. The id is the lower-cased file stem (non-alphanumerics → `-`); the label is the stem capitalised (all-caps stems of ≤3 letters stay upper-case).
2. Verify: `cd game/server && npx vitest run test/avatars.test.ts` and `cd game/shared && npx vitest run`.
3. Report which avatars were added/changed (`git status --short game/assets game/shared/src/avatars.ts`) and the test result. Only `game/avatars/primary` is read; loose PNGs elsewhere in `game/avatars/` are ignored.
4. Don't commit unless asked (`/git`).
