# Agent D notes (web scaffold)

Status: done (mock-only). `cd game/web && npx tsc -p tsconfig.json`, `npm run build -w @hp/web`, `npx vite --port 5173`.

## Structure (game/web)
- `vite.config.ts` plugin `hp-site-data`: serves ../../site/data at /data (real 404 for missing files), copies world/detail topo, seats.json and game/ into dist/data on build.
- `src/net/transport.ts` Transport interface (REST + WS halves); `mock.ts` MockTransport (only impl); `client.ts` action layer (`setTransport()` is the plug-in point).
- `src/state/store.ts` zustand: snapshot, priv, lobby, chat, clockOffset, names, gamePkg, polledSeats, UI. `applyServer(ServerMessage)` is the single reducer for WS messages.
- `src/map/SeatMap.tsx` d3 map (port of site/app.js), props: fills, leading, dimmed, selectedSeat, onSeatClick, pulse, names, centres; ref handle zoomToSeat/reset.
- `src/screens/*` Home, Lobby, PartySetup, Campaign, Counting (+TallyBar), Result; `src/components/Negotiation.tsx`, `campaign.tsx`, `ui.tsx`.
- Mock timings via URL: `?campaign=120&counting=60&post=120` (seconds).

## Decisions / contract notes
- PartyIdentity.colour: UI sends the HEX from PARTY_COLOURS; `colourHex()` accepts either id or hex when reading. Server should pick one and validate.
- ReportEntry.estimate: seat report = fraction 0..1 (UI shows %), global = seat count.
- CountTally.leads = seats currently leading (not yet won); wins = declared won; declared = number won.
- Screen routing is derived from status (`currentScreen`); lobby page vs party page is UI state.
- Web opens the WebSocket right after create/join (while still pending); real server must allow that, or connect only after admission (change in client.ts openSocket + Lobby polling).
