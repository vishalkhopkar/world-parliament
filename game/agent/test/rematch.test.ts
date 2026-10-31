// Rematch ("play again") in the agent: offline, with a scripted fake WebSocket (no server, no port).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameSnapshot, LobbyView, ServerMessage } from '@hp/shared';
import { WORLD_CONFIG } from '@hp/shared';
import { AgentSession } from '../src/session';
import { call, sleep, until } from './helpers';
import { players4, seatDir } from './fake';

const cfg = WORLD_CONFIG;

const hooks = { nextOf: (_g: string): { id: string; code: string } | undefined => undefined };

class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private helloed = false;
  gameId: string;
  constructor(public url: string) {
    FakeWS.all.push(this);
    this.gameId = new URL(url).searchParams.get('gameId') ?? '';
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0);
  }
  emit(m: unknown): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  send(d: string): void {
    const m = JSON.parse(d);
    this.sent.push(m);
    if (m.action === 'ping') {
      if (!this.helloed) { this.helloed = true; this.emit(helloFor(this.gameId, hooks.nextOf(this.gameId))); }
      else this.emit({ type: 'pong', clientTime: m.clientTime, serverTime: Date.now() });
    } else if (m.action === 'campaign') this.emit({ type: 'actionAck', clientRef: m.clientRef, ok: true, budget: cfg.budget - 1 });
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

function snapshotFor(gameId: string, status: GameSnapshot['status'], next?: { id: string; code: string }): GameSnapshot {
  const now = Date.now();
  return {
    gameId, mapId: 'world-500', status, phases: 2, players: players4(), news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null,
    timeline: { campaignStart: now - 1000, phaseCloses: [now + 100_000, now + 200_000], campaignEnd: now + 200_000, countingEnd: now + 260_000, postCountingEnd: now + 320_000 },
    ...(next ? { nextGameId: next.id, nextJoinCode: next.code } : {}),
  };
}
function helloFor(gameId: string, next?: { id: string; code: string }): ServerMessage {
  return {
    type: 'hello', serverTime: Date.now(), features: ['actionRef', 'rematch'], snapshot: snapshotFor(gameId, gameId === 'g1' ? 'finished' : 'campaign', next),
    private: { you: 'me', budget: gameId === 'g1' ? 0 : cfg.budget, myActions: [], myReports: [] },
  };
}

let dir: string;
let file: string;
let lobbyNext: { id: string; code: string } | undefined;
const fetchImpl = (async (url: string) => {
  const id = String(url).split('/games/')[1];
  const lobby: LobbyView = {
    gameId: id, joinCode: id === 'g1' ? 'OLD111' : 'NEW222', mapId: 'world-500', phases: 2, status: id === 'g1' ? 'finished' : 'campaign', admissionOpen: false,
    you: 'me', players: players4(), ...(id === 'g1' && lobbyNext ? { nextGameId: lobbyNext.id, nextJoinCode: lobbyNext.code } : {}),
  };
  return new Response(JSON.stringify(lobby), { status: 200 });
}) as unknown as typeof fetch;

const mk = async (): Promise<AgentSession> =>
  new AgentSession({ server: 'http://localhost:8787', ws: 'ws://localhost:8787/ws', seats: await seatDir(), sessionFile: file, fetchImpl, reconnectBaseMs: 20, pingMs: 60_000 });
const writeSession = (gameId: string, joinCode: string) =>
  writeFileSync(file, JSON.stringify({ server: 'http://localhost:8787', gameId, playerId: 'me', token: 'tok', joinCode, nickname: 'Claude' }));
const readSession = () => JSON.parse(readFileSync(file, 'utf8'));
const live = () => FakeWS.all.filter((w) => w.readyState === 1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hp-rematch-'));
  file = join(dir, 's.json');
  FakeWS.all = [];
  lobbyNext = undefined;
  hooks.nextOf = () => undefined;
  vi.stubGlobal('WebSocket', FakeWS);
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('rematch push message', () => {
  it('switches to the new game, rewrites the session file, logs a rematch event and campaigning works there', async () => {
    writeSession('g1', 'OLD111');
    const s = await mk();
    expect(await s.restore()).toBe(true);
    await until(() => s.client.state.snapshot?.gameId === 'g1', 2000, 'hello of the old game');
    expect(s.client.state.snapshot?.status).toBe('finished');
    const cursor = s.client.events.cursor;
    const oldWs = live()[0];

    oldWs.emit({ type: 'rematch', gameId: 'g2', joinCode: 'NEW222' });
    await until(() => s.client.state.snapshot?.gameId === 'g2', 2000, 'hello of the new game');

    // identity kept, game switched, old socket closed, per-game state replaced by the new game's
    expect(s.client.session).toMatchObject({ gameId: 'g2', joinCode: 'NEW222', playerId: 'me', token: 'tok', nickname: 'Claude' });
    expect(s.client.state.joinCode).toBe('NEW222');
    expect(s.client.state.snapshot?.status).toBe('campaign');
    expect(s.client.state.priv?.budget).toBe(cfg.budget);
    expect(s.client.state.features).toContain('actionRef');
    expect(oldWs.readyState).toBe(3);
    expect(live().map((w) => w.gameId)).toEqual(['g2']);
    expect(s.client.lostReason).toBeNull();
    expect(readSession()).toMatchObject({ gameId: 'g2', joinCode: 'NEW222', playerId: 'me', token: 'tok' });

    // wait_for_events returns the rematch event, with the previous game
    const w = await call(s, 'wait_for_events', { since_cursor: cursor, timeout_s: 2, types: ['rematch'] });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: 'rematch', game_id: 'g2', join_code: 'NEW222', previous_game_id: 'g1' });
    expect(JSON.stringify(w.events[0])).toMatch(/campaign/);
    expect(w.hint_state.status).toBe('campaign');

    // campaign_batch is sent on the NEW game's socket
    const r = await call(s, 'campaign_batch', { actions: [{ type: 'roadshow', seat: 1 }] });
    expect(r.results[0].ok).toBe(true);
    expect(live()[0].sent.some((m) => m.action === 'campaign')).toBe(true);
    expect(live()[0].url).toContain('gameId=g2');
    s.client.close();
  });

  it('a duplicate rematch for the game we are already in is ignored', async () => {
    writeSession('g1', 'OLD111');
    const s = await mk();
    await s.restore();
    await until(() => !!s.client.state.snapshot, 2000);
    live()[0].emit({ type: 'rematch', gameId: 'g2', joinCode: 'NEW222' });
    await until(() => s.client.state.snapshot?.gameId === 'g2', 2000);
    const n = FakeWS.all.length;
    live()[0].emit({ type: 'rematch', gameId: 'g2', joinCode: 'NEW222' });
    await sleep(50);
    expect(FakeWS.all.length).toBe(n);
    expect(s.client.events.since(0, { types: ['rematch'] }).events).toHaveLength(1);
    s.client.close();
  });
});

describe('missed push: REST / hello fallbacks', () => {
  it('restore() of a session whose game already has a follow-up game follows it', async () => {
    lobbyNext = { id: 'g2', code: 'NEW222' };
    writeSession('g1', 'OLD111');
    const s = await mk();
    expect(await s.restore()).toBe(true);
    await until(() => s.client.state.snapshot?.gameId === 'g2', 2000, 'new game hello');
    expect(s.client.session?.gameId).toBe('g2');
    expect(readSession()).toMatchObject({ gameId: 'g2', joinCode: 'NEW222', token: 'tok' });
    expect(live().map((w) => w.gameId)).toEqual(['g2']);
    s.client.close();
  });

  it('hello of the old game carrying nextGameId follows it', async () => {
    writeSession('g1', 'OLD111');
    hooks.nextOf = (g) => (g === 'g1' ? { id: 'g2', code: 'NEW222' } : undefined);
    const s = await mk();
    await s.restore();
    await until(() => s.client.state.snapshot?.gameId === 'g2', 2000, 'followed via hello');
    expect(readSession().gameId).toBe('g2');
    s.client.close();
  });

  it('a finished game keeps a live link: a dropped socket reconnects and finds the follow-up game by REST', async () => {
    writeSession('g1', 'OLD111');
    const s = await mk();
    await s.restore();
    await until(() => s.client.state.snapshot?.status === 'finished', 2000);
    lobbyNext = { id: 'g2', code: 'NEW222' }; // the host plays again while we are offline
    live()[0].close();
    await until(() => s.client.state.snapshot?.gameId === 'g2', 15_000, 'reconnect + follow');
    expect(s.client.state.link).not.toBe('closed');
    s.client.close();
  }, 20_000);

  it('a finished game does not go permanently closed after a dropped socket', async () => {
    writeSession('g1', 'OLD111');
    const s = await mk();
    await s.restore();
    await until(() => s.client.state.snapshot?.status === 'finished', 2000);
    const n = FakeWS.all.length;
    live()[0].close();
    await until(() => FakeWS.all.length > n, 15_000, 'reconnect attempt');
    expect(s.client.lostReason).toBeNull();
    s.client.close();
  }, 20_000);

  it('leave_game still forgets the session file', async () => {
    writeSession('g1', 'OLD111');
    const s = await mk();
    await s.restore();
    await call(s, 'leave_game');
    expect(existsSync(file)).toBe(false);
  });
});
