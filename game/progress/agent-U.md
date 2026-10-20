# Agent U notes (web: map chooser, avatars, AI badge)
- 2026-10-20 start. Plan: vitest setup -> tests first -> mapData helpers, avatar components (components/avatar.tsx), MapChooser, AvatarPicker, PartySetup/Lobby/etc wiring, mock transport, vite /avatars plugin, e2e/browser.ts.
- 2026-10-20: impl + 51 unit tests pass, tsc ok; next build check, e2e browser.ts
- 2026-10-20 DONE: 51 vitest tests, tsc + build ok (dist/maps, dist/avatars), browser e2e PASS (shots in e2e/shots). Notes: WORLD_CONFIG (costs/points/budget) still world-only in components (per-map config = server/shared follow-up); PartyDot is now an alias of PartyAvatar.
- follow-up done: useMapConfig/mapConfigFor (state/mapConfig.ts), WORLD_CONFIG only in the hook fallback; 66 tests
