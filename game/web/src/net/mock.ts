// MOCK backend: simulates the whole game in the browser. Every message is a ServerMessage from protocol.ts,
// so replacing this with the real REST + WebSocket transport requires no UI changes.
// Tunables via URL query: ?campaign=120&counting=60&post=120 (seconds). Defaults: 120 / 60 / 120.
import { AVATARS, DEFAULT_MAP_ID, MAP_MANIFESTS, PARTY_COLOURS, WORLD_CONFIG, leavesPartyOut, majorityOf } from '@hp/shared';
import type {
  MapConfig, Action, AdmissionRequest, AdmitRequest, AnalystReport, ClientMessage, CoalitionOffer, CommittedView, CountTally,
  CreateGameRequest, CreateGameResponse, ErrorCode, FinalResult, GameId, GameMapPackage, GameSnapshot,
  GameStatus, GameTimeline, Government, JoinGameRequest, JoinGameResponse, LobbyView, NewsItem, PartyIdentity,
  PartyRequest, PlayerId, PlayerPublic, PointsBreakdown, PortfolioAssignment, PrivateState, SeatDeclaration,
  SeatId, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';
import { ApiException, type Transport } from './transport';
import { gamePackageUrl, mapDataUrl } from '../map/mapData';
import { mapConfigFor } from '../state/mapConfig';

const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const secs = (k: string, d: number) => { const v = Number(q.get(k)); return (v > 0 ? v : d) * 1000; };
const OPTS = {
  campaignMs: secs('campaign', 120),
  countingMs: secs('counting', 60),
  postCountingMs: secs('post', 120),
  skewMs: 2000, // pretend the server clock is ahead of the browser's, to exercise the offset logic
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / 0.7071; };
const uid = () => Math.random().toString(36).slice(2, 10);
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

type ErrFn = (code: ErrorCode, message: string, clientRef?: string) => void;
type Msg<A extends ClientMessage['action']> = Extract<ClientMessage, { action: A }>;

interface MockPlayer { pub: PlayerPublic; budget: number; bot: boolean; token: string }

const BOT_PARTIES: PartyIdentity[] = [
  { name: 'Lotus Alliance', colour: PARTY_COLOURS[0].hex, symbol: 'sun', avatar: 'mamata' },
  { name: 'Blue Anchor Front', colour: PARTY_COLOURS[1].hex, symbol: 'anchor', avatar: 'macron' },
  { name: 'Green Leaf Movement', colour: PARTY_COLOURS[2].hex, symbol: 'leaf', avatar: 'kim' }, // the AI bot (Meera)
];
const BOT_REPLIES = [
  'Interesting. What portfolios are you thinking of?', 'We could work together if the numbers add up.',
  'I want Finance. Non-negotiable.', 'Let me talk to the others first.', 'Deputy PM and Home, and we have a deal.',
  'Your offer is too thin. Sweeten it.', 'Agreed in principle - send a formal offer.', 'Not before I see the final count.',
];

class MockGame {
  gameId = 'g_' + uid();
  joinCode = 'HP' + Math.random().toString(36).slice(2, 6).toUpperCase();
  phases: number;
  status: GameStatus = 'lobby';
  admissionOpen = true;
  mapId: string;
  /** tuning of THIS game's map */
  cfg: MapConfig;
  players = new Map<PlayerId, MockPlayer>();
  me!: PlayerId;
  botAdmin = false;
  timeline: GameTimeline | null = null;
  actions: Action[] = [];
  news: NewsItem[] = [];
  seatIds: SeatId[] = [];
  seatPhase = new Map<SeatId, number>();
  polledPhases: number[] = [];
  seats: Record<SeatId, SeatDeclaration> = {};
  tally: CountTally | null = null;
  offers: CoalitionOffer[] = [];
  government: Government | null = null;
  result: FinalResult | null = null;
  myReports: AnalystReport[] = [];
  schedule: { t: number; decl: SeatDeclaration }[] = [];
  /** True final shares per seat, set when counting starts (peekSeat shows them for won seats, a wobbly version for leads). */
  trueShares: Record<SeatId, Record<PlayerId, number>> = {};
  botOfferSent = false;
  nextBotRally = 0;
  constructor(phases: number, mapId: string = DEFAULT_MAP_ID) { this.phases = phases; this.mapId = mapId; this.cfg = mapConfigFor(mapId); }
}

export class MockTransport implements Transport {
  private g: MockGame | null = null;
  private onMessage: ((m: ServerMessage) => void) | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  private now = () => Date.now() + OPTS.skewMs;

  // -------------------------------------------------------------- plumbing
  private later(fn: () => void, ms: number) {
    const h = setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
  }
  private emit(m: ServerMessage) {
    const cb = this.onMessage;
    if (cb) { const copy = structuredClone(m); this.later(() => cb(copy), 20); }
  }
  private game(token: string): MockGame {
    if (!this.g || this.g.players.get(this.g.me)?.token !== token) throw new ApiException('UNAUTHORIZED', 'Not in a game');
    return this.g;
  }
  private fail(code: ErrorCode, msg: string): never { throw new ApiException(code, msg); }
  private checkPhases(g: MockGame, phases: number) {
    const { min, max } = g.cfg.phases;
    if (phases < min || phases > max) this.fail('BAD_REQUEST', `Phases must be ${min}-${max}`);
  }
  private reset() {
    this.timers.forEach(clearTimeout); this.timers.clear();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null; this.g = null;
  }

  private publicPlayers(g: MockGame): PlayerPublic[] {
    const me = g.players.get(g.me)!;
    return [...g.players.values()]
      .filter(p => me.pub.isAdmin || p.pub.status !== 'pending' || p.pub.playerId === g.me)
      .map(p => structuredClone(p.pub));
  }
  private snapshot(g: MockGame): GameSnapshot {
    return {
      gameId: g.gameId, mapId: g.mapId, status: g.status, phases: g.phases, timeline: g.timeline,
      players: this.publicPlayers(g), news: [...g.news], polledPhases: [...g.polledPhases], seats: { ...g.seats },
      tally: g.tally, offers: g.offers.filter(o => o.proposer === g.me || o.partners.includes(g.me)),
      government: g.government, result: g.result,
    };
  }
  private priv(g: MockGame): PrivateState {
    return {
      you: g.me, budget: g.players.get(g.me)!.budget,
      myActions: g.actions.filter(a => a.playerId === g.me).map(a => ({ type: a.type, seat: a.seat, ts: a.ts })),
      myReports: [...g.myReports],
      committed: this.committed(g),
    };
  }
  /** Offline demo of committed voters: a strong seat with weaker bands in the seats that follow it (ids are roughly geographic). */
  private committed(g: MockGame): CommittedView[] {
    if (!g.seatIds.length) return [];
    const at = Math.floor(g.seatIds.length / 3);
    const bands = WORLD_CONFIG.committed.bands;
    return bands.flatMap((b, i) => {
      const seat = g.seatIds[at + i];
      return seat === undefined ? [] : [{ seat, band: i + 1, percent: b.percent, level: b.level }];
    });
  }
  private emitPlayers(g: MockGame) { this.emit({ type: 'players', players: this.publicPlayers(g) }); }
  private activePlayers(g: MockGame) { return [...g.players.values()].filter(p => p.pub.status === 'active'); }
  private addBot(g: MockGame, nickname: string, party: PartyIdentity | undefined, status: PlayerPublic['status'], admin = false, kind: PlayerPublic['kind'] = 'human') {
    const id = 'p_' + uid();
    g.players.set(id, { pub: { playerId: id, nickname, isAdmin: admin, kind, party, status }, budget: g.cfg.budget, bot: true, token: '' });
    return id;
  }
  private requireAdmin(g: MockGame) {
    if (!g.players.get(g.me)!.pub.isAdmin) this.fail('FORBIDDEN', 'Admin only');
    return g;
  }

  // -------------------------------------------------------------- REST
  async createGame(req: CreateGameRequest): Promise<CreateGameResponse> {
    this.reset();
    const nick = req.nickname.trim();
    if (!nick) this.fail('BAD_REQUEST', 'Nickname required');
    if (!MAP_MANIFESTS.some(m => m.id === req.mapId)) this.fail('BAD_REQUEST', 'Unknown map');
    const g = new MockGame(req.phases, req.mapId);
    this.checkPhases(g, req.phases);
    const me: MockPlayer = { pub: { playerId: 'p_' + uid(), nickname: nick, isAdmin: true, kind: 'human', status: 'active' }, budget: g.cfg.budget, bot: false, token: 'tok_' + uid() };
    g.me = me.pub.playerId; g.players.set(g.me, me);
    this.addBot(g, 'Asha', BOT_PARTIES[0], 'active');
    this.addBot(g, 'Ravi', BOT_PARTIES[1], 'active');
    this.addBot(g, 'Meera', undefined, 'pending', false, 'agent'); // an AI asking to join (waiting for admission)
    this.g = g;
    this.ticker = setInterval(() => this.tick(), 400);
    return { gameId: g.gameId, joinCode: g.joinCode, playerId: g.me, token: me.token };
  }

  async joinGame(req: JoinGameRequest): Promise<JoinGameResponse> {
    this.reset();
    if (req.joinCode.trim().length < 4) this.fail('NOT_FOUND', 'No game with that code');
    const nick = req.nickname.trim();
    if (!nick) this.fail('BAD_REQUEST', 'Nickname required');
    const g = new MockGame(mapConfigFor(DEFAULT_MAP_ID).phases.default);
    g.joinCode = req.joinCode.trim().toUpperCase(); g.botAdmin = true;
    this.addBot(g, 'Asha', BOT_PARTIES[0], 'active', true);
    this.addBot(g, 'Ravi', BOT_PARTIES[1], 'active');
    this.addBot(g, 'Meera', BOT_PARTIES[2], 'active', false, 'agent');
    const me: MockPlayer = { pub: { playerId: 'p_' + uid(), nickname: nick, isAdmin: false, kind: 'human', status: 'pending' }, budget: g.cfg.budget, bot: false, token: 'tok_' + uid() };
    g.me = me.pub.playerId; g.players.set(g.me, me);
    this.g = g;
    this.ticker = setInterval(() => this.tick(), 400);
    // the bot admin admits you after a moment
    this.later(() => { me.pub.status = 'active'; this.emitPlayers(g); }, 2500);
    return { gameId: g.gameId, playerId: g.me, token: me.token, status: 'pending' };
  }

  async getLobby(_gameId: GameId, token: string): Promise<LobbyView> {
    const g = this.game(token);
    return {
      gameId: g.gameId, joinCode: g.joinCode, mapId: g.mapId, phases: g.phases, status: g.status,
      admissionOpen: g.admissionOpen, you: g.me, players: this.publicPlayers(g),
    };
  }

  async admit(_id: GameId, token: string, req: AdmitRequest): Promise<void> {
    const g = this.requireAdmin(this.game(token));
    const p = g.players.get(req.playerId);
    if (!p) this.fail('NOT_FOUND', 'No such player');
    if (req.admit) {
      p.pub.status = 'active';
      if (p.bot && !p.pub.party) this.later(() => {
        const used = new Set([...g.players.values()].map(o => o.pub.party?.avatar));
        p.pub.party = { ...BOT_PARTIES[2], avatar: used.has(BOT_PARTIES[2].avatar) ? AVATARS.find(a => !used.has(a.id))?.id : BOT_PARTIES[2].avatar };
        this.emitPlayers(g);
      }, 1500);
    } else p.pub.status = 'rejected';
    this.emitPlayers(g);
  }
  async setAdmission(_id: GameId, token: string, req: AdmissionRequest) { this.requireAdmin(this.game(token)).admissionOpen = req.open; }
  async setSettings(_id: GameId, token: string, req: SettingsRequest) {
    const g = this.requireAdmin(this.game(token));
    if (g.status !== 'lobby') this.fail('WRONG_PHASE', 'Game already started');
    this.checkPhases(g, req.phases);
    g.phases = req.phases;
  }
  async setParty(_id: GameId, token: string, req: PartyRequest) {
    const g = this.game(token);
    const p = req.party;
    if (!p.name.trim()) this.fail('BAD_REQUEST', 'Party name required');
    if (p.avatar !== undefined && !AVATARS.some(a => a.id === p.avatar)) this.fail('BAD_REQUEST', 'Unknown avatar');
    for (const o of g.players.values()) {
      if (o.pub.playerId === g.me || !o.pub.party || o.pub.status === 'rejected') continue;
      if (o.pub.party.colour.toLowerCase() === p.colour.toLowerCase()) this.fail('COLOUR_TAKEN', 'That colour is taken');
      if (o.pub.party.symbol === p.symbol) this.fail('SYMBOL_TAKEN', 'That symbol is taken');
      if (p.avatar && o.pub.party.avatar === p.avatar) this.fail('AVATAR_TAKEN', 'That avatar is taken');
      if (o.pub.party.name.toLowerCase() === p.name.trim().toLowerCase()) this.fail('NAME_TAKEN', 'That party name is taken');
    }
    g.players.get(g.me)!.pub.party = { ...p, name: p.name.trim() };
    this.emitPlayers(g);
    if (g.botAdmin && g.status === 'lobby') this.later(() => { void this.doStart(g).catch(() => undefined); }, 4000); // joined games are started by the bot admin
  }
  async start(_id: GameId, token: string): Promise<StartResponse> {
    return this.doStart(this.requireAdmin(this.game(token)));
  }

  // -------------------------------------------------------------- game start
  private async loadSeats(g: MockGame) {
    let ids: SeatId[] = [];
    let groups: SeatId[][] | undefined;
    try {
      const r = await fetch(gamePackageUrl(g.mapId));
      if (r.ok) {
        const pkg = (await r.json()) as GameMapPackage;
        ids = pkg.seats.map(s => s.id);
        groups = pkg.phaseGroups[String(g.phases)];
      }
    } catch { /* package missing: fall back below */ }
    if (!ids.length) {
      try { ids = ((await (await fetch(mapDataUrl(g.mapId, 'seats.json'))).json()) as { id: number }[]).map(s => s.id); } catch { /* ignore */ }
    }
    if (!ids.length) ids = Array.from({ length: g.cfg.seatCount }, (_, i) => i + 1);
    ids.sort((a, b) => a - b);
    if (!groups || groups.length !== g.phases) {
      const gs: SeatId[][] = Array.from({ length: g.phases }, () => []);
      ids.forEach((id, i) => gs[Math.floor((i * g.phases) / ids.length)].push(id));
      groups = gs;
    }
    g.seatIds = ids;
    groups.forEach((grp, ph) => grp.forEach(id => g.seatPhase.set(id, ph)));
  }

  private async doStart(g: MockGame): Promise<StartResponse> {
    if (g.status !== 'lobby') this.fail('WRONG_PHASE', 'Already started');
    const act = this.activePlayers(g);
    if (act.length < g.cfg.players.min) this.fail('NOT_ENOUGH_PLAYERS', `Need at least ${g.cfg.players.min} active players`);
    if (act.some(p => !p.pub.party)) this.fail('BAD_REQUEST', 'Every active player needs a party first');
    if (act.some(p => !p.pub.party?.avatar)) this.fail('BAD_REQUEST', 'Every active player needs an avatar first');
    g.status = 'campaign'; // reserve against double starts while seats load
    await this.loadSeats(g);
    for (const p of g.players.values()) if (p.pub.status === 'pending') p.pub.status = 'rejected';
    const start = this.now();
    // exactly 2 players: shorter counting (as the real server); the ?counting= tunable only ever shortens it
    const countingMs = act.length === 2 ? Math.min(OPTS.countingMs, g.cfg.durations.countingMsTwoPlayers) : OPTS.countingMs;
    const closes = Array.from({ length: g.phases }, (_, i) => Math.round(start + (OPTS.campaignMs * (i + 1)) / g.phases));
    g.timeline = {
      campaignStart: start, phaseCloses: closes, campaignEnd: closes[closes.length - 1],
      countingEnd: closes[closes.length - 1] + countingMs,
      postCountingEnd: closes[closes.length - 1] + countingMs + OPTS.postCountingMs,
    };
    g.nextBotRally = start + 1500;
    this.emit({ type: 'status', status: 'campaign', timeline: g.timeline });
    this.emitPlayers(g);
    this.emit({ type: 'private', private: this.priv(g) });
    return { ok: true, timeline: g.timeline };
  }

  // -------------------------------------------------------------- WebSocket
  connect(gameId: GameId, token: string, onMessage: (m: ServerMessage) => void) {
    const g = this.game(token);
    if (g.gameId !== gameId) throw new ApiException('NOT_FOUND', 'Unknown game');
    this.onMessage = onMessage;
    this.emit({ type: 'hello', serverTime: this.now(), snapshot: this.snapshot(g), private: this.priv(g) });
  }
  disconnect() { this.onMessage = null; this.reset(); }

  send(msg: ClientMessage) {
    const g = this.g;
    if (!g) return;
    const err: ErrFn = (error, message, clientRef) => this.emit({ type: 'error', error, message, clientRef });
    switch (msg.action) {
      case 'ping': this.emit({ type: 'pong', clientTime: msg.clientTime, serverTime: this.now() }); break;
      case 'campaign': this.handleCampaign(g, msg, err); break;
      case 'buyReport': this.handleReport(g, msg, err); break;
      case 'peekSeat': this.handlePeek(g, msg, err); break;
      case 'chat': this.handleChat(g, msg, err); break;
      case 'proposeGovernment': this.handlePropose(g, msg, err); break;
      case 'respondOffer': this.handleRespond(g, msg, err); break;
      case 'withdrawOffer': {
        const o = g.offers.find(x => x.offerId === msg.offerId && x.proposer === g.me && x.status === 'open');
        if (!o) return err('OFFER_NOT_FOUND', 'No such open offer');
        o.status = 'withdrawn'; this.emit({ type: 'offer', offer: o });
        break;
      }
    }
  }

  private handlePeek(g: MockGame, msg: Msg<'peekSeat'>, err: ErrFn) {
    if (g.status === 'lobby' || g.status === 'campaign') return err('WRONG_PHASE', 'Vote shares are available once counting has started');
    if (typeof msg.seat !== 'number' || !g.seatPhase.has(msg.seat)) return err('BAD_REQUEST', 'Unknown seat');
    const d = g.seats[msg.seat], truth = g.trueShares[msg.seat];
    if (!d || !truth) return err('NOT_FOUND', 'That seat has no lead yet');
    let shares = truth;
    if (d.status === 'leading') {
      // wobble the true shares and keep the party shown as leading on top (like the real server's estimate)
      const w = Object.entries(truth).map(([id, v]) => [id, v * (0.5 + Math.random())] as const);
      const tot = w.reduce((a, [, v]) => a + v, 0);
      shares = Object.fromEntries(w.map(([id, v]) => [id, Math.round((v / tot) * 1000) / 1000]));
      const top = Math.max(0, ...Object.entries(shares).filter(([id]) => id !== d.playerId).map(([, v]) => v));
      if (!(shares[d.playerId] > top)) shares[d.playerId] = Math.min(1, Math.round((top + 0.01) * 1000) / 1000);
    }
    this.emit({ type: 'seatShares', seat: msg.seat, status: d.status, shares });
  }

  private handleCampaign(g: MockGame, msg: Msg<'campaign'>, err: ErrFn) {
    const me = g.players.get(g.me)!;
    if (g.status !== 'campaign') return err('WRONG_PHASE', 'The campaign is not running', msg.clientRef);
    const ph = g.seatPhase.get(msg.seat);
    if (ph === undefined) return err('BAD_REQUEST', 'Unknown seat', msg.clientRef);
    if (g.polledPhases.includes(ph) || this.now() >= g.timeline!.phaseCloses[ph]) return err('SEAT_POLLED', 'That seat has already polled', msg.clientRef);
    const cost = g.cfg.costs[msg.type];
    if (me.budget < cost) return err('INSUFFICIENT_FUNDS', 'Not enough funds', msg.clientRef);
    me.budget -= cost;
    const a: Action = { id: uid(), playerId: g.me, type: msg.type, seat: msg.seat, ts: this.now() };
    g.actions.push(a);
    this.emit({ type: 'actionAck', clientRef: msg.clientRef, ok: true, budget: me.budget });
    this.emit({ type: 'private', private: this.priv(g) });
    if (msg.type === 'rally') this.publishRally(g, a);
  }
  private publishRally(g: MockGame, a: Action) {
    const item: NewsItem = { playerId: a.playerId, seat: a.seat, ts: a.ts };
    g.news.push(item);
    this.emit({ type: 'news', item });
  }

  // ---- analyst
  private price(curve: { start: number; end: number }, g: MockGame) {
    const t = g.timeline!;
    const f = Math.min(1, Math.max(0, (this.now() - t.campaignStart) / (t.campaignEnd - t.campaignStart)));
    return Math.round(curve.start + (curve.end - curve.start) * f);
  }
  private weights(g: MockGame, seat: SeatId, upTo: number): Map<PlayerId, number> {
    const w = new Map<PlayerId, number>();
    for (const p of this.activePlayers(g)) {
      let v = 0.6 + 0.8 * hash01(p.pub.playerId + ':' + seat);
      for (const a of g.actions) {
        if (a.playerId !== p.pub.playerId || a.ts > upTo) continue;
        if (a.type === 'rally') v += (a.seat === seat ? 1.0 : 0) + 0.01;
        else if (a.seat === seat) v += 1.5;
      }
      w.set(p.pub.playerId, v);
    }
    return w;
  }
  private handleReport(g: MockGame, msg: Msg<'buyReport'>, err: ErrFn) {
    const me = g.players.get(g.me)!;
    if (g.status !== 'campaign') return err('WRONG_PHASE', 'Reports are sold during the campaign only');
    if (msg.scope === 'seat' && (msg.seat === undefined || !g.seatPhase.has(msg.seat))) return err('BAD_REQUEST', 'Pick a seat for a seat report');
    const price = this.price(msg.scope === 'seat' ? g.cfg.analyst.seatReport : g.cfg.analyst.globalReport, g);
    if (me.budget < price) return err('INSUFFICIENT_FUNDS', 'Not enough funds for this report');
    me.budget -= price;
    const asOf = this.now() - g.cfg.analyst.delayMs;
    const noise = g.cfg.analyst.noise, mf = g.cfg.analyst.marginFactor;
    let entries: AnalystReport['entries'];
    if (msg.scope === 'seat') {
      const w = this.weights(g, msg.seat!, asOf);
      const tot = [...w.values()].reduce((a, b) => a + b, 0);
      // seat report: vote share as a fraction 0..1
      entries = [...w.entries()].map(([playerId, v]) => ({
        playerId, rank: 0, estimate: Math.max(0.01, v / tot + gauss() * noise * 0.5), margin: noise * mf * 0.5 + 0.01,
      }));
    } else {
      const seats = new Map<PlayerId, number>();
      for (const id of g.seatIds) {
        const w = this.weights(g, id, asOf);
        const best = [...w.entries()].sort((a, b) => b[1] - a[1])[0][0];
        seats.set(best, (seats.get(best) ?? 0) + 1);
      }
      // global report: estimated seats
      entries = this.activePlayers(g).map(p => {
        const t = seats.get(p.pub.playerId) ?? 0;
        return { playerId: p.pub.playerId, rank: 0, estimate: Math.max(0, Math.round(t * (1 + gauss() * noise))), margin: Math.round(Math.max(t, 20) * noise * mf) };
      });
    }
    entries.sort((a, b) => b.estimate - a.estimate).forEach((e, i) => (e.rank = i + 1));
    const report: AnalystReport = { scope: msg.scope, seat: msg.seat, asOf, purchasedAt: this.now(), price, entries };
    g.myReports.push(report);
    this.emit({ type: 'report', report, budget: me.budget });
  }

  private noNegotiation(g: MockGame) { return [...g.players.values()].filter(p => p.pub.status !== 'pending' && p.pub.status !== 'rejected').length < 3; }

  // ---- chat
  private handleChat(g: MockGame, msg: Msg<'chat'>, err: ErrFn) {
    const early = g.status === 'campaign' && g.cfg.messaging.opensAt === 'campaign';
    if (!early && g.status !== 'counting' && g.status !== 'postCounting') return err('WRONG_PHASE', 'Chat opens when ' + (g.cfg.messaging.opensAt === 'campaign' ? 'the campaign' : 'counting') + ' starts');
    if (this.noNegotiation(g)) return err('NEGOTIATION_DISABLED', '2-player game: no chat');
    const group = g.cfg.messaging.mode === 'group';
    const everyone = [...g.players.values()].filter(p => p.pub.status !== 'pending' && p.pub.status !== 'rejected').map(p => p.pub.playerId).filter(id => id !== g.me);
    const to = group ? everyone : (msg.to ?? []).filter(id => g.players.has(id) && id !== g.me);
    if (!to.length || !msg.text.trim()) return err('BAD_REQUEST', 'Pick recipients and write something');
    this.emit({ type: 'chat', message: { id: uid(), from: g.me, to, text: msg.text.trim().slice(0, 500), ts: this.now() } });
    // group chat: one random bot answers everybody; threads: every bot recipient answers
    const repliers = group ? [pick(to.filter(id => g.players.get(id)!.bot))].filter(Boolean) : to;
    for (const id of repliers) {
      if (!g.players.get(id)!.bot) continue;
      this.later(() => this.emit({
        type: 'chat', message: { id: uid(), from: id, to: [g.me, ...to.filter(x => x !== id)], text: pick(BOT_REPLIES), ts: this.now() },
      }), rnd(1500, 3500));
    }
  }

  // ---- coalition
  private seatsOf(g: MockGame, id: PlayerId): number {
    return (g.tally?.wins[id] ?? 0) + (g.tally?.leads[id] ?? 0);
  }
  private handlePropose(g: MockGame, msg: Msg<'proposeGovernment'>, err: ErrFn) {
    if (g.status !== 'counting' && g.status !== 'postCounting') return err('WRONG_PHASE', 'Negotiation opens when counting starts');
    if (this.noNegotiation(g)) return err('NEGOTIATION_DISABLED', '2-player game: no coalition-building');
    if (g.government) return err('ALREADY_COMMITTED', 'A government is already formed');
    const pf: PortfolioAssignment = { ...msg.portfolios, PM: [g.me] };
    const members = new Set<PlayerId>([g.me]);
    for (const def of g.cfg.points.portfolios) {
      const holders = pf[def.id] ?? [];
      if (holders.length > def.max) return err('INVALID_GOVERNMENT', `${def.label}: at most ${def.max}`);
      holders.forEach(h => { if (g.players.get(h)?.pub.status === 'active') members.add(h); });
    }
    (msg.partners ?? []).forEach(p => { if (g.players.get(p)?.pub.status === 'active') members.add(p); });
    if (!leavesPartyOut([...members], this.activePlayers(g).map(p => p.pub.playerId))) return err('INVALID_GOVERNMENT', 'At least one party must stay out of the government');
    const combined = [...members].reduce((s, id) => s + this.seatsOf(g, id), 0);
    const maj = majorityOf(g.cfg.seatCount);
    if (combined < maj) return err('INVALID_GOVERNMENT', `Combined seats ${combined} are below the majority mark ${maj}`);
    const partners = [...members].filter(id => id !== g.me);
    const offer: CoalitionOffer = { offerId: uid(), proposer: g.me, portfolios: pf, partners, accepted: [], status: 'open', createdAt: this.now() };
    g.offers.filter(o => o.proposer === g.me && o.status === 'open').forEach(o => { o.status = 'superseded'; o.supersededBy = offer.offerId; this.emit({ type: 'offer', offer: o }); });
    g.offers.push(offer);
    this.emit({ type: 'offer', offer });
    for (const id of partners) {
      if (!g.players.get(id)!.bot) continue;
      const holds = Object.values(pf).some(h => h.includes(id));
      this.later(() => {
        if (offer.status !== 'open') return;
        if (Math.random() < (holds ? 0.8 : 0.4)) { offer.accepted.push(id); this.checkFormed(g, offer); }
        else { offer.status = 'declined'; offer.declinedBy = id; this.emit({ type: 'offer', offer }); }
      }, rnd(2000, 5000));
    }
  }
  private handleRespond(g: MockGame, msg: Msg<'respondOffer'>, err: ErrFn) {
    const o = g.offers.find(x => x.offerId === msg.offerId);
    if (!o || o.status !== 'open' || !o.partners.includes(g.me)) return err('OFFER_NOT_FOUND', 'That offer is no longer open');
    if (g.government) return err('ALREADY_COMMITTED', 'A government is already formed');
    if (!msg.accept) { o.status = 'declined'; o.declinedBy = g.me; this.emit({ type: 'offer', offer: o }); return; }
    if (!o.accepted.includes(g.me)) o.accepted.push(g.me);
    for (const id of o.partners) {
      if (id === g.me || o.accepted.includes(id) || !g.players.get(id)?.bot) continue;
      this.later(() => {
        if (o.status !== 'open' || o.accepted.includes(id)) return;
        o.accepted.push(id); this.checkFormed(g, o);
      }, rnd(1500, 3500));
    }
    this.checkFormed(g, o);
  }
  /** All partners accepted: the offer waits as 'accepted'; the government is confirmed only once every seat is declared. */
  private checkFormed(g: MockGame, o: CoalitionOffer) {
    if (o.status !== 'open' || g.government) return;
    if (!o.partners.every(p => o.accepted.includes(p))) { this.emit({ type: 'offer', offer: o }); return; }
    o.status = 'accepted';
    this.emit({ type: 'offer', offer: o });
    if (g.status === 'postCounting') this.confirmAccepted(g);
  }
  /** Confirms an accepted offer whose members hold a majority of WON seats (all seats are declared) and finishes the game. */
  private confirmAccepted(g: MockGame): boolean {
    if (g.result || g.government) return false;
    const maj = majorityOf(g.cfg.seatCount);
    const o = g.offers.find(x => x.status === 'accepted' && [x.proposer, ...x.partners].reduce((s, id) => s + (g.tally?.wins[id] ?? 0), 0) >= maj);
    if (!o) return false;
    o.status = 'formed';
    g.offers.filter(x => x !== o && (x.status === 'open' || x.status === 'accepted')).forEach(x => { x.status = 'superseded'; x.supersededBy = o.offerId; this.emit({ type: 'offer', offer: x }); });
    g.government = { pm: o.proposer, members: [o.proposer, ...o.partners], portfolios: o.portfolios, formedAt: this.now(), viaNegotiation: true };
    this.emit({ type: 'offer', offer: o });
    this.emit({ type: 'government', government: g.government });
    this.finish(g, 'coalition');
    return true;
  }
  private botOffer(g: MockGame) {
    const act = this.activePlayers(g);
    const proposer = act.find(p => p.bot);
    if (!proposer) return;
    const pf: PortfolioAssignment = { PM: [proposer.pub.playerId], DPM: [g.me] };
    const others = act.filter(p => p.pub.playerId !== proposer.pub.playerId && p.pub.playerId !== g.me);
    const ids = ['HOME', 'FINANCE', 'DEFENCE', 'EXTERNAL'];
    others.forEach((p, i) => { const k = ids[i % ids.length]; pf[k] = [...(pf[k] ?? []), p.pub.playerId]; });
    const offer: CoalitionOffer = {
      offerId: uid(), proposer: proposer.pub.playerId, portfolios: pf,
      partners: [g.me, ...others.map(p => p.pub.playerId)], accepted: others.map(p => p.pub.playerId), status: 'open', createdAt: this.now(),
    };
    g.offers.push(offer);
    this.emit({ type: 'offer', offer });
  }

  // -------------------------------------------------------------- simulation tick
  private tick() {
    const g = this.g;
    if (!g || !g.timeline) return;
    const now = this.now(), t = g.timeline;
    if (g.status === 'campaign' && g.seatIds.length) {
      t.phaseCloses.forEach((c, ph) => {
        if (now >= c && !g.polledPhases.includes(ph)) {
          g.polledPhases.push(ph);
          this.emit({ type: 'phaseClosed', phase: ph, seats: g.seatIds.filter(id => g.seatPhase.get(id) === ph) });
        }
      });
      this.botCampaign(g, now);
      if (now >= t.campaignEnd) this.beginCounting(g);
    } else if (g.status === 'counting' || g.status === 'postCounting') {
      this.reveal(g, now);
      if (g.status === 'counting' && now >= t.countingEnd) this.endCounting(g);
      if (g.status === 'counting' && !g.botOfferSent && now > t.campaignEnd + (t.countingEnd - t.campaignEnd) * 0.45) { g.botOfferSent = true; this.botOffer(g); }
      if (g.status === 'postCounting' && !g.result) {
        if (this.confirmAccepted(g)) { /* finished */ }
        else if (now >= t.postCountingEnd) this.finish(g, 'noGovernment');
      }
    }
  }
  private botCampaign(g: MockGame, now: number) {
    if (now < g.nextBotRally) return;
    g.nextBotRally = now + rnd(1500, 5000);
    const bots = this.activePlayers(g).filter(p => p.bot);
    if (!bots.length) return;
    const bot = pick(bots);
    const open = g.seatIds.filter(id => !g.polledPhases.includes(g.seatPhase.get(id)!));
    if (!open.length) return;
    const type = Math.random() < 0.75 ? 'rally' : 'roadshow';
    if (bot.budget < g.cfg.costs[type]) return;
    bot.budget -= g.cfg.costs[type];
    const a: Action = { id: uid(), playerId: bot.pub.playerId, type, seat: pick(open), ts: now };
    g.actions.push(a);
    if (type === 'rally') this.publishRally(g, a);
  }

  private beginCounting(g: MockGame) {
    g.status = 'counting';
    const act = this.activePlayers(g).map(p => p.pub.playerId);
    const C = g.timeline!.countingEnd - g.timeline!.campaignEnd, start = g.timeline!.campaignEnd;
    const cc = g.cfg.counting;
    g.tally = { leads: Object.fromEntries(act.map(id => [id, 0])), wins: Object.fromEntries(act.map(id => [id, 0])), declared: 0, total: g.seatIds.length };
    g.schedule = [];
    g.trueShares = {};
    // Per seat: true shares and winner, plus a noisy lead that is re-guessed every epoch (noise decays with time).
    const seatInfo = g.seatIds.map(seat => {
      const w = this.weights(g, seat, Infinity);
      for (const [id, v] of w) w.set(id, v * (0.85 + Math.random() * 0.3)); // random swing
      const tot = [...w.values()].reduce((a, b) => a + b, 0);
      const shares: Record<PlayerId, number> = {};
      w.forEach((v, id) => (shares[id] = v / tot));
      const sorted = Object.entries(shares).sort((a, b) => b[1] - a[1]);
      const margin = sorted[0][1] - (sorted[1]?.[1] ?? 0);
      g.trueShares[seat] = shares;
      return { seat, shares, winner: sorted[0][0], key: margin + cc.winJitter * Math.random() };
    });
    // confirm safest seats first (margin + jitter), spread evenly over [winStart, 1] of the time, last seat at the very end
    const byWin = seatInfo.sort((a, b) => b.key - a.key);
    const epoch = cc.leadNoiseEpochFraction * C;
    byWin.forEach((si, i) => {
      const f = byWin.length > 1 ? cc.winStartFraction + (i / (byWin.length - 1)) * (1 - cc.winStartFraction) : 1;
      const wonAt = f * C;
      let current: PlayerId | null = null;
      // first lead somewhere before allLeadsByFraction, then a fresh guess each epoch; noise reaches 0 before the win
      for (let t = rnd(0.02, cc.allLeadsByFraction) * C; t < wonAt - epoch; t += epoch) {
        const sigma = cc.leadNoiseStart * Math.pow(1 - t / C, cc.leadNoiseExponent) * Math.min(1, (wonAt - epoch - t) / epoch);
        let best = si.winner, bestScore = -Infinity;
        for (const [id, sh] of Object.entries(si.shares)) { const sc = sh * Math.exp(sigma * gauss()); if (sc > bestScore) { bestScore = sc; best = id; } }
        if (best !== current) { g.schedule.push({ t: start + t, decl: { seat: si.seat, status: 'leading', playerId: best } }); current = best; }
      }
      if (current !== si.winner) g.schedule.push({ t: start + wonAt - epoch / 2, decl: { seat: si.seat, status: 'leading', playerId: si.winner } });
      g.schedule.push({ t: start + wonAt, decl: { seat: si.seat, status: 'won', playerId: si.winner, shares: si.shares } });
    });
    g.schedule.sort((a, b) => b.t - a.t); // pop from the end
    this.emit({ type: 'status', status: 'counting', timeline: g.timeline });
  }
  private reveal(g: MockGame, now: number) {
    while (g.schedule.length && g.schedule[g.schedule.length - 1].t <= now) {
      const { decl } = g.schedule.pop()!;
      const tally = g.tally!;
      const prev = g.seats[decl.seat];
      if (prev?.status === 'leading') tally.leads[prev.playerId]--;
      if (decl.status === 'leading') tally.leads[decl.playerId]++;
      else { tally.wins[decl.playerId]++; tally.declared++; }
      g.seats[decl.seat] = decl;
      this.emit({ type: 'seatUpdate', declaration: decl, tally: tally });
    }
  }
  private endCounting(g: MockGame) {
    this.reveal(g, Infinity);
    g.status = 'postCounting';
    this.emit({ type: 'status', status: 'postCounting', timeline: g.timeline });
    const wins = Object.entries(g.tally!.wins).sort((a, b) => b[1] - a[1]);
    if (wins[0][1] >= majorityOf(g.cfg.seatCount) && !g.government) this.finish(g, 'majority');
    else if (wins.length > 1 && wins[0][1] === wins[1][1]) this.finish(g, 'draw');
    else this.confirmAccepted(g);
  }
  private finish(g: MockGame, outcome: FinalResult['outcome']) {
    const wins = g.tally!.wins;
    const ids = Object.keys(wins);
    const N = g.cfg.seatCount;
    let gov = g.government;
    if (outcome === 'majority') {
      const top = Object.entries(wins).sort((a, b) => b[1] - a[1])[0][0];
      gov = { pm: top, members: [top], portfolios: Object.fromEntries(g.cfg.points.portfolios.map(p => [p.id, [top]])), formedAt: this.now(), viaNegotiation: false };
    }
    if (outcome === 'draw' || outcome === 'noGovernment') gov = null;
    const points: PointsBreakdown[] = ids.map(id => {
      if (!gov || !gov.members.includes(id)) return { playerId: id, portfolioPoints: 0, seatPoints: 0, governmentFloor: 0, total: g.cfg.points.opposition };
      let pp = 0;
      for (const def of g.cfg.points.portfolios) if (gov.portfolios[def.id]?.includes(id)) pp += def.points;
      const sp = Math.round((g.cfg.points.seatMultiplier * wins[id]) / N);
      return { playerId: id, portfolioPoints: pp, seatPoints: sp, governmentFloor: g.cfg.points.governmentFloor, total: pp + sp + g.cfg.points.governmentFloor };
    });
    let winners: PlayerId[] = [];
    if (outcome === 'majority') winners = [gov!.pm];
    else if (outcome === 'draw') winners = Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
    else if (outcome === 'coalition') { const m = Math.max(...points.map(p => p.total)); winners = points.filter(p => p.total === m).map(p => p.playerId); }
    g.government = gov;
    g.status = 'finished';
    g.result = { outcome, tally: { ...wins }, government: gov, points, winners };
    if (outcome === 'majority') this.emit({ type: 'government', government: gov! });
    this.emit({ type: 'status', status: 'finished', timeline: g.timeline });
    this.emit({ type: 'result', result: g.result });
  }
}
