# Agent G notes (wiring + e2e)
- Started 2026-10-19. Plan: web/src/net/remote.ts + client.ts selection -> mismatch fixes -> e2e/bots.ts -> e2e/browser.ts -> README.
- Found so far: server `start` sends no `private` (client budget stays 0); `actionAck` has no myActions update (web must append via clientRef);
  pending/rejected sockets; hello only after first message (ping on open).
- remote.ts, client.ts, store (link, pendingActions), App resume, server start->private (+test) done; next: e2e/bots.ts
- bots.ts written; 3 players pass; check 6 + browser next
- server: newId time-sortable, join code retry x20 (coordinator request), util.test added; 172+1 tests pass. bots 3p and 6p PASS. next: browser.ts, README
- browser.ts PASS, README written, mock smoke ok. DONE; final report pending
