// Coverage-gap report (grep based). @vitest/coverage-v8 is not installed in this repo, so instead of line coverage this
// script lists the public surface that no test file mentions:
//   - shared:  every exported function / const of src/ (engine + contract helpers)
//   - server:  every ErrorCode (protocol.ts), GameService public method, REST route (core/http.ts), WS action
//              (handleMessage switch), Lambda handler, Repo method, Notifier / Scheduler method
//   - agent:   every action of the ACTIONS table (actions.ts)
//   - sim:     exported functions / strategies
// "Mentioned" = the identifier / quoted literal occurs in a test file of that workspace (word match). It is a heuristic
// (a mention is not proof of a good assertion) but a name with ZERO mentions is certainly untested.
//
//   npx tsx scripts/coverage-gaps.ts            report, exit 0
//   npx tsx scripts/coverage-gaps.ts --strict   exit 1 when anything is unmentioned (used by `npm run test:gaps`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gameDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

function walk(dir: string, filter: (f: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}
const read = (f: string) => fs.readFileSync(f, 'utf8');
const readAll = (files: string[]) => files.map(read).join('\n');
const testText = (ws: string, extra: string[] = []) =>
  readAll([...walk(path.join(gameDir, ws, 'test'), f => /\.ts$/.test(f)), ...extra.filter(fs.existsSync)]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentioned = (text: string, name: string, quoted = false) =>
  new RegExp(quoted ? `['"\`]${escape(name)}['"\`]` : `\\b${escape(name)}\\b`).test(text);

interface Group { title: string; items: { name: string; hit: boolean }[] }
const groups: Group[] = [];
function add(title: string, names: string[], text: string, quoted = false) {
  const uniq = [...new Set(names)];
  groups.push({ title, items: uniq.map(name => ({ name, hit: mentioned(text, name, quoted) })) });
}

// ------------------------------------------------------------------ shared
{
  const text = testText('shared', walk(path.join(gameDir, 'server', 'test'), f => /\.ts$/.test(f)));
  const names: string[] = [];
  for (const f of walk(path.join(gameDir, 'shared/src'), f => /\.ts$/.test(f) && !/generated|index\.ts$|types\.ts$/.test(f))) {
    for (const m of read(f).matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) names.push(m[1]);
  }
  add('shared: exported functions/constants (shared + server tests)', names, text);
}

// ------------------------------------------------------------------ server
{
  const text = testText('server');
  const proto = read(path.join(gameDir, 'shared/src/protocol.ts'));
  const block = /export type ErrorCode =([\s\S]*?);/.exec(proto)?.[1] ?? '';
  const codes = [...block.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
  add('server: ErrorCode values (must be asserted somewhere)', codes, text, true);

  const svc = read(path.join(gameDir, 'server/src/core/gameService.ts'));
  const methods = [...svc.matchAll(/^  async (\w+)\(/gm)].map(m => m[1]);
  add('server: GameService public methods', methods, text);

  const http = read(path.join(gameDir, 'server/src/core/http.ts'));
  const routes = [...http.matchAll(/case '(\w+)':/g)].map(m => m[1]);
  // a route counts as mentioned when it appears as a quoted literal or as a path segment ("/admit")
  groups.push({ title: 'server: REST routes (core/http.ts)', items: ['join', ...routes].map(name => ({ name, hit: mentioned(text, name, true) || new RegExp(`/${name}\\b`).test(text) })) });

  const wsActions = [...[...svc.matchAll(/case '(\w+)'(?::| )/g)].map(m => m[1])].filter(a => ['ping', 'campaign', 'buyReport', 'chat', 'proposeGovernment', 'respondOffer', 'withdrawOffer'].includes(a));
  add('server: WebSocket actions', wsActions, text, true);

  const handlers = walk(path.join(gameDir, 'server/src/handlers'), f => /\.ts$/.test(f)).map(f => path.basename(f, '.ts'));
  add('server: Lambda handlers (file name mentioned)', handlers, text);

  const types = read(path.join(gameDir, 'server/src/core/types.ts'));
  const repo = /export interface Repo \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
  add('server: Repo methods', [...repo.matchAll(/^  (\w+)\(/gm)].map(m => m[1]), text);
}

// ------------------------------------------------------------------ agent
{
  const text = testText('agent');
  const src = read(path.join(gameDir, 'agent/src/actions.ts'));
  const names = [...src.matchAll(/^\s{4}name: '(\w+)'/gm)].map(m => m[1]);
  add('agent: actions of the ACTIONS table', names, text, true);
  const files = walk(path.join(gameDir, 'agent/src'), f => /\.ts$/.test(f)).map(f => path.basename(f, '.ts'));
  add('agent: source modules (file name mentioned in a test import)', files, text);
}

// ------------------------------------------------------------------ sim
{
  const text = testText('sim');
  const bots = read(path.join(gameDir, 'sim/src/bots.ts'));
  const strategies = [...(/export const STRATEGIES[^{]*\{([\s\S]*?)\n\};/.exec(bots)?.[1] ?? '').matchAll(/^\s+(\w+):/gm)].map(m => m[1]);
  // a test that iterates Object.keys(STRATEGIES) covers every strategy
  const iterates = /Object\.(keys|values|entries)\(STRATEGIES\)/.test(text);
  groups.push({ title: 'sim: strategies', items: strategies.map(name => ({ name, hit: iterates || mentioned(text, name) })) });
  add('sim: entry points', ['runGame', 'buildWorld', 'loadMap'], text);
}

// ------------------------------------------------------------------ report
let missing = 0;
for (const g of groups) {
  const miss = g.items.filter(i => !i.hit);
  missing += miss.length;
  console.log(`\n## ${g.title}: ${g.items.length - miss.length}/${g.items.length} mentioned in tests`);
  if (miss.length) console.log('   NOT MENTIONED: ' + miss.map(i => i.name).join(', '));
}
console.log(`\nTotal unmentioned: ${missing}`);
if (strict && missing) process.exit(1);
