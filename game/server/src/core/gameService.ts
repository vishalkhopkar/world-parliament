// All game logic. Depends only on the interfaces in ./types (no AWS SDK imports).
import {
  AVATARS, DEFAULT_MAP_ID, buildGlobalReports, newsSampleTimes, PARTY_COLOURS, PARTY_SYMBOLS, analystPrice, analystReport, buildTimeline, committedMatrix, committedView, dealCommitted, computeEffects, reputationView, countingMsFor, postCountingMsFor, createRng,
  chatModeFor, finalResult, governmentFromOffer, leavesPartyOut, logOfferEvent, majorityGovernment, majorityOf, phaseOfSeat, pollSeats, rallyAvailableAt,
  removePlayerFromResults, validateGovernment,
} from '@hp/shared';
import { channelOf, findMentions } from '@hp/chat/common';
import type {
  Action, AdmissionRequest, AdmitRequest, ChatMessage, ClientMessage, CoalitionOffer, CountTally,
  CreateGameRequest, CreateGameResponse, GameSnapshot, GlobalReports, JoinGameRequest, JoinGameResponse, LobbyView, MapConfig,
  PartyIdentity, PartyRequest, PlayerId, PlayerPublic, PortfolioAssignment, PrivateState, SeatDeclaration, SeatId,
  SeatResult, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';
import { createHash } from 'node:crypto';
import { declaredState, diffDeclarations, fullTally, makePlan, seatSharesAt, stepAt, stepTime } from './counting';
import type {
  Clock, CountPlan, GameRecord, LoadedMap, MapProvider, Notifier, PlayerRecord, Repo, Scheduler,
} from './types';
import { GameError } from './types';
import { buildElectionCsv, electionReportName } from './reportSink';
import type { ReportSink } from './reportSink';
import { cleanText, hashToken, newId, newJoinCode, newToken, randomInt, uniq } from './util';

/** Server epoch ms of the player's next allowed rally; null = never rallied (a rally is allowed now). */
function nextRallyAt(p: Pick<PlayerRecord, 'lastRallyAt'> | null | undefined, cfg: MapConfig): number | null {
  return p?.lastRallyAt === undefined ? null : rallyAvailableAt(p.lastRallyAt, cfg);
}

/** RATE_LIMITED for a rally inside the cooldown; retryAt = the next allowed rally time. */
function rallyCooldown(at: number, now: number, cfg: MapConfig): GameError {
  const wait = Math.max(1, Math.ceil((at - now) / 1000));
  return new GameError('RATE_LIMITED', `Next rally in ${wait} s (rallies must be at least ${Math.round(cfg.cooldowns.rallyMs / 1000)} s apart)`, at);
}

export interface GameServiceDeps {
  repo: Repo;
  notifier: Notifier;
  scheduler: Scheduler;
  clock: Clock;
  maps: MapProvider;
  /** Receives the per-seat election CSV when a game finishes. Default: discard. */
  reportSink?: ReportSink;
  /** Lead-in between /start and campaign start. Default 5000 ms. */
  startDelayMs?: number;
}

const LIVE: ReadonlySet<string> = new Set(['campaign', 'counting', 'postCounting']);
const CONTENDER: ReadonlySet<string> = new Set(['active', 'disconnected']);
/** Players who are part of the game (not pending/rejected). */
/** Negotiation (chat + coalition offers) needs at least this many players who started the game. */
const MIN_NEGOTIATION_PLAYERS = 3;
const MEMBER: ReadonlySet<string> = new Set(['active', 'disconnected', 'eliminated']);

/** `count` distinct random candidates.csv columns out of 0..columns-1 (partial Fisher-Yates with the OS CSPRNG). */
export function dealCandidateColumns(count: number, columns: number): number[] {
  if (count > columns) throw new GameError('GAME_FULL', 'Not enough candidate columns for every player');
  const pool = Array.from({ length: columns }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + randomInt(columns - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function toPublic(p: PlayerRecord): PlayerPublic {
  const out: PlayerPublic = { playerId: p.playerId, nickname: p.nickname, isAdmin: p.isAdmin, kind: p.kind ?? 'human', status: p.status };
  if (p.party) out.party = p.party;
  return out;
}

/** Canonical hex of a PARTY_COLOURS entry (accepts the hex, or for leniency the id); '' if unknown. */
const colourKey = (c: string): string => {
  const lc = c.trim().toLowerCase();
  const hit = PARTY_COLOURS.find((x) => x.hex.toLowerCase() === lc || x.id === lc);
  return hit ? hit.hex : '';
};

/** Games whose latest global reports are kept in memory (oldest dropped first). */
const NEWS_CACHE_GAMES = 200;

export class GameService {
  constructor(private readonly d: GameServiceDeps) {}

  /** Latest global reports per game with the key of the inputs they were built from (see globalReports). */
  private readonly newsCache = new Map<string, { key: string; reports: GlobalReports }>();
  /** How many times global reports were really built (not served from the cache); read by tests and diagnostics. */
  newsBuilds = 0;

  private now(): number { return this.d.clock.now(); }
  private get repo(): Repo { return this.d.repo; }

  // ------------------------------------------------------------------ helpers
  private loadMap(mapId: string): LoadedMap {
    const m = this.d.maps(mapId);
    if (!m) throw new GameError('BAD_REQUEST', `Unknown map: ${mapId}`);
    return m;
  }

  /**
   * Deal this player's committed voters once (idempotent), against the sets already dealt to the other contenders so the
   * per-seat cap sees them. `committedSeq` is bumped under a condition first, so concurrent deals retry on a fresh view.
   * Every successful bump is followed by one player's `committed` write: a view with fewer dealt players than committedSeq
   * catches another deal between its two writes, so wait for it (bounded, in case that deal died in between).
   */
  private async dealCommittedFor(gameId: string, playerId: PlayerId): Promise<void> {
    for (let attempt = 0, waits = 0; attempt < 10; attempt++) {
      const game = await this.loadGame(gameId);
      const me = await this.repo.getPlayer(gameId, playerId);
      if (!me || me.committed || game.status !== 'lobby') return;
      const { map, cfg, kernels } = this.loadMap(game.mapId);
      const players = await this.repo.listPlayers(gameId);
      if (players.filter((p) => p.committed).length < (game.committedSeq ?? 0) && waits++ < 20) {
        await new Promise((r) => setTimeout(r, 25));
        attempt--;
        continue;
      }
      const others = players.filter((p) => p.playerId !== playerId && CONTENDER.has(p.status) && p.committed).map((p) => p.committed!);
      const seq = game.committedSeq;
      const rng = createRng(`${gameId}:committed:${playerId}:${seq ?? 0}`);
      // a map with fewer seats than players (tests, tiny maps): cores may then repeat, so only the per-seat cap applies
      const set = others.length >= kernels.n
        ? dealCommitted(map, kernels, cfg, others.map((o) => ({ ...o, core: -1 })), rng)
        : dealCommitted(map, kernels, cfg, others, rng);
      if (!(await this.repo.updateGame(gameId, { committedSeq: (seq ?? 0) + 1 }, { status: 'lobby', committedSeq: seq }))) continue;
      await this.repo.updatePlayer(gameId, playerId, { committed: set });
      return;
    }
    throw new GameError('INTERNAL', 'Could not deal committed voters');
  }

  private async loadGame(gameId: string): Promise<GameRecord> {
    const g = typeof gameId === 'string' && gameId ? await this.repo.getGame(gameId) : null;
    if (!g) throw new GameError('NOT_FOUND', 'Game not found');
    return g;
  }

  private async auth(gameId: string, token: string | undefined): Promise<{ game: GameRecord; player: PlayerRecord; players: PlayerRecord[] }> {
    if (!token) throw new GameError('UNAUTHORIZED', 'Missing token');
    const game = await this.loadGame(gameId);
    const players = await this.repo.listPlayers(gameId);
    const h = hashToken(token);
    const player = players.find((p) => p.tokenHash === h);
    if (!player) throw new GameError('UNAUTHORIZED', 'Invalid token');
    return { game, player, players };
  }

  private requireAdmin(game: GameRecord, player: PlayerRecord): void {
    if (!player.isAdmin || game.adminId !== player.playerId) throw new GameError('FORBIDDEN', 'Only the admin can do this');
  }

  private requireLobby(game: GameRecord): void {
    if (game.status !== 'lobby') throw new GameError('WRONG_PHASE', 'The game has already started');
  }

  /** Tell a rejected player and close their socket. */
  private async rejectConnection(gameId: string, p: PlayerRecord): Promise<void> {
    if (!p.connectionId) return;
    await this.d.notifier.sendToPlayer(gameId, p.playerId, { type: 'players', players: [toPublic({ ...p, status: 'rejected' })] });
    await this.d.notifier.closeConnection(p.connectionId).catch(() => undefined);
    await this.repo.deleteConnection(p.connectionId).catch(() => undefined);
    await this.repo.updatePlayer(gameId, p.playerId, { connectionId: undefined });
  }

  private async broadcastPlayers(gameId: string): Promise<void> {
    const players = await this.repo.listPlayers(gameId);
    await this.d.notifier.broadcast(gameId, { type: 'players', players: players.filter((p) => MEMBER.has(p.status)).map(toPublic) });
  }

  /** Lobby-level 'players' message, tailored per recipient (admin sees pending requests; others only members + themselves). */
  private async broadcastLobby(gameId: string): Promise<void> {
    const players = this.sortedPlayers(await this.repo.listPlayers(gameId));
    const members = players.filter((p) => MEMBER.has(p.status));
    for (const p of players) {
      if (!p.connectionId) continue;
      let list = members;
      if (p.isAdmin) list = players.filter((x) => x.status !== 'rejected');
      else if (!MEMBER.has(p.status)) list = [...members, p].sort((a, b) => a.joinedAt - b.joinedAt);
      await this.d.notifier.sendToPlayer(gameId, p.playerId, { type: 'players', players: list.map(toPublic) });
    }
  }

  private sortedPlayers(players: PlayerRecord[]): PlayerRecord[] {
    return [...players].sort((a, b) => a.joinedAt - b.joinedAt || a.playerId.localeCompare(b.playerId));
  }

  // ------------------------------------------------------------------ lobby (REST)
  async createGame(req: CreateGameRequest): Promise<CreateGameResponse> {
    // AI agents can only JOIN games; hosting is human-only (the agent package has no create call either).
    if ((req as { kind?: unknown } | null)?.kind === 'agent') throw new GameError('FORBIDDEN', 'AI agents cannot create games; ask a human to host and give you the join code');
    const nickname = cleanText(req?.nickname, 1, 24, 'Nickname');
    const mapId = typeof req?.mapId === 'string' ? req.mapId : DEFAULT_MAP_ID;
    const { map, cfg } = this.loadMap(mapId);
    const phases = req?.phases === undefined ? cfg.phases.default : req.phases;
    this.checkPhases(cfg, map.phaseGroups, phases);
    let joinCode = '';
    for (let i = 0; i < 20; i++) { // the join-code index does not enforce uniqueness: check before use
      const c = newJoinCode();
      if (!(await this.repo.findGameByCode(c))) { joinCode = c; break; }
    }
    if (!joinCode) throw new GameError('INTERNAL', 'Could not allocate a join code');
    const now = this.now();
    const gameId = newId(5);
    const playerId = newId(4);
    const token = newToken();
    const game: GameRecord = {
      gameId, joinCode, mapId, phases, status: 'lobby', admissionOpen: true, adminId: playerId,
      createdAt: now, timeline: null, closedPhases: 0, revealedStep: 0, newsSecret: newToken(),
    };
    const admin: PlayerRecord = {
      gameId, playerId, nickname, tokenHash: hashToken(token), isAdmin: true, status: 'active', budget: 0, joinedAt: now,
    };
    await this.repo.createGame(game, admin);
    await this.dealCommittedFor(gameId, playerId);
    return { gameId, joinCode, playerId, token };
  }

  private checkPhases(cfg: MapConfig, groups: Record<string, unknown>, phases: unknown): asserts phases is number {
    if (!Number.isInteger(phases) || (phases as number) < cfg.phases.min || (phases as number) > cfg.phases.max || !groups[String(phases)]) {
      throw new GameError('BAD_REQUEST', `Phases must be a whole number from ${cfg.phases.min} to ${cfg.phases.max}`);
    }
  }

  async joinGame(req: JoinGameRequest): Promise<JoinGameResponse> {
    const nickname = cleanText(req?.nickname, 1, 24, 'Nickname');
    if (req?.kind !== undefined && req.kind !== 'human' && req.kind !== 'agent') throw new GameError('BAD_REQUEST', "kind must be 'human' or 'agent'");
    const code = typeof req?.joinCode === 'string' ? req.joinCode.trim().toUpperCase() : '';
    const game = code ? await this.repo.findGameByCode(code) : null;
    if (!game) throw new GameError('NOT_FOUND', 'No game with that join code');
    if (game.status !== 'lobby') throw new GameError('ADMISSION_CLOSED', 'The game has already started');
    if (!game.admissionOpen) throw new GameError('ADMISSION_CLOSED', 'The admin is not admitting new players');
    const { cfg } = this.loadMap(game.mapId);
    const players = await this.repo.listPlayers(game.gameId);
    if (players.filter((p) => CONTENDER.has(p.status)).length >= cfg.players.max) throw new GameError('GAME_FULL', 'The game is full');
    if (players.length >= cfg.players.max * 4) throw new GameError('GAME_FULL', 'Too many join requests');
    const playerId = newId(4);
    const token = newToken();
    await this.repo.putPlayer({
      gameId: game.gameId, playerId, nickname, tokenHash: hashToken(token), isAdmin: false, status: 'pending', budget: 0, joinedAt: this.now(),
      ...(req.kind === 'agent' ? { kind: 'agent' as const } : {}),
    });
    await this.broadcastLobby(game.gameId);
    return { gameId: game.gameId, playerId, token, status: 'pending' };
  }

  async getLobby(gameId: string, token: string | undefined): Promise<LobbyView> {
    const { game, player, players } = await this.auth(gameId, token);
    const visible = this.sortedPlayers(players).filter((p) =>
      p.playerId === player.playerId || (player.isAdmin ? p.status !== 'rejected' : MEMBER.has(p.status)));
    return {
      gameId, joinCode: game.joinCode, mapId: game.mapId, phases: game.phases, status: game.status,
      admissionOpen: game.admissionOpen, you: player.playerId, players: visible.map(toPublic),
    };
  }

  async admit(gameId: string, token: string | undefined, req: AdmitRequest): Promise<{ ok: true }> {
    const { game, player, players } = await this.auth(gameId, token);
    this.requireAdmin(game, player);
    this.requireLobby(game);
    const target = players.find((p) => p.playerId === req?.playerId);
    if (!target || target.isAdmin) throw new GameError('NOT_FOUND', 'No such player');
    if (req.admit) {
      if (target.status === 'active') return { ok: true };
      const { cfg } = this.loadMap(game.mapId);
      if (players.filter((p) => CONTENDER.has(p.status)).length >= cfg.players.max) throw new GameError('GAME_FULL', 'The game is full');
      await this.repo.updatePlayer(gameId, target.playerId, { status: 'active' });
      await this.dealCommittedFor(gameId, target.playerId);
    } else {
      await this.repo.updatePlayer(gameId, target.playerId, { status: 'rejected', party: undefined });
      await this.rejectConnection(gameId, target);
    }
    await this.broadcastLobby(gameId);
    return { ok: true };
  }

  async setAdmission(gameId: string, token: string | undefined, req: AdmissionRequest): Promise<{ ok: true }> {
    const { game, player } = await this.auth(gameId, token);
    this.requireAdmin(game, player);
    this.requireLobby(game);
    if (typeof req?.open !== 'boolean') throw new GameError('BAD_REQUEST', 'open must be true or false');
    await this.repo.updateGame(gameId, { admissionOpen: req.open }, { status: 'lobby' });
    return { ok: true };
  }

  async setSettings(gameId: string, token: string | undefined, req: SettingsRequest): Promise<{ ok: true }> {
    const { game, player } = await this.auth(gameId, token);
    this.requireAdmin(game, player);
    this.requireLobby(game);
    const { cfg, map } = this.loadMap(game.mapId);
    this.checkPhases(cfg, map.phaseGroups, req?.phases);
    await this.repo.updateGame(gameId, { phases: req.phases }, { status: 'lobby' });
    return { ok: true };
  }

  private validateParty(raw: PartyIdentity, selfId: PlayerId, players: PlayerRecord[]): PartyIdentity {
    const name = cleanText(raw?.name, 2, 30, 'Party name');
    const colour = typeof raw?.colour === 'string' ? raw.colour : '';
    const symbol = typeof raw?.symbol === 'string' ? raw.symbol : '';
    const ck = colourKey(colour);
    if (!ck) throw new GameError('BAD_REQUEST', 'Unknown party colour');
    if (!PARTY_SYMBOLS.some((s) => s.id === symbol)) throw new GameError('BAD_REQUEST', 'Unknown party symbol');
    let avatar: string | undefined;
    if (raw?.avatar !== undefined && raw.avatar !== null && raw.avatar !== '') {
      if (typeof raw.avatar !== 'string' || !AVATARS.some((a) => a.id === raw.avatar)) throw new GameError('BAD_REQUEST', 'Unknown party avatar');
      avatar = raw.avatar;
    }
    for (const p of players) {
      if (p.playerId === selfId || !p.party || !MEMBER.has(p.status)) continue;
      if (p.party.name.trim().toLowerCase() === name.toLowerCase()) throw new GameError('NAME_TAKEN', 'Another party already has that name');
      if (colourKey(p.party.colour) === ck) throw new GameError('COLOUR_TAKEN', 'Another party already has that colour');
      if (p.party.symbol === symbol) throw new GameError('SYMBOL_TAKEN', 'Another party already has that symbol');
      if (avatar && p.party.avatar === avatar) throw new GameError('AVATAR_TAKEN', 'Another party already has that avatar');
    }
    return avatar ? { name, colour: ck, symbol, avatar } : { name, colour: ck, symbol };
  }

  async setParty(gameId: string, token: string | undefined, req: PartyRequest): Promise<{ ok: true }> {
    const { game, player, players } = await this.auth(gameId, token);
    this.requireLobby(game);
    if (player.status !== 'active') throw new GameError('FORBIDDEN', 'You have not been admitted to this game');
    const party = this.validateParty(req?.party, player.playerId, players);
    await this.repo.updatePlayer(gameId, player.playerId, { party });
    await this.broadcastLobby(gameId);
    return { ok: true };
  }

  async start(gameId: string, token: string | undefined): Promise<StartResponse> {
    const { game, player, players } = await this.auth(gameId, token);
    this.requireAdmin(game, player);
    this.requireLobby(game);
    const { cfg } = this.loadMap(game.mapId);
    const active = players.filter((p) => p.status === 'active');
    if (active.length < cfg.players.min) throw new GameError('NOT_ENOUGH_PLAYERS', `At least ${cfg.players.min} players are needed`);
    if (active.length > cfg.players.max) throw new GameError('GAME_FULL', `At most ${cfg.players.max} players can play`);
    // every active player needs a party WITH an avatar (BAD_REQUEST with the names of who is still missing)
    const missing = active.filter((p) => !p.party || !p.party.avatar);
    if (missing.length) throw new GameError('BAD_REQUEST', `Waiting for a party (name, colour, symbol and avatar) from: ${missing.map((p) => p.nickname).join(', ')}`);
    // Re-validate uniqueness (party picks are not atomic with each other).
    for (const p of active) this.validateParty(p.party as PartyIdentity, p.playerId, active);
    // Candidate columns are dealt once, here, when the roster is final (so there is nothing to race over): a random
    // permutation of the map's columns, one per active player. Never sent to clients.
    // Safety net: anyone still without committed voters is dealt now (must precede the status flip: deals need the lobby).
    for (const p of active) if (!p.committed) await this.dealCommittedFor(gameId, p.playerId);
    const columns = dealCandidateColumns(active.length, cfg.players.max);
    await Promise.all(active.map((p, i) => this.repo.updatePlayer(gameId, p.playerId, { candidateColumn: columns[i] })));

    const now = this.now();
    // counting is shorter with exactly 2 players (no negotiation)
    const timeline = buildTimeline(cfg, game.phases, now + (this.d.startDelayMs ?? 5000), countingMsFor(cfg, active.length), postCountingMsFor(cfg, active.length));
    const ok = await this.repo.updateGame(gameId, {
      status: 'campaign', timeline, admissionOpen: false, closedPhases: 0, revealedStep: 0,
    }, { status: 'lobby' });
    if (!ok) throw new GameError('WRONG_PHASE', 'The game has already started');
    for (const p of players) {
      if (p.status === 'active') await this.repo.updatePlayer(gameId, p.playerId, { budget: cfg.budget });
      else if (p.status === 'pending') {
        await this.repo.updatePlayer(gameId, p.playerId, { status: 'rejected' });
        await this.rejectConnection(gameId, p);
      }
    }
    try {
      await this.d.scheduler.startLifecycle(gameId, timeline);
    } catch (e) {
      await this.repo.updateGame(gameId, { status: 'lobby', timeline: null, admissionOpen: true });
      throw e;
    }
    await this.d.notifier.broadcast(gameId, { type: 'status', status: 'campaign', timeline });
    // budgets were just set: tell every connected player (their lobby-time hello carried budget 0)
    for (const p of players) {
      if (p.status === 'active' && p.connectionId) {
        await this.d.notifier.sendToPlayer(gameId, p.playerId, { type: 'private', private: await this.privateState(gameId, p.playerId) });
      }
    }
    return { ok: true, timeline };
  }

  // ------------------------------------------------------------------ websocket session
  /** $connect: authenticate and register the connection. Nothing can be sent yet (API Gateway limitation); the hello is sent on the first message. */
  async connect(gameId: string, token: string | undefined, connectionId: string): Promise<PlayerId> {
    const { game, player } = await this.auth(gameId, token);
    if (player.status === 'rejected') throw new GameError('FORBIDDEN', 'Your request to join was declined');
    if (player.connectionId && player.connectionId !== connectionId) {
      await this.repo.deleteConnection(player.connectionId).catch(() => undefined);
    }
    await this.repo.putConnection({ connectionId, gameId, playerId: player.playerId });
    const patch: Partial<PlayerRecord> = { connectionId };
    const reactivate = player.status === 'disconnected';
    if (reactivate) { patch.status = 'active'; patch.disconnectedAt = undefined; patch.graceSchedule = undefined; }
    await this.repo.updatePlayer(gameId, player.playerId, patch);
    if (player.graceSchedule) await this.d.scheduler.cancelGraceCheck(player.graceSchedule).catch(() => undefined);
    if (reactivate && LIVE.has(game.status)) await this.broadcastPlayers(gameId);
    return player.playerId;
  }

  async disconnect(connectionId: string): Promise<void> {
    const conn = await this.repo.getConnection(connectionId);
    if (!conn) return;
    await this.repo.deleteConnection(connectionId);
    const player = await this.repo.getPlayer(conn.gameId, conn.playerId);
    const game = await this.repo.getGame(conn.gameId);
    if (!player || !game || player.connectionId !== connectionId) return; // replaced by a newer connection
    if (!(LIVE.has(game.status) && player.status === 'active')) {
      await this.repo.updatePlayer(conn.gameId, conn.playerId, { connectionId: undefined });
      return;
    }
    const { cfg } = this.loadMap(game.mapId);
    const now = this.now();
    const name = await this.d.scheduler.scheduleGraceCheck(conn.gameId, conn.playerId, now + cfg.durations.graceMs);
    await this.repo.updatePlayer(conn.gameId, conn.playerId, {
      status: 'disconnected', disconnectedAt: now, graceSchedule: name, connectionId: undefined,
    }, { status: 'active' });
    await this.broadcastPlayers(conn.gameId);
  }

  /** Entry point for every client message after $connect. Replies (including errors) are sent through the Notifier. */
  async handleMessage(connectionId: string, msg: ClientMessage): Promise<void> {
    const conn = await this.repo.getConnection(connectionId);
    const n = this.d.notifier;
    if (!conn) {
      await n.sendToConnection(connectionId, { type: 'error', error: 'UNAUTHORIZED', message: 'Unknown connection' });
      return;
    }
    const clientRef = (msg as { clientRef?: string } | null)?.clientRef;
    try {
      const player = await this.repo.getPlayer(conn.gameId, conn.playerId);
      if (!player) throw new GameError('UNAUTHORIZED', 'Unknown player');
      if (!conn.helloSent) {
        await this.repo.putConnection({ ...conn, helloSent: true });
        await n.sendToConnection(connectionId, await this.hello(player));
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { action?: unknown }).action !== 'string') {
        throw new GameError('BAD_REQUEST', 'Malformed message');
      }
      switch (msg.action) {
        case 'ping':
          await n.sendToConnection(connectionId, { type: 'pong', clientTime: Number(msg.clientTime) || 0, serverTime: this.now() });
          break;
        case 'campaign': await this.campaign(player, msg.type, msg.seat, msg.clientRef); break;
        case 'buyReport': await this.buyReport(player, msg.scope, msg.seat); break;
        case 'globalReports': await this.globalReports(player); break;
        case 'peekSeat': await this.peekSeat(player, msg.seat); break;
        case 'chat': await this.chat(player, msg.to, msg.text); break;
        case 'proposeGovernment': await this.proposeGovernment(player, msg.portfolios, msg.partners); break;
        case 'respondOffer': await this.respondOffer(player, msg.offerId, msg.accept); break;
        case 'withdrawOffer': await this.withdrawOffer(player, msg.offerId); break;
        default: throw new GameError('BAD_REQUEST', 'Unknown action');
      }
    } catch (e) {
      if (e instanceof GameError) {
        await n.sendToConnection(connectionId, {
          type: 'error', error: e.code, message: e.message, ...(clientRef ? { clientRef } : {}), ...(e.retryAt !== undefined ? { retryAt: e.retryAt } : {}),
        });
      } else {
        console.error('handleMessage failed', e);
        await n.sendToConnection(connectionId, { type: 'error', error: 'INTERNAL', message: 'Internal error' });
      }
    }
  }

  // ------------------------------------------------------------------ state for a player
  async hello(player: PlayerRecord): Promise<ServerMessage> {
    const game = await this.loadGame(player.gameId);
    const players = await this.repo.listPlayers(player.gameId);
    if (!MEMBER.has(player.status)) {
      // pending player: lobby-level information only
      const members = this.sortedPlayers(players).filter((p) => MEMBER.has(p.status) || p.playerId === player.playerId);
      return {
        type: 'hello', serverTime: this.now(),
        snapshot: {
          gameId: game.gameId, mapId: game.mapId, status: game.status, phases: game.phases, timeline: game.timeline,
          players: members.map(toPublic), news: [], polledPhases: [], seats: {}, tally: null, offers: [],
          government: null, result: null,
        },
        private: { you: player.playerId, budget: 0, myActions: [], myReports: [] },
      };
    }
    const snapshot = await this.snapshot(game, players, player.playerId);
    // API Gateway WebSocket messages are limited to 128 KB: with 500 seats x 10 players the declared-seat shares can
    // exceed that late in counting, so drop the (cosmetic) per-seat shares from an oversized hello.
    if (JSON.stringify(snapshot).length > 100_000) {
      for (const d of Object.values(snapshot.seats)) delete d.shares;
    }
    return {
      type: 'hello', serverTime: this.now(),
      snapshot,
      private: await this.privateState(player.gameId, player.playerId),
      chat: await this.chatHistoryFor(player),
    };
  }

  /** A hello must stay well under the 128 KB WebSocket frame limit: at most this many characters of chat history (newest kept). */
  private static readonly HELLO_CHAT_BUDGET = 12_000;

  /** What this player may read (every group message, their own one-to-one messages), oldest first, bounded. */
  private async chatHistoryFor(player: PlayerRecord): Promise<ChatMessage[]> {
    const game = await this.repo.getGame(player.gameId);
    if (!game || (game.status !== 'campaign' && game.status !== 'counting' && game.status !== 'postCounting' && game.status !== 'finished')) return [];
    const all = (await this.repo.listChat(player.gameId)).sort((a, b) => a.ts - b.ts);
    const mine = all.filter((m) => channelOf(m) === 'group' || m.from === player.playerId || m.to.includes(player.playerId));
    const out: ChatMessage[] = [];
    let size = 2;
    for (let i = mine.length - 1; i >= 0; i--) {
      const s = mine[i];
      const m: ChatMessage = {
        id: s.id, from: s.from, to: s.to, text: s.text, ts: s.ts, channel: channelOf(s), ...(s.mentions?.length ? { mentions: s.mentions } : {}),
      };
      size += JSON.stringify(m).length + 1;
      if (size > GameService.HELLO_CHAT_BUDGET) break;
      out.unshift(m);
    }
    return out;
  }

  /** The player's own reputation per seat, rounded for display (the only effect figure that ever leaves the server). */
  private async reputationFor(game: GameRecord, playerId: PlayerId, actions?: Action[]): Promise<Record<SeatId, number>> {
    if (!game.timeline) return {};
    const { cfg, map, kernels } = this.loadMap(game.mapId);
    const players = await this.repo.listPlayers(game.gameId);
    const exclude = new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId));
    const effects = computeEffects(actions ?? await this.repo.listActions(game.gameId), kernels, cfg, game.timeline, map, game.phases, { exclude });
    return reputationView(effects.get(playerId), kernels, cfg);
  }

  async privateState(gameId: string, playerId: PlayerId): Promise<PrivateState> {
    const p = await this.repo.getPlayer(gameId, playerId);
    const actions = await this.repo.listActions(gameId);
    const reports = await this.repo.listReports(gameId, playerId);
    const game = await this.repo.getGame(gameId);
    const cfg = game ? this.loadMap(game.mapId).cfg : undefined;
    return {
      you: playerId,
      budget: p?.budget ?? 0,
      committed: cfg ? committedView(p?.committed, cfg) : [],
      reputation: game ? await this.reputationFor(game, playerId, actions) : {},
      myActions: actions.filter((a) => a.playerId === playerId).map((a) => ({ type: a.type, seat: a.seat, ts: a.ts })),
      myReports: reports.sort((a, b) => a.ts - b.ts).map((r) => r.report),
      nextRallyAt: cfg ? nextRallyAt(p, cfg) : null,
    };
  }

  private currentStep(game: GameRecord, plan: CountPlan): number {
    return game.status === 'finished' ? plan.steps : game.revealedStep;
  }

  private async snapshot(game: GameRecord, players: PlayerRecord[], me: PlayerId): Promise<GameSnapshot> {
    const { cfg } = this.loadMap(game.mapId);
    const actions = await this.repo.listActions(game.gameId);
    const news = actions.filter((a) => a.type === 'rally').sort((a, b) => a.ts - b.ts).map((a) => ({ playerId: a.playerId, seat: a.seat, ts: a.ts }));
    let seats: Record<SeatId, SeatDeclaration> = {};
    let tally: CountTally | null = null;
    if (game.status === 'counting' || game.status === 'postCounting' || game.status === 'finished') {
      const plan = await this.repo.getCountPlan(game.gameId);
      if (plan) {
        const results = await this.repo.listSeatResults(game.gameId);
        const st = declaredState(plan, results, this.currentStep(game, plan), cfg.seatCount);
        seats = st.seats;
        tally = st.tally;
      }
    }
    const offers = (await this.repo.listOffers(game.gameId)).filter((o) => o.proposer === me || o.partners.includes(me));
    return {
      gameId: game.gameId, mapId: game.mapId, status: game.status, phases: game.phases, timeline: game.timeline,
      players: this.sortedPlayers(players).filter((p) => MEMBER.has(p.status)).map(toPublic),
      news, polledPhases: Array.from({ length: game.closedPhases }, (_, i) => i), seats, tally, offers,
      government: await this.repo.getGovernment(game.gameId),
      result: await this.repo.getResult(game.gameId),
    };
  }

  // ------------------------------------------------------------------ campaign
  private requireContender(player: PlayerRecord): void {
    if (player.status === 'eliminated') throw new GameError('FORBIDDEN', 'You have been eliminated');
    if (player.status !== 'active') throw new GameError('FORBIDDEN', 'You are not an active player');
  }

  private campaignWindow(game: GameRecord, now: number): void {
    if (game.status === 'lobby' || !game.timeline) throw new GameError('WRONG_PHASE', 'The campaign has not started');
    if (now < game.timeline.campaignStart) throw new GameError('WRONG_PHASE', 'The campaign has not started yet');
    if (game.status !== 'campaign' || now >= game.timeline.campaignEnd) throw new GameError('TOO_LATE', 'The campaign is over');
  }

  async campaign(player: PlayerRecord, type: unknown, seat: unknown, clientRef?: string): Promise<void> {
    if (type !== 'rally' && type !== 'roadshow') throw new GameError('BAD_REQUEST', 'Unknown action type');
    if (typeof seat !== 'number' || !Number.isInteger(seat)) throw new GameError('BAD_REQUEST', 'Invalid seat');
    for (let attempt = 0; attempt < 3; attempt++) {
      const game = await this.loadGame(player.gameId);
      const me = await this.repo.getPlayer(player.gameId, player.playerId);
      if (!me) throw new GameError('UNAUTHORIZED', 'Unknown player');
      this.requireContender(me);
      const now = this.now(); // server time decides; the client timer is display-only
      this.campaignWindow(game, now);
      const timeline = game.timeline!;
      const { cfg, map, kernels } = this.loadMap(game.mapId);
      if (!kernels.index.has(seat)) throw new GameError('BAD_REQUEST', 'Unknown seat');
      const p = phaseOfSeat(map, game.phases, seat);
      if (p < game.closedPhases || timeline.phaseCloses[p] <= now) throw new GameError('SEAT_POLLED', 'Polling has closed in that seat');
      // rally cooldown (the leader has to be present): checked here for a cheap early answer, and enforced atomically by
      // the repo (lastRallyAt condition in the spend transaction) against concurrent/pipelined rallies
      if (type === 'rally' && now < rallyAvailableAt(me.lastRallyAt, cfg)) throw rallyCooldown(rallyAvailableAt(me.lastRallyAt, cfg), now, cfg);
      const cost = cfg.costs[type];
      if (me.budget < cost) throw new GameError('INSUFFICIENT_FUNDS', 'Not enough funds');
      const action: Action = { id: newId(4), playerId: me.playerId, type, seat, ts: now };
      const res = await this.repo.addAction(
        game.gameId, me.playerId, cost, action, game.closedPhases, type === 'rally' ? { rallyGapMs: cfg.cooldowns.rallyMs } : undefined,
      );
      if (res === 'conflict') continue;
      if (res === 'cooldown') {
        // lost the race to a concurrent rally of the same player: final, never retried
        const fresh = await this.repo.getPlayer(game.gameId, me.playerId);
        throw rallyCooldown(Math.max(rallyAvailableAt(fresh?.lastRallyAt, cfg), now + 1), now, cfg);
      }
      if (res === 'insufficient') throw new GameError('INSUFFICIENT_FUNDS', 'Not enough funds');
      const after = await this.repo.getPlayer(game.gameId, me.playerId);
      await this.d.notifier.sendToPlayer(game.gameId, me.playerId, {
        type: 'actionAck', ...(clientRef ? { clientRef } : {}), ok: true, budget: after ? after.budget : me.budget - cost,
        reputation: await this.reputationFor(game, me.playerId),
        nextRallyAt: nextRallyAt(after ?? (type === 'rally' ? { lastRallyAt: now } : me), cfg),
      });
      if (type === 'rally') {
        await this.d.notifier.broadcast(game.gameId, { type: 'news', item: { playerId: me.playerId, seat, ts: now } });
      }
      return;
    }
    throw new GameError('TOO_LATE', 'Polling has just closed, try again');
  }

  async buyReport(player: PlayerRecord, scope: unknown, seat: unknown): Promise<void> {
    if (scope !== 'seat' && scope !== 'global') throw new GameError('BAD_REQUEST', 'Unknown report scope');
    if (scope === 'seat' && (typeof seat !== 'number' || !Number.isInteger(seat))) throw new GameError('BAD_REQUEST', 'A seat report needs a seat');
    for (let attempt = 0; attempt < 3; attempt++) {
      const game = await this.loadGame(player.gameId);
      const me = await this.repo.getPlayer(player.gameId, player.playerId);
      if (!me) throw new GameError('UNAUTHORIZED', 'Unknown player');
      this.requireContender(me);
      const now = this.now();
      this.campaignWindow(game, now);
      const timeline = game.timeline!;
      const { cfg, map, kernels } = this.loadMap(game.mapId);
      if (!(scope === 'seat' ? cfg.analyst.seatReport : cfg.analyst.globalReport).enabled) {
        throw new GameError('FORBIDDEN', scope === 'seat' ? 'Analyst seat reports are switched off in this game' : 'Analyst global reports are switched off in this game');
      }
      if (scope === 'seat') {
        if (!kernels.index.has(seat as number)) throw new GameError('BAD_REQUEST', 'Unknown seat');
        const p = phaseOfSeat(map, game.phases, seat as number);
        if (p < game.closedPhases || timeline.phaseCloses[p] <= now) throw new GameError('SEAT_POLLED', 'Polling has closed in that seat');
      }
      const price = analystPrice(cfg, scope, timeline, now);
      if (me.budget < price) throw new GameError('INSUFFICIENT_FUNDS', 'Not enough funds');
      const players = this.sortedPlayers(await this.repo.listPlayers(game.gameId));
      const exclude = new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId));
      const asOf = now - cfg.analyst.delayMs;
      const actions = await this.repo.listActions(game.gameId);
      const effects = computeEffects(actions, kernels, cfg, timeline, map, game.phases, { upTo: asOf, exclude });
      const decided = await this.repo.listSeatResults(game.gameId);
      const prev = await this.repo.listReports(game.gameId, me.playerId);
      const rng = createRng(`${game.gameId}:analyst:${me.playerId}:${prev.length}`);
      const contenders = players.filter((p) => CONTENDER.has(p.status));
      const committed = committedMatrix(contenders.filter((p) => p.committed).map((p) => [p.playerId, p.committed!] as const), kernels, cfg);
      const report = analystReport(
        effects, committed, kernels, cfg, scope, scope === 'seat' ? (seat as number) : undefined, decided,
        contenders.map((p) => p.playerId), asOf, now, price, rng,
      );
      const res = await this.repo.addReport(game.gameId, me.playerId, price, { playerId: me.playerId, ts: now, report }, game.closedPhases);
      if (res === 'conflict') continue;
      if (res === 'insufficient') throw new GameError('INSUFFICIENT_FUNDS', 'Not enough funds');
      const after = await this.repo.getPlayer(game.gameId, me.playerId);
      await this.d.notifier.sendToPlayer(game.gameId, me.playerId, { type: 'report', report, budget: after ? after.budget : me.budget - price });
      return;
    }
    throw new GameError('TOO_LATE', 'Polling has just closed, try again');
  }

  // ------------------------------------------------------------------ global reports (free, noised, by the news agencies)
  /**
   * A player asked for the news agencies' graphs: reply, to that player only, with every agency's growing series of noisy projected
   * seats per party and its latest seat ranges. Free (no budget, no action stored) and read-only. The numbers are computed here from
   * the hidden state (effects, committed voters) but only the noisy output leaves the server. Allowed from the campaign start to the
   * end of the game; the series is frozen at the campaign end. Refused in the lobby, for non-members and when news.enabled is off.
   */
  async globalReports(player: PlayerRecord): Promise<void> {
    const me = await this.repo.getPlayer(player.gameId, player.playerId);
    if (!me || !MEMBER.has(me.status)) throw new GameError('FORBIDDEN', 'You are not a player of this game');
    const game = await this.loadGame(player.gameId);
    if (game.status === 'lobby' || !game.timeline) throw new GameError('WRONG_PHASE', 'The campaign has not started');
    const { cfg, map, kernels } = this.loadMap(game.mapId);
    if (!cfg.news.enabled) throw new GameError('FORBIDDEN', 'Global reports are switched off in this game');
    const timeline = game.timeline;
    const players = this.sortedPlayers(await this.repo.listPlayers(game.gameId));
    const exclude = new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId));
    const contenders = players.filter((p) => CONTENDER.has(p.status));
    const actions = await this.repo.listActions(game.gameId);
    const decided = await this.repo.listSeatResults(game.gameId);
    const secret = await this.newsSecretOf(game);
    // The reports are identical for every player and change only with the newest sample time, the actions up to it, the parties in
    // the vote, the eliminated players, the poll results of closed phases and the secret: one build serves all of them.
    const sampleTimes = newsSampleTimes(cfg, timeline, this.now());
    const asOf = sampleTimes[sampleTimes.length - 1].t;
    const key = createHash('sha256').update(JSON.stringify([
      game.gameId, secret, asOf, contenders.map((p) => p.playerId), [...exclude].sort(),
      actions.filter((a) => a.ts <= asOf).map((a) => [a.playerId, a.ts, a.type, a.seat]),
      decided.filter((r) => r.winner !== null && (timeline.phaseCloses[r.phase] ?? Infinity) <= asOf).map((r) => [r.seat, r.phase, r.winner]).sort(),
    ])).digest('hex');
    let reports = this.newsCache.get(game.gameId)?.key === key ? this.newsCache.get(game.gameId)!.reports : undefined;
    if (!reports) {
      const committed = committedMatrix(contenders.filter((p) => p.committed).map((p) => [p.playerId, p.committed!] as const), kernels, cfg);
      reports = buildGlobalReports({
        gameId: game.gameId, secret, cfg, map, kernels, timeline, phases: game.phases, actions,
        players: contenders.map((p) => p.playerId), committed, decided, exclude, now: this.now(),
      });
      this.newsBuilds++;
      this.newsCache.delete(game.gameId); // re-insert last = most recently used
      this.newsCache.set(game.gameId, { key, reports });
      while (this.newsCache.size > NEWS_CACHE_GAMES) this.newsCache.delete(this.newsCache.keys().next().value!);
    }
    await this.d.notifier.sendToPlayer(game.gameId, me.playerId, { type: 'globalReports', reports });
  }

  /** The game's server-only news secret; a game from before the field existed gets one now (stored once, then stable). */
  private async newsSecretOf(game: GameRecord): Promise<string> {
    if (game.newsSecret) return game.newsSecret;
    const fresh = newToken();
    if (await this.repo.updateGame(game.gameId, { newsSecret: fresh }, { newsSecret: undefined })) return fresh;
    const again = await this.repo.getGame(game.gameId); // somebody else stored one first
    if (!again?.newsSecret) throw new GameError('INTERNAL', 'Could not store the news secret');
    return again.newsSecret;
  }

  // ------------------------------------------------------------------ seat vote shares (counting screen pie chart / result panels)
  /**
   * A player clicked a seat (or the result panels need its candidates): reply, to that player only, with the seat's shares and
   * candidate names. Only seats the count has already declared (lead or result) answer, so nothing is revealed early; a lead
   * answers with the swinging estimate, never with the true shares. Works until the game is over (Result screen).
   */
  async peekSeat(player: PlayerRecord, seat: unknown): Promise<void> {
    if (typeof seat !== 'number' || !Number.isInteger(seat)) throw new GameError('BAD_REQUEST', 'Invalid seat');
    const me = await this.repo.getPlayer(player.gameId, player.playerId);
    if (!me || !MEMBER.has(me.status)) throw new GameError('FORBIDDEN', 'You are not a player of this game');
    const game = await this.loadGame(player.gameId);
    if (game.status !== 'counting' && game.status !== 'postCounting' && game.status !== 'finished') {
      throw new GameError('WRONG_PHASE', 'Vote shares are available once counting has started');
    }
    const { map, candidates } = this.loadMap(game.mapId);
    if (!map.seats.some((s) => s.id === seat)) throw new GameError('BAD_REQUEST', 'Unknown seat');
    const plan = await this.repo.getCountPlan(game.gameId);
    const result = plan ? (await this.repo.listSeatResults(game.gameId)).find((r) => r.seat === seat) : undefined;
    const view = plan && result ? seatSharesAt(plan, result, this.currentStep(game, plan)) : null;
    if (!view) throw new GameError('NOT_FOUND', 'That seat has no lead yet');
    const names: Record<PlayerId, string> = {};
    // candidates.csv row n belongs to the n-th seat in id order (= seat n on maps numbered 1..N)
    const row = candidates?.[map.seats.map((s) => s.id).sort((a, b) => a - b).indexOf(seat)];
    if (row) {
      for (const p of await this.repo.listPlayers(game.gameId)) {
        const name = MEMBER.has(p.status) && p.candidateColumn !== undefined ? row[p.candidateColumn] : undefined;
        if (name) names[p.playerId] = name;
      }
    }
    await this.d.notifier.sendToPlayer(game.gameId, me.playerId, {
      type: 'seatShares', seat, status: view.status, shares: view.shares,
      ...(Object.keys(names).length ? { candidates: names } : {}),
    });
  }

  // ------------------------------------------------------------------ lifecycle (called by Step Functions / timers)
  /** Poll the seats of polling phase `phaseIndex` (0-based) using effects as of that phase's close time. Idempotent. */
  async phaseClose(gameId: string, phaseIndex: number): Promise<void> {
    const game = await this.repo.getGame(gameId);
    if (!game || !game.timeline || game.status === 'lobby' || game.status === 'finished' || game.status === 'abandoned') return;
    if (!Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex >= game.phases) return;
    const { cfg, map, kernels } = this.loadMap(game.mapId);
    await this.repo.markPhaseClosed(gameId, phaseIndex + 1);
    const seats = map.phaseGroups[String(game.phases)][phaseIndex];
    const existing = await this.repo.listSeatResults(gameId);
    if (!existing.some((r) => r.phase === phaseIndex)) {
      const actions = await this.repo.listActions(gameId);
      let players = await this.repo.listPlayers(gameId);
      const exclude = new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId));
      const effects = computeEffects(actions, kernels, cfg, game.timeline, map, game.phases, {
        upTo: game.timeline.phaseCloses[phaseIndex], exclude,
      });
      const voters = this.sortedPlayers(players).filter((p) => CONTENDER.has(p.status));
      const committed = committedMatrix(voters.filter((p) => p.committed).map((p) => [p.playerId, p.committed!] as const), kernels, cfg);
      let results = pollSeats(effects, committed, voters.map((p) => p.playerId), kernels, cfg, seats, phaseIndex, createRng(`${gameId}:poll:${phaseIndex}`));
      await this.repo.putSeatResults(gameId, results);
      // A player eliminated while we were polling must not keep seats.
      players = await this.repo.listPlayers(gameId);
      const late = players.filter((p) => p.status === 'eliminated' && !exclude.has(p.playerId));
      if (late.length) {
        for (const p of late) results = removePlayerFromResults(results, p.playerId);
        await this.repo.putSeatResults(gameId, results);
      }
    }
    await this.d.notifier.broadcast(gameId, { type: 'phaseClosed', phase: phaseIndex, seats: [...seats] });
    if (phaseIndex === game.phases - 1) await this.startCounting(gameId);
  }

  private async startCounting(gameId: string): Promise<void> {
    const game = await this.repo.getGame(gameId);
    if (!game || !game.timeline || game.status !== 'campaign') return;
    const { cfg, map } = this.loadMap(game.mapId);
    // plan length = the timeline's counting window (chosen at start from the player count); all phases are polled, so results exist
    const results = await this.repo.listSeatResults(gameId);
    const countingMs = game.timeline.countingEnd - game.timeline.campaignEnd;
    const plan = makePlan(map.seats.map((s) => s.id), game.timeline.campaignEnd, countingMs, createRng(`${gameId}:count`), results, cfg, gameId);
    await this.repo.putCountPlan(gameId, plan);
    const ok = await this.repo.updateGame(gameId, { status: 'counting', revealedStep: 0 }, { status: 'campaign' });
    if (ok) await this.d.notifier.broadcast(gameId, { type: 'status', status: 'counting', timeline: game.timeline });
  }

  private async ensurePolled(gameId: string): Promise<GameRecord | null> {
    let game = await this.repo.getGame(gameId);
    if (!game) return null;
    if (game.status === 'campaign' || (game.status === 'counting' && game.closedPhases < game.phases)) {
      for (let p = game.closedPhases; p < game.phases; p++) await this.phaseClose(gameId, p);
      game = await this.repo.getGame(gameId);
    }
    return game;
  }

  /** Reveal every declaration up to the step that `now` corresponds to. Returns done + when to call again (epoch ms). */
  async countReveal(gameId: string): Promise<{ done: boolean; nextAtMs: number }> {
    const now = this.now();
    let game = await this.repo.getGame(gameId);
    if (!game || game.status === 'lobby' || game.status === 'finished' || game.status === 'abandoned') return { done: true, nextAtMs: now };
    game = await this.ensurePolled(gameId);
    if (!game || (game.status !== 'counting' && game.status !== 'postCounting')) return { done: true, nextAtMs: now };
    const plan = await this.repo.getCountPlan(gameId);
    if (!plan) return { done: true, nextAtMs: now };
    const target = stepAt(plan, now);
    await this.revealTo(game, plan, target);
    const done = target >= plan.steps;
    if (done) {
      const ok = await this.repo.updateGame(gameId, { status: 'postCounting' }, { status: 'counting' });
      if (ok) await this.d.notifier.broadcast(gameId, { type: 'status', status: 'postCounting', timeline: game.timeline });
    }
    await this.evaluateOffers(gameId);
    return { done, nextAtMs: done ? now : stepTime(plan, target + 1) };
  }

  private async revealTo(game: GameRecord, plan: CountPlan, target: number): Promise<boolean> {
    if (target <= game.revealedStep) return false;
    const { cfg } = this.loadMap(game.mapId);
    const ok = await this.repo.updateGame(game.gameId, { revealedStep: target }, { revealedStep: game.revealedStep });
    if (!ok) return false; // another invocation revealed these steps
    const results = await this.repo.listSeatResults(game.gameId);
    const msgs: ServerMessage[] = [];
    // one declaredState per step: events = what changed since the previous step (lead changes included)
    let prev = declaredState(plan, results, game.revealedStep, cfg.seatCount).seats;
    for (let s = game.revealedStep + 1; s <= target; s++) {
      const { seats, tally } = declaredState(plan, results, s, cfg.seatCount);
      for (const declaration of diffDeclarations(prev, seats)) msgs.push({ type: 'seatUpdate', declaration, tally });
      prev = seats;
    }
    if (msgs.length) await this.d.notifier.broadcast(game.gameId, msgs);
    game.revealedStep = target;
    return true;
  }

  /** Wins of players among seats declared 'won' so far. */
  private async knownWins(game: GameRecord): Promise<Record<PlayerId, number>> {
    const results = await this.repo.listSeatResults(game.gameId);
    if (game.status === 'finished') return fullTally(results);
    const plan = await this.repo.getCountPlan(game.gameId);
    if (!plan) return {};
    return declaredState(plan, results, game.revealedStep, results.length).tally.wins;
  }

  // ------------------------------------------------------------------ elimination
  async graceCheck(gameId: string, playerId: PlayerId): Promise<void> {
    const game = await this.repo.getGame(gameId);
    const player = await this.repo.getPlayer(gameId, playerId);
    if (!game || !player || !LIVE.has(game.status)) return;
    if (player.status !== 'disconnected' || player.disconnectedAt === undefined) return; // reconnected in time
    const { cfg } = this.loadMap(game.mapId);
    // A stale schedule from an earlier disconnect must not eliminate a player who reconnected and dropped again.
    if (this.now() + 2000 < player.disconnectedAt + cfg.durations.graceMs) return;
    // OPEN QUESTION (docx): what should happen when a player disconnects AFTER their seats have been polled
    // (or during counting)? For now every grace-period timeout eliminates the player, whatever the phase.
    await this.eliminate(gameId, playerId);
  }

  async eliminate(gameId: string, playerId: PlayerId): Promise<void> {
    const ok = await this.repo.updatePlayer(gameId, playerId, { status: 'eliminated', graceSchedule: undefined, connectionId: undefined });
    if (!ok) return;
    const game = await this.loadGame(gameId);
    if (LIVE.has(game.status)) {
      const results = await this.repo.listSeatResults(gameId);
      const updated = removePlayerFromResults(results, playerId);
      const changed = updated.filter((_, i) => playerId in results[i].shares);
      if (changed.length) await this.repo.putSeatResults(gameId, changed);
      // withdraw offers that involve the player
      for (const o of await this.repo.listOffers(gameId)) {
        if ((o.status === 'open' || o.status === 'accepted') && (o.proposer === playerId || o.partners.includes(playerId))) {
          await this.setOfferStatus(gameId, o, 'withdrawn');
        }
      }
      await this.broadcastPlayers(gameId);
      // re-announce already declared seats whose winner changed
      if (game.status === 'counting' || game.status === 'postCounting') {
        const plan = await this.repo.getCountPlan(gameId);
        if (plan) {
          const { cfg } = this.loadMap(game.mapId);
          const old = declaredState(plan, results, game.revealedStep, cfg.seatCount).seats;
          const st = declaredState(plan, updated, game.revealedStep, cfg.seatCount);
          const msgs: ServerMessage[] = [];
          for (const r of changed) {
            const d = st.seats[r.seat];
            if (d && (!old[r.seat] || old[r.seat].playerId !== d.playerId)) msgs.push({ type: 'seatUpdate', declaration: d, tally: st.tally });
          }
          if (msgs.length) await this.d.notifier.broadcast(gameId, msgs);
        }
      }
      const players = await this.repo.listPlayers(gameId);
      // OPEN QUESTION (docx): with fewer than 2 players left the game simply ends with no government
      // (or the single-party-majority rule if the remaining player already holds a majority).
      if (players.filter((p) => CONTENDER.has(p.status)).length < 2) {
        await this.finishGame(gameId, true);
        return;
      }
      await this.evaluateOffers(gameId);
    }
  }

  // ------------------------------------------------------------------ finalise
  /** Idempotent. error=true is used by the state machine when the lifecycle failed. */
  async finalise(gameId: string, opts?: { error?: boolean }): Promise<void> {
    const game = await this.repo.getGame(gameId);
    if (!game || game.status === 'lobby') return;
    if (game.finalised || (await this.repo.getResult(gameId))) return;
    try {
      const g = await this.ensurePolled(gameId);
      if (g && (g.status === 'counting' || g.status === 'postCounting')) {
        const plan = await this.repo.getCountPlan(gameId);
        if (plan) await this.revealTo(g, plan, plan.steps);
      }
      await this.finishGame(gameId, false);
    } catch (e) {
      if (!opts?.error) throw e;
      console.error('finalise after error failed; abandoning game', e);
      await this.repo.updateGame(gameId, { status: 'abandoned' });
      await this.d.notifier.broadcast(gameId, { type: 'status', status: 'abandoned', timeline: game.timeline });
    }
  }

  private async finishGame(gameId: string, early: boolean): Promise<void> {
    const game = await this.loadGame(gameId);
    if (game.finalised || (await this.repo.getResult(gameId))) return;
    const { cfg } = this.loadMap(game.mapId);
    const players = this.sortedPlayers(await this.repo.listPlayers(gameId)).filter((p) => MEMBER.has(p.status));
    const eliminated = new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId));
    const results = await this.repo.listSeatResults(gameId);
    const tally = fullTally(results);
    // everything is declared now: make sure a pending accepted offer sees the full tally
    if (!early) {
      await this.formGovernment(gameId, tally);
    }
    let government = await this.repo.getGovernment(gameId);
    let newGovernment = false;
    if (!government) {
      const need = majorityOf(cfg.seatCount);
      const winner = players.find((p) => !eliminated.has(p.playerId) && (tally[p.playerId] ?? 0) >= need);
      if (winner) {
        const g = majorityGovernment(winner.playerId, cfg, this.now());
        if (await this.repo.putGovernmentIfAbsent(gameId, g)) { government = g; newGovernment = true; }
        else government = await this.repo.getGovernment(gameId);
      }
    }
    const result = finalResult(tally, government, players.map((p) => p.playerId), eliminated, cfg, cfg.seatCount);
    if (!(await this.repo.putResultIfAbsent(gameId, result))) return;
    await this.repo.updateGame(gameId, { status: 'finished', finalised: true });
    const msgs: ServerMessage[] = [];
    if (newGovernment && government) msgs.push({ type: 'government', government });
    msgs.push({ type: 'status', status: 'finished', timeline: game.timeline }, { type: 'result', result });
    await this.d.notifier.broadcast(gameId, msgs);
    await this.saveElectionReport(gameId, game.mapId, players, results);
  }

  /** Best effort: failures are logged and never block finishing the game (runs once, after putResultIfAbsent). */
  private async saveElectionReport(gameId: string, mapId: string, players: PlayerRecord[], results: SeatResult[]): Promise<void> {
    const sink = this.d.reportSink;
    if (!sink) return;
    try {
      const { map, cfg, kernels, seatNames = {} } = this.loadMap(mapId);
      const game = await this.repo.getGame(gameId);
      const seatIds = map.seats.map((s) => s.id);
      const parties = players.map((p) => ({ playerId: p.playerId, name: p.party?.name ?? p.playerId }));
      const perSeat = (vals: Float64Array | undefined, scale: number) =>
        new Map(seatIds.map((id) => [id, (vals?.[kernels.index.get(id) ?? -1] ?? 0) * scale] as const));
      const effects = game?.timeline
        ? computeEffects(await this.repo.listActions(gameId), kernels, cfg, game.timeline, map, game.phases,
          { exclude: new Set(players.filter((p) => p.status === 'eliminated').map((p) => p.playerId)) })
        : new Map<string, Float64Array>();
      const matrix = committedMatrix(players.filter((p) => p.committed).map((p) => [p.playerId, p.committed!] as const), kernels, cfg);
      const csv = buildElectionCsv(seatIds, seatNames, parties, {
        results,
        reputation: new Map(players.map((p) => [p.playerId, perSeat(effects.get(p.playerId), cfg.display.reputationScale)] as const)),
        committedPercent: new Map(players.map((p) => [p.playerId, perSeat(matrix.get(p.playerId), 100)] as const)),
      });
      await sink.saveElectionCsv(electionReportName(this.now(), gameId), csv);
    } catch (e) {
      console.error('saving election report failed', gameId, e);
    }
  }

  // ------------------------------------------------------------------ chat
  /** Designer's rule: with only 2 players who started the game there is no negotiation (majority or exact tie). Eliminated players still count. */
  private async requireNegotiationAllowed(gameId: string): Promise<void> {
    const players = await this.repo.listPlayers(gameId);
    if (players.filter((p) => MEMBER.has(p.status)).length < MIN_NEGOTIATION_PLAYERS) {
      throw new GameError('NEGOTIATION_DISABLED', 'With 2 players there is no chat or coalition-building: a majority wins, an exact tie is a draw');
    }
  }

  /**
   * Chat.Campaigning (campaign) and the fixed one-to-one rule from counting decide the stage's chat (chatModeFor). GROUP: everybody reads it, `to` is
   * ignored, "@Party name" tags fill `mentions`. INDV: one-to-one; a message to several players is stored and delivered as
   * one private copy per recipient, so nobody sees who else got it.
   */
  async chat(player: PlayerRecord, to: unknown, text: unknown): Promise<void> {
    const game = await this.loadGame(player.gameId);
    const { cfg } = this.loadMap(game.mapId);
    const mode = chatModeFor(cfg, game.status);
    if (!mode) {
      if (game.status === 'finished' || game.status === 'abandoned') throw new GameError('WRONG_PHASE', 'The game is over: the chat is closed');
      throw new GameError('WRONG_PHASE', cfg.chat.campaigning !== 'OFF' ? 'Chat opens when the campaign starts' : 'Chat opens when counting starts');
    }
    await this.requireNegotiationAllowed(game.gameId);
    if (!MEMBER.has(player.status)) throw new GameError('FORBIDDEN', 'You are not part of this game');
    const body = cleanText(text, 1, 500, 'Message');
    const players = await this.repo.listPlayers(player.gameId);
    const members = players.filter((p) => MEMBER.has(p.status));
    if (mode === 'GROUP') {
      // one common chat: everybody else in the game (eliminated players included) reads it; `to` is ignored
      const recipients = members.filter((p) => p.playerId !== player.playerId).map((p) => p.playerId);
      const named = members.filter((p) => p.party?.name).map((p) => ({ id: p.playerId, name: p.party!.name }));
      const mentions = findMentions(body, named, player.playerId);
      const message: ChatMessage = { id: newId(6), from: player.playerId, to: recipients, text: body, ts: this.now(), channel: 'group', ...(mentions.length ? { mentions } : {}) };
      await this.repo.addChat(player.gameId, message);
      for (const id of [player.playerId, ...recipients]) await this.d.notifier.sendToPlayer(player.gameId, id, { type: 'chat', message });
      return;
    }
    if (!Array.isArray(to) || to.length === 0 || to.some((x) => typeof x !== 'string')) throw new GameError('BAD_REQUEST', 'Choose the party to message');
    const recipients = uniq(to as string[]).filter((id) => id !== player.playerId);
    if (!recipients.length) throw new GameError('BAD_REQUEST', 'Choose at least one other player');
    for (const r of recipients) if (!members.some((p) => p.playerId === r)) throw new GameError('BAD_REQUEST', 'Unknown recipient');
    const ts = this.now();
    for (const r of recipients) {
      const message: ChatMessage = { id: newId(6), from: player.playerId, to: [r], text: body, ts, channel: 'direct' };
      await this.repo.addChat(player.gameId, message);
      await this.d.notifier.sendToPlayer(player.gameId, player.playerId, { type: 'chat', message });
      await this.d.notifier.sendToPlayer(player.gameId, r, { type: 'chat', message });
    }
  }

  // ------------------------------------------------------------------ coalition
  private async notifyOffer(gameId: string, offer: CoalitionOffer): Promise<void> {
    for (const id of uniq([offer.proposer, ...offer.partners])) {
      await this.d.notifier.sendToPlayer(gameId, id, { type: 'offer', offer });
    }
  }

  private async setOfferStatus(gameId: string, offer: CoalitionOffer, status: CoalitionOffer['status']): Promise<void> {
    offer.status = status;
    await this.repo.putOffer(gameId, offer);
    await this.notifyOffer(gameId, offer);
  }

  private requireNegotiation(game: GameRecord, player: PlayerRecord): void {
    if (game.status !== 'counting' && game.status !== 'postCounting') throw new GameError('WRONG_PHASE', 'Coalition talks open when counting starts');
    if (player.status === 'eliminated') throw new GameError('FORBIDDEN', 'You have been eliminated');
    if (!CONTENDER.has(player.status)) throw new GameError('FORBIDDEN', 'You are not an active player');
  }

  /**
   * Drop `player`'s commitment to every other open offer (their own offers are superseded, acceptances removed).
   * `supersededBy` = the id of the player's new proposal, recorded on (and announced with) their superseded offers.
   */
  private async uncommit(gameId: string, playerId: PlayerId, except?: string, supersededBy?: string): Promise<void> {
    for (const o of await this.repo.listOffers(gameId)) {
      if (o.offerId === except || (o.status !== 'open' && o.status !== 'accepted')) continue;
      if (o.proposer === playerId) {
        if (supersededBy) o.supersededBy = supersededBy;
        await this.setOfferStatus(gameId, o, 'superseded');
      } else if (o.accepted.includes(playerId)) {
        o.accepted = o.accepted.filter((x) => x !== playerId);
        o.status = 'open';
        logOfferEvent(o, 'unaccepted', playerId, this.now());
        await this.repo.putOffer(gameId, o);
        await this.notifyOffer(gameId, o);
      }
    }
  }

  async proposeGovernment(player: PlayerRecord, portfoliosIn: unknown, partnersIn?: unknown): Promise<void> {
    const game = await this.loadGame(player.gameId);
    const me = (await this.repo.getPlayer(player.gameId, player.playerId)) as PlayerRecord;
    this.requireNegotiation(game, me);
    await this.requireNegotiationAllowed(game.gameId);
    if (await this.repo.getGovernment(game.gameId)) throw new GameError('ALREADY_COMMITTED', 'A government has already been formed');
    const { cfg } = this.loadMap(game.mapId);
    if (!portfoliosIn || typeof portfoliosIn !== 'object' || Array.isArray(portfoliosIn)) throw new GameError('INVALID_GOVERNMENT', 'Portfolios are required');
    const players = await this.repo.listPlayers(game.gameId);
    const valid = new Set(players.filter((p) => CONTENDER.has(p.status)).map((p) => p.playerId));
    const portfolios: PortfolioAssignment = {};
    for (const [id, holders] of Object.entries(portfoliosIn as Record<string, unknown>)) {
      if (!Array.isArray(holders) || holders.some((h) => typeof h !== 'string')) throw new GameError('INVALID_GOVERNMENT', `Invalid holders for ${id}`);
      const hs = uniq(holders as string[]);
      for (const h of hs) if (!valid.has(h)) throw new GameError('INVALID_GOVERNMENT', 'A portfolio is assigned to someone who is not an active player');
      if (hs.length) portfolios[id] = hs;
    }
    if (!portfolios['PM']) portfolios['PM'] = [me.playerId];
    if (portfolios['PM'].length !== 1 || portfolios['PM'][0] !== me.playerId) {
      throw new GameError('INVALID_GOVERNMENT', 'The proposer must be the Prime Minister');
    }
    const members = uniq(Object.values(portfolios).flat());
    // structural validation only: pretend every member has all seats so that the majority check passes
    const err = validateGovernment(portfolios, Object.fromEntries(members.map((m) => [m, cfg.seatCount])), cfg, cfg.seatCount);
    if (err) throw new GameError('INVALID_GOVERNMENT', err);
    let extra: string[] = [];
    if (partnersIn !== undefined) {
      if (!Array.isArray(partnersIn) || partnersIn.some((x) => typeof x !== 'string' || !valid.has(x))) {
        throw new GameError('INVALID_GOVERNMENT', 'Invalid partner');
      }
      extra = partnersIn as string[];
    }
    const partners = uniq([...members, ...extra]).filter((x) => x !== me.playerId);
    // designer's rule: no everyone-in government, at least one party still in the game must stay out
    if (!leavesPartyOut([me.playerId, ...partners], [...valid])) {
      throw new GameError('INVALID_GOVERNMENT', 'At least one party must stay out of the government: leave out at least one of the other parties');
    }
    const offerId = newId(5);
    await this.uncommit(game.gameId, me.playerId, undefined, offerId);
    const offer: CoalitionOffer = {
      offerId, proposer: me.playerId, portfolios, partners, accepted: [],
      status: partners.length === 0 ? 'accepted' : 'open', createdAt: this.now(),
    };
    await this.repo.putOffer(game.gameId, offer);
    await this.notifyOffer(game.gameId, offer);
    await this.evaluateOffers(game.gameId);
  }

  async respondOffer(player: PlayerRecord, offerId: unknown, accept: unknown): Promise<void> {
    if (typeof offerId !== 'string' || typeof accept !== 'boolean') throw new GameError('BAD_REQUEST', 'Malformed response');
    const game = await this.loadGame(player.gameId);
    const me = (await this.repo.getPlayer(player.gameId, player.playerId)) as PlayerRecord;
    this.requireNegotiation(game, me);
    await this.requireNegotiationAllowed(game.gameId);
    const offer = await this.repo.getOffer(game.gameId, offerId);
    if (!offer || !offer.partners.includes(me.playerId)) throw new GameError('OFFER_NOT_FOUND', 'No such offer');
    if (offer.status !== 'open' && offer.status !== 'accepted') throw new GameError('OFFER_NOT_FOUND', 'That offer is no longer open');
    if (await this.repo.getGovernment(game.gameId)) throw new GameError('ALREADY_COMMITTED', 'A government has already been formed');
    if (!accept) {
      offer.accepted = offer.accepted.filter((x) => x !== me.playerId);
      offer.declinedBy = me.playerId;
      logOfferEvent(offer, 'declined', me.playerId, this.now());
      await this.setOfferStatus(game.gameId, offer, 'declined');
      return;
    }
    if (offer.accepted.includes(me.playerId)) return;
    // one accepted open offer at a time: accepting this withdraws earlier acceptances
    await this.uncommit(game.gameId, me.playerId, offer.offerId);
    const fresh = (await this.repo.getOffer(game.gameId, offerId)) as CoalitionOffer;
    if (fresh.status !== 'open' && fresh.status !== 'accepted') throw new GameError('OFFER_NOT_FOUND', 'That offer is no longer open');
    fresh.accepted = uniq([...fresh.accepted, me.playerId]);
    logOfferEvent(fresh, 'accepted', me.playerId, this.now());
    fresh.status = fresh.partners.every((p) => fresh.accepted.includes(p)) ? 'accepted' : 'open';
    await this.repo.putOffer(game.gameId, fresh);
    await this.notifyOffer(game.gameId, fresh);
    await this.evaluateOffers(game.gameId);
  }

  async withdrawOffer(player: PlayerRecord, offerId: unknown): Promise<void> {
    if (typeof offerId !== 'string') throw new GameError('BAD_REQUEST', 'Malformed request');
    await this.requireNegotiationAllowed(player.gameId);
    const offer = await this.repo.getOffer(player.gameId, offerId);
    if (!offer || offer.proposer !== player.playerId) throw new GameError('OFFER_NOT_FOUND', 'No such offer');
    if (offer.status !== 'open' && offer.status !== 'accepted') throw new GameError('OFFER_NOT_FOUND', 'That offer is no longer open');
    logOfferEvent(offer, 'withdrawn', player.playerId, this.now());
    await this.setOfferStatus(player.gameId, offer, 'withdrawn');
  }

  /**
   * Designer's rule: a negotiated government is confirmed only once EVERY seat has been declared, and the game then ends at
   * once. Until then accepted offers simply stay 'accepted'. Once the count is complete, the oldest accepted offer whose
   * members' seats reach the majority (and that leaves at least one remaining party out) is confirmed, and the game is
   * finished (result + 'finished' status). Idempotent; the GOVT item is written with attribute_not_exists, so only the
   * first confirmed government wins even with concurrent invocations.
   */
  async evaluateOffers(gameId: string): Promise<void> {
    if (await this.formGovernment(gameId)) await this.finishGame(gameId, false);
  }

  /** True once the game is over (or unknown): the local scheduler stops waiting for postCountingEnd. */
  async isFinished(gameId: string): Promise<boolean> {
    const game = await this.repo.getGame(gameId);
    return !game || game.status === 'finished';
  }

  /**
   * Confirm the first qualifying accepted offer (see evaluateOffers) without finishing the game. `fullTally` is the
   * finishGame path (every seat decided); otherwise nothing happens before the count plan is fully revealed.
   * Returns true when THIS call stored the government.
   */
  private async formGovernment(gameId: string, fullTallyIn?: Record<PlayerId, number>): Promise<boolean> {
    const game = await this.repo.getGame(gameId);
    if (!game || (game.status !== 'counting' && game.status !== 'postCounting')) return false;
    if (await this.repo.getGovernment(gameId)) return false;
    let wins = fullTallyIn;
    if (!wins) {
      const plan = await this.repo.getCountPlan(gameId);
      if (!plan || game.revealedStep < plan.steps) return false; // seats are still being declared
      wins = await this.knownWins(game);
    }
    const offers = (await this.repo.listOffers(gameId)).filter((o) => o.status === 'accepted').sort((a, b) => a.createdAt - b.createdAt);
    if (!offers.length) return false;
    const { cfg } = this.loadMap(game.mapId);
    const players = await this.repo.listPlayers(gameId);
    const contenders = players.filter((p) => CONTENDER.has(p.status)).map((p) => p.playerId);
    const alive = new Set(contenders);
    for (const o of offers) {
      const members = uniq(Object.values(o.portfolios).flat().concat(o.proposer, o.partners));
      if (members.some((m) => !alive.has(m))) continue;
      if (!leavesPartyOut(members, contenders)) continue; // e.g. everybody else was eliminated after it was made
      if (validateGovernment(o.portfolios, wins, cfg, cfg.seatCount, o.partners) !== null) continue;
      const gov = governmentFromOffer(o, this.now(), cfg);
      if (!(await this.repo.putGovernmentIfAbsent(gameId, gov))) return false; // somebody else was first
      await this.setOfferStatus(gameId, o, 'formed');
      for (const other of await this.repo.listOffers(gameId)) {
        if (other.offerId !== o.offerId && (other.status === 'open' || other.status === 'accepted')) {
          await this.setOfferStatus(gameId, other, 'superseded');
        }
      }
      await this.d.notifier.broadcast(gameId, { type: 'government', government: gov });
      return true;
    }
    return false;
  }
}
