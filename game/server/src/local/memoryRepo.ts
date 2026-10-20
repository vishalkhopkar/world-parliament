import type { Action, CoalitionOffer, FinalResult, Government, PlayerId, SeatResult } from '@hp/shared';
import type {
  ConnectionRecord, CountPlan, GameRecord, PlayerRecord, Repo, SpendResult, StoredChat, StoredReport,
} from '../core/types';

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function applyPatch<T extends object>(target: T, patch: Partial<T>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (target as Record<string, unknown>)[k];
    else (target as Record<string, unknown>)[k] = clone(v);
  }
}
function matches<T extends object>(target: T, cond?: Partial<T>): boolean {
  if (!cond) return true;
  return Object.entries(cond).every(([k, v]) => JSON.stringify((target as Record<string, unknown>)[k]) === JSON.stringify(v));
}

interface GameData {
  game: GameRecord;
  players: Map<PlayerId, PlayerRecord>;
  actions: Action[];
  reports: StoredReport[];
  results: Map<number, SeatResult>;
  plan: CountPlan | null;
  chat: StoredChat[];
  offers: Map<string, CoalitionOffer>;
  government: Government | null;
  result: FinalResult | null;
}

/** In-memory Repo with the same atomicity semantics as DynamoRepo (single-threaded, so trivially atomic). */
export class MemoryRepo implements Repo {
  private games = new Map<string, GameData>();
  private codes = new Map<string, string>();
  private conns = new Map<string, ConnectionRecord>();

  private d(gameId: string): GameData {
    const g = this.games.get(gameId);
    if (!g) throw new Error(`MemoryRepo: no game ${gameId}`);
    return g;
  }

  async createGame(game: GameRecord, admin: PlayerRecord): Promise<void> {
    if (this.games.has(game.gameId)) throw new Error('game exists');
    this.games.set(game.gameId, {
      game: clone(game), players: new Map([[admin.playerId, clone(admin)]]), actions: [], reports: [], results: new Map(),
      plan: null, chat: [], offers: new Map(), government: null, result: null,
    });
    this.codes.set(game.joinCode, game.gameId);
  }
  async getGame(gameId: string) { const g = this.games.get(gameId); return g ? clone(g.game) : null; }
  async findGameByCode(code: string) { const id = this.codes.get(code); return id ? this.getGame(id) : null; }
  async updateGame(gameId: string, patch: Partial<GameRecord>, cond?: Partial<GameRecord>) {
    const g = this.games.get(gameId);
    if (!g || !matches(g.game, cond)) return false;
    applyPatch(g.game, patch);
    return true;
  }
  async markPhaseClosed(gameId: string, n: number) {
    const g = this.d(gameId);
    if (g.game.closedPhases < n) g.game.closedPhases = n;
  }

  async putPlayer(p: PlayerRecord) { this.d(p.gameId).players.set(p.playerId, clone(p)); }
  async getPlayer(gameId: string, playerId: PlayerId) { const p = this.games.get(gameId)?.players.get(playerId); return p ? clone(p) : null; }
  async listPlayers(gameId: string) { return [...(this.games.get(gameId)?.players.values() ?? [])].map(clone); }
  async updatePlayer(gameId: string, playerId: PlayerId, patch: Partial<PlayerRecord>, cond?: Partial<PlayerRecord>) {
    const p = this.games.get(gameId)?.players.get(playerId);
    if (!p || !matches(p, cond)) return false;
    applyPatch(p, patch);
    return true;
  }

  async putConnection(c: ConnectionRecord) { this.conns.set(c.connectionId, clone(c)); }
  async getConnection(id: string) { const c = this.conns.get(id); return c ? clone(c) : null; }
  async deleteConnection(id: string) { this.conns.delete(id); }

  private spend(gameId: string, playerId: PlayerId, cost: number, expectClosed: number): SpendResult {
    const g = this.d(gameId);
    const p = g.players.get(playerId);
    if (!p || p.status !== 'active' || p.budget < cost) return 'insufficient';
    if (g.game.status !== 'campaign' || g.game.closedPhases !== expectClosed) return 'conflict';
    p.budget -= cost;
    return 'ok';
  }
  async addAction(gameId: string, playerId: PlayerId, cost: number, action: Action, expectClosed: number) {
    const r = this.spend(gameId, playerId, cost, expectClosed);
    if (r === 'ok') this.d(gameId).actions.push(clone(action));
    return r;
  }
  async listActions(gameId: string) {
    return [...(this.games.get(gameId)?.actions ?? [])].sort((a, b) => a.ts - b.ts).map(clone);
  }
  async addReport(gameId: string, playerId: PlayerId, cost: number, rep: StoredReport, expectClosed: number) {
    const r = this.spend(gameId, playerId, cost, expectClosed);
    if (r === 'ok') this.d(gameId).reports.push(clone(rep));
    return r;
  }
  async listReports(gameId: string, playerId: PlayerId) {
    return (this.games.get(gameId)?.reports ?? []).filter((r) => r.playerId === playerId).map(clone);
  }

  async putSeatResults(gameId: string, results: SeatResult[]) { for (const r of results) this.d(gameId).results.set(r.seat, clone(r)); }
  async listSeatResults(gameId: string) {
    return [...(this.games.get(gameId)?.results.values() ?? [])].sort((a, b) => a.seat - b.seat).map(clone);
  }
  async putCountPlan(gameId: string, plan: CountPlan) { this.d(gameId).plan = clone(plan); }
  async getCountPlan(gameId: string) { const p = this.games.get(gameId)?.plan; return p ? clone(p) : null; }

  async addChat(gameId: string, msg: StoredChat) { this.d(gameId).chat.push(clone(msg)); }
  async listChat(gameId: string) { return (this.games.get(gameId)?.chat ?? []).map(clone); }

  async putOffer(gameId: string, offer: CoalitionOffer) { this.d(gameId).offers.set(offer.offerId, clone(offer)); }
  async getOffer(gameId: string, offerId: string) { const o = this.games.get(gameId)?.offers.get(offerId); return o ? clone(o) : null; }
  async listOffers(gameId: string) {
    return [...(this.games.get(gameId)?.offers.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }
  async putGovernmentIfAbsent(gameId: string, g: Government) {
    const d = this.d(gameId);
    if (d.government) return false;
    d.government = clone(g);
    return true;
  }
  async getGovernment(gameId: string) { const g = this.games.get(gameId)?.government; return g ? clone(g) : null; }
  async putResultIfAbsent(gameId: string, r: FinalResult) {
    const d = this.d(gameId);
    if (d.result) return false;
    d.result = clone(r);
    return true;
  }
  async getResult(gameId: string) { const r = this.games.get(gameId)?.result; return r ? clone(r) : null; }
}
