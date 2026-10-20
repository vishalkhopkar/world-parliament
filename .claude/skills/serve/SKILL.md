---
name: serve
description: Start the HUNG PARLIAMENT game locally (game server on :8787 plus the web app on :5173), or restart both if they are already running. Takes no arguments. Use when the user asks to serve, start, run or restart the game/server/website, or after server code changes need to take effect.
---

# serve

Starts, or restarts, the local game. No arguments.

Run this one command from the repo root and report its output:

```bash
python -I .claude/skills/serve/serve.py
```

What it does:
1. Stops whatever is listening on port 8787 (game server) and port 5173 (web app), if anything. It kills only those processes (by PID, with their children), never `node.exe` in general.
2. Starts both again, detached, so they keep running after the command returns:
   - game server: `npm run dev` in `game/server` → REST + WebSocket on http://localhost:8787, log in `.srv.log`
   - web app: `npx vite --port 5173 --host` in `game/web` → http://localhost:5173, log in `.vite.log`
3. Waits until both answer and prints `started` or `restarted`, then the play URL `http://localhost:5173/?server=local`.

Notes for the reply:
- Tell the user the URL. For several players in one browser profile, add `&as=<name>` to give each tab its own saved session.
- A restart ends any game in progress on the server (games live in memory); say so if one was running.
- If it prints FAILED, read the end of `.srv.log` / `.vite.log` and report the error. If `game/node_modules` is missing it says so: run `npm install` in `game/` (ask first).
- The static map study site needs no server of its own: the web app serves it at http://localhost:5173/maps/world-500/site/index.html.
