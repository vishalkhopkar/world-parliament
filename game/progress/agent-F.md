# Agent F notes (server)
- Plan: server/src/core (GameService + interfaces), aws (Dynamo/ApiGw/Sfn), local (Memory + devServer), handlers, tests.
- phase from SFN is 1-based -> convert. Grace schedules in SCHEDULE_GROUP.
- Status: started 2026-10-19; writing core first.
- core + memoryRepo + lobby/campaign tests done; counting tests written; next: hidden-info test, aws/*, local devServer, handlers
- aws/, handlers done, bundles ok; next: local devServer + final checks
- local devServer + e2e test done; remaining: final checks, report
- DONE (2026-10-19): all handlers real; 44 tests pass; tsc clean; 8 handlers bundle with esbuild.
- Run local: cd game/server && npm run dev (http://localhost:8787, ws://localhost:8787/ws). Short games: HP_CAMPAIGN_MS etc.
- Contract notes: hello is sent on the FIRST client message (API GW cannot post during $connect); phase from SFN is 1-based; phaseClosed.phase is 0-based.
