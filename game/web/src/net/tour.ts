// TOUR backend (?tour): a scripted practice election that runs entirely in the browser and never talks to a server.
// It reuses the real engine (committed voters, reputation, coalition points) but the RESULT is fixed by tourSeatCounts():
// you are the runner-up, the largest party is short of a majority, and you + all seven smaller parties make exactly the
// majority. Every message is an ordinary ServerMessage, so the normal screens run unchanged.
import {
  DEFAULT_MAP_ID, MAP_MANIFESTS, PARTY_COLOURS, buildKernels, committedView, computeEffects, createRng, dealCommitted, finalResult,
  governmentFromOffer, leavesPartyOut, majorityOf, rallyAvailableAt, reputationView,
  gaussian, newsAgencies, newsErrorRates, newsSeed, newsSampleTimes,
} from '@hp/shared';
import type {
  Action, AdmissionRequest, AdmitRequest, ClientMessage, CoalitionOffer, CommittedSet, CountTally, CreateGameRequest, CreateGameResponse,
  ErrorCode, FinalResult, GlobalReports, GameId, GameMapPackage, GameSnapshot, GameStatus, GameTimeline, Government, JoinGameRequest, JoinGameResponse, Kernels,
  LobbyView, MapConfig, NewsItem, PartyIdentity, PartyRequest, PlayerId, PlayerPublic, PortfolioAssignment, PrivateState,
  Rng, SeatDeclaration, SeatId, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';
import { ApiException, type Transport } from './transport';
import { gamePackageUrl } from '../map/mapData';
import { mapConfigFor } from '../state/mapConfig';
import {
  SMALL_PARTIES, assignSeats, buildReveal, pickCores, quotasInPartyOrder, tourSeatCounts,
} from '../tour/tourScript';
import type { RevealPlan } from '../tour/tourScript';
import { useTour } from '../tour/tourStore';

/** The 9 parties of the practice election, in party order: you, the largest party, then the seven smaller ones. */
export const TOUR_PARTIES: PartyIdentity[] = [
  { name: 'Your Party', colour: PARTY_COLOURS[0].hex, symbol: 'torch', avatar: 'babu' },
  { name: 'National Alliance', colour: PARTY_COLOURS[1].hex, symbol: 'globe', avatar: 'macron' },
  { name: 'Green Leaf Movement', colour: PARTY_COLOURS[2].hex, symbol: 'leaf', avatar: 'mandela' },
  { name: 'People’s Star', colour: PARTY_COLOURS[3].hex, symbol: 'star', avatar: 'gandhi' },
  { name: 'Mountain Union', colour: PARTY_COLOURS[4].hex, symbol: 'mountain', avatar: 'indira' },
  { name: 'Harbour League', colour: PARTY_COLOURS[5].hex, symbol: 'anchor', avatar: 'kim' },
  { name: 'Sunrise Party', colour: PARTY_COLOURS[6].hex, symbol: 'sun', avatar: 'mamata' },
  { name: 'Reform Bell Party', colour: PARTY_COLOURS[7].hex, symbol: 'bell', avatar: 'nehru' },
  { name: 'Forest Peoples’ Front', colour: PARTY_COLOURS[8].hex, symbol: 'tree', avatar: 'sonia' },
];
export const TOUR_ME_ID = 'p_you';
const PARTY_IDS = ['p_you', 'p_alliance', 'p_s1', 'p_s2', 'p_s3', 'p_s4', 'p_s5', 'p_s6', 'p_s7'];

/** Ten years: nothing in the practice campaign ever closes by itself. */
const FAR_MS = 10 * 365 * 24 * 3600 * 1000;

export interface TourOptions {
  /** Map package to use instead of fetching the real one (tests). */
  pkg?: GameMapPackage;
  /** Real time the count takes to reach the coalition pause (default 20 s). */
  revealMs?: number;
  /** Real time the count takes from the accepted government to the last declared seat (default 9 s). */
  resumeMs?: number;
  /** Delays (ms after the start) of the scripted rallies of rival parties shown in the news ticker. */
  botRallyAt?: number[];
  seed?: string;
}

const BOT_REPLIES = [
  'Interesting. What portfolios are you thinking of?', 'We could work together if the numbers add up.',
  'Let me talk to the others first.', 'Agreed in principle – send a formal offer.', 'Not before I see the final count.',
];
const BOT_RALLIES = [3_500, 9_000, 16_000, 26_000, 38_000, 52_000, 70_000, 95_000];

type Msg<A extends ClientMessage['action']> = Extract<ClientMessage, { action: A }>;
type ErrFn = (code: ErrorCode, message: string, clientRef?: string) => void;

interface TourGame {
  gameId: GameId;
  pkg: GameMapPackage;
  kernels: Kernels;
  cfg: MapConfig;
  n: number;
  status: GameStatus;
  timeline: GameTimeline;
  players: PlayerPublic[];
  budget: number;
  actions: Action[];
  news: NewsItem[];
  committedSet: CommittedSet;
  /** seat -> party index (the scripted final winner) */
  truth: Map<SeatId, number>;
  trueShares: Record<SeatId, Record<PlayerId, number>>;
  seats: Record<SeatId, SeatDeclaration>;
  tally: CountTally | null;
  offers: CoalitionOffer[];
  government: Government | null;
  plan: RevealPlan | null;
  planIdx: number;
  vt: number;
  lastTick: number;
  paused: boolean;
  /** an accepted government releases the pause */
  released: boolean;
  result: FinalResult | null;
}

export class TourTransport implements Transport {
  private g: TourGame | null = null;
  private onMessage: ((m: ServerMessage) => void) | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private opts: Required<Pick<TourOptions, 'revealMs' | 'resumeMs' | 'botRallyAt'>> & TourOptions;
  private rng: Rng;
  private uidN = 0;

  constructor(opts: TourOptions = {}) {
    this.opts = { revealMs: 20_000, resumeMs: 9_000, botRallyAt: BOT_RALLIES, ...opts };
    this.rng = createRng(opts.seed ?? 'hung-parliament-tour');
    useTour.getState().register({ startCounting: () => this.startCounting() });
  }

  // -------------------------------------------------------------- plumbing
  private uid(prefix: string) { return `${prefix}${++this.uidN}`; }
  private later(fn: () => void, ms: number) {
    const h = setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
  }
  private emit(m: ServerMessage) {
    const cb = this.onMessage;
    if (cb) { const copy = structuredClone(m); this.later(() => cb(copy), 20); }
  }
  private fail(code: ErrorCode, msg: string): never { throw new ApiException(code, msg); }
  private game(): TourGame {
    if (!this.g) this.fail('UNAUTHORIZED', 'Not in a game');
    return this.g;
  }
  private clearTimers() {
    this.timers.forEach(clearTimeout); this.timers.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
  private ids(g: TourGame) { return g.players.map(p => p.playerId); }
  private smallIds(g: TourGame) { return g.players.slice(2).map(p => p.playerId); }
  private pid(idx: number) { return PARTY_IDS[idx]; }

  // -------------------------------------------------------------- views
  private snapshot(g: TourGame): GameSnapshot {
    return {
      gameId: g.gameId, mapId: g.pkg.mapId, status: g.status, phases: 1, timeline: g.timeline,
      players: structuredClone(g.players), news: [...g.news], polledPhases: [], seats: { ...g.seats },
      tally: g.tally ? structuredClone(g.tally) : null, offers: structuredClone(g.offers), government: g.government, result: g.result,
    };
  }
  private lastRallyAt(g: TourGame): number | undefined {
    let last: number | undefined;
    for (const a of g.actions) if (a.type === 'rally' && (last === undefined || a.ts > last)) last = a.ts;
    return last;
  }
  private nextRallyAt(g: TourGame): number | null {
    const at = rallyAvailableAt(this.lastRallyAt(g), g.cfg);
    return Number.isFinite(at) ? at : null;
  }
  private reputation(g: TourGame): Record<SeatId, number> {
    const eff = computeEffects(g.actions, g.kernels, g.cfg, g.timeline, g.pkg, 1);
    return reputationView(eff.get(TOUR_ME_ID), g.kernels, g.cfg);
  }
  private priv(g: TourGame): PrivateState {
    return {
      you: TOUR_ME_ID, budget: g.budget,
      myActions: g.actions.map(a => ({ type: a.type, seat: a.seat, ts: a.ts })),
      myReports: [], nextRallyAt: this.nextRallyAt(g),
      committed: committedView(g.committedSet, g.cfg), reputation: this.reputation(g),
    };
  }

  // -------------------------------------------------------------- game set-up
  private async loadPackage(mapId: string): Promise<GameMapPackage> {
    if (this.opts.pkg) return this.opts.pkg;
    let pkg: GameMapPackage | null = null;
    try {
      const r = await fetch(gamePackageUrl(mapId));
      if (r.ok) pkg = (await r.json()) as GameMapPackage;
    } catch { /* handled below */ }
    if (!pkg || !Array.isArray(pkg.seats) || !pkg.phaseGroups?.['1']) this.fail('INTERNAL', 'The tour could not load the map. Please reload the page.');
    return pkg;
  }

  async createGame(req: CreateGameRequest): Promise<CreateGameResponse> {
    this.clearTimers();
    const mapId = MAP_MANIFESTS.some(m => m.id === req.mapId) ? req.mapId : DEFAULT_MAP_ID;
    const pkg = await this.loadPackage(mapId);
    const n = pkg.seats.length;
    const cfg: MapConfig = { ...mapConfigFor(pkg.mapId, n), seatCount: n };
    const kernels = buildKernels(pkg, cfg);
    const rng = this.rng;

    // you: committed voters dealt by the real engine, so the shaded seats are what a real game would give
    const committedSet = dealCommitted(pkg, kernels, cfg, [], rng);

    // who wins which seat: the scripted result, grown around your committed area (on a tiny map your committed seats
    // could outnumber your seats: then only the first ones in walk order are pinned to you)
    const counts = tourSeatCounts(n);
    const quotas = quotasInPartyOrder(counts);
    const pinned = committedSet.seats.slice(0, Math.max(1, Math.floor(quotas[0] * 0.8)));
    const mineSeats = new Set(pinned.map(s => s.seat));
    const nodes = pkg.seats.map(s => ({ id: s.id, x: s.x, y: s.y, neighbours: s.neighbours }));
    const cores = [committedSet.core, ...pickCores(nodes, mineSeats, quotas.length - 1)];
    const pre = new Map<number, number>();
    for (const cs of pinned) pre.set(cs.seat, 0);
    const truth = assignSeats(nodes, quotas, cores, pre);

    const players: PlayerPublic[] = TOUR_PARTIES.map((party, i) => ({
      playerId: this.pid(i), nickname: i === 0 ? 'You' : party.name, isAdmin: i === 0, kind: 'human', party: { ...party }, status: 'active',
    }));
    const now = Date.now();
    const timeline: GameTimeline = {
      campaignStart: now - 1_000, phaseCloses: [now + FAR_MS], campaignEnd: now + FAR_MS,
      countingEnd: now + FAR_MS + 1, postCountingEnd: now + FAR_MS + 2,
    };
    this.g = {
      gameId: 'tour_' + this.uid('g'), pkg, kernels, cfg, n, status: 'campaign', timeline, players, budget: cfg.budget, actions: [],
      news: [], committedSet, truth, trueShares: {}, seats: {}, tally: null, offers: [], government: null, plan: null, planIdx: 0,
      vt: 0, lastTick: now, paused: false, released: false, result: null,
    };
    const g = this.g;
    this.buildShares(g, rng);
    // rivals rally now and then, so the news ticker has something to show
    this.opts.botRallyAt.forEach((ms, k) => this.later(() => this.botRally(g, k), ms));
    return { gameId: g.gameId, joinCode: '', playerId: TOUR_ME_ID, token: 'tour' };
  }

  private buildShares(g: TourGame, rng: Rng) {
    const mine = new Map(g.committedSet.seats.map(s => [s.seat, g.cfg.committed.bands[s.band - 1]?.percent ?? 0] as const));
    for (const seat of g.truth.keys()) {
      const win = g.truth.get(seat)!;
      const raw = PARTY_IDS.map((_, i) => 0.2 + 0.8 * rng());
      raw[0] += (mine.get(seat) ?? 0) / 100;
      const topOther = Math.max(...raw.filter((_, i) => i !== win));
      raw[win] = topOther * 1.2 + 0.35;
      const tot = raw.reduce((a, b) => a + b, 0);
      g.trueShares[seat] = Object.fromEntries(raw.map((v, i) => [this.pid(i), Math.round((v / tot) * 1000) / 1000]));
    }
  }

  private botRally(g: TourGame, k: number) {
    if (this.g !== g || g.status !== 'campaign') return;
    const party = 1 + (k % 8);
    const own = [...g.truth].filter(([, p]) => p === party).map(([s]) => s);
    if (!own.length) return;
    const seat = own[Math.floor(this.rng() * own.length)];
    const item: NewsItem = { playerId: this.pid(party), seat, ts: Date.now() };
    g.news.push(item);
    this.emit({ type: 'news', item });
  }

  // -------------------------------------------------------------- REST (a practice game has no lobby)
  async joinGame(_req: JoinGameRequest): Promise<JoinGameResponse> { return this.fail('FORBIDDEN', 'The tour is a practice game: nobody can join it.'); }
  async getLobby(_id: GameId, _token: string): Promise<LobbyView> {
    const g = this.game();
    return {
      gameId: g.gameId, joinCode: '', mapId: g.pkg.mapId, phases: 1, status: g.status, admissionOpen: false, you: TOUR_ME_ID,
      players: structuredClone(g.players),
    };
  }
  async admit(_id: GameId, _token: string, _req: AdmitRequest): Promise<void> { /* nothing to admit */ }
  async setAdmission(_id: GameId, _token: string, _req: AdmissionRequest): Promise<void> { /* nothing to open */ }
  async setSettings(_id: GameId, _token: string, _req: SettingsRequest): Promise<void> { this.fail('WRONG_PHASE', 'The practice game has already started'); }
  async setParty(_id: GameId, _token: string, _req: PartyRequest): Promise<void> { this.fail('WRONG_PHASE', 'The practice game has already started'); }
  async start(_id: GameId, _token: string): Promise<StartResponse> { return this.fail('WRONG_PHASE', 'The practice game has already started'); }

  // -------------------------------------------------------------- WebSocket
  connect(gameId: GameId, _token: string, onMessage: (m: ServerMessage) => void) {
    const g = this.game();
    if (g.gameId !== gameId) throw new ApiException('NOT_FOUND', 'Unknown game');
    this.onMessage = onMessage;
    this.emit({ type: 'hello', serverTime: Date.now(), snapshot: this.snapshot(g), private: this.priv(g) });
  }
  disconnect() {
    this.onMessage = null;
    this.clearTimers();
    this.g = null;
    const t = useTour.getState();
    t.setCountPaused(false);
  }

  send(msg: ClientMessage) {
    const g = this.g;
    if (!g) return;
    const err: ErrFn = (error, message, clientRef) => this.emit({ type: 'error', error, message, clientRef });
    switch (msg.action) {
      case 'ping': this.emit({ type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() }); break;
      case 'campaign': this.handleCampaign(g, msg, err); break;
      case 'buyReport': err('BAD_REQUEST', 'Analyst reports are not part of the tour'); break;
      case 'globalReports': this.handleGlobalReports(g, err); break;
      case 'peekSeat': this.handlePeek(g, msg, err); break;
      case 'chat': this.handleChat(g, msg, err); break;
      case 'proposeGovernment': this.handlePropose(g, msg, err); break;
      case 'respondOffer': err('OFFER_NOT_FOUND', 'No party has made you an offer in this practice game'); break;
      case 'withdrawOffer': {
        const o = g.offers.find(x => x.offerId === msg.offerId && x.status === 'open');
        if (!o) return err('OFFER_NOT_FOUND', 'No such open offer');
        o.status = 'withdrawn';
        this.emit({ type: 'offer', offer: o });
        break;
      }
    }
  }

  // ---- global reports (news agencies)
  /**
   * Scripted series: the practice clock is frozen (a 10-year campaign), so the engine's time-based series would be a single point.
   * Instead the agencies' graphs run over a synthetic campaign of MIN(maxPoints, 3 + your actions) points: they start from the even
   * split and move toward the scripted final result (largest party first, you the runner-up), so the picture is the one the tour
   * narrates, and every action you take adds one point (the graph visibly changes). Noise and error shrinkage are the engine's own
   * (newsErrorRates, same config); seeds are fixed per game, so asking again repeats the answer.
   */
  private handleGlobalReports(g: TourGame, err: ErrFn) {
    if (!g.cfg.news.enabled) return err('FORBIDDEN', 'News agency reports are switched off in this game');
    const ids = g.players.map(p => p.playerId);
    const final = ids.map((_, i) => [...g.truth.values()].filter(w => w === i).length);
    const count = Math.min(g.cfg.news.maxPoints, 3 + g.actions.length);
    const interval = g.cfg.news.sampleIntervalMs;
    const start = g.timeline.campaignStart;
    const tl: GameTimeline = { ...g.timeline, campaignStart: start, campaignEnd: start + (count - 1) * interval };
    const times = newsSampleTimes(g.cfg, tl, tl.campaignEnd);
    const even = g.n / ids.length;
    const agencies = newsAgencies(g.cfg).map(agency => {
      const errs = newsErrorRates(g.cfg, newsSeed(g.gameId, 'tour'), agency.id, tl, times);
      const points = times.map((x, i) => {
        if (i === 0) return { t: x.t, seats: Object.fromEntries(ids.map(id => [id, even])) };
        const f = i / (times.length - 1);
        const rng = createRng(`${g.gameId}:tour-news:${agency.id}:${x.k}`);
        const raw = ids.map((_, j) => Math.max(0, (even + (final[j] - even) * f) * (1 + errs[i] * gaussian(rng))));
        const sum = raw.reduce((a, b) => a + b, 0);
        return { t: x.t, seats: Object.fromEntries(ids.map((id, j) => [id, sum > 0 ? (raw[j] * g.n) / sum : even])) };
      });
      const latest = points[points.length - 1].seats, e = errs[errs.length - 1];
      const clamp = (v: number) => Math.min(g.n, Math.max(0, v));
      const ranges = Object.fromEntries(ids.map(id => [id, [clamp(Math.round(latest[id] * (1 - e))), clamp(Math.round(latest[id] * (1 + e)))] as [number, number]]));
      return { id: agency.id, name: agency.name, points, ranges };
    });
    const reports: GlobalReports = { asOf: times[times.length - 1].t, sampleIntervalMs: interval, agencies };
    this.emit({ type: 'globalReports', reports });
  }

  // ---- campaign
  private handleCampaign(g: TourGame, msg: Msg<'campaign'>, err: ErrFn) {
    if (g.status !== 'campaign') return err('WRONG_PHASE', 'The campaign is over', msg.clientRef);
    if (!g.kernels.index.has(msg.seat)) return err('BAD_REQUEST', 'Unknown seat', msg.clientRef);
    const now = Date.now();
    if (msg.type === 'rally') {
      const at = this.nextRallyAt(g);
      if (at !== null && now < at) {
        return this.emit({ type: 'error', error: 'RATE_LIMITED', retryAt: at, clientRef: msg.clientRef,
          message: `You can rally once every ${Math.round(g.cfg.cooldowns.rallyMs / 1000)} s; next rally in ${Math.ceil((at - now) / 1000)} s` });
      }
    }
    const cost = g.cfg.costs[msg.type];
    if (g.budget < cost) return err('INSUFFICIENT_FUNDS', 'Not enough funds', msg.clientRef);
    g.budget -= cost;
    const a: Action = { id: this.uid('a'), playerId: TOUR_ME_ID, type: msg.type, seat: msg.seat, ts: now };
    g.actions.push(a);
    this.emit({ type: 'actionAck', clientRef: msg.clientRef, ok: true, budget: g.budget, reputation: this.reputation(g), nextRallyAt: this.nextRallyAt(g) });
    this.emit({ type: 'private', private: this.priv(g) });
    if (msg.type === 'rally') {
      const item: NewsItem = { playerId: TOUR_ME_ID, seat: msg.seat, ts: now };
      g.news.push(item);
      this.emit({ type: 'news', item });
    }
  }

  // ---- chat
  private handleChat(g: TourGame, msg: Msg<'chat'>, err: ErrFn) {
    const early = g.status === 'campaign' && g.cfg.messaging.opensAt === 'campaign';
    if (!early && g.status !== 'counting' && g.status !== 'postCounting') return err('WRONG_PHASE', 'Chat opens when the campaign starts');
    const others = this.ids(g).filter(id => id !== TOUR_ME_ID);
    const group = g.cfg.messaging.mode === 'group';
    const to = group ? others : (msg.to ?? []).filter(id => others.includes(id));
    if (!to.length || !msg.text.trim()) return err('BAD_REQUEST', 'Pick recipients and write something');
    const now = Date.now();
    this.emit({ type: 'chat', message: { id: this.uid('c'), from: TOUR_ME_ID, to, text: msg.text.trim().slice(0, 500), ts: now } });
    const replier = to[Math.floor(this.rng() * to.length)];
    this.later(() => this.emit({
      type: 'chat', message: { id: this.uid('c'), from: replier, to: [TOUR_ME_ID, ...to.filter(x => x !== replier)], text: BOT_REPLIES[Math.floor(this.rng() * BOT_REPLIES.length)], ts: Date.now() },
    }), 1_500 + Math.floor(this.rng() * 1_500));
  }

  // ---- peek (vote-share pie)
  private handlePeek(g: TourGame, msg: Msg<'peekSeat'>, err: ErrFn) {
    if (g.status === 'campaign') return err('WRONG_PHASE', 'Vote shares are available once counting has started');
    const d = g.seats[msg.seat];
    const truth = g.trueShares[msg.seat];
    if (!d || !truth) return err('NOT_FOUND', 'That seat has no lead yet');
    let shares = truth;
    if (d.status === 'leading') {
      // a wobbly version of the truth, with the current leader on top (like the real server's estimate)
      const w = Object.entries(truth).map(([id, v]) => [id, v * (0.5 + this.rng())] as const);
      const tot = w.reduce((a, [, v]) => a + v, 0);
      shares = Object.fromEntries(w.map(([id, v]) => [id, Math.round((v / tot) * 1000) / 1000]));
      const top = Math.max(0, ...Object.entries(shares).filter(([id]) => id !== d.playerId).map(([, v]) => v));
      if (!(shares[d.playerId] > top)) shares[d.playerId] = Math.min(1, Math.round((top + 0.01) * 1000) / 1000);
    }
    this.emit({ type: 'seatShares', seat: msg.seat, status: d.status, shares });
  }

  // -------------------------------------------------------------- the count
  /** End the campaign and start the scripted count. It pauses by itself once every seat has its true lead. */
  startCounting() {
    const g = this.g;
    if (!g || g.status !== 'campaign') return;
    const ids = this.ids(g);
    g.status = 'counting';
    // the clocks read 0:00: a practice game has no running time
    const past = Date.now() - 1;
    g.timeline = { ...g.timeline, phaseCloses: [past], campaignEnd: past, countingEnd: past, postCountingEnd: past };
    g.tally = { leads: Object.fromEntries(ids.map(id => [id, 0])), wins: Object.fromEntries(ids.map(id => [id, 0])), declared: 0, total: g.n };
    const margin = (seat: SeatId) => {
      const v = Object.values(g.trueShares[seat]).sort((a, b) => b - a);
      return v[0] - (v[1] ?? 0);
    };
    g.plan = buildReveal(g.truth, ids.length, this.rng, { pauseMs: this.opts.revealMs, resumeMs: this.opts.resumeMs, margin });
    g.planIdx = 0; g.vt = 0; g.lastTick = Date.now(); g.paused = false; g.released = false;
    useTour.getState().setCountPaused(false);
    this.emit({ type: 'status', status: 'counting', timeline: g.timeline });
    this.ticker = setInterval(() => this.tick(), 250);
  }

  private tick() {
    const g = this.g;
    if (!g || g.status !== 'counting' || !g.plan || g.paused) return;
    const now = Date.now();
    g.vt += now - g.lastTick;
    g.lastTick = now;
    const limit = g.released ? g.plan.endMs : g.plan.pauseMs;
    this.revealUpTo(g, Math.min(g.vt, limit));
    if (g.vt < limit) return;
    if (g.released) this.finalize(g);
    else { g.paused = true; useTour.getState().setCountPaused(true); }
  }

  private revealUpTo(g: TourGame, upTo: number) {
    const plan = g.plan!;
    const tally = g.tally!;
    while (g.planIdx < plan.events.length && plan.events[g.planIdx].t <= upTo) {
      const e = plan.events[g.planIdx++];
      const prev = g.seats[e.seat];
      if (prev?.status === 'won') continue;
      const pid = this.pid(e.party);
      if (prev?.status === 'leading') tally.leads[prev.playerId]--;
      let decl: SeatDeclaration;
      if (e.status === 'leading') { tally.leads[pid]++; decl = { seat: e.seat, status: 'leading', playerId: pid }; }
      else { tally.wins[pid]++; tally.declared++; decl = { seat: e.seat, status: 'won', playerId: pid, shares: g.trueShares[e.seat] }; }
      g.seats[e.seat] = decl;
      this.emit({ type: 'seatUpdate', declaration: decl, tally: structuredClone(tally) });
    }
  }

  // ---- coalition
  private seatsOf(g: TourGame, id: PlayerId) { return (g.tally?.wins[id] ?? 0) + (g.tally?.leads[id] ?? 0); }

  private handlePropose(g: TourGame, msg: Msg<'proposeGovernment'>, err: ErrFn) {
    if (g.status !== 'counting') return err('WRONG_PHASE', 'Negotiation opens when counting starts');
    if (g.government) return err('ALREADY_COMMITTED', 'A government is already formed');
    const known = new Set(this.ids(g));
    const pf: PortfolioAssignment = { ...msg.portfolios, PM: [TOUR_ME_ID] };
    const members = new Set<PlayerId>([TOUR_ME_ID]);
    const defs = new Map(g.cfg.points.portfolios.map(d => [d.id, d] as const));
    for (const [pid, holders] of Object.entries(pf)) {
      const def = defs.get(pid);
      if (!def) return err('INVALID_GOVERNMENT', `Unknown portfolio: ${pid}`);
      if (holders.length > def.max) return err('INVALID_GOVERNMENT', `${def.label}: at most ${def.max}`);
      for (const h of holders) { if (!known.has(h)) return err('INVALID_GOVERNMENT', 'Unknown party'); members.add(h); }
    }
    for (const p of msg.partners ?? []) if (known.has(p)) members.add(p);
    if (!leavesPartyOut([...members], this.ids(g))) return err('INVALID_GOVERNMENT', 'At least one party must stay out of the government');
    const combined = [...members].reduce((s, id) => s + this.seatsOf(g, id), 0);
    const maj = majorityOf(g.n);
    if (combined < maj) return err('INVALID_GOVERNMENT', `Combined seats ${combined} are below the majority mark ${maj}`);

    const partners = [...members].filter(id => id !== TOUR_ME_ID);
    const offer: CoalitionOffer = { offerId: this.uid('o'), proposer: TOUR_ME_ID, portfolios: pf, partners, accepted: [], status: 'open', createdAt: Date.now() };
    g.offers.filter(o => o.status === 'open').forEach(o => { o.status = 'superseded'; o.supersededBy = offer.offerId; this.emit({ type: 'offer', offer: o }); });
    g.offers.push(offer);
    this.emit({ type: 'offer', offer });

    // the designer's rule for the practice bots: they all say yes only when ALL the smaller parties are in the offer
    const smalls = this.smallIds(g);
    if (smalls.every(id => partners.includes(id))) {
      partners.forEach((id, i) => this.later(() => {
        if (offer.status !== 'open' || offer.accepted.includes(id)) return;
        offer.accepted.push(id);
        if (offer.partners.every(p => offer.accepted.includes(p))) this.accepted(g, offer);
        else this.emit({ type: 'offer', offer });
      }, 1_000 + i * 350));
    } else {
      const decliner = partners.find(id => smalls.includes(id)) ?? partners[0];
      const withLargest = partners.includes(this.pid(1));
      this.later(() => {
        if (offer.status !== 'open') return;
        offer.status = 'declined';
        offer.declinedBy = decliner;
        this.emit({ type: 'offer', offer });
        this.emit({
          type: 'chat', message: {
            id: this.uid('c'), from: decliner, to: [TOUR_ME_ID], ts: Date.now(),
            text: withLargest
              ? 'We will not sit in a government with the biggest party. Build it without them.'
              : 'We will only join if all of the smaller parties are on board. Count the seats again.',
          },
        });
      }, 1_500);
    }
  }

  /** All partners said yes: the offer waits as 'accepted'; the count resumes and the government is confirmed with the last seat. */
  private accepted(g: TourGame, offer: CoalitionOffer) {
    offer.status = 'accepted';
    this.emit({ type: 'offer', offer });
    g.released = true;
    if (g.paused) {
      g.paused = false;
      g.lastTick = Date.now();
      useTour.getState().setCountPaused(false);
    }
  }

  /** Every seat is declared: confirm the accepted government at once and finish. */
  private finalize(g: TourGame) {
    const o = g.offers.find(x => x.status === 'accepted');
    if (!o || g.government) return;
    o.status = 'formed';
    g.offers.filter(x => x !== o && (x.status === 'open' || x.status === 'accepted')).forEach(x => { x.status = 'superseded'; x.supersededBy = o.offerId; this.emit({ type: 'offer', offer: x }); });
    g.government = governmentFromOffer(o, Date.now(), g.cfg);
    g.status = 'finished';
    g.result = finalResult(g.tally!.wins, g.government, this.ids(g), new Set(), g.cfg, g.n);
    this.emit({ type: 'offer', offer: o });
    this.emit({ type: 'government', government: g.government });
    this.emit({ type: 'status', status: 'finished', timeline: g.timeline });
    this.emit({ type: 'result', result: g.result });
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }

  // -------------------------------------------------------------- for tests and the overlay
  /** The scripted final seats per player id. */
  scriptedTally(): Record<PlayerId, number> | null {
    const g = this.g;
    if (!g) return null;
    const out: Record<PlayerId, number> = Object.fromEntries(this.ids(g).map(id => [id, 0]));
    for (const p of g.truth.values()) out[this.pid(p)]++;
    return out;
  }
  /** The smaller parties' ids (the ones that must all be in the government). */
  smallPartyIds(): PlayerId[] { return this.g ? this.smallIds(this.g) : PARTY_IDS.slice(2); }
}

export { SMALL_PARTIES };
