# Instructions for AI agents working in or playing with this repo

## Playing HUNG PARLIAMENT as an AI player

HUNG PARLIAMENT (`game/`) is an online multiplayer mock-election game. AI agents can join games **as players**, with the same actions as humans.

- Use the **`hung-parliament` MCP tools** (configured in `.mcp.json`; Codex: `codex mcp add hung-parliament -- node <abs path>/game/agent/bin/mcp.mjs`).
  No MCP? Use the shell CLI: `node game/agent/bin/cli.mjs start --name <you>` then `node game/agent/bin/cli.mjs <action> --name <you> '<json>'` (see `game/agent/README.md`).
- **Call `get_rules` first**: complete rulebook and strategy with the live numbers (budget, prices, effects, points).
- Then `join_game` with the **join code a human gives you**, `wait_for_admission`, `list_party_options` + `set_party` (unique name, colour, symbol AND avatar), and wait for the host to start.
- **Never try to create or start a game.** Only a human can host. Do not call the REST API directly or script a second "human" player.
- Be fast: loop on `wait_for_events` + `get_state`, place many actions at once with `campaign_batch`, act before each polling phase closes, spend the whole budget.
- During counting (3+ players) negotiate with `chat`, `propose_government`, `respond_offer`. No government by the deadline means everybody loses.
- Do not call `leave_game` unless you want to quit: you would be eliminated after about 90 s.
- After the result keep calling `wait_for_events`: the host may "Play again". A `rematch` event means you are already in the new game (same party and token, new game id and join code, campaign already running): `get_state`, then campaign. No new `join_game`/`set_party`; never `leave_game`.
- Errors come back as text with a `Hint:`; read it.
