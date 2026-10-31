// AgentSession: everything one AI player needs (GameClient + map package + persistence). One MCP server / daemon = one session.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MapConfig, PlayerPublic, SeatId } from '@hp/shared';
import { GameClient } from './client';
import type { ClientOptions, Session } from './client';
import { AgentError } from './errors';
import { loadGamePackage, loadSeatNames } from './gamePackage';
import { SeatDirectory } from './resolve';
import { configForMap } from './rules';

export interface SessionOptions extends ClientOptions {
  /** Persist {gameId, playerId, token} here so a restarted process rejoins. */
  sessionFile?: string;
  /** Inject a ready SeatDirectory (tests) instead of loading the map package from disk. */
  seats?: SeatDirectory;
}

export class AgentSession {
  readonly client: GameClient;
  /** Cursor used by wait_for_events when the caller does not pass since_cursor. */
  readCursor = 0;
  private seatDir: SeatDirectory | null;
  private phaseCache = new Map<number, Map<SeatId, number>>();
  readonly sessionFile?: string;
  private log: (m: string) => void;

  constructor(opts: SessionOptions = {}) {
    this.log = opts.log ?? (() => undefined);
    this.client = new GameClient(opts);
    this.sessionFile = opts.sessionFile;
    this.seatDir = opts.seats ?? null;
  }

  /** Try to rejoin from the session file (no-op when absent or stale). */
  async restore(): Promise<boolean> {
    if (!this.sessionFile || !existsSync(this.sessionFile)) return false;
    try {
      const s = JSON.parse(readFileSync(this.sessionFile, 'utf8')) as Session;
      if (!s.gameId || !s.token || !s.playerId) return false;
      await this.client.discover();
      if (s.server && s.server.replace(/\/+$/, '') !== this.client.server) return false;
      await this.client.resume(s);
      this.log(`restored session for game ${s.gameId}`);
      return true;
    } catch (e) {
      this.log('could not restore session: ' + (e as Error).message);
      if (e instanceof AgentError && (e.code === 'UNAUTHORIZED' || e.code === 'NOT_FOUND')) this.clearPersisted();
      return false;
    }
  }

  private lastRestoreTry = 0;
  /** If we should be in a game (session file exists) but are not attached, e.g. the server was down at start-up, try again (at most every 5 s). */
  async maybeRestore(): Promise<void> {
    if (this.joined || !this.sessionFile || !existsSync(this.sessionFile) || Date.now() - this.lastRestoreTry < 5000) return;
    this.lastRestoreTry = Date.now();
    await this.restore();
  }

  persist(): void {
    const s = this.client.session;
    if (!this.sessionFile || !s) return;
    try {
      mkdirSync(dirname(this.sessionFile), { recursive: true });
      writeFileSync(this.sessionFile, JSON.stringify(s, null, 2));
    } catch (e) { this.log('could not persist session: ' + (e as Error).message); }
  }

  clearPersisted(): void {
    if (this.sessionFile && existsSync(this.sessionFile)) { try { unlinkSync(this.sessionFile); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------------ derived info
  get joined(): boolean { return this.client.session !== null; }

  mapId(): string | null {
    const st = this.client.state;
    return st.snapshot?.mapId ?? st.lobby?.mapId ?? null;
  }

  cfg(): MapConfig { return configForMap(this.mapId()); }

  players(): PlayerPublic[] {
    const st = this.client.state;
    return st.snapshot?.players ?? st.lobby?.players ?? [];
  }

  player(id: string): PlayerPublic | undefined { return this.players().find((p) => p.playerId === id); }

  /** party name for display (nickname only while party-less; falls back to the id). */
  nameOf(id: string): string { const p = this.player(id); return p ? (p.party?.name ?? p.nickname) : id; }

  /** Loaded seat directory or null when the map package is unavailable. */
  async seatsOrNull(): Promise<SeatDirectory | null> {
    if (this.seatDir) return this.seatDir;
    const id = this.mapId();
    if (!id) return null;
    const pkg = await loadGamePackage(id);
    if (pkg) this.seatDir = new SeatDirectory(pkg, loadSeatNames(id));
    return this.seatDir;
  }

  async seats(): Promise<SeatDirectory> {
    const d = await this.seatsOrNull();
    if (!d) throw new AgentError('NO_MAP', `Cannot load the map package for "${this.mapId() ?? 'unknown map'}".`);
    return d;
  }

  /** 0-based polling phase of every seat for the game's number of phases. */
  phaseMap(dir: SeatDirectory): Map<SeatId, number> {
    // the timeline is authoritative: the lobby snapshot can be stale if the host changed the number of phases after we joined
    const st = this.client.state;
    const phases = st.snapshot?.timeline?.phaseCloses.length ?? st.snapshot?.phases ?? st.lobby?.phases ?? 1;
    let m = this.phaseCache.get(phases);
    if (!m) {
      m = new Map();
      const groups = dir.pkg.phaseGroups[String(phases)] ?? [];
      groups.forEach((g, i) => g.forEach((id) => m!.set(id, i)));
      this.phaseCache.set(phases, m);
    }
    return m;
  }

  /** Is this 0-based phase closed (known closed, or its deadline passed more than 1 s ago on our estimate of the server clock)? */
  phaseClosed(p: number): boolean {
    const st = this.client.state;
    if (st.polledPhases.has(p)) return true;
    const tl = st.snapshot?.timeline;
    return !!tl && tl.phaseCloses[p] !== undefined && tl.phaseCloses[p] <= this.client.serverNow() - 1000;
  }
}
