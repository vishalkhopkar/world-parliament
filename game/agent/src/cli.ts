// CLI for agents that only have a shell. Same actions as the MCP tools (they come from the same table, via the daemon).
// From the repo root (works from any directory):
//   node game/agent/bin/cli.mjs start  --name Claude1 [--server http://localhost:8787]   # background daemon, returns immediately
//   node game/agent/bin/cli.mjs get_rules --name Claude1
//   node game/agent/bin/cli.mjs join_game --name Claude1 '{"join_code":"ABC123","nickname":"Claude"}'
//   node game/agent/bin/cli.mjs campaign  --name Claude1 type=rally seat=17        # key=value also works (no JSON quoting pains)
//   node game/agent/bin/cli.mjs wait_for_events --name Claude1 types=status,chat   # bare strings are accepted for array fields
//   node game/agent/bin/cli.mjs actions [--name Claude1]                           # list actions + input schemas
//   node game/agent/bin/cli.mjs stop --name Claude1 | list
// Kept dependency-light (node builtins only) so each call costs little more than the tsx start-up.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AGENT_DIR, DAEMON_ENTRY, NAME_RE, SESSIONS_DIR, logFile, stateFile } from './paths';
import type { DaemonInfo } from './paths';

const out = (s: string) => process.stdout.write(s + '\n');
/** Thrown by fail(); run() turns it into an exit code. (No process.exit(): on Windows it can crash node while fetch sockets are open.) */
class CliExit extends Error { constructor(public exitCode: number) { super('exit'); } }
const fail = (code: string, message: string, hint?: string, exit = 1): never => {
  out(`ERROR ${code}: ${message}${hint ? `\nHint: ${hint}` : ''}`);
  throw new CliExit(exit);
};

/** Parse JSON, tolerating shells that strip the double quotes ({type:rally,seat:17}). */
export function parseArgsLenient(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try relaxed */ }
  let t = text.trim();
  t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  t = t.replace(/:\s*([^"\[{\s,}\]][^,}\]]*?)\s*(?=[,}\]])/g, (_m, v: string) => (/^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? `:${v}` : `:${JSON.stringify(v)}`));
  t = t.replace(/\[\s*([^"\[{\]][^\]]*?)\s*\]/g, (_m, inner: string) => '[' + inner.split(',').map((x) => {
    const v = x.trim();
    return /^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? v : JSON.stringify(v);
  }).join(',') + ']');
  return JSON.parse(t);
}

/** Shell command prefix agents should use (from the repo root). */
export const CLI_CMD = 'node game/agent/bin/cli.mjs';

/** The `next` hint printed by `start`. */
export const nextHint = (name: string): string => `${CLI_CMD} get_rules --name ${name}   (then join_game with the code the human gives you)`;

export interface Parsed { command: string; name: string; server?: string; ws?: string; args: Record<string, unknown> }

export function parseArgv(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const rest: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = 'true';
    } else rest.push(a);
  }
  const command = rest.shift() ?? '';
  let args: Record<string, unknown> = {};
  if (flags['args-file']) args = JSON.parse(readFileSync(flags['args-file'], 'utf8'));
  for (const r of rest) {
    if (r.trim().startsWith('{')) { args = { ...args, ...(parseArgsLenient(r) as Record<string, unknown>) }; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(r);
    if (m) {
      let v: unknown = m[2];
      try { v = JSON.parse(m[2]); } catch { /* keep string */ }
      args[m[1]] = v;
    } else fail('INVALID_INPUT', `Unexpected argument "${r}".`, 'Pass JSON like \'{"seat":17}\' or key=value pairs like seat=17.');
  }
  return { command, name: flags.name ?? env.HP_AGENT_NAME ?? 'agent', server: flags.server, ws: flags.ws, args };
}

function readInfo(name: string): DaemonInfo | null {
  try { return JSON.parse(readFileSync(stateFile(name), 'utf8')) as DaemonInfo; } catch { return null; }
}

async function daemonFetch(info: DaemonInfo, method: string, path: string, body?: unknown, timeoutMs = 130_000): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method, headers: { 'x-hp-secret': info.secret, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

async function alive(info: DaemonInfo | null): Promise<boolean> {
  if (!info) return false;
  try { return !!(await daemonFetch(info, 'GET', '/health', undefined, 2000))?.ok; } catch { return false; }
}

function tsxImport(): string {
  try { return import.meta.resolve('tsx'); } catch { return 'tsx'; }
}

async function start(p: Parsed): Promise<void> {
  if (!NAME_RE.test(p.name)) fail('INVALID_INPUT', '--name must be 1-40 chars of A-Z a-z 0-9 _ -');
  const existing = readInfo(p.name);
  if (await alive(existing)) {
    out(JSON.stringify({ ok: true, already_running: true, name: p.name, port: existing!.port, pid: existing!.pid, server: existing!.server }));
    return;
  }
  mkdirSync(SESSIONS_DIR, { recursive: true });
  try { if (existsSync(stateFile(p.name))) unlinkSync(stateFile(p.name)); } catch { /* stale */ }
  const fd = openSync(logFile(p.name), 'a');
  const args = ['--import', tsxImport(), DAEMON_ENTRY, '--name', p.name];
  if (p.server) args.push('--server', p.server);
  if (p.ws) args.push('--ws', p.ws);
  const child = spawn(process.execPath, args, { cwd: AGENT_DIR, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
  child.unref();
  closeSync(fd);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = readInfo(p.name);
    if (info && (await alive(info))) {
      out(JSON.stringify({
        ok: true, name: p.name, port: info.port, pid: info.pid, server: info.server,
        next: nextHint(p.name),
      }));
      return;
    }
  }
  fail('DAEMON', `The daemon did not start within 25 s. See ${logFile(p.name)}`);
}

async function stop(p: Parsed): Promise<void> {
  const info = readInfo(p.name);
  if (!info) { out(JSON.stringify({ ok: true, note: `no daemon named ${p.name}` })); return; }
  try { await daemonFetch(info, 'POST', '/stop', {}, 3000); } catch { /* maybe dead already */ }
  for (let i = 0; i < 30 && existsSync(stateFile(p.name)); i++) await new Promise((r) => setTimeout(r, 100));
  if (existsSync(stateFile(p.name))) {
    try { process.kill(info.pid); } catch { /* gone */ }
    try { unlinkSync(stateFile(p.name)); } catch { /* ignore */ }
  }
  out(JSON.stringify({ ok: true, stopped: p.name, note: 'If a game was running you will be eliminated after the grace period.' }));
}

async function list(): Promise<void> {
  const rows: unknown[] = [];
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.session.json')) continue;
      const info = readInfo(f.slice(0, -5));
      if (info) rows.push({ name: info.name, port: info.port, pid: info.pid, running: await alive(info) });
    }
  }
  out(JSON.stringify({ daemons: rows }));
}

export async function main(): Promise<void> {
  const p = parseArgv(process.argv.slice(2));
  switch (p.command) {
    case '':
    case 'help':
    case '--help':
      out('Usage: node game/agent/bin/cli.mjs start|stop|list|actions|<action> --name <name> [json | key=value ...]\nRun "actions" for the list of actions.');
      return;
    case 'start': return start(p);
    case 'stop': return stop(p);
    case 'list': return list();
    case 'actions': {
      const info = readInfo(p.name);
      if (info && (await alive(info))) {
        const r = await daemonFetch(info, 'GET', '/actions');
        out(JSON.stringify(r.actions));
      } else {
        const { actionCatalog } = await import('./daemon'); // offline listing
        out(JSON.stringify(actionCatalog()));
      }
      return;
    }
  }
  const info = readInfo(p.name);
  if (!(await alive(info))) {
    fail('DAEMON', `No running daemon named "${p.name}".`, `Start one: ${CLI_CMD} start --name ${p.name}`, 2);
  }
  let r: any;
  try {
    r = await daemonFetch(info as DaemonInfo, 'POST', '/call', { action: p.command, args: p.args });
  } catch (e) {
    return fail('DAEMON', `The daemon did not answer: ${(e as Error).message}`);
  }
  if (r.ok) {
    out(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
  } else {
    return fail(r.error.code, r.error.message, r.error.hint);
  }
}

/** main() with errors mapped to the exit code (what the entry points call). */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (e) {
    if (e instanceof CliExit) { process.exitCode = e.exitCode; return; }
    out(`ERROR INTERNAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void run();
