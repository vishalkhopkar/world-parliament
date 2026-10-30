import { AVATARS, WORLD_CONFIG, PARTY_COLOURS, PARTY_SYMBOLS, buildKernels } from '@hp/shared';
import type { ClientMessage, GameMapPackage, GameMapSeat, GameTimeline, MapConfig, PlayerId, ServerMessage } from '@hp/shared';
import { GameService } from '../src/core/gameService';
import type { Clock, GameRecord, MapProvider, Notifier, Repo, Scheduler } from '../src/core/types';
import { MemoryRepo } from '../src/local/memoryRepo';

export const T0 = 1_000_000_000;

export const TEST_CFG: MapConfig = {
  ...WORLD_CONFIG,
  mapId: 'test',
  seatCount: 8,
  budget: 100_000,
  // the long-standing private-chat tests run one-to-one from counting; groupChat.test.ts covers the shipped modes
  chat: { campaigning: 'OFF' },
  costs: { rally: 1000, roadshow: 300 },
  analyst: { ...WORLD_CONFIG.analyst, seatReport: { start: 100, end: 300, enabled: true }, globalReport: { start: 500, end: 1000, enabled: true }, delayMs: 1000 },
  effects: {
    distanceUnitKm: 100,
    rally: { local: 1.0, global: 0.01, decay: { spread: 0.5, maxKm: 500 } },
    roadshow: { local: 1.5, decay: { spread: 2.8, maxKm: 150 } },
    firstMover: { rally: 0, roadshow: 0 }, // off in the shared server test config
  },
  cooldowns: { rallyMs: 30_000 },
  display: { reputationScale: 10 }, // a round scale for the tests (the shipped file uses 4)
  durations: {
    campaignMs: 60_000, countingMs: 30_000, countingMsTwoPlayers: 10_000, countingStepMs: 1_000, postCountingMs: 10_000, postCountingMsTwoPlayers: 0, graceMs: 5_000,
  },
};

function seat(id: number, lon: number): GameMapSeat {
  return { id, lon, lat: 0, x: lon, y: 0, neighbours: [] };
}

export const TEST_MAP: GameMapPackage = {
  mapId: 'test', version: 1, seatCount: 8,
  seats: [seat(1, 0), seat(2, 0.01), seat(3, 1), seat(4, 3), seat(5, 6), seat(6, 20), seat(7, 0.2), seat(8, 120)],
  phaseGroups: {
    '1': [[1, 2, 3, 4, 5, 6, 7, 8]],
    '2': [[1, 2, 3, 4], [5, 6, 7, 8]],
    '3': [[1, 2, 3], [4, 5, 6], [7, 8]],
  },
  topo: { coarse: 'x.json' },
};

export class FakeClock implements Clock {
  t = T0;
  now() { return this.t; }
  set(t: number) { this.t = t; }
  advance(ms: number) { this.t += ms; }
}

export interface Sent { to: PlayerId; msg: ServerMessage }
const arr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

export class FakeNotifier implements Notifier {
  log: Sent[] = [];
  constructor(private repo: Repo) {}
  async sendToPlayer(_g: string, to: PlayerId, msg: ServerMessage | ServerMessage[]) { for (const m of arr(msg)) this.log.push({ to, msg: m }); }
  async broadcast(gameId: string, msg: ServerMessage | ServerMessage[]) {
    const players = await this.repo.listPlayers(gameId);
    for (const p of players) {
      if (p.status === 'pending' || p.status === 'rejected') continue;
      for (const m of arr(msg)) this.log.push({ to: p.playerId, msg: m });
    }
  }
  closed: string[] = [];
  async closeConnection(connectionId: string) { this.closed.push(connectionId); }
  async sendToConnection(connectionId: string, msg: ServerMessage | ServerMessage[]) {
    const c = await this.repo.getConnection(connectionId);
    for (const m of arr(msg)) this.log.push({ to: c ? c.playerId : `conn:${connectionId}`, msg: m });
  }
  to(p: PlayerId, type?: string) { return this.log.filter((s) => s.to === p && (!type || s.msg.type === type)).map((s) => s.msg); }
  clear() { this.log = []; }
}

export class FakeScheduler implements Scheduler {
  lifecycles: { gameId: string; timeline: GameTimeline }[] = [];
  graces = new Map<string, { gameId: string; playerId: PlayerId; atMs: number }>();
  cancelled: string[] = [];
  private n = 0;
  async startLifecycle(gameId: string, timeline: GameTimeline) { this.lifecycles.push({ gameId, timeline }); }
  async scheduleGraceCheck(gameId: string, playerId: PlayerId, atMs: number) {
    const name = `g${this.n++}`;
    this.graces.set(name, { gameId, playerId, atMs });
    return name;
  }
  async cancelGraceCheck(name: string) { this.graces.delete(name); this.cancelled.push(name); }
}

export interface TP { playerId: PlayerId; token: string; conn: string; nickname: string }

/** A map of `n` seats on the equator, 10 degrees apart (no spill-over between seats), with phase groupings 1..3. */
export function lineMap(n: number, mapId = 'line'): GameMapPackage {
  const seats = Array.from({ length: n }, (_, i) => seat(i + 1, (i - n / 2) * 10));
  const ids = seats.map((s) => s.id);
  const split = (k: number) => Array.from({ length: k }, (_, g) => ids.filter((_id, i) => i % k === g));
  const phaseGroups: Record<string, number[][]> = { '1': split(1) };
  if (n >= 2) phaseGroups['2'] = split(2);
  if (n >= 3) phaseGroups['3'] = split(3);
  return { mapId, version: 1, seatCount: n, seats, phaseGroups, topo: { coarse: 'x.json' } };
}

export interface CtxOptions { map?: GameMapPackage; cfg?: MapConfig; startDelayMs?: number; candidates?: string[][] }

export class Ctx {
  clock = new FakeClock();
  repo = new MemoryRepo();
  notifier = new FakeNotifier(this.repo);
  scheduler = new FakeScheduler();
  cfg: MapConfig;
  map: GameMapPackage;
  maps: MapProvider;
  svc: GameService;
  constructor(opts: CtxOptions = {}) {
    this.map = opts.map ?? TEST_MAP;
    this.cfg = opts.cfg ?? { ...TEST_CFG, mapId: this.map.mapId, seatCount: this.map.seatCount };
    this.maps = (id) => (id === this.map.mapId
      ? { map: this.map, cfg: this.cfg, kernels: buildKernels(this.map, this.cfg), ...(opts.candidates ? { candidates: opts.candidates } : {}) }
      : undefined);
    this.svc = new GameService({
      repo: this.repo, notifier: this.notifier, scheduler: this.scheduler, clock: this.clock, maps: this.maps, startDelayMs: opts.startDelayMs ?? 1000,
    });
  }
  gameId = '';
  joinCode = '';
  players: TP[] = [];

  /** Creates a lobby with `n` admitted players, each with a unique party. Player 0 is the admin. */
  async lobby(n: number, phases = 3): Promise<this> {
    const c = await this.svc.createGame({ nickname: 'P0', mapId: this.map.mapId, phases });
    this.gameId = c.gameId;
    this.joinCode = c.joinCode;
    this.players.push({ playerId: c.playerId, token: c.token, conn: 'c0', nickname: 'P0' });
    for (let i = 1; i < n; i++) {
      this.clock.advance(1);
      const j = await this.svc.joinGame({ joinCode: c.joinCode, nickname: `P${i}` });
      this.players.push({ playerId: j.playerId, token: j.token, conn: `c${i}`, nickname: `P${i}` });
      await this.svc.admit(this.gameId, c.token, { playerId: j.playerId, admit: true });
    }
    for (let i = 0; i < n; i++) {
      await this.svc.setParty(this.gameId, this.players[i].token, {
        party: { name: `Party ${i}`, colour: PARTY_COLOURS[i].id, symbol: PARTY_SYMBOLS[i].id, avatar: AVATARS[i].id },
      });
    }
    return this;
  }

  /** Lobby + start + everyone connected; clock at campaignStart. */
  async started(n: number, phases = 3): Promise<this> {
    await this.lobby(n, phases);
    await this.svc.start(this.gameId, this.players[0].token);
    for (const p of this.players) await this.svc.connect(this.gameId, p.token, p.conn);
    this.clock.set(this.timeline.campaignStart);
    return this;
  }

  get p() { return this.players; }
  async game(): Promise<GameRecord> { return (await this.repo.getGame(this.gameId)) as GameRecord; }
  get timeline(): GameTimeline { return this.scheduler.lifecycles[0].timeline; }
  send(i: number, msg: ClientMessage) { return this.svc.handleMessage(this.players[i].conn, msg); }
  lastError(i: number) {
    const e = this.notifier.to(this.players[i].playerId, 'error');
    return e.length ? (e[e.length - 1] as Extract<ServerMessage, { type: 'error' }>) : undefined;
  }
  async budget(i: number) { return (await this.repo.getPlayer(this.gameId, this.players[i].playerId))!.budget; }

  /** Drive the lifecycle like the state machine does, to the end of counting (not finalise). */
  async runCampaignToCountingEnd() {
    const tl = this.timeline;
    const game = await this.game();
    for (let p = 0; p < game.phases; p++) {
      this.clock.set(tl.phaseCloses[p]);
      await this.svc.phaseClose(this.gameId, p);
    }
    let r = await this.svc.countReveal(this.gameId);
    let guard = 0;
    while (!r.done && guard++ < 1000) {
      this.clock.set(r.nextAtMs);
      r = await this.svc.countReveal(this.gameId);
    }
    return r;
  }
}

// ------------------------------------------------------------------ extra helpers for the matrix / lifecycle tests
/** Overwrite the stored seat results so that seat -> winner (index into ctx.players, or null) is exactly as given. */
export async function setResults(c: Ctx, winners: Record<number, number | null>): Promise<void> {
  const game = await c.game();
  const groups = c.map.phaseGroups[String(game.phases)];
  const results = Object.entries(winners).map(([seatId, w]) => {
    const seat = Number(seatId);
    const phase = groups.findIndex((g) => g.includes(seat));
    const id = w === null ? null : c.players[w].playerId;
    return { seat, phase, winner: id, shares: id === null ? {} : { [id]: 1 } };
  });
  await c.repo.putSeatResults(c.gameId, results);
}

/** Close every polling phase (seat results exist, status = counting, nothing revealed yet). */
export async function pollAll(c: Ctx): Promise<void> {
  const game = await c.game();
  for (let p = 0; p < game.phases; p++) {
    c.clock.set(c.timeline.phaseCloses[p]);
    await c.svc.phaseClose(c.gameId, p);
  }
}

/** Put the game into a given status by driving the real lifecycle (or direct repo edits for 'abandoned'). */
export async function driveTo(c: Ctx, status: 'campaign' | 'counting' | 'postCounting' | 'finished' | 'abandoned'): Promise<void> {
  if (status === 'campaign') return;
  if (status === 'abandoned') { await c.repo.updateGame(c.gameId, { status: 'abandoned' }); return; }
  if (status === 'counting') { await pollAll(c); return; }
  // spread the seats round-robin so that NO party holds a majority (a lone majority ends the game at the last count step)
  await pollAll(c);
  const n = c.players.length;
  await setResults(c, Object.fromEntries(c.map.seats.map((st, i) => [st.id, i % n])));
  await c.runCampaignToCountingEnd();
  if (status === 'finished') { c.clock.set(c.timeline.postCountingEnd); await c.svc.finalise(c.gameId); }
}

/** The status a game is in right after the last seat is declared: finished when one party holds a majority, else postCounting. */
export async function statusAfterCount(c: Ctx): Promise<'finished' | 'postCounting'> {
  const wins: Record<string, number> = {};
  for (const r of await c.repo.listSeatResults(c.gameId)) if (r.winner) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  return Math.max(0, ...Object.values(wins)) >= Math.floor(c.map.seatCount / 2) + 1 ? 'finished' : 'postCounting';
}
