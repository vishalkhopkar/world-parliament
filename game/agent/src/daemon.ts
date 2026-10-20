// Background daemon for agents that only have a shell: holds ONE AgentSession (GameClient + WebSocket) and exposes the
// action table over a local HTTP API (127.0.0.1, random port, shared-secret header). Started by `cli.ts start`.
//   node --import tsx src/daemon.ts --name Claude1 [--server URL] [--ws URL]
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ACTIONS, executeAction } from './actions';
import { NAME_RE, SESSIONS_DIR, sessionFile, stateFile } from './paths';
import type { DaemonInfo } from './paths';
import { toJsonSchema } from './schema';
import { AgentSession } from './session';

export interface DaemonOptions { name: string; server?: string; ws?: string; dir?: string; port?: number; idleExitMs?: number }
export interface RunningDaemon { info: DaemonInfo; session: AgentSession; close(): Promise<void> }

export function actionCatalog() {
  return ACTIONS.map((a) => ({ name: a.name, description: a.description, read_only: !!a.readOnly, input_schema: toJsonSchema(a.schema) }));
}

export async function startDaemon(o: DaemonOptions): Promise<RunningDaemon> {
  if (!NAME_RE.test(o.name)) throw new Error('--name must be 1-40 chars of A-Z a-z 0-9 _ -');
  const dir = o.dir ?? SESSIONS_DIR;
  mkdirSync(dir, { recursive: true });
  const server = o.server || process.env.HP_SERVER || 'http://localhost:8787';
  const session = new AgentSession({
    server, ws: o.ws || process.env.HP_WS || undefined, sessionFile: sessionFile(o.name, dir),
    log: (m) => console.error(`[${new Date().toISOString()}] ${m}`),
  });
  await session.restore();
  const secret = randomBytes(16).toString('hex');
  let lastCall = Date.now();
  let closing = false;
  let close: () => Promise<void> = async () => undefined;

  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.headers['x-hp-secret'] !== secret) return send(403, { ok: false, error: { code: 'FORBIDDEN', message: 'bad secret' } });
        lastCall = Date.now();
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, name: o.name, joined: session.joined, link: session.client.state.link });
          if (req.method === 'GET' && url.pathname === '/actions') return send(200, { ok: true, actions: actionCatalog() });
          if (req.method === 'POST' && url.pathname === '/stop') { send(200, { ok: true }); setTimeout(() => void close(), 20); return; }
          if (req.method === 'POST' && url.pathname === '/call') {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { action?: string; args?: unknown };
            const r = await executeAction(session, String(body.action ?? ''), body.args ?? {});
            return send(200, r);
          }
          return send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown route' } });
        } catch (e) {
          return send(500, { ok: false, error: { code: 'INTERNAL', message: (e as Error).message } });
        }
      })();
    });
  });
  await new Promise<void>((r) => http.listen(o.port ?? 0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const info: DaemonInfo = { name: o.name, pid: process.pid, port, secret, server: session.client.server, startedAt: Date.now() };
  writeFileSync(stateFile(o.name, dir), JSON.stringify(info));

  const idle = setInterval(() => {
    if (o.idleExitMs && Date.now() - lastCall > o.idleExitMs) { console.error('idle timeout: exiting'); void close(); }
  }, 30_000);
  idle.unref();

  close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(idle);
    session.client.close();
    try { if (existsSync(stateFile(o.name, dir))) unlinkSync(stateFile(o.name, dir)); } catch { /* ignore */ }
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { info, session, close };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const name = arg(argv, 'name') ?? 'agent';
  startDaemon({
    name, server: arg(argv, 'server'), ws: arg(argv, 'ws'), idleExitMs: 3 * 60 * 60 * 1000,
  }).then((d) => {
    console.error(`daemon "${name}" listening on 127.0.0.1:${d.info.port} (server ${d.info.server})`);
    const stop = () => { void d.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // exit when the control server closes via /stop
    const t = setInterval(() => { if (!existsSync(stateFile(name))) { clearInterval(t); process.exit(0); } }, 500);
  }).catch((e) => { console.error('daemon failed:', e); process.exit(1); });
}
