// End-to-end orchestrator:  npm run test:e2e   (from game/)
//
//   1. bot e2e (e2e/bots.ts) for 2 and 3 players, each against its OWN dev server on a free port with short timings
//      (the two runs go in parallel),
//   2. browser e2e (e2e/browser.ts): it starts its own dev server (:8787) + Vite (:5173) and drives headless Chrome.
//
// Only processes started here are stopped (by PID, whole tree) - never by image name. Exit code 0 = everything passed.
//
// Options:  --players=2,3   bot player counts          --phases=2      polling phases for the bots
//           --skip-bots     only the browser test       --skip-browser  only the bot tests
// Env:      CHROME_PATH     Chrome/Chromium executable for the browser test (auto-detected when unset)
//           VERBOSE=1       also print server output
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gameDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(gameDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const argv = process.argv.slice(2);
const flagValue = (n: string, d: string) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const PLAYERS = flagValue('players', '2,3').split(',').map(Number);
const PHASES = flagValue('phases', '2');
const SKIP_BOTS = argv.includes('--skip-bots');
const SKIP_BROWSER = argv.includes('--skip-browser');
const VERBOSE = !!process.env.VERBOSE;

/** Short game: campaign 45 s, counting 20 s, post-counting 15 s, 2 s lead-in (see e2e/README.md). */
const SHORT_ENV = { HP_CAMPAIGN_MS: '45000', HP_COUNTING_MS: '20000', HP_POST_MS: '15000', HP_START_DELAY_MS: '2000' };

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ------------------------------------------------------------------ process management (own children only)
const children = new Set<ChildProcess>();

function spawnNode(args: string[], env: Record<string, string>, label: string, onLine?: (l: string) => void): ChildProcess {
  const c = spawn(process.execPath, args, {
    cwd: gameDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', // own process group on POSIX so the whole tree can be signalled
  });
  children.add(c);
  c.on('exit', () => children.delete(c));
  const pipe = (stream: NodeJS.ReadableStream | null, err: boolean) => {
    let buf = '';
    stream?.on('data', d => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine?.(line);
        if (VERBOSE || label.startsWith('bots') || (err && /error/i.test(line))) (err ? console.error : console.log)(`  [${label}] ${line}`);
      }
    });
  };
  pipe(c.stdout, false);
  pipe(c.stderr, true);
  return c;
}

function killTree(c: ChildProcess) {
  if (!c.pid || c.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-c.pid, 'SIGKILL');
  } catch { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
}
function killAll() { for (const c of [...children]) killTree(c); }
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { killAll(); process.exit(130); });
process.on('exit', killAll);

function exitCode(c: ChildProcess): Promise<number> {
  return new Promise(resolve => {
    if (c.exitCode !== null) return resolve(c.exitCode);
    c.on('exit', code => resolve(code ?? 1));
    c.on('error', () => resolve(1));
  });
}

// ------------------------------------------------------------------ ports
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}
function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(port, () => s.close(() => resolve(false)));
  });
}
async function waitHttp(url: string, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error('timeout waiting for ' + url);
    await sleep(250);
  }
}

// ------------------------------------------------------------------ steps
async function runBots(players: number): Promise<boolean> {
  const label = `bots-${players}p`;
  const port = await freePort();
  const server = spawnNode([tsxCli, 'server/src/local/devServer.ts'], { ...SHORT_ENV, HP_PORT: String(port) }, `server-${players}p`);
  try {
    await waitHttp(`http://127.0.0.1:${port}/`, 60_000);
    log(`${label}: dev server on :${port}, starting ${players} bots`);
    const bots = spawnNode([tsxCli, 'e2e/bots.ts', `http://127.0.0.1:${port}`, '--players', String(players), '--phases', PHASES, '--seed', String(7 + players)], {}, label);
    const code = await exitCode(bots);
    log(`${label}: ${code === 0 ? 'PASS' : 'FAIL (exit ' + code + ')'}`);
    return code === 0;
  } finally {
    killTree(server);
  }
}

function detectChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find(existsSync);
}

async function runBrowser(): Promise<boolean> {
  for (const port of [8787, 5173]) {
    if (await portInUse(port)) { console.error(`browser e2e needs port ${port} (fixed in e2e/browser.ts) but it is in use; stop whatever uses it and retry`); return false; }
  }
  const chrome = detectChrome();
  if (!chrome) { console.error('browser e2e: no Chrome found; set CHROME_PATH'); return false; }
  log(`browser: using ${chrome}`);
  const b = spawnNode([tsxCli, 'e2e/browser.ts'], { CHROME_PATH: chrome }, 'browser');
  const code = await exitCode(b);
  log(`browser: ${code === 0 ? 'PASS' : 'FAIL (exit ' + code + ')'}`);
  return code === 0;
}

async function main() {
  const results: [string, boolean][] = [];
  if (!SKIP_BOTS) {
    const outcomes = await Promise.all(PLAYERS.map(async n => [`bots ${n} players`, await runBots(n)] as [string, boolean]));
    results.push(...outcomes);
  }
  if (!SKIP_BROWSER) results.push(['browser', await runBrowser()]);
  killAll();
  console.log('\n=== e2e summary ===');
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const ok = results.length > 0 && results.every(r => r[1]);
  console.log(ok ? 'ALL E2E PASSED' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); killAll(); process.exit(1); });
