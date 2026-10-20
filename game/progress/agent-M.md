# Agent M notes (AI agent package: MCP + CLI)
- Started 2026-10-20. Plan: server kind (tests first) -> agent/src client/actions/mcp/daemon/cli -> RULES.md -> tests -> docs.
- written so far: state.ts errors.ts client.ts resolve.ts gamePackage.ts rules.ts RULES.md; server kind change done (tests pass), web Lobby.tsx robot badge done. Next: views/session/actions/mcp/daemon/cli, tests
- 2026-10-20: all src written; unit tests (state/resolve/actions) + integration test (full game via actions, reconnect, decline) PASS. Next: mcp stdio test, cli/daemon test, .mcp.json, README, AGENTS.md, CLAUDE_SNIPPET.md, server tests rerun, final checks
- DONE 2026-10-20: avatars server+tests, bots.ts avatar+budget reserve, docs, .mcp.json (node wrapper), AGENTS.md, CLAUDE_SNIPPET.md; agent 45 tests + server 189 pass
