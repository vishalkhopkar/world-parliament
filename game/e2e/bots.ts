// Bot-client end-to-end test for the HUNG PARLIAMENT backend (REST + WebSocket).
//   npx tsx e2e/bots.ts [baseUrl] [--players 3] [--phases 2] [--ws ws://localhost:8787/ws] [--seed 1]
// Starts nothing itself: run the dev server first (see e2e/README.md). Exits non-zero on any failed check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG, fullyFieldedBudget, hasPreCampaign, majorityOf } from '@hp/shared';
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

// Pre-campaign (3+ players): every bot fields a candidate in every seat except VACANT ones, which nobody contests. So the contested
// seats and the majority are fixed by the fielding, not by the map. A 2-player game has no pre-campaign: all seats are fielded for them.
const PRE = hasPreCampaign(N);
const LAST_GROUP = GROUPS[GROUPS.length - 1];
const VACANT = new Set<SeatId>(PRE ? LAST_GROUP.slice(0, 2) : []);
const CONTESTED = PKG.seatCount - VACANT.size;
const MAJ = majorityOf(CONTESTED);
const BATCH = 100; // seats per field message

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
const ALLOWED_BUDGET = new Set(['hello', 'private', 'actionAck', 'report', 'fieldAck']);

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
  /** seats this bot has a candidate in (kept from fieldAck) */
  fielded = new Set<SeatId>();
  /** game this bot is connected to; empty = the shared `gameId` (follows a rematch) */
  gameId = '';
  violations: string[] = [];
  private refCounter = 0;
  constructor(public name: string, public idx: number) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS}?gameId=${encodeURIComponent(this.gameId || gameId)}&token=${encodeURIComponent(this.token)}`);
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
    if (raw.includes('minorRally') && m.type !== 'hello' && m.type !== 'private') bad('minor rally data outside private state');
    if (m.type === 'hello' && m.private.you !== this.playerId) bad('hello carries another player\'s private state');
    if (m.type === 'private' && m.private.you !== this.playerId) bad('private state of another player');
    if (m.type === 'hello' || m.type === 'private') {
      this.budget = m.private.budget;
      const myRoad = m.private.myActions.filter(a => a.type === 'roadshow').length;
      const acked = this.acked.filter(a => a.type === 'roadshow').length;
      if (m.private.myActions.length > this.acked.length || myRoad > acked) bad('myActions longer than what this player did');
    }
    if (m.type === 'actionAck' || m.type === 'fieldAck') this.budget = m.budget;
    if (m.type === 'report') { this.budget = m.budget; }
    if (m.type === 'hello' && m.snapshot.players.some(p => (p as any).budget !== undefined)) bad('budget inside players');
    // global reports (free news-agency graphs): noisy public numbers only; no private fields (budget is already refused above: globalReports is NOT in ALLOWED_BUDGET)
    if (m.type === 'globalReports' && /"(reputation|committed|effect|effects|roadshow)"/.test(raw)) bad('private field inside global reports');
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
  requestB(msg: ClientMessage, ok: Pred, ref?: string): Promise<{ m: ServerMessage; before: number; after: number }> {
    return this.serial(async () => {
      const from = this.msgs.length, before = this.budget;
      this.send(msg);
      const m = await this.waitFor(x => ok(x) || (x.type === 'error' && (ref === undefined || x.clientRef === ref)), { from, what: msg.action });
      return { m, before, after: this.budget }; // `after` is read inside the serial slot: a concurrent campaign of this bot cannot change it
    });
  }
  async request(msg: ClientMessage, ok: Pred, ref?: string): Promise<ServerMessage> { return (await this.requestB(msg, ok, ref)).m; }
  /** true when a rally from this bot would not run into the rally cooldown (rallies must be cooldowns.rallyMs apart; roadshows are never limited) */
  rallyReady(): boolean { return !this.rallyPending && Date.now() >= this.rallyAfter; }
  async campaign(type: 'rally' | 'minorRally' | 'roadshow', seat: SeatId): Promise<ServerMessage> {
    const ref = `${this.idx}-${++this.refCounter}`;
    if (type === 'rally') this.rallyPending = true;
    let res: { m: ServerMessage; before: number; after: number };
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
  /** field / withdraw `seats` (one message, answered by fieldAck or an error); keeps `fielded` and the budget up to date */
  async field(op: 'field' | 'withdraw', seats: SeatId[]): Promise<ServerMessage> {
    const ref = `${this.idx}-f${++this.refCounter}`;
    const r = await this.request({ action: op, seats, clientRef: ref }, m => m.type === 'fieldAck' && m.clientRef === ref, ref);
    if (r.type === 'fieldAck') {
      for (const a of r.added) this.fielded.add(a.seat);
      for (const s of r.removed) this.fielded.delete(s);
    }
    return r;
  }
  /** field every contested-map seat (not VACANT) in batches */
  async fieldAll(): Promise<void> {
    const seats = PKG.seats.map(s => s.id).filter(s => !VACANT.has(s));
    for (let i = 0; i < seats.length; i += BATCH) {
      const r = await this.field('field', seats.slice(i, i + BATCH));
      check(r.type === 'fieldAck', `${this.name}: field batch refused: ${this.err(r)} ${r.type === 'error' ? r.message : ''}`);
    }
  }
  /** press (done = true) or take back (false) "Done fielding": answered by a fieldingDone about this bot, or an error */
  async done(done = true): Promise<ServerMessage> {
    const ref = `${this.idx}-d${++this.refCounter}`;
    return this.request({ action: 'doneFielding', done, clientRef: ref }, m => m.type === 'fieldingDone' && m.playerId === this.playerId && m.done === done, ref);
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
  GROUPS.forEach((g, p) => { if (timeline.phaseCloses[p] - now > minRemainingMs) out.push(...g.filter(s => !VACANT.has(s))); });
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
    const roll = rnd();
    const type = roll < 0.45 && allowRally && bot.rallyReady() ? 'rally' : roll < 0.65 ? 'minorRally' : 'roadshow';
    if (bot.budget - CFG.costs[type] < bot.reserve) continue;
    const r = await bot.campaign(type, seat);
    check(r.type === 'actionAck', `${bot.name}: ${type} in seat ${seat} rejected: ${bot.err(r)} ${r.type === 'error' ? r.message : ''}`);
    if (type === 'rally' && r.type === 'actionAck' && !bot.rateChecked) {
      bot.rateChecked = true;
      const again = await bot.campaign('rally', seat);
      check(bot.err(again) === 'RATE_LIMITED', `${bot.name}: a second rally right after the first should be RATE_LIMITED, got ${again.type === 'error' ? again.error : again.type}`);
      check(again.type === 'error' && typeof again.retryAt === 'number' && again.retryAt > Date.now() + CFG.cooldowns.rallyMs - 5000, `${bot.name}: RATE_LIMITED should carry retryAt about ${CFG.cooldowns.rallyMs / 1000} s ahead, got ${again.type === 'error' ? again.retryAt : again.type}`);
      // the rally cooldown is for rallies only: a minor rally right after a rally is accepted
      if (bot.budget - CFG.costs.minorRally >= bot.reserve) {
        const minor = await bot.campaign('minorRally', seat);
        check(minor.type === 'actionAck', `${bot.name}: a minor rally right after a rally should be accepted (no cooldown), got ${bot.err(minor)}`);
      }
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
    const polledReport = CFG.analyst.seatReport.enabled ? 'SEAT_POLLED' : 'FORBIDDEN'; // a switched-off report is refused first
    check(bot.err(r) === polledReport, `${bot.name}: seat report on a polled seat should be ${polledReport}, got ${r.type === 'error' ? r.error : r.type}`);
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
  for (let i = 0; i < (CFG.analyst.globalReport.enabled ? 100 : 0); i++) {
    const { m: r, before } = await bot.requestB({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
    if (r.type === 'error') { check(r.error === 'INSUFFICIENT_FUNDS', `${bot.name}: unexpected report error ${r.error}`); break; }
    bot.reportsBought++;
    check(r.type === 'report' && r.budget < before, `${bot.name}: report did not cost anything`);
  }
  check(bot.budget >= 0, `${bot.name}: budget went negative (${bot.budget})`);
  const last = await bot.request({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
  check(bot.err(last) === (CFG.analyst.globalReport.enabled ? 'INSUFFICIENT_FUNDS' : 'FORBIDDEN'), `${bot.name}: final report should be ${CFG.analyst.globalReport.enabled ? 'INSUFFICIENT_FUNDS' : 'FORBIDDEN (switched off)'}`);
  log(`${bot.name}: drained after ${n} roadshows + ${bot.reportsBought} reports, budget left ${bot.budget} (>= 0)`);
}

/** Bot 1: buys a seat report and a global report and sanity-checks them; also tries things that are not allowed yet. */
async function analystScenario(bot: Bot) {
  await sleep(timeline.campaignStart + (timeline.campaignEnd - timeline.campaignStart) * 0.3 - Date.now());
  // Chat.Campaigning = GROUP (default): the group chat is already open; INDV = one-to-one; OFF = none; 2 players never get a chat
  const campaignChat = CFG.chat.campaigning;
  const cText = 'campaign chat ' + SEED;
  const from0 = bots.map(b => b.msgs.length);
  let r = await bot.request({ action: 'chat', to: bots.filter(b => b !== bot).map(b => b.playerId), text: cText }, m => m.type === 'chat' && m.message.text === cText);
  if (N === 2) check(bot.err(r) === 'NEGOTIATION_DISABLED', `${bot.name}: 2 players: campaign chat should be NEGOTIATION_DISABLED, got ${r.type === 'error' ? r.error : r.type}`);
  else if (campaignChat !== 'OFF') {
    check(r.type === 'chat', `${bot.name}: campaign chat should be allowed (Chat.Campaigning=${campaignChat}), got ${bot.err(r)}`);
    if (r.type === 'chat') check(r.message.channel === (campaignChat === 'GROUP' ? 'group' : 'direct'), `${bot.name}: campaign chat channel should follow Chat.Campaigning, got ${r.message.channel}`);
    await sleep(400);
    bots.forEach((b, i) => { if (b !== bot && b.idx !== 2) check(b.msgs.slice(from0[i]).some(m => m.type === 'chat' && m.message.text === cText), `${b.name}: campaign chat message not received`); });
  } else check(bot.err(r) === 'WRONG_PHASE', `${bot.name}: chat during the campaign should be WRONG_PHASE (Chat.Campaigning=OFF), got ${r.type === 'error' ? r.error : r.type}`);
  r = await bot.request({ action: 'proposeGovernment', portfolios: { PM: [bot.playerId] } }, m => m.type === 'offer');
  check(bot.err(r) === 'WRONG_PHASE', `${bot.name}: proposeGovernment during the campaign should be WRONG_PHASE, got ${r.type === 'error' ? r.error : r.type}`);

  const seat = pick(openSeats(5000));
  if (!CFG.analyst.seatReport.enabled) {
    // switched off in game.properties: the server must refuse it (FORBIDDEN) and charge nothing
    const { m: off, before, after } = await bot.requestB({ action: 'buyReport', scope: 'seat', seat }, m => m.type === 'report');
    check(bot.err(off) === 'FORBIDDEN', `${bot.name}: seat report is switched off, should be FORBIDDEN, got ${off.type === 'error' ? off.error : off.type}`);
    check(after === before, `${bot.name}: a refused seat report must not cost anything`);
  }
  const { m: seatRep, before } = CFG.analyst.seatReport.enabled
    ? await bot.requestB({ action: 'buyReport', scope: 'seat', seat }, m => m.type === 'report')
    : { m: null as never, before: 0 };
  if (CFG.analyst.seatReport.enabled && check(seatRep.type === 'report', `${bot.name}: seat report refused: ${bot.err(seatRep)}`) && seatRep.type === 'report') {
    bot.reportsBought++;
    const lo = Math.min(CFG.analyst.seatReport.start, CFG.analyst.seatReport.end), hi = Math.max(CFG.analyst.seatReport.start, CFG.analyst.seatReport.end);
    check(Number.isInteger(seatRep.report.price) && seatRep.report.price >= lo && seatRep.report.price <= hi, `${bot.name}: seat report price ${seatRep.report.price} outside [${lo}, ${hi}]`);
    check(seatRep.budget === before - seatRep.report.price, `${bot.name}: budget after report inconsistent`);
    check(seatRep.report.seat === seat && seatRep.report.scope === 'seat', `${bot.name}: report is for the wrong seat`);
    check(seatRep.report.asOf < seatRep.report.purchasedAt, `${bot.name}: report must describe the past`);
    const ids = new Set(bots.map(b => b.playerId));
    check(seatRep.report.entries.length === bots.length && seatRep.report.entries.every(e => ids.has(e.playerId)), `${bot.name}: report entries are not the players of this game`);
  }
  if (!CFG.analyst.globalReport.enabled) {
    const { m: off, before: b0, after } = await bot.requestB({ action: 'buyReport', scope: 'global' }, m => m.type === 'report');
    check(bot.err(off) === 'FORBIDDEN', `${bot.name}: global report is switched off, should be FORBIDDEN, got ${off.type === 'error' ? off.error : off.type}`);
    check(after === b0, `${bot.name}: a refused global report must not cost anything`);
  }
  const { m: globalRep, before: before2 } = CFG.analyst.globalReport.enabled
    ? await bot.requestB({ action: 'buyReport', scope: 'global' }, m => m.type === 'report')
    : { m: null as never, before: 0 };
  if (CFG.analyst.globalReport.enabled && check(globalRep.type === 'report', `${bot.name}: global report refused`) && globalRep.type === 'report') {
    bot.reportsBought++;
    check(globalRep.budget === before2 - globalRep.report.price, `${bot.name}: budget after global report inconsistent`);
  }
  const missing = await bot.request({ action: 'buyReport', scope: 'seat' } as ClientMessage, m => m.type === 'report');
  check(bot.err(missing) === 'BAD_REQUEST', `${bot.name}: seat report without a seat should be BAD_REQUEST, got ${missing.type === 'error' ? missing.error : missing.type}`); // malformed: refused before the switch
  log(`${bot.name}: bought ${bot.reportsBought} reports`);
  await globalReportsCheck(bot);
}

/** Free global reports (news agencies): shape, one point per sample so far, parties only, and the budget stays exactly the same. */
async function globalReportsCheck(bot: Bot) {
  const { m, before, after } = await bot.requestB({ action: 'globalReports' }, x => x.type === 'globalReports');
  if (!CFG.news.enabled) {
    check(bot.err(m) === 'FORBIDDEN', `${bot.name}: global reports are switched off, should be FORBIDDEN, got ${m.type === 'error' ? m.error : m.type}`);
    return;
  }
  if (!check(m.type === 'globalReports', `${bot.name}: global reports refused: ${bot.err(m)}`) || m.type !== 'globalReports') return;
  check(after === before, `${bot.name}: global reports must be free (budget ${before} -> ${after})`);
  const r = m.reports, ids = new Set(bots.map(b => b.playerId));
  check(r.agencies.length === CFG.news.agencies.length, `${bot.name}: expected ${CFG.news.agencies.length} agencies, got ${r.agencies.length}`);
  check(r.asOf >= timeline.campaignStart && r.asOf <= timeline.campaignEnd, `${bot.name}: global reports asOf ${r.asOf} outside the campaign`);
  for (const a of r.agencies) {
    check(a.points.length >= 1 && a.points[0].t === timeline.campaignStart, `${bot.name}: ${a.name}: expected a series from the campaign start, got ${a.points.length} point(s)`);
    check(Object.keys(a.ranges).length === bots.length && Object.keys(a.ranges).every(id => ids.has(id)), `${bot.name}: ${a.name}: ranges are not keyed by the parties`);
    for (const p of a.points) {
      const total = Object.values(p.seats).reduce((x, y) => x + y, 0);
      check(Object.keys(p.seats).every(id => ids.has(id)) && Math.abs(total - CONTESTED) < 1e-6 * CFG.seatCount, `${bot.name}: ${a.name}: a point does not add up to the contested seats (${total}, expected ${CONTESTED})`);
    }
    for (const id of ids) check(Math.abs(a.points[0].seats[id] - CONTESTED / bots.length) < 1e-6, `${bot.name}: ${a.name}: point 0 should be contested seats / parties (${CONTESTED / bots.length}), got ${a.points[0].seats[id]}`);
  }
}

/**
 * Minor rally: no cooldown (two in a row are acked and charged costs.minorRally each, see Bot.campaign) and hidden like a roadshow.
 * "Not in the news" is proven at the end (news items == acked rallies, minor rallies not counted) and "never in another player's
 * messages" by the raw-string check on every message (Bot.inspect).
 */
async function minorRallyScenario(bot: Bot) {
  await sleep(timeline.campaignStart + 1500 - Date.now());
  const seat = pick(openSeats(8000));
  for (let i = 0; i < 2; i++) {
    const r = await bot.campaign('minorRally', seat);
    check(r.type === 'actionAck', `${bot.name}: minor rally #${i + 1} (no cooldown) should be acked, got ${bot.err(r)} ${r.type === 'error' ? r.message : ''}`);
  }
  log(`${bot.name}: two minor rallies in a row acked`);
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
  // the hello carries the fielding: a candidate of every party in each contested seat, nobody in a vacant one, and the fixed majority
  const snap = hello.snapshot;
  check(snap.contestedSeats === CONTESTED && snap.majority === MAJ, `${bot.name}: reconnect hello contestedSeats / majority ${snap.contestedSeats} / ${snap.majority}, expected ${CONTESTED} / ${MAJ}`);
  check(PKG.seats.every(s => (snap.fielding[s.id]?.length ?? 0) === (VACANT.has(s.id) ? 0 : bots.length)), `${bot.name}: reconnect hello fielding is wrong (a candidate per party in every non-vacant seat, none in the vacant ones)`);
  log(`${bot.name}: reconnected, hello has ${hello.private.myActions.length} own actions`);
}

// ------------------------------------------------------------------ pre-campaign
const fieldingUpdates = (b: Bot, from = 0) => b.msgs.slice(from).filter((m): m is Extract<ServerMessage, { type: 'fieldingUpdate' }> => m.type === 'fieldingUpdate');
const doneMsgs = (b: Bot, from = 0) => b.msgs.slice(from).filter((m): m is Extract<ServerMessage, { type: 'fieldingDone' }> => m.type === 'fieldingDone');
const wrongPhase = (what: string, r: ServerMessage, who: string) => check(bot_err(r) === 'WRONG_PHASE', `${who}: ${what} should be WRONG_PHASE, got ${r.type === 'error' ? r.error : r.type}`);

/**
 * 3+ players. Rules checked: campaign actions and reports are WRONG_PHASE; field / withdraw are answered with fieldAck to the sender
 * (budget -/+ costs.candidate per seat) and fieldingUpdate to the others; seats already fielded (or never fielded) are skipped; bad
 * input is BAD_REQUEST; the chat is one-to-one; then everybody fields every seat except the VACANT ones, so the contested seats and the
 * majority the server announces must equal CONTESTED / MAJ.
 */
async function preCampaignPhase() {
  const end = timeline.preCampaignEnd as number;
  const [b0, b1, b2] = bots;
  const free = PKG.seats.map(s => s.id).filter(s => !VACANT.has(s));
  const s1 = free[0];
  check(end - Date.now() > 4000, `pre-campaign is too short for the checks (${end - Date.now()} ms left); raise HP_PRECAMPAIGN_MS`);
  log(`pre-campaign: ${((end - Date.now()) / 1000).toFixed(0)}s left; vacant seats ${[...VACANT].join(',')}, expecting ${CONTESTED} contested seats, majority ${MAJ}`);

  // nothing of the campaign works yet
  for (const t of ['rally', 'minorRally', 'roadshow'] as const) wrongPhase(`${t} during the pre-campaign`, await b0.campaign(t, s1), b0.name);
  wrongPhase('a seat report during the pre-campaign', await b0.request({ action: 'buyReport', scope: 'seat', seat: s1 }, m => m.type === 'report'), b0.name);
  wrongPhase('a global report during the pre-campaign', await b0.request({ action: 'buyReport', scope: 'global' }, m => m.type === 'report'), b0.name);
  wrongPhase('news agencies during the pre-campaign', await b0.request({ action: 'globalReports' }, m => m.type === 'globalReports'), b0.name);

  // input checks
  const empty = await b0.field('field', []);
  check(bot_err(empty) === 'BAD_REQUEST', `field with no seats should be BAD_REQUEST, got ${empty.type === 'error' ? empty.error : empty.type}`);
  const unknown = await b0.field('field', [999999]);
  check(bot_err(unknown) === 'BAD_REQUEST', `field on an unknown seat should be BAD_REQUEST, got ${unknown.type === 'error' ? unknown.error : unknown.type}`);
  check(b0.budget === CFG.budget, `${b0.name}: refused fielding must not cost anything (budget ${b0.budget})`);
  // Done fielding with no candidate is refused (a party with none is eliminated at the deadline) and changes nothing
  const doneMark = bots.map(b => b.msgs.length);
  const noCand = await b0.done();
  check(bot_err(noCand) === 'BAD_REQUEST', `Done fielding with no candidate should be BAD_REQUEST, got ${noCand.type === 'error' ? noCand.error : noCand.type}`);
  const badDone = await b0.request({ action: 'doneFielding', done: 'yes', clientRef: 'bd1' } as unknown as ClientMessage, m => m.type === 'fieldingDone', 'bd1');
  check(bot_err(badDone) === 'BAD_REQUEST', `a non-boolean done should be BAD_REQUEST, got ${badDone.type === 'error' ? badDone.error : badDone.type}`);
  await sleep(200);
  check(bots.every(b => doneMsgs(b, doneMark[b.idx]).every(m => m.playerId !== b0.playerId || !m.done)), 'a refused Done must not be broadcast as done');

  // field one seat: fieldAck to the sender, fieldingUpdate to the others (and not a thing more on a repeat)
  const mark = bots.map(b => b.msgs.length);
  const one = await b0.field('field', [s1]);
  if (check(one.type === 'fieldAck', `field one seat refused: ${bot_err(one)}`) && one.type === 'fieldAck') {
    check(one.added.length === 1 && one.added[0].seat === s1 && one.removed.length === 0, `${b0.name}: fieldAck should name the added seat`);
    check(one.budget === CFG.budget - CFG.costs.candidate, `${b0.name}: budget after one candidate is ${one.budget}, expected ${CFG.budget - CFG.costs.candidate}`);
  }
  for (const b of [b1, b2]) {
    const m = await b.waitFor(x => x.type === 'fieldingUpdate' && x.playerId === b0.playerId, { from: mark[b.idx], what: 'fieldingUpdate' });
    if (m.type === 'fieldingUpdate') {
      check(m.added.length === 1 && m.added[0].seat === s1 && m.removed.length === 0, `${b.name}: fieldingUpdate should name the seat`);
      check(m.contestedSeats === 1 && m.majority === majorityOf(1), `${b.name}: one fielded seat => contestedSeats 1 / majority ${majorityOf(1)}, got ${m.contestedSeats} / ${m.majority}`);
    }
  }
  const again = await b0.field('field', [s1]);
  check(again.type === 'fieldAck' && again.added.length === 0 && again.budget === CFG.budget - CFG.costs.candidate, `${b0.name}: fielding an already fielded seat should be skipped and free`);
  const unfielded = await b0.field('withdraw', [free[1]]);
  check(unfielded.type === 'fieldAck' && unfielded.removed.length === 0 && unfielded.budget === CFG.budget - CFG.costs.candidate, `${b0.name}: withdrawing a seat without a candidate should be skipped`);
  await sleep(300);
  for (const b of [b1, b2]) check(fieldingUpdates(b, mark[b.idx]).length === 1, `${b.name}: a no-op field / withdraw must not broadcast (got ${fieldingUpdates(b, mark[b.idx]).length} updates)`);

  // Done fielding: pressed and revoked (everybody hears it with the counts); withdrawing the last candidate clears it again
  {
    const m0 = bots.map(b => b.msgs.length);
    const d = await b0.done();
    if (check(d.type === 'fieldingDone', `Done fielding with a candidate refused: ${bot_err(d)}`) && d.type === 'fieldingDone') check(d.done && d.doneCount === 1 && d.needed === N, `${b0.name}: Done counts should be 1 of ${N}, got ${d.doneCount} of ${d.needed}`);
    for (const b of [b1, b2]) {
      const m = await b.waitFor(x => x.type === 'fieldingDone' && x.playerId === b0.playerId && x.done, { from: m0[b.idx], what: 'fieldingDone broadcast' });
      if (m.type === 'fieldingDone') check(m.doneCount === 1 && m.needed === N, `${b.name}: fieldingDone should say 1 of ${N}, got ${m.doneCount} of ${m.needed}`);
    }
    const rv = await b0.done(false);
    check(rv.type === 'fieldingDone' && !rv.done && rv.doneCount === 0, `${b0.name}: revoking Done should broadcast done:false with 0 done`);
    await b1.waitFor(x => x.type === 'fieldingDone' && x.playerId === b0.playerId && !x.done, { from: m0[1], what: 'revoke broadcast' });
    check((await b0.done()).type === 'fieldingDone', `${b0.name}: Done again after a revoke`);
  }

  // withdraw refunds in full
  const wdMark = bots.map(b => b.msgs.length);
  const wd = await b0.field('withdraw', [s1]);
  if (check(wd.type === 'fieldAck', `withdraw refused: ${bot_err(wd)}`) && wd.type === 'fieldAck') {
    check(wd.removed.length === 1 && wd.removed[0] === s1 && wd.added.length === 0, `${b0.name}: withdraw fieldAck should name the removed seat`);
    check(wd.budget === CFG.budget, `${b0.name}: withdraw should refund the candidate cost (budget ${wd.budget})`);
  }
  for (const b of [b1, b2]) {
    const m = await b.waitFor(x => x.type === 'fieldingUpdate' && x.removed.includes(s1), { from: mark[b.idx], what: 'withdraw fieldingUpdate' });
    if (m.type === 'fieldingUpdate') check(m.contestedSeats === 0 && m.majority === majorityOf(0), `${b.name}: after the withdraw contestedSeats 0 / majority ${majorityOf(0)}, got ${m.contestedSeats} / ${m.majority}`);
  }

  // withdrawing the last candidate cleared b0's Done (done:false to everybody); fielding after Done clears it too
  for (const b of [b0, b1, b2]) await b.waitFor(m => m.type === 'fieldingDone' && m.playerId === b0.playerId && !m.done && m.doneCount === 0, { from: wdMark[b.idx], what: 'Done cleared by the withdraw' });
  {
    await b0.field('field', [s1]);
    check((await b0.done()).type === 'fieldingDone', 'Done after fielding again');
    const m0 = b1.msgs.length;
    await b0.field('field', [free[1]]);
    await b1.waitFor(m => m.type === 'fieldingDone' && m.playerId === b0.playerId && !m.done, { from: m0, what: 'Done cleared by a new candidate' });
    await b0.field('withdraw', [free[1]]);
    check(b0.fielded.has(s1) && b0.budget === CFG.budget - CFG.costs.candidate, `${b0.name}: s1 stays fielded and free[1] is refunded (budget ${b0.budget})`);
  }
  // a reconnect during the pre-campaign: the hello is followed by this player's fieldingDone
  {
    const had = b2.msgs.length;
    await b2.serial(async () => { b2.close(); await sleep(1200); await b2.connect(); });
    const hello = b2.msgs.slice(had).find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello');
    check(!!hello && Array.isArray(hello.snapshot.fieldingDone), `${b2.name}: the pre-campaign hello carries snapshot.fieldingDone`);
    check(!!hello && !hello.snapshot.fieldingDone.includes(b2.playerId), `${b2.name}: hello.fieldingDone should not list b2 (not done)`);
    await b2.waitFor(m => m.type === 'fieldingDone' && m.playerId === b2.playerId && !m.done, { from: had, what: 'fieldingDone after the reconnect hello' });
    const helloAt = b2.msgs.findIndex((m, i) => i >= had && m.type === 'hello'), doneAt = b2.msgs.findIndex((m, i) => i >= had && m.type === 'fieldingDone' && m.playerId === b2.playerId);
    check(doneAt > helloAt, `${b2.name}: fieldingDone should follow the hello`);
  }
  // the pre-campaign chat is one-to-one
  const text = 'pre-campaign chat ' + SEED, c0 = bots.map(b => b.msgs.length);
  const c = await b0.request({ action: 'chat', to: [b1.playerId], text }, m => m.type === 'chat' && m.message.text === text);
  check(c.type === 'chat' && c.message.channel === 'direct' && c.message.to.length === 1, `pre-campaign chat should be one-to-one, got ${c.type === 'error' ? c.error : c.type}`);
  const noTo = await b0.request({ action: 'chat', text: 'hello all' } as ClientMessage, m => m.type === 'chat' && m.message.text === 'hello all');
  check(bot_err(noTo) === 'BAD_REQUEST', `pre-campaign chat without a recipient should be BAD_REQUEST, got ${noTo.type === 'error' ? noTo.error : noTo.type}`);
  await b1.waitFor(m => m.type === 'chat' && m.message.text === text, { from: c0[1], what: 'pre-campaign chat delivery' });
  await sleep(300);
  check(!b2.msgs.slice(c0[2]).some(m => m.type === 'chat' && m.message.text === text), `${b2.name}: a one-to-one pre-campaign message leaked to a third party`);

  // everybody fields every seat but the vacant ones, all at once
  check(end - Date.now() > 2500, 'ran out of pre-campaign time before fielding');
  await Promise.all(bots.map(b => b.fieldAll()));
  for (const b of bots) {
    check(b.fielded.size === CONTESTED, `${b.name}: fielded ${b.fielded.size} seats, expected ${CONTESTED}`);
    check(b.budget === CFG.budget - CFG.costs.candidate * CONTESTED, `${b.name}: budget after fielding ${CONTESTED} seats is ${b.budget}, expected ${CFG.budget - CFG.costs.candidate * CONTESTED}`);
    await b.waitFor(m => m.type === 'fieldingUpdate' && m.contestedSeats === CONTESTED && m.majority === MAJ, { what: `fieldingUpdate with ${CONTESTED} contested seats / majority ${MAJ}` });
    check(fieldingUpdates(b).every(m => m.contestedSeats <= CONTESTED), `${b.name}: contestedSeats above ${CONTESTED} (a vacant seat counted)`);
  }
  log('pre-campaign: everyone fielded');
  await earlyStart();
}

/**
 * Scenario 1: everybody has fielded; all but the last press Done (the campaign must NOT open: someone is still fielding), one revokes
 * and presses again, then the last presses Done and the campaign opens at once: 'status campaign' arrives within seconds with a timeline
 * moved earlier as a whole (the campaign keeps its length), budgets and fielding untouched.
 */
async function earlyStart() {
  const old = timeline, last = bots[N - 1];
  const mark = bots.map(b => b.msgs.length);
  for (const b of bots.slice(0, N - 1)) {
    const d = await b.done();
    check(d.type === 'fieldingDone', `${b.name}: Done refused: ${bot_err(d)}`);
  }
  const rv = await bots[1].done(false);
  check(rv.type === 'fieldingDone' && rv.doneCount === N - 2 && rv.needed === N, `${bots[1].name}: after a revoke ${N - 2} of ${N} should be done, got ${rv.type === 'fieldingDone' ? rv.doneCount + ' of ' + rv.needed : bot_err(rv)}`);
  check((await bots[1].done()).type === 'fieldingDone', `${bots[1].name}: Done again`);
  await sleep(1500);
  for (const b of bots) check(!b.msgs.slice(mark[b.idx]).some(m => m.type === 'status'), `${b.name}: the campaign must not open while ${last.name} is not done`);
  const tDone = Date.now();
  check(old.preCampaignEnd! - tDone > 5000, `too little pre-campaign left (${old.preCampaignEnd! - tDone} ms) to show an early start; raise HP_PRECAMPAIGN_MS`);
  const d = await last.done();
  check(d.type === 'fieldingDone' && d.doneCount === N && d.needed === N, `${last.name}: the last Done should make ${N} of ${N}`);
  for (const b of bots) {
    const st = await b.waitFor(m => m.type === 'status' && m.status === 'campaign', { from: mark[b.idx], ms: 8000, what: 'early campaign status' });
    const tl = st.type === 'status' ? st.timeline : null;
    if (!check(!!tl, `${b.name}: the early campaign status carries a timeline`) || !tl) continue;
    check(Date.now() - tDone < 6000, `${b.name}: the campaign should open within seconds of the last Done`);
    const shift = old.campaignStart - tl.campaignStart;
    check(shift > 4000, `${b.name}: the campaign should start well before the old time (shifted only ${shift} ms)`);
    check(tl.preCampaignEnd! < old.preCampaignEnd! - 4000 && tl.preCampaignEnd! <= Date.now(), `${b.name}: preCampaignEnd should move to now`);
    check(old.campaignEnd - tl.campaignEnd === shift && old.countingEnd - tl.countingEnd === shift && old.postCountingEnd - tl.postCountingEnd === shift, `${b.name}: campaign end / counting / post-counting must move by the same ${shift} ms`);
    check(tl.phaseCloses.length === old.phaseCloses.length && tl.phaseCloses.every((t, i) => old.phaseCloses[i] - t === shift), `${b.name}: every phase close must move by the same ${shift} ms`);
    check(tl.campaignEnd - tl.campaignStart === old.campaignEnd - old.campaignStart, `${b.name}: the campaign keeps its length`);
    if (b === bots[0]) timeline = tl;
  }
  check(timeline.campaignStart < old.campaignStart, 'the bots must continue on the new, earlier timeline');
  // Done belongs to the pre-campaign: a Done now is WRONG_PHASE
  wrongPhase('Done fielding in the campaign', await bots[0].request({ action: 'doneFielding', clientRef: 'late1' }, m => m.type === 'fieldingDone', 'late1'), bots[0].name);
  log(`pre-campaign: everyone done, the campaign opened ${((old.campaignStart - timeline.campaignStart) / 1000).toFixed(0)}s early`);
}

/** 2 players: no pre-campaign; every seat is fielded and charged for them, announced with fieldingUpdates. */
async function twoPlayerFielding() {
  for (const b of bots) {
    check(b.budget === fullyFieldedBudget(CFG), `${b.name}: a 2-player game starts on ${fullyFieldedBudget(CFG)}, got ${b.budget}`);
    for (const p of bots) {
      await b.waitFor(m => m.type === 'fieldingUpdate' && m.playerId === p.playerId, { what: 'fieldingUpdate for every party' });
      const seats = new Set(fieldingUpdates(b).filter(m => m.playerId === p.playerId).flatMap(m => m.added.map(a => a.seat)));
      check(seats.size === PKG.seatCount, `${b.name}: ${p.name} should be fielded in all ${PKG.seatCount} seats, saw ${seats.size}`);
    }
    check(fieldingUpdates(b).every(m => m.contestedSeats === PKG.seatCount && m.majority === majorityOf(PKG.seatCount)), `${b.name}: a 2-player game contests every seat`);
  }
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
  check(PRE ? typeof timeline.preCampaignEnd === 'number' && timeline.preCampaignEnd < timeline.campaignStart : timeline.preCampaignEnd === undefined, `timeline.preCampaignEnd should be ${PRE ? 'set (3+ players)' : 'absent (2 players)'}`);
  const startBudget = PRE ? CFG.budget : fullyFieldedBudget(CFG);
  for (const b of bots) {
    await b.waitFor(m => m.type === 'status' && m.status === (PRE ? 'preCampaign' : 'campaign'), { what: PRE ? 'preCampaign status' : 'campaign status' });
    await b.waitFor(m => m.type === 'private' && m.private.budget === startBudget, { what: 'budget after start' });
  }
  if (PRE) {
    await preCampaignPhase();
    for (const b of bots) {
      await b.waitFor(m => m.type === 'status' && m.status === 'campaign', { ms: 30000, what: 'campaign status after the pre-campaign' });
      await b.waitFor(m => m.type === 'private' && m.private.budget === CFG.budget - CFG.costs.candidate * CONTESTED, { what: 'budget when the campaign opens' });
      const last = fieldingUpdates(b).pop();
      check(!!last && last.contestedSeats === CONTESTED && last.majority === MAJ, `${b.name}: contested seats / majority fixed at the campaign start should be ${CONTESTED} / ${MAJ}`);
    }
    // fielding is closed now
    wrongPhase('field during the campaign', await bots[0].field('field', [[...VACANT][0]]), bots[0].name);
    wrongPhase('withdraw during the campaign', await bots[0].field('withdraw', [[...bots[0].fielded][0]]), bots[0].name);
    log('campaign opened with the fielding fixed');
  } else {
    await twoPlayerFielding();
    wrongPhase('Done fielding in a 2-player game', await bots[0].request({ action: 'doneFielding', clientRef: 'late2' }, m => m.type === 'fieldingDone', 'late2'), bots[0].name);
  }
  check((await api('POST', '/games/join', { joinCode, nickname: 'TooLate' })).status === 409, 'joining after start should be refused (409)');
  const lateLobby = await api('GET', '/games/' + gameId, undefined, bots[0].token);
  check(!lateLobby.json.players.some((p: any) => p.nickname === 'Late' && p.status === 'pending'), 'pending applicants must be rejected at start');

  if (Date.now() < timeline.campaignStart - 100) {
    const r = await bots[0].campaign('rally', PKG.seats.find(s => !VACANT.has(s.id))!.id);
    check(bots[0].err(r) === 'WRONG_PHASE', `campaign before the start time should be WRONG_PHASE, got ${r.type === 'error' ? r.error : r.type}`);
  }
  await sleep(timeline.campaignStart + 100 - Date.now());

  // a seat nobody fielded is vacant: nobody can campaign there (and it costs nothing)
  for (const v of [...VACANT].slice(0, 1)) {
    const before = bots[0].budget;
    for (const t of ['rally', 'minorRally', 'roadshow'] as const) {
      const r = await bots[0].campaign(t, v);
      check(bot_err(r) === 'NOT_FIELDED', `${t} in seat ${v} (no candidate) should be NOT_FIELDED, got ${r.type === 'error' ? r.error : r.type}`);
    }
    check(bots[0].budget === before, 'a refused action must not cost anything');
  }

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
  if (N >= 2) { bots[1].reserve = (CFG.analyst.seatReport.enabled ? CFG.analyst.seatReport.end : 0) + (CFG.analyst.globalReport.enabled ? CFG.analyst.globalReport.end : 0); scenarios.push(analystScenario(bots[1])); }
  scenarios.push(minorRallyScenario(bots[N >= 3 ? 1 : 0]));
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
  const from1 = bots.map(b => b.msgs.length);
  const text = 'counting chat ' + SEED;
  const c = await b0.request({ action: 'chat', to: [b1.playerId], text }, m => m.type === 'chat' && m.message.text === text);
  check(c.type === 'chat', 'chat refused: ' + bot_err(c));
  // counting and post-counting are always one-to-one: only the recipient (and the sender) get it, and a recipient is required
  await b1.waitFor(m => m.type === 'chat' && m.message.text === text, { from: from1[1], what: 'chat delivery' });
  await sleep(300);
  bots.forEach((b, i) => {
    const got = b.msgs.slice(from1[i]).some(m => m.type === 'chat' && m.message.text === text);
    check(got === (b === b0 || b === b1), `${b.name}: one-to-one message ${got ? 'leaked to' : 'not received by'} this player`);
  });
  if (c.type === 'chat') check(c.message.channel === 'direct' && c.message.to.length === 1, 'counting chat should be one-to-one (channel direct, one recipient)');
  const noTo = await b1.request({ action: 'chat', text: 'hello all' } as ClientMessage, m => m.type === 'chat' && m.message.text === 'hello all');
  check(bot_err(noTo) === 'BAD_REQUEST', `one-to-one chat without a recipient should be BAD_REQUEST, got ${noTo.type === 'error' ? noTo.error : noTo.type}`);
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
  check(finalTally.total === CONTESTED && finalTally.declared === CONTESTED, `every contested seat must be declared (${finalTally.declared}/${finalTally.total}, expected ${CONTESTED})`);
  check(!updates.some(u => VACANT.has(u.declaration.seat)), 'a vacant seat must never be declared');
  const wonSeats = new Set(updates.filter(u => u.declaration.status === 'won').map(u => u.declaration.seat));
  check(wonSeats.size === CONTESTED, `expected ${CONTESTED} distinct won seats, got ${wonSeats.size}`);
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
  check(bots.reduce((s, b) => s + winsOf(b.playerId), 0) === CONTESTED, 'wins must add up to the number of contested seats');

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
    const expected = w0 === w1 ? 'draw' : (Math.max(w0, w1) >= MAJ ? 'majority' : 'noGovernment');
    check(R2.outcome === expected, `2 players: outcome should be ${expected} (wins ${w0}-${w1}), got ${R2.outcome}`);
    check(R2.outcome !== 'coalition' && !R2.government?.viaNegotiation, '2 players: there must be no negotiated government');
    log('result:', R2.outcome, 'wins', w0, w1);
    const fin2 = await api('GET', '/games/' + gameId, undefined, admin.token);
    check(fin2.json.status === 'finished', 'lobby status should be finished, got ' + fin2.json.status);
    for (const b of bots) for (const v of b.violations) check(false, 'hidden info: ' + v);
    return;
  }

  // ---- coalition: smallest group (>= 2 parties, and ALWAYS fewer than all: at least one party stays out) with a majority of WON seats
  const need = MAJ;
  // a single party with a majority after counting ends the game at once: no coalition talks
  if (bots.some(b => winsOf(b.playerId) >= need)) {
    log('one party holds a majority after counting: expecting an immediate majority result, no coalition talks');
    const resultsMaj: FinalResult[] = [];
    for (const b of bots) {
      const m = await b.waitFor(x => x.type === 'result', { ms: Math.max(15000, timeline.postCountingEnd - Date.now() + 15000), what: 'result' });
      if (m.type === 'result') resultsMaj.push(m.result);
    }
    check(resultsMaj.every(x => JSON.stringify(x) === JSON.stringify(resultsMaj[0])), 'all players must receive the same result');
    check(resultsMaj[0].outcome === 'majority', `a single party held a majority, outcome ${resultsMaj[0].outcome}`);
    for (const b of bots) for (const v of b.violations) check(false, 'hidden info: ' + v);
    return;
  }
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
      const seatPts = Math.round((CFG.points.seatMultiplier * winsOf(b.playerId)) / CONTESTED);
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

/**
 * A separate 3-party game on the same server where one party fields nothing (it fields a seat and withdraws it again, so the refund is
 * covered too). At the pre-campaign deadline it is eliminated but stays connected and may chat; the other two play on: the game
 * does not end, and the contested seats / majority follow what the other two fielded (a seat only one of them contests is not vacant).
 */
async function eliminationScenario() {
  const tag = 'Elim';
  const created = await api('POST', '/games', { nickname: tag + '0', mapId: 'world-500', phases: 2 });
  must(created.status === 200, 'elimination game: create failed ' + JSON.stringify(created));
  const gid: string = created.json.gameId, code: string = created.json.joinCode;
  const es: Bot[] = [];
  const first = new Bot(tag + '0', 0); first.playerId = created.json.playerId; first.token = created.json.token; first.gameId = gid; es.push(first);
  for (let i = 1; i < 3; i++) {
    const j = await api('POST', '/games/join', { joinCode: code, nickname: tag + i });
    must(j.status === 200, 'elimination game: join failed');
    const b = new Bot(tag + i, i); b.playerId = j.json.playerId; b.token = j.json.token; b.gameId = gid; es.push(b);
    check((await api('POST', `/games/${gid}/admit`, { playerId: b.playerId, admit: true }, first.token)).status === 200, 'elimination game: admit');
  }
  await api('POST', `/games/${gid}/settings`, { phases: 2 }, first.token);
  for (const b of es) {
    const party = { name: 'Elim ' + b.name, colour: PARTY_COLOURS[b.idx].hex, symbol: PARTY_SYMBOLS[b.idx].id, avatar: AVATARS[b.idx].id };
    check((await api('POST', `/games/${gid}/party`, { party }, b.token)).status === 200, `${b.name}: elimination game party`);
  }
  for (const b of es) await b.connect();
  const st = await api('POST', `/games/${gid}/start`, undefined, first.token);
  must(st.status === 200, 'elimination game: start failed ' + JSON.stringify(st.json));
  const tl: GameTimeline = st.json.timeline;
  for (const b of es) await b.waitFor(m => m.type === 'status' && m.status === 'preCampaign', { what: 'elimination game preCampaign' });

  // Elim0 fields seats a,b,c; Elim1 fields b,c,d; Elim2 fields a and withdraws it again => seat a is contested by Elim0 alone
  const [a, b, c, d] = PKG.seats.map(x => x.id).slice(0, 4);
  const [e0, e1, e2] = es;
  const r0 = await e0.field('field', [a, b, c]), r1 = await e1.field('field', [b, c, d]);
  check(r0.type === 'fieldAck' && r1.type === 'fieldAck', 'elimination game: fielding refused');
  const f2 = await e2.field('field', [a]);
  check(f2.type === 'fieldAck' && f2.budget === CFG.budget - CFG.costs.candidate, 'elimination game: Elim2 fielded one seat');
  const w2 = await e2.field('withdraw', [a]);
  check(w2.type === 'fieldAck' && w2.budget === CFG.budget && e2.fielded.size === 0, 'elimination game: Elim2 withdrew it for a full refund');

  // Scenario 2: only some press Done. Elim2 (connected, no candidate) can not, so the early start never fires and the deadline ends the phase
  const noC = await e2.done();
  check(bot_err(noC) === 'BAD_REQUEST', `elimination game: Done with no candidate should be BAD_REQUEST, got ${noC.type === 'error' ? noC.error : noC.type}`);
  const dm = es.map(x => x.msgs.length);
  check((await e0.done()).type === 'fieldingDone' && (await e1.done()).type === 'fieldingDone', 'elimination game: Elim0 and Elim1 press Done');
  const lastDone = await e2.waitFor(m => m.type === 'fieldingDone' && m.doneCount === 2, { from: dm[2], what: 'fieldingDone 2 of 3' });
  check(lastDone.type === 'fieldingDone' && lastDone.needed === 3, 'elimination game: 2 of 3 done');

  // the deadline: Elim2 has no candidate and is eliminated, but its socket stays open and the game goes on
  const from = es.map(x => x.msgs.length);
  for (const x of es) {
    const st = await x.waitFor(m => m.type === 'status' && m.status === 'campaign', { from: dm[x.idx], ms: tl.preCampaignEnd! - Date.now() + 15000, what: 'elimination game campaign status' });
    check(Date.now() >= tl.preCampaignEnd! - 300, `${x.name}: with a party not done the campaign must wait for the deadline (opened ${tl.preCampaignEnd! - Date.now()} ms early)`);
    check(st.type === 'status' && st.timeline?.campaignStart === tl.campaignStart, `${x.name}: the timeline must stay unchanged when the deadline ends the phase`);
  }
  for (const x of [e0, e1]) {
    await x.waitFor(m => m.type === 'players' && m.players.some(p => p.playerId === e2.playerId && p.status === 'eliminated'), { from: from[x.idx], what: 'Elim2 eliminated broadcast' });
    const last = fieldingUpdates(x, from[x.idx]).pop();
    check(!!last && last.contestedSeats === 4 && last.majority === majorityOf(4), `${x.name}: contested seats / majority at the deadline should be 4 / ${majorityOf(4)}, got ${last?.contestedSeats} / ${last?.majority}`);
  }
  check(e2.ws.readyState === WebSocket.OPEN, 'Elim2 must stay connected after the elimination');
  await e2.waitFor(m => m.type === 'players' && m.players.some(p => p.playerId === e2.playerId && p.status === 'eliminated'), { from: from[2], what: 'Elim2 hears about its own elimination' });
  const r = await e2.field('field', [a]);
  check(bot_err(r) === 'FORBIDDEN', `an eliminated party cannot field, got ${r.type === 'error' ? r.error : r.type}`);
  await sleep(tl.campaignStart + 200 - Date.now());
  const ra = await e2.campaign('roadshow', b);
  check(bot_err(ra) === 'FORBIDDEN', `an eliminated party cannot campaign, got ${ra.type === 'error' ? ra.error : ra.type}`);
  // it can still talk to the others
  const text = 'eliminated but here ' + SEED;
  const chatR = await e2.request({ action: 'chat', to: [e0.playerId], text }, m => m.type === 'chat' && m.message.text === text);
  if (CFG.chat.campaigning !== 'OFF') {
    check(chatR.type === 'chat', `an eliminated party should still be able to chat, got ${bot_err(chatR)}`);
    await e0.waitFor(m => m.type === 'chat' && m.message.text === text, { from: from[0], what: 'chat from the eliminated party' });
  }
  // the others campaign where they have a candidate, and are refused where they have none (seat d is Elim1's alone)
  const ok = await e0.campaign('minorRally', a);
  check(ok.type === 'actionAck', `Elim0 should campaign in its own seat, got ${bot_err(ok)}`);
  const no = await e0.campaign('roadshow', d);
  check(bot_err(no) === 'NOT_FIELDED', `Elim0 has no candidate in seat ${d}: should be NOT_FIELDED, got ${no.type === 'error' ? no.error : no.type}`);
  // the game goes on: two parties left is enough, nothing ends it
  await sleep(1500);
  for (const x of es) check(!x.msgs.some(m => m.type === 'result'), `${x.name}: the game must not end because one party was eliminated`);
  const lobby = await api('GET', '/games/' + gid, undefined, e0.token);
  check(lobby.json.status === 'campaign', `the elimination game should still be in the campaign, got ${lobby.json.status}`);
  for (const x of es) for (const v of x.violations) check(false, 'hidden info (elimination game): ' + v);
  for (const x of es) x.close();
  log('elimination: a party with no candidates was eliminated at the deadline, stayed connected, and the game continued');
}

function bot_err(r: ServerMessage): string | undefined { return r.type === 'error' ? r.error : undefined; }

/** Play again: the host (bots[0]) starts a follow-up game with a different number of phases; everybody rolls over with the same player id, token and party and lands in the pre-campaign (3+ players) or the campaign (2). */
async function rematchCheck() {
  const oldGameId = gameId, host = bots[0];
  const phases = PHASES === 1 ? 2 : 1;
  const mark = bots.map(b => b.msgs.length);
  const parties = new Map<string, string>();
  const before = await api('GET', '/games/' + oldGameId, undefined, host.token);
  for (const pl of before.json.players ?? []) if (pl.party?.name) parties.set(pl.playerId, pl.party.name);
  check(parties.size === bots.length, `every player should have a party before the rematch (${parties.size}/${bots.length})`);

  const denied = await api('POST', `/games/${oldGameId}/rematch`, { phases }, bots[bots.length - 1].token);
  check(denied.status === 403, `a non-host rematch should be 403, got ${denied.status}`);
  const bad = await api('POST', `/games/${oldGameId}/rematch`, { phases: 99 }, host.token);
  check(bad.status === 400, `rematch with phases 99 should be 400, got ${bad.status}`);
  const r = await api('POST', `/games/${oldGameId}/rematch`, { phases }, host.token);
  if (!check(r.status === 200 && !!r.json.gameId, `host rematch should be 200 with a game, got ${r.status}`)) return;
  check(r.json.gameId !== oldGameId && r.json.joinCode, 'the follow-up game must be a new game with its own join code');
  const again = await api('POST', `/games/${oldGameId}/rematch`, { phases: phases === 1 ? 2 : 1 }, host.token);
  check(again.status === 200 && again.json.gameId === r.json.gameId, 'a second rematch click must return the same game');

  for (const [i, b] of bots.entries()) {
    const m = await b.waitFor(x => x.type === 'rematch', { from: mark[i], ms: 10000, what: 'rematch message' });
    check(m.type === 'rematch' && m.gameId === r.json.gameId, `${b.name}: rematch message names the new game`);
  }
  const old = await api('GET', '/games/' + oldGameId, undefined, host.token);
  check(old.json.nextGameId === r.json.gameId, 'the old game should point to the new one (nextGameId)');

  // everybody switches game with the SAME token and gets the campaign
  gameId = r.json.gameId;
  for (const b of bots) {
    b.close();
    b.msgs = [];
    await b.connect();
    const h = b.msgs.find((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello');
    check(!!h && h.snapshot.gameId === r.json.gameId, `${b.name}: hello for the new game`);
    // 3+ players start in the pre-campaign (nothing fielded, full budget); 2 players straight in the campaign with every seat fielded
    const wantStatus = PRE ? 'preCampaign' : 'campaign';
    check(h?.snapshot.status === wantStatus, `${b.name}: the new game should be in the ${wantStatus}, got ${h?.snapshot.status}`);
    check(PRE ? typeof h?.snapshot.timeline?.preCampaignEnd === 'number' : h?.snapshot.timeline?.preCampaignEnd === undefined, `${b.name}: rematch timeline preCampaignEnd ${PRE ? 'should be set' : 'should be absent'}`);
    if (PRE) check(Object.values(h?.snapshot.fielding ?? {}).every(l => !l.length) && h?.snapshot.contestedSeats === 0, `${b.name}: a fresh pre-campaign has nothing fielded`);
    else check(PKG.seats.every(s => h?.snapshot.fielding?.[s.id]?.length === bots.length) && h?.snapshot.contestedSeats === PKG.seatCount && h?.snapshot.majority === majorityOf(PKG.seatCount), `${b.name}: a 2-player rematch has every seat fielded by both parties`);
    check(h?.snapshot.phases === phases, `${b.name}: the new game should have ${phases} phase(s), got ${h?.snapshot.phases}`);
    check(h?.private.budget === (PRE ? CFG.budget : fullyFieldedBudget(CFG)), `${b.name}: budget is fresh (${PRE ? CFG.budget : fullyFieldedBudget(CFG)}), got ${h?.private.budget}`);
    check(h?.snapshot.players.find(p => p.playerId === b.playerId)?.party?.name === parties.get(b.playerId), `${b.name}: party carried over`);
    check((h?.snapshot.players.length ?? 0) === bots.length, `${b.name}: all players rolled over`);
  }
  log(`play again: new game ${r.json.gameId} (${phases} phase(s)), ${bots.length} players rolled over`);
  for (const b of bots) for (const v of b.violations) check(false, 'hidden info (rematch): ' + v);
}

Promise.all([main().then(rematchCheck), N >= 3 ? eliminationScenario() : Promise.resolve()]).then(() => {
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
