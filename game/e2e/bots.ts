// Bot-client end-to-end test for the HUNG PARLIAMENT backend (REST + WebSocket).
//   npx tsx e2e/bots.ts [baseUrl] [--players 3] [--phases 2] [--ws ws://localhost:8787/ws] [--seed 1]
// Starts nothing itself: run the dev server first (see e2e/README.md). Exits non-zero on any failed check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG, majorityOf } from '@hp/shared';
import type {
  ClientMessage, FinalResult, GameMapPackage, GameTimeline, PlayerId, SeatId, ServerMessage,
} from '@hp/shared';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !argv[i - 1].includes('=')));
const BASE = (positional[0] ?? 'http://localhost:8787').replace(/\/+$/, '');
const WS = flag('ws', BASE.replace(/^http/, 'ws') + '/ws');
const N = Number(flag('players', '3'));
const PHASES = Number(flag('phases', '2'));
const SEED = Number(flag('seed', String(Date.now() % 100000)));
const CFG = WORLD_CONFIG;
if (!(N >= 2 && N <= CFG.players.max)) throw new Error(`--players must be 2..${CFG.players.max}`);

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../../maps/world-500/site/data/game.json', import.meta.url)), 'utf8')) as GameMapPackage;
const GROUPS = PKG.phaseGroups[String(PHASES)];
if (!GROUPS) throw new Error('map has no phase grouping for ' + PHASES);
const NEIGH = new Map(PKG.seats.map(s => [s.id, s.neighbours]));

// ------------------------------------------------------------------ utilities
let seedState = SEED >>> 0;
const rnd = () => { seedState = (seedState + 0x6D2B79F5) >>> 0; let t = seedState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
const t0 = Date.now();
/** extra wait (ms) on top of the rally cooldown before a bot rallies again, so timer jitter never hits RATE_LIMITED */
const RALLY_MARGIN_MS = 600;
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

const failures: string[] = [];
function check(cond: unknown, msg: string): boolean {
  if (!cond) { failures.push(msg); console.error('  FAIL: ' + msg); }
  return !!cond;
}
class Fatal extends Error {}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Fatal(msg); }

async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(BASE + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

// ------------------------------------------------------------------ bot client
type Pred = (m: ServerMessage) => boolean;
const ALLOWED_BUDGET = new Set(['hello', 'private', 'actionAck', 'report']);

class Bot {
  msgs: ServerMessage[] = [];
  ws!: WebSocket;
  playerId = '';
  token = '';
  /** budget as last reported by the server for this player */
  budget = -1;
  /** budget kept back from random campaigning (the analyst scenario must still afford its reports; W₹50,000 is tight) */
  reserve = 0;
  acked: { type: string; seat: number }[] = [];
  /** earliest local time (ms) this bot sends its next rally: the ack's nextRallyAt (cooldowns.rallyMs after the last rally) plus a margin */
  rallyAfter = 0;
  /** a rally request is in flight (bot 0 runs two campaign streams): hold further rallies until the ack says when the next is allowed */
  rallyPending = false;
  /** the one-off "a second rally right away is RATE_LIMITED" check has been done for this bot */
  rateChecked = false;
  reportsBought = 0;
  violations: string[] = [];
  private refCounter = 0;
  constructor(public name: string, public idx: number) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS}?gameId=${encodeURIComponent(gameId)}&token=${encodeURIComponent(this.token)}`);
      this.ws = ws;
      let done = false;
      ws.onopen = () => { ws.send(JSON.stringify({ action: 'ping', clientTime: Date.now() })); };
      ws.onerror = () => { if (!done) { done = true; reject(new Error(this.name + ': websocket error')); } };
      ws.onmessage = ev => {
        const raw = String(ev.data);
        const m = JSON.parse(raw) as ServerMessage;
        this.inspect(raw, m);
        this.msgs.push(m);
        if (m.type === 'hello' && !done) { done = true; resolve(); }
      };
    });
  }
  /** Hidden-information invariants, checked on every raw message this client receives. */
  private inspect(raw: string, m: ServerMessage) {
    const bad = (s: string) => { this.violations.push(`${this.name}: ${s} (${m.type})`); };
    if (raw.includes('"budget"') && !ALLOWED_BUDGET.has(m.type)) bad('budget field in a public message');
    if (raw.includes('roadshow') && m.type !== 'hello' && m.type !== 'private') bad('roadshow data outside private state');
    if (m.type === 'hello' && m.private.you !== this.playerId) bad('hello carries another player\'s private state');
    if (m.type === 'private' && m.private.you !== this.playerId) bad('private state of another player');
    if (m.type === 'hello' || m.type === 'private') {
      this.budget = m.private.budget;
      const myRoad = m.private.myActions.filter(a => a.type === 'roadshow').length;
      const acked = this.acked.filter(a => a.type === 'roadshow').length;
      if (m.private.myActions.length > this.acked.length || myRoad > acked) bad('myActions longer than what this player did');
    }
    if (m.type === 'actionAck') this.budget = m.budget;
    if (m.type === 'report') { this.budget = m.budget; }
    if (m.type === 'hello' && m.snapshot.players.some(p => (p as any).budget !== undefined)) bad('budget inside players');
  }
  send(msg: ClientMessage) { this.ws.send(JSON.stringify(msg)); }
  async waitFor(pred: Pred, opts: { from?: number; ms?: number; what?: string } = {}): Promise<ServerMessage> {
    const from = opts.from ?? 0, deadline = Date.now() + (opts.ms ?? 15000);
    for (;;) {
      for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i])) return this.msgs[i];
      if (Date.now() > deadline) throw new Fatal(`${this.name}: timeout waiting for ${opts.what ?? 'message'}; last types: ${this.msgs.slice(-8).map(m => m.type).join(',')}`);
      await sleep(10);
    }
  }
  private chain: Promise<unknown> = Promise.resolve();
  /** One request at a time per bot, so budget bookkeeping is exact. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  /** Send and wait for the matching success message, or the first error. `before` = budget when the request was sent. */
  requestB(msg: ClientMessage, ok: Pred, ref?: string): Promise<{ m: ServerMessage; before: number }> {
    return this.serial(async () => {
      const from = this.msgs.length, before = this.budget;
      this.send(msg);
      const m = await this.waitFor(x => ok(x) || (x.type === 'error' && (ref === undefined || x.clientRef === ref)), { from, what: msg.action });
      return { m, before };
    });
  }
  async request(msg: ClientMessage, ok: Pred, ref?: string): Promise<ServerMessage> { return (await this.requestB(msg, ok, ref)).m; }
  /** true when a rally from this bot would not run into the rally cooldown (rallies must be cooldowns.rallyMs apart; roadshows are never limited) */
  rallyReady(): boolean { return !this.rallyPending && Date.now() >= this.rallyAfter; }
  async campaign(type: 'rally' | 'roadshow', seat: SeatId): Promise<ServerMessage> {
    const ref = `${this.idx}-${++this.refCounter}`;
    if (type === 'rally') this.rallyPending = true;
    let res: { m: ServerMessage; before: number };
    try {
      res = await this.requestB({ action: 'campaign', type, seat, clientRef: ref }, m => m.type === 'actionAck' && m.clientRef === ref, ref);
    } finally {
      if (type === 'rally') this.rallyPending = false;
    }
    const { m: r, before } = res;
    if (r.type === 'actionAck') {
      // ack time is after the server's receipt time, so ack + cooldown is never too early; the server's own nextRallyAt is the exact value
      if (type === 'rally') this.rallyAfter = (r.nextRallyAt ?? Date.now() + CFG.cooldowns.rallyMs) + RALLY_MARGIN_MS;
      this.acked.push({ type, seat });
      check(r.budget === before - CFG.costs[type], `${this.name}: budget after ${type} is ${r.budget}, expected ${before - CFG.costs[type]}`);
    }
    return r;
  }
  err(r: ServerMessage): string | undefined { return r.type === 'error' ? r.error : undefined; }
  has(type: ServerMessage['type'], from = 0) { return this.msgs.slice(from).some(m => m.type === type); }
  get newsCount(): number {
    let lastHello = -1;
    this.msgs.forEach((m, i) => { if (m.type === 'hello') lastHello = i; });
    const h = this.msgs[lastHello];
    const base = h && h.type === 'hello' ? h.snapshot.news.length : 0;
    return base + this.msgs.slice(lastHello + 1).filter(m => m.type === 'news').length;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let gameId = '';
let bots: Bot[] = [];
let timeline!: GameTimeline;

// ------------------------------------------------------------------ campaign behaviour
function openSeats(minRemainingMs: number): SeatId[] {
  const now = Date.now();
  const out: SeatId[] = [];
  GROUPS.forEach((g, p) => { if (timeline.phaseCloses[p] - now > minRemainingMs) out.push(...g); });
  return out;
}

/**
 * Random rallies and roadshows until `until`. Rallies are only sent when the bot's cooldown (cooldowns.rallyMs, 30 s) has passed, so
 * every action is acked; the first rally of each bot is followed at once by a second one, which must be RATE_LIMITED and cost nothing.
 * `allowRally = false` = roadshows only (bot 0's pre-drain stream: its later "rally with an empty purse" must see INSUFFICIENT_FUNDS).
 */
async function randomCampaign(bot: Bot, until: number, home: Set<SeatId>, allowRally = true) {
  while (Date.now() < until) {
    await sleep(120 + rnd() * 500);
    if (Date.now() >= until) break;
    const open = openSeats(1500);
    if (!open.length) break;
    const openHome = [...home].filter(s => open.includes(s));
    const seat = openHome.length && rnd() < 0.75 ? pick(openHome) : pick(open);
    const type = rnd() < 0.6 && allowRally && bot.rallyReady() ? 'rally' : 'roadshow';
    if (bot.budget - CFG.costs[type] < bot.reserve) continue;
    const r = await bot.campaign(type, seat);
    check(r.type === 'actionAck', `${bot.name}: ${type} in seat ${seat} rejected: ${bot.err(r)} ${r.type === 'error' ? r.message : ''}`);
    if (type === 'rally' && r.type === 'actionAck' && !bot.rateChecked) {
      bot.rateChecked = true;
      const again = await bot.campaign('rally', seat);
      check(bot.err(again) === 'RATE_LIMITED', `${bot.name}: a second rally right after the first should be RATE_LIMITED, got ${again.type === 'error' ? again.error : again.type}`);
      check(again.type === 'error' && typeof again.retryAt === 'number' && again.retryAt > Date.now() + CFG.cooldowns.rallyMs - 5000, `${bot.name}: RATE_LIMITED should carry retryAt about ${CFG.cooldowns.rallyMs / 1000} s ahead, got ${again.type === 'error' ? again.retryAt : again.type}`);
    }
  }
}

function homeOf(): Set<SeatId> {
  const s0 = pick(PKG.seats).id;
  const home = new Set<SeatId>([s0]);
  for (const n of NEIGH.get(s0) ?? []) { home.add(n); for (const n2 of NEIGH.get(n) ?? []) home.add(n2); }
  return home;
}

/** Bot 0: after the first polling phase closes, prove SEAT_POLLED, then drain the whole budget and prove overspending fails. */
async function drainScenario(bot: Bot) {
  if (PHASES >= 2) {
    await sleep(timeline.phaseCloses[0] + 700 - Date.now());
    const polled = GROUPS[0];
    const seat = pick(polled);
    let r = await bot.campaign('rally', seat);
    check(bot.err(r) === 'SEAT_POLLED', `${bot.name}: rally on a polled seat should be SEAT_POLLED, got ${r.type === 'error' ? r.error : r.type}`);
    r = await bot.campaign('roadshow', seat);
    check(bot.err(r) === 'SEAT_POLLED', `${bot.name}: roadshow on a polled seat should be SEAT_POLLED, got ${r.type === 'error' ? r.error : r.type}`);
    r = await bot.request({ action: 'buyReport', scope: 'seat', seat }, m => m.type === 'report');
    check(bot.err(r) === 'SEAT_POLLED', `${bot.name}: seat report on a polled seat should be SEAT_POLLED, got ${r.type === 'error' ? r.error : r.type}`);
    log(`${bot.name}: polled-seat actions rejected`);
  } else {
    await sleep(timeline.campaignStart + 3000 - Date.now());
  }
  // drain with cheap roadshows (hidden actions => no news spam), then with analyst reports
  let n = 0;
  for (;;) {
    const open = openSeats(2500);
    if (!open.length || Date.now() > timeline.campaignEnd - 2500) { log(`${bot.name}: out of time before the budget ran out (${n} roadshows)`); return; }
    const r = await bot.campaign('roadshow', pick(open));
    if (r.type === 'error') {
      check(r.error === 'INSUFFICIENT_FUNDS', `${bot.name}: unexpected error while draining: ${r.error} ${r.message}`);
      check(bot.budget < CFG.costs.roadshow, `${bot.name}: INSUFFICIENT_FUNDS although budget ${bot.budget} >= cost ${CFG.costs.roadshow}`);
      break;
    }
    n++;
    if (n > 5000) throw new Fatal('drain loop did not terminate');
  }
  const rally = await bot.campaign('rally', pick(openSeats(1000)));
  check(bot.err(rally) === 'INSUFFICIENT_FUNDS', `${bot.name}: rally with an empty purse should be INSUFFICIENT_FUNDS, got ${rally.type === 'error' ? rally.error : rally.type}`);
  for (let i = 0; i < 100; i++) {
    const { m: r, before } = await bot.requestB({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
    if (r.type === 'error') { check(r.error === 'INSUFFICIENT_FUNDS', `${bot.name}: unexpected report error ${r.error}`); break; }
    bot.reportsBought++;
    check(r.type === 'report' && r.budget < before, `${bot.name}: report did not cost anything`);
  }
  check(bot.budget >= 0, `${bot.name}: budget went negative (${bot.budget})`);
  const last = await bot.request({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
  check(bot.err(last) === 'INSUFFICIENT_FUNDS', `${bot.name}: final report should be INSUFFICIENT_FUNDS`);
  log(`${bot.name}: drained after ${n} roadshows + ${bot.reportsBought} reports, budget left ${bot.budget} (>= 0)`);
}

/** Bot 1: buys a seat report and a global report and sanity-checks them; also tries things that are not allowed yet. */
async function analystScenario(bot: Bot) {
  await sleep(timeline.campaignStart + (timeline.campaignEnd - timeline.campaignStart) * 0.3 - Date.now());
  // messaging.opensAt = campaign (default): the group chat is already open; 2 players never get a chat
  const chatFromCampaign = CFG.messaging.opensAt === 'campaign';
  const cText = 'campaign chat ' + SEED;
  const from0 = bots.map(b => b.msgs.length);
  let r = await bot.request({ action: 'chat', to: bots.filter(b => b !== bot).map(b => b.playerId), text: cText }, m => m.type === 'chat' && m.message.text === cText);
  if (N === 2) check(bot.err(r) === 'NEGOTIATION_DISABLED', `${bot.name}: 2 players: campaign chat should be NEGOTIATION_DISABLED, got ${r.type === 'error' ? r.error : r.type}`);
  else if (chatFromCampaign) {
    check(r.type === 'chat', `${bot.name}: campaign chat should be allowed (messaging.opensAt=campaign), got ${bot.err(r)}`);
    await sleep(400);
    bots.forEach((b, i) => { if (b !== bot && b.idx !== 2) check(b.msgs.slice(from0[i]).some(m => m.type === 'chat' && m.message.text === cText), `${b.name}: campaign group chat message not received`); });
  } else check(bot.err(r) === 'WRONG_PHASE', `${bot.name}: chat during the campaign should be WRONG_PHASE (messaging.opensAt=counting), got ${r.type === 'error' ? r.error : r.type}`);
  r = await bot.request({ action: 'proposeGovernment', portfolios: { PM: [bot.playerId] } }, m => m.type === 'offer');
  check(bot.err(r) === 'WRONG_PHASE', `${bot.name}: proposeGovernment during the campaign should be WRONG_PHASE, got ${r.type === 'error' ? r.error : r.type}`);

  const seat = pick(openSeats(5000));
  const { m: seatRep, before } = await bot.requestB({ action: 'buyReport', scope: 'seat', seat }, m => m.type === 'report');
  if (check(seatRep.type === 'report', `${bot.name}: seat report refused: ${bot.err(seatRep)}`) && seatRep.type === 'report') {
    bot.reportsBought++;
    const lo = Math.min(CFG.analyst.seatReport.start, CFG.analyst.seatReport.end), hi = Math.max(CFG.analyst.seatReport.start, CFG.analyst.seatReport.end);
    check(Number.isInteger(seatRep.report.price) && seatRep.report.price >= lo && seatRep.report.price <= hi, `${bot.name}: seat report price ${seatRep.report.price} outside [${lo}, ${hi}]`);
    check(seatRep.budget === before - seatRep.report.price, `${bot.name}: budget after report inconsistent`);
    check(seatRep.report.seat === seat && seatRep.report.scope === 'seat', `${bot.name}: report is for the wrong seat`);
    check(seatRep.report.asOf < seatRep.report.purchasedAt, `${bot.name}: report must describe the past`);
    const ids = new Set(bots.map(b => b.playerId));
    check(seatRep.report.entries.length === bots.length && seatRep.report.entries.every(e => ids.has(e.playerId)), `${bot.name}: report entries are not the players of this game`);
  }
  const { m: globalRep, before: before2 } = await bot.requestB({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
  if (check(globalRep.type === 'report', `${bot.name}: global report refused`) && globalRep.type === 'report') {
    bot.reportsBought++;
    check(globalRep.budget === before2 - globalRep.report.price, `${bot.name}: budget after global report inconsistent`);
  }
  const missing = await bot.request({ action: 'buyReport', scope: 'seat' } as ClientMessage, m => m.type === 'report');
  check(bot.err(missing) === 'BAD_REQUEST', `${bot.name}: seat report without a seat should be BAD_REQUEST`);
  log(`${bot.name}: bought ${bot.reportsBought} reports`);
}

/** Bot 2: drops the connection mid-campaign and reconnects with the same token (server restores the player). */
async function reconnectScenario(bot: Bot) {
  await sleep(timeline.campaignStart + (timeline.campaignEnd - timeline.campaignStart) * 0.5 - Date.now());
  const { budgetBefore, doneBefore, from } = await bot.serial(async () => {
    const budgetBefore = bot.budget, doneBefore = bot.acked.length;
    bot.close();
    await sleep(1200);
    const from = bot.msgs.length;
    await bot.connect();
    return { budgetBefore, doneBefore, from };
  });
  const hello = bot.msgs.slice(from).find(m => m.type === 'hello');
  must(hello && hello.type === 'hello', 'no hello after reconnect');
  check(hello.private.myActions.length === doneBefore, `${bot.name}: reconnect hello has ${hello.private.myActions.length} own actions, expected ${doneBefore}`);
  check(hello.private.budget === budgetBefore, `${bot.name}: reconnect hello budget ${hello.private.budget} != before ${budgetBefore}`);
  const me = hello.snapshot.players.find(p => p.playerId === bot.playerId);
  check(me && (me.status === 'active' || me.status === 'disconnected'), `${bot.name}: not restored after reconnect`);
  log(`${bot.name}: reconnected, hello has ${hello.private.myActions.length} own actions`);
}

// ------------------------------------------------------------------ main
async function main() {
  log(`bots: ${N} players, ${PHASES} phases, seed ${SEED}, server ${BASE}`);

  // ---- lobby
  const created = await api('POST', '/games', { nickname: 'Bot0', mapId: 'world-500', phases: 3 });
  must(created.status === 200, 'create game failed: ' + JSON.stringify(created));
  gameId = created.json.gameId;
  const joinCode: string = created.json.joinCode;
  const admin = new Bot('Bot0', 0);
  admin.playerId = created.json.playerId; admin.token = created.json.token;
  bots = [admin];
  for (let i = 1; i < N; i++) {
    const j = await api('POST', '/games/join', { joinCode: joinCode.toLowerCase(), nickname: 'Bot' + i });
    must(j.status === 200 && j.json.status === 'pending', 'join failed: ' + JSON.stringify(j));
    const b = new Bot('Bot' + i, i); b.playerId = j.json.playerId; b.token = j.json.token;
    bots.push(b);
  }
  check((await api('POST', '/games/join', { joinCode: 'ZZZZZZ', nickname: 'x' })).status === 404, 'unknown join code should be 404');
  check((await api('GET', '/games/' + gameId)).status === 401, 'lobby without a token should be 401');
  check((await api('GET', '/games/' + gameId, undefined, 'bogus')).status === 401, 'lobby with a bad token should be 401');
  const lobbyAdmin = await api('GET', '/games/' + gameId, undefined, admin.token);
  check(lobbyAdmin.json.players.length === N, `admin should see all ${N} players incl. pending, saw ${lobbyAdmin.json.players.length}`);
  if (N >= 3) {
    const lobbyPending = await api('GET', '/games/' + gameId, undefined, bots[1].token);
    check(lobbyPending.json.players.length === 2, `a pending player should see only the admin and themselves, saw ${lobbyPending.json.players.length}`);
    check((await api('POST', `/games/${gameId}/admit`, { playerId: bots[2].playerId, admit: true }, bots[1].token)).status === 403, 'non-admin admit should be 403');
  }
  check((await api('POST', `/games/${gameId}/start`, undefined, bots[N - 1].token)).status === 403, 'non-admin start should be 403');

  // pending players may connect; they get a minimal hello
  for (const b of bots) await b.connect();
  for (const b of bots.slice(1)) {
    const hello = b.msgs.find(m => m.type === 'hello');
    check(hello && hello.type === 'hello' && hello.private.budget === 0 && hello.snapshot.news.length === 0, `${b.name}: pending hello should be minimal`);
  }
  // admit everyone; each applicant is told
  for (const b of bots.slice(1)) {
    const from = b.msgs.length;
    const a = await api('POST', `/games/${gameId}/admit`, { playerId: b.playerId, admit: true }, admin.token);
    check(a.status === 200, `admit ${b.name}: ${JSON.stringify(a.json)}`);
    await b.waitFor(m => m.type === 'players' && m.players.some(p => p.playerId === b.playerId && p.status === 'active'), { from, what: 'admission' });
  }
  const s0 = await api('POST', `/games/${gameId}/settings`, { phases: PHASES }, admin.token);
  check(s0.status === 200, 'set phases: ' + JSON.stringify(s0.json));
  check((await api('POST', `/games/${gameId}/settings`, { phases: 99 }, admin.token)).status === 400, 'phases 99 should be 400');
  check((await api('POST', `/games/${gameId}/start`, undefined, admin.token)).status === 400, 'start without parties should be 400');
  // parties
  for (const b of bots) {
    const party = { name: 'Party ' + b.name, colour: PARTY_COLOURS[b.idx].hex, symbol: PARTY_SYMBOLS[b.idx].id, avatar: AVATARS[b.idx].id };
    const r = await api('POST', `/games/${gameId}/party`, { party }, b.token);
    check(r.status === 200, `${b.name}: set party failed ${JSON.stringify(r.json)}`);
  }
  const dup = await api('POST', `/games/${gameId}/party`, { party: { name: 'Another', colour: PARTY_COLOURS[0].hex, symbol: PARTY_SYMBOLS[N].id, avatar: AVATARS[N % AVATARS.length].id } }, bots[N - 1].token);
  check(dup.json?.error === 'COLOUR_TAKEN', 'duplicate colour should be COLOUR_TAKEN, got ' + JSON.stringify(dup.json));
  const lobby = await api('GET', '/games/' + gameId, undefined, bots[N - 1].token);
  check(lobby.json.phases === PHASES && lobby.json.players.length === N && lobby.json.players.every((p: any) => p.status === 'active' && p.party), 'lobby view after setup');
  // an extra join request that will be denied by the start (still pending)
  const extra = await api('POST', '/games/join', { joinCode, nickname: 'Late' });
  check(extra.status === 200, 'late join request');

  // ---- start
  const started = await api('POST', `/games/${gameId}/start`, undefined, admin.token);
  must(started.status === 200, 'start failed: ' + JSON.stringify(started.json));
  timeline = started.json.timeline;
  check(timeline.phaseCloses.length === PHASES, 'timeline phases');
  log(`started; campaign ${((timeline.campaignEnd - timeline.campaignStart) / 1000).toFixed(0)}s, counting ${((timeline.countingEnd - timeline.campaignEnd) / 1000).toFixed(0)}s, post ${((timeline.postCountingEnd - timeline.countingEnd) / 1000).toFixed(0)}s`);
  for (const b of bots) {
    await b.waitFor(m => m.type === 'status' && m.status === 'campaign', { what: 'campaign status' });
    await b.waitFor(m => m.type === 'private' && m.private.budget === CFG.budget, { what: 'budget after start' });
  }
  check((await api('POST', '/games/join', { joinCode, nickname: 'TooLate' })).status === 409, 'joining after start should be refused (409)');
  const lateLobby = await api('GET', '/games/' + gameId, undefined, bots[0].token);
  check(!lateLobby.json.players.some((p: any) => p.nickname === 'Late' && p.status === 'pending'), 'pending applicants must be rejected at start');

  if (Date.now() < timeline.campaignStart - 100) {
    const r = await bots[0].campaign('rally', GROUPS[0][0]);
    check(bots[0].err(r) === 'WRONG_PHASE', `campaign before the start time should be WRONG_PHASE, got ${r.type === 'error' ? r.error : r.type}`);
  }
  await sleep(timeline.campaignStart + 100 - Date.now());

  // ---- campaign (all bots in parallel)
  const until = timeline.campaignEnd - 1200;
  const scenarios: Promise<unknown>[] = [];
  for (const b of bots) {
    const home = homeOf();
    const normal = b.idx === 0 ? Promise.resolve() : randomCampaign(b, until, home);
    scenarios.push(normal);
  }
  scenarios.push(drainScenario(bots[0]));
  // bot 0 acts normally for a while before draining
  scenarios.push(randomCampaign(bots[0], timeline.phaseCloses[0] - 2500, homeOf(), false));
  if (N >= 2) { bots[1].reserve = CFG.analyst.seatReport.end + CFG.analyst.globalReport.end; scenarios.push(analystScenario(bots[1])); }
  if (N >= 3) scenarios.push(reconnectScenario(bots[2]));
  await Promise.all(scenarios);

  // after the campaign: everything is TOO_LATE
  await sleep(timeline.campaignEnd + 300 - Date.now());
  for (const b of bots) {
    const r = await b.campaign('rally', pick(PKG.seats).id);
    check(bot_err(r) === 'TOO_LATE' || bot_err(r) === 'INSUFFICIENT_FUNDS', `${b.name}: campaign after the end should be rejected, got ${r.type === 'error' ? r.error : r.type}`);
  }

  // ---- phases / counting
  for (const b of bots) await b.waitFor(m => m.type === 'status' && m.status === 'counting', { ms: 20000, what: 'counting' });
  const closed = new Map<number, SeatId[]>();
  for (const m of bots[0].msgs) if (m.type === 'phaseClosed') closed.set(m.phase, m.seats);
  check(closed.size === PHASES, `expected ${PHASES} phaseClosed messages, got ${closed.size}`);
  const polledAll = [...closed.values()].flat();
  check(polledAll.length === PKG.seatCount && new Set(polledAll).size === PKG.seatCount, 'phaseClosed seats must cover every seat exactly once');
  log('counting started');

  // chat: one group chat everybody reads
  const [b0, b1] = bots;
  if (N === 2) {
    // designer's rule: no negotiation in a 2-player game
    const cr = await b0.request({ action: 'chat', to: [b1.playerId], text: 'deal?' }, m => m.type === 'chat');
    check(bot_err(cr) === 'NEGOTIATION_DISABLED', `2 players: chat should be NEGOTIATION_DISABLED, got ${cr.type === 'error' ? cr.error : cr.type}`);
    const pr = await b0.request({ action: 'proposeGovernment', portfolios: { PM: [b0.playerId], DPM: [b1.playerId] } }, m => m.type === 'offer');
    check(bot_err(pr) === 'NEGOTIATION_DISABLED', `2 players: proposeGovernment should be NEGOTIATION_DISABLED, got ${pr.type === 'error' ? pr.error : pr.type}`);
    log('2 players: chat and proposeGovernment rejected with NEGOTIATION_DISABLED');
  } else {
  // messaging.mode = group (the default): ONE chat everybody reads; `to` is only a hint and is ignored
  const from1 = bots.map(b => b.msgs.length);
  const text = 'open to all ' + SEED;
  const c = await b0.request({ action: 'chat', to: [b1.playerId], text }, m => m.type === 'chat' && m.message.text === text);
  check(c.type === 'chat', 'chat refused: ' + bot_err(c));
  await Promise.all(bots.slice(1).map((b, i) => b.waitFor(m => m.type === 'chat' && m.message.text === text, { from: from1[i + 1], what: 'chat delivery' })));
  await sleep(300);
  bots.forEach((b, i) => {
    const got = b.msgs.slice(from1[i]).some(m => m.type === 'chat' && m.message.text === text);
    check(got, `${b.name}: group chat message not received`);
  });
  const noTo = await b1.request({ action: 'chat', text: 'hello all' } as ClientMessage, m => m.type === 'chat' && m.message.text === 'hello all');
  check(noTo.type === 'chat', 'chat without recipients refused: ' + bot_err(noTo));
  log('chat ok');

  // invalid governments are refused while counting
  let r = await b0.request({ action: 'proposeGovernment', portfolios: { PM: [b1.playerId] } }, m => m.type === 'offer');
  check(bot_err(r) === 'INVALID_GOVERNMENT', `PM must be the proposer, got ${r.type === 'error' ? r.error : r.type}`);
  r = await b0.request({ action: 'proposeGovernment', portfolios: { PM: [b0.playerId], NOPE: [b1.playerId] } }, m => m.type === 'offer');
  check(bot_err(r) === 'INVALID_GOVERNMENT', `unknown portfolio should be INVALID_GOVERNMENT, got ${r.type === 'error' ? r.error : r.type}`);
  r = await b0.request({ action: 'proposeGovernment', portfolios: { PM: [b0.playerId], HOME: ['ghost'] } }, m => m.type === 'offer');
  check(bot_err(r) === 'INVALID_GOVERNMENT', `portfolio for a non-player should be INVALID_GOVERNMENT, got ${r.type === 'error' ? r.error : r.type}`);
  r = await b0.request({ action: 'respondOffer', offerId: 'nope', accept: true }, m => m.type === 'offer');
  check(bot_err(r) === 'OFFER_NOT_FOUND', `unknown offer should be OFFER_NOT_FOUND, got ${r.type === 'error' ? r.error : r.type}`);

  }

  // ---- wait for the count to finish
  await Promise.all(bots.map(b => b.waitFor(m => m.type === 'status' && m.status === 'postCounting', { ms: 60000, what: 'postCounting' })));
  const updates = bots[0].msgs.filter((m): m is Extract<ServerMessage, { type: 'seatUpdate' }> => m.type === 'seatUpdate');
  const finalTally = updates[updates.length - 1].tally;
  log('count finished, tally', JSON.stringify(finalTally.wins), 'declared', finalTally.declared);
  check(finalTally.total === PKG.seatCount && finalTally.declared === PKG.seatCount, `every seat must be declared (${finalTally.declared}/${finalTally.total})`);
  const wonSeats = new Set(updates.filter(u => u.declaration.status === 'won').map(u => u.declaration.seat));
  check(wonSeats.size === PKG.seatCount, `expected ${PKG.seatCount} distinct won seats, got ${wonSeats.size}`);
  const firstSeen = new Set<number>();
  let orderOk = true;
  for (const u of updates) {
    if (!firstSeen.has(u.declaration.seat)) {
      firstSeen.add(u.declaration.seat);
      if (u.declaration.status === 'won' && updates.some(x => x.declaration.seat === u.declaration.seat && x.declaration.status === 'leading')) orderOk = false;
    }
  }
  check(orderOk, 'a seat must be declared leading before it is won');
  for (const b of bots.slice(1)) {
    const u = b.msgs.filter(m => m.type === 'seatUpdate').length;
    check(u === updates.length || b.idx === 2, `${b.name}: saw ${u} seat updates, bot0 saw ${updates.length}`);
  }
  const winsOf = (id: PlayerId) => finalTally.wins[id] ?? 0;
  check(bots.reduce((s, b) => s + winsOf(b.playerId), 0) === PKG.seatCount, 'wins must add up to the number of seats');

  // news = every rally, nothing else
  const rallies = bots.reduce((s, b) => s + b.acked.filter(a => a.type === 'rally').length, 0);
  for (const b of bots) check(b.newsCount === rallies, `${b.name}: news items ${b.newsCount} != rallies ${rallies} (roadshows must stay hidden)`);

  if (N === 2) {
    log('waiting for the result (2 players, no coalition) ...');
    const results2: FinalResult[] = [];
    for (const b of bots) {
      const m = await b.waitFor(x => x.type === 'result', { ms: Math.max(15000, timeline.postCountingEnd - Date.now() + 15000), what: 'result' });
      if (m.type === 'result') results2.push(m.result);
    }
    const R2 = results2[0];
    check(results2.every(x => JSON.stringify(x) === JSON.stringify(R2)), 'all players must receive the same result');
    const w0 = winsOf(bots[0].playerId), w1 = winsOf(bots[1].playerId);
    const expected = w0 === w1 ? 'draw' : (Math.max(w0, w1) >= majorityOf(PKG.seatCount) ? 'majority' : 'noGovernment');
    check(R2.outcome === expected, `2 players: outcome should be ${expected} (wins ${w0}-${w1}), got ${R2.outcome}`);
    check(R2.outcome !== 'coalition' && !R2.government?.viaNegotiation, '2 players: there must be no negotiated government');
    log('result:', R2.outcome, 'wins', w0, w1);
    const fin2 = await api('GET', '/games/' + gameId, undefined, admin.token);
    check(fin2.json.status === 'finished', 'lobby status should be finished, got ' + fin2.json.status);
    for (const b of bots) for (const v of b.violations) check(false, 'hidden info: ' + v);
    return;
  }

  // ---- coalition: smallest group (>= 2 parties, and ALWAYS fewer than all: at least one party stays out) with a majority of WON seats
  const need = majorityOf(PKG.seatCount);
  const allPortfolios = (): Record<string, string[]> => {
    const o: Record<string, string[]> = { PM: [bots[0].playerId] };
    const ds = CFG.points.portfolios.filter(p => p.id !== 'PM');
    bots.slice(1).forEach((p, i) => { const d = ds[i % ds.length]; o[d.id] = [...(o[d.id] ?? []), p.playerId].slice(0, d.max); });
    return o;
  };
  // rule: a government can never include every party (nobody can negotiate with everybody)
  const everyone = await bots[0].request({ action: 'proposeGovernment', portfolios: allPortfolios() }, m => m.type === 'offer');
  check(bot_err(everyone) === 'INVALID_GOVERNMENT', `an all-parties proposal should be INVALID_GOVERNMENT, got ${everyone.type === 'error' ? everyone.error : everyone.type}`);
  check(everyone.type === 'error' && /stay out/i.test(everyone.message ?? ''), 'all-parties rejection should say that at least one party must stay out');
  let best: Bot[] | null = null;
  for (let mask = 1; mask < (1 << N); mask++) {
    const group = bots.filter((_, i) => mask & (1 << i));
    if (group.length < 2 || group.length >= N) continue;
    if (group.reduce((s, b) => s + winsOf(b.playerId), 0) < need) continue;
    if (!best || group.length < best.length || (group.length === best.length && group.reduce((s, b) => s + winsOf(b.playerId), 0) < best.reduce((s, b) => s + winsOf(b.playerId), 0))) best = group;
  }
  if (!best) {
    // the only majority group is everyone (or none exists): no valid government can form
    log('no valid coalition (a majority needs every party): expecting no government');
    await sleep(500);
    for (const b of bots) check(!b.msgs.some(m => m.type === 'government'), `${b.name}: a government formed although none was possible`);
    const resultsNone: FinalResult[] = [];
    for (const b of bots) {
      const m = await b.waitFor(x => x.type === 'result', { ms: Math.max(15000, timeline.postCountingEnd - Date.now() + 15000), what: 'result' });
      if (m.type === 'result') resultsNone.push(m.result);
    }
    check(resultsNone.every(x => JSON.stringify(x) === JSON.stringify(resultsNone[0])), 'all players must receive the same result');
    check(resultsNone[0].outcome !== 'coalition', `no coalition was possible, outcome ${resultsNone[0].outcome}`);
    for (const b of bots) for (const v of b.violations) check(false, 'hidden info: ' + v);
    return;
  }
  const coalition: Bot[] = [...best].sort((a, z) => winsOf(z.playerId) - winsOf(a.playerId));
  const pm = coalition[0], partners = coalition.slice(1);
  const opposition = bots.filter(b => !coalition.includes(b));
  log(`coalition: PM ${pm.name} + ${partners.map(p => p.name).join(', ')}; opposition: ${opposition.map(o => o.name).join(', ') || 'none'}`);

  const portfolios: Record<string, string[]> = { PM: [pm.playerId] };
  const defs = CFG.points.portfolios.filter(p => p.id !== 'PM');
  partners.forEach((p, i) => { const d = defs[i % defs.length]; portfolios[d.id] = [...(portfolios[d.id] ?? []), p.playerId].slice(0, d.max); });
  const offerOf = (b: Bot, id: string) => b.msgs.filter((m): m is Extract<ServerMessage, { type: 'offer' }> => m.type === 'offer' && m.offer.offerId === id).pop()?.offer;

  // first proposal: the first partner declines
  const fromO = bots.map(b => b.msgs.length);
  const prop1 = await pm.request({ action: 'proposeGovernment', portfolios }, m => m.type === 'offer' && m.offer.proposer === pm.playerId);
  must(prop1.type === 'offer', 'proposal refused: ' + bot_err(prop1) + (prop1.type === 'error' ? ' ' + prop1.message : ''));
  const offer1 = prop1.offer.offerId;
  check(prop1.offer.status === 'open' || prop1.offer.status === 'accepted', 'new offer status');
  await partners[0].waitFor(m => m.type === 'offer' && m.offer.offerId === offer1, { from: fromO[partners[0].idx], what: 'incoming offer' });
  const decl = await partners[0].request({ action: 'respondOffer', offerId: offer1, accept: false }, m => m.type === 'offer' && m.offer.offerId === offer1 && m.offer.status === 'declined');
  check(decl.type === 'offer' && decl.offer.status === 'declined', 'decline should mark the offer declined');
  await pm.waitFor(m => m.type === 'offer' && m.offer.offerId === offer1 && m.offer.status === 'declined', { from: fromO[pm.idx], what: 'declined notice' });
  // opposition never hears about offers it is not part of; and cannot respond to them
  for (const o of opposition) {
    const leak = o.msgs.slice(fromO[o.idx]).some(m => m.type === 'offer');
    check(!leak, `${o.name}: opposition received a coalition offer`);
    const rr = await o.request({ action: 'respondOffer', offerId: offer1, accept: true }, m => m.type === 'offer');
    check(bot_err(rr) === 'OFFER_NOT_FOUND', `${o.name}: responding to a foreign offer should be OFFER_NOT_FOUND, got ${rr.type === 'error' ? rr.error : rr.type}`);
  }
  // second proposal: everyone accepts
  const prop2 = await pm.request({ action: 'proposeGovernment', portfolios }, m => m.type === 'offer' && m.offer.proposer === pm.playerId && m.offer.offerId !== offer1);
  must(prop2.type === 'offer', 'second proposal refused');
  const offer2 = prop2.offer.offerId;
  for (const p of partners) {
    await p.waitFor(m => m.type === 'offer' && m.offer.offerId === offer2, { from: fromO[p.idx], what: 'second offer' });
    const ar = await p.request({ action: 'respondOffer', offerId: offer2, accept: true }, m => m.type === 'offer' && m.offer.offerId === offer2 && m.offer.accepted.includes(p.playerId));
    check(ar.type === 'offer', `${p.name}: accept refused: ${bot_err(ar)}`);
  }
  // the government is confirmed because every seat is already declared; the game then finishes at once
  const govMsg = await pm.waitFor(m => m.type === 'government', { from: fromO[pm.idx], ms: 15000, what: 'government' });
  if (govMsg.type === 'government') {
    const g = govMsg.government;
    check(g.pm === pm.playerId && g.viaNegotiation === true, 'government PM / viaNegotiation');
    check(new Set(g.members).size === coalition.length && coalition.every(b => g.members.includes(b.playerId)), 'government members should be exactly the coalition');
  }
  check(offerOf(pm, offer2)?.status === 'formed', 'offer 2 should end as formed');
  // the game is over: further proposals are WRONG_PHASE, withdrawing is OFFER_NOT_FOUND
  const again = await pm.request({ action: 'proposeGovernment', portfolios }, m => m.type === 'offer' && m.offer.offerId !== offer1 && m.offer.offerId !== offer2);
  check(bot_err(again) === 'WRONG_PHASE', `proposing after the game finished should be WRONG_PHASE, got ${again.type === 'error' ? again.error : again.type}`);
  const wd = await pm.request({ action: 'withdrawOffer', offerId: offer2 } as ClientMessage, m => m.type === 'offer');
  check(bot_err(wd) === 'OFFER_NOT_FOUND', `withdrawing after the game finished should be OFFER_NOT_FOUND, got ${wd.type === 'error' ? wd.error : wd.type}`);

  // ---- result: announced immediately after the government (no waiting for postCountingEnd)
  log('waiting for the result ...');
  const results: FinalResult[] = [];
  for (const b of bots) {
    const m = await b.waitFor(x => x.type === 'result', { from: fromO[b.idx], ms: 15000, what: 'result (immediately after the government)' });
    if (m.type === 'result') results.push(m.result);
  }
  const R = results[0];
  check(results.every(x => JSON.stringify(x) === JSON.stringify(R)), 'all players must receive the same result');
  check(R.outcome === 'coalition', `outcome should be coalition, got ${R.outcome}`);
  check(R.points.length === N, 'one points row per player');
  for (const b of bots) {
    const row = R.points.find(p => p.playerId === b.playerId);
    if (!check(row, `${b.name}: no points row`) || !row) continue;
    check(Number.isInteger(row.total) && Number.isInteger(row.portfolioPoints) && Number.isInteger(row.seatPoints) && Number.isInteger(row.governmentFloor), `${b.name}: points must be whole numbers`);
    check(R.tally[b.playerId] === (winsOf(b.playerId) || undefined) || (R.tally[b.playerId] ?? 0) === winsOf(b.playerId), `${b.name}: result tally ${R.tally[b.playerId]} != counted ${winsOf(b.playerId)}`);
    if (coalition.includes(b)) {
      const held = CFG.points.portfolios.filter(d => R.government?.portfolios[d.id]?.includes(b.playerId)).reduce((s, d) => s + d.points, 0);
      const seatPts = Math.round((CFG.points.seatMultiplier * winsOf(b.playerId)) / PKG.seatCount);
      check(row.portfolioPoints === held, `${b.name}: portfolio points ${row.portfolioPoints} != ${held}`);
      check(row.seatPoints === seatPts, `${b.name}: seat points ${row.seatPoints} != ${seatPts}`);
      check(row.governmentFloor === CFG.points.governmentFloor, `${b.name}: floor`);
      check(row.total === held + seatPts + CFG.points.governmentFloor, `${b.name}: total points`);
    } else {
      check(row.total === CFG.points.opposition && row.portfolioPoints === 0 && row.seatPoints === 0 && row.governmentFloor === 0, `${b.name}: opposition must score ${CFG.points.opposition}, got ${JSON.stringify(row)}`);
    }
  }
  const top = Math.max(...R.points.map(p => p.total));
  check(R.winners.length >= 1 && R.winners.every(id => R.points.find(p => p.playerId === id)?.total === top), 'winners must have the top total');
  check(R.points.filter(p => p.total === top).length === R.winners.length, 'every top scorer is a winner');
  check(R.government?.pm === pm.playerId, 'result government PM');
  log('result:', R.outcome, 'winners', R.winners.map(w => bots.find(b => b.playerId === w)?.name).join(','), 'points', R.points.map(p => `${bots.find(b => b.playerId === p.playerId)?.name}=${p.total}`).join(' '));

  // hello after the end carries the full state (late reconnect)
  const fin = await api('GET', '/games/' + gameId, undefined, admin.token);
  check(fin.json.status === 'finished', 'lobby status should be finished, got ' + fin.json.status);

  // ---- hidden-information summary
  for (const b of bots) for (const v of b.violations) check(false, 'hidden info: ' + v);
}

function bot_err(r: ServerMessage): string | undefined { return r.type === 'error' ? r.error : undefined; }

main().then(() => {
  for (const b of bots) b.close();
  if (failures.length) { console.error(`\n${failures.length} check(s) FAILED`); process.exit(1); }
  console.log(`\nPASS: ${N} players, ${PHASES} phases, seed ${SEED} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(0);
}).catch(e => {
  console.error('\nFATAL:', e instanceof Error ? e.message : e);
  if (!(e instanceof Fatal)) console.error(e);
  if (failures.length) console.error(`${failures.length} earlier check(s) failed:\n  ` + failures.join('\n  '));
  for (const b of bots) b.close();
  process.exit(1);
});
