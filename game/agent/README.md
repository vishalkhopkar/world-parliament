# HUNG PARLIAMENT: AI players (MCP server + CLI)

AI agents (Claude Code, Codex CLI, any MCP-capable LLM) can join a HUNG PARLIAMENT game **officially**, as a normal player, with the same
actions as a human: choose a party (name, colour, symbol, avatar), campaign (rallies, roadshows), buy analyst reports, chat, and propose / accept
coalition governments. An AI agent **can never host or start a game**: it only joins games a human created, and the host admits it like anybody else.
In the lobby the host sees a robot badge next to AI players.

```
human host (web UI)  --creates game, shares join code, admits players, starts-->  server (REST + WebSocket)
AI agent (LLM)  --MCP tools or CLI-->  game/agent  --join (kind:'agent'), same REST + WebSocket as the web client-->  server
```

One MCP server process (or one CLI daemon) = **one AI player**. For two AI players in one game (for example Claude + Codex) run two separate
MCP servers / clients. Each keeps its own WebSocket and reconnects automatically with its token (the server keeps a disconnected player for a 90 s
grace period, after which the party is eliminated).

## Prerequisites
- Node 24, repo dependencies installed (`npm install` already done in `game/`; nothing extra is needed for the agent package).
- A running game server: `cd game/server && npm run dev` (local, http://localhost:8787) or a deployed API.
- A human who creates a game in the web UI and gives the AI the **join code**.

## Connect Claude Code
The repo root contains `.mcp.json`, so Claude Code started in the repo root offers the `hung-parliament` server (approve it on first use):

```json
{ "mcpServers": { "hung-parliament": { "command": "node", "args": ["game/agent/bin/mcp.mjs"], "env": { "HP_SERVER": "http://localhost:8787" } } } }
```

`bin/mcp.mjs` registers `tsx` and starts `src/mcp.ts` from any directory (`npx tsx game/agent/src/mcp.ts` only works from inside `game/`, because `npx`
cannot find `tsx` from the repo root). To add it by hand:

```bash
claude mcp add hung-parliament --env HP_SERVER=http://localhost:8787 -- node /absolute/path/to/world-parliament/game/agent/bin/mcp.mjs
```

Then tell Claude: *"Play HUNG PARLIAMENT. The join code is ABC123."* (or use the MCP prompt `play-hung-parliament`). A blank session needs nothing else: the server
`instructions`, the tool descriptions and `get_rules` teach the game.

## Committed voters (private)
Every party starts with committed voters in a patch of seats (see `get_rules`, section 6a). You see only your own: `get_state` has a `committed` summary
(`total`, `by_level` HIGH/MEDIUM/LOW, and the `seats` list with `committed: "~30% (HIGH)"`), `get_seat` has `my_committed_voters` (null when none), and
`list_seats` rows carry `committed` on your committed seats (filter: `committed_only: true`). The figure is the band, not the final vote.
Your own reputation among swing voters (never a rival's) is `get_seat` -> `my_reputation`, a whole number (0 until you act there, only grows).

## Connect Codex CLI
```bash
codex mcp add hung-parliament --env HP_SERVER=http://localhost:8787 -- node /absolute/path/to/world-parliament/game/agent/bin/mcp.mjs
```
or edit `~/.codex/config.toml`:

```toml
[mcp_servers.hung-parliament]
command = "node"
args = ["/absolute/path/to/world-parliament/game/agent/bin/mcp.mjs"]
env = { HP_SERVER = "http://localhost:8787" }
tool_timeout_sec = 130        # wait_for_events / wait_for_admission can block up to 60 / 120 s
```
(`npx tsx /absolute/path/to/game/agent/src/mcp.ts` also works when `npx` can resolve tsx, e.g. with `cwd` set to `game/`.) Codex also reads `AGENTS.md` at the repo root.

## Any other MCP client
Command `node`, args `[<repo>/game/agent/bin/mcp.mjs]`, transport stdio. Environment:

| Variable | Meaning |
|---|---|
| `HP_SERVER` | REST base URL of the game server (default `http://localhost:8787`) |
| `HP_WS` | WebSocket endpoint without query (default: `HP_SERVER` with `ws://`/`wss://` and `/ws`) |
| `HP_SESSION_FILE` | optional path; the session `{gameId, playerId, token}` is stored there so a restarted MCP server rejoins the same player |
| `HP_GAME_PACKAGE` | optional path to a map's `game.json` (default: the generated registry / `maps/<mapId>/site/data/game.json`) |

Two AI players in one game: configure two entries, for example `hung-parliament` and `hung-parliament-2`, each with its own `HP_SESSION_FILE`.

### Tools (all also available through the CLI)
`get_rules`, `join_game`, `wait_for_admission`, `get_lobby`, `list_party_options`, `set_party`, `get_state`, `list_seats`, `get_seat`, `campaign`, `campaign_batch`,
`buy_report`, `get_news`, `wait_for_events`, `chat`, `get_chat`, `propose_government`, `respond_offer`, `withdraw_offer`, `list_offers`, `leave_game`.
Limits: `wait_for_events` `timeout_s` max 60 (default 25), `wait_for_admission` `timeout_s` max 120 (default 30), `list_seats` `limit` max 100, `campaign_batch` max 50 actions per call.
Chat opens at the campaign start by default (`messaging.opensAt`); a government is confirmed only once every seat is declared (end of counting) and the game then ends at once; at least one party always stays out; offers are private. `set_party {auto_pick:true}` alone picks a free unique name / colour / symbol / avatar (explicit fields always win; with a name it only fills the rest and retries on clashes); `join_game` accepts `code` as an alias of `join_code` and defaults `nickname` to "Claude"; report prices rise by the second (the report shows `price_paid_wr`); an outright-majority government is flagged `outright_majority` (no shared portfolios); `withdraw_offer` needs no id.
Plus the MCP resource `hung-parliament://rules` and the prompt `play-hung-parliament`. Players are given as party name (case-insensitive) or id (nicknames are never used in game output or input); seats as id or
name. Errors are returned as text (`ERROR CODE: message` + `Hint: ...`), never as protocol failures.

`get_rules` renders `RULES.md` (a template) with the live numbers of the game's map configuration (budget, prices, effects, points), so the text can never go stale.

## CLI fallback (agents that only have a shell)
```bash
# from the repo root (works from any directory); `npx tsx game/agent/src/cli.ts ...` from inside game/ is equivalent but slower to start
node game/agent/bin/cli.mjs start --name Claude1 --server http://localhost:8787   # background daemon, returns immediately
node game/agent/bin/cli.mjs get_rules --name Claude1
node game/agent/bin/cli.mjs join_game --name Claude1 '{"join_code":"ABC123","nickname":"Claude"}'
node game/agent/bin/cli.mjs wait_for_admission --name Claude1 timeout_s=60
node game/agent/bin/cli.mjs set_party --name Claude1 name="Blue Wave" colour=Blue symbol=globe avatar=modi
node game/agent/bin/cli.mjs campaign_batch --name Claude1 '{"actions":[{"type":"roadshow","seat":12},{"type":"rally","seat":"Delhi East"}]}'
node game/agent/bin/cli.mjs actions                      # all actions with JSON input schemas
node game/agent/bin/cli.mjs list                         # running daemons
node game/agent/bin/cli.mjs stop --name Claude1
```
Arguments: a JSON object, or `key=value` pairs (values parsed as JSON when possible; a bare string for an array field is split on commas: `types=status`, `types=chat,offer`, `to=all`, `partners=a,b`), or `--args-file file.json`. Shells that strip double quotes (PowerShell) are tolerated:
`'{type:rally,seat:17}'` works. Output is the same text an MCP client would see (JSON, or the rules, or `ERROR CODE: ...`); exit code 1 on action errors, 2 when no daemon runs.
The daemon (`src/daemon.ts`) holds the GameClient and WebSocket, listens on `127.0.0.1` on a random port with a shared secret, and writes
`game/agent/.sessions/<name>.json` (git-ignored; also `<name>.log` and `<name>.session.json`). `start` again after a crash rejoins the same player.

## How a human hosts and admits AI players
1. Start the server and the web app; create a game in the web UI (choose map and number of polling phases). Share the **join code**.
2. Give the code to the AI ("play HUNG PARLIAMENT, code ABC123"). The AI calls `join_game`; it appears under **Join requests** with a robot badge.
3. Click **Admit** (or Deny). The AI then picks a unique party name / colour / symbol / avatar (`list_party_options`, `set_party`).
4. When 2+ players have a party with an avatar, the host clicks **Start**. The AI sees the status change and campaigns. Humans and AIs play identically; AI decisions are not artificially slowed.

## Design notes
- `src/actions.ts` is the single action table (name, LLM description, zod schema, handler); `mcp.ts` and `daemon.ts`/`cli.ts` only wrap it.
- `src/client.ts` (`GameClient`): REST + WebSocket (ping on open and every 15 s, reconnect with backoff and the same token, server-clock offset), state reducer in `src/state.ts`
  (same logic as the web store), event log with a monotonic cursor and `waitForEvents`. It has **no create-game method**.
- Campaign actions are pipelined with `clientRef`s (`campaign_batch`, up to 50 per call); everything else is sent one at a time and confirmed with a ping barrier.
- Local pre-validation (budget, polled seat, campaign window) only saves wasted calls; the server is always the authority.

## What cannot be enforced
"AI can never host" is enforced by construction (no create call in this package) and by the server refusing `kind:'agent'` on game creation and marking players who join with
`kind:'agent'`. A determined user could still script the REST API as a "human" or join as `human` from a script: the `kind` flag is a declaration, not authentication.

## Tests
`cd game/agent && npx vitest run` (unit tests, a real in-process dev server with two AI clients playing a full game, MCP over stdio, the CLI daemon) and `npx tsc -p tsconfig.json`.
