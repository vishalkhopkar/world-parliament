import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../transport';

const SAVED = { gameId: 'g1', playerId: 'p1', token: 't', joinCode: 'HP1234' };
const lobby = (gameId: string, extra: object = {}) => ({ gameId, joinCode: gameId === 'g1' ? 'HP1234' : 'HP5678', status: 'finished', players: [{ playerId: 'p1', status: 'active' }], ...extra });

async function load() {
  vi.resetModules();
  window.history.replaceState({}, '', '/?server=https://api.test');
  const client = await import('../client');
  const store = await import('../../state/store');
  const rematch = vi.fn(async () => ({ gameId: 'g2', joinCode: 'HP5678' }));
  const getLobby = vi.fn(async (id: string) => (id === 'g1' ? lobby('g1', { nextGameId: 'g2', nextJoinCode: 'HP5678' }) : lobby('g2', { status: 'campaign' })));
  const connect = vi.fn();
  const disconnect = vi.fn();
  client.setTransport({ getLobby, rematch, connect, disconnect, send: vi.fn() } as unknown as Transport);
  return { client, useStore: store.useStore, selectScreen: (store as unknown as { selectScreen?: (s: unknown) => string }).selectScreen, rematch, getLobby, connect, disconnect };
}

beforeEach(() => localStorage.setItem('hp.session', JSON.stringify(SAVED)));
afterEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); });

describe('rematch session switch', () => {
  it('playAgain calls the REST endpoint then moves to the new game with the same token and player', async () => {
    const { client, useStore, rematch, connect, disconnect } = await load();
    useStore.getState().setSession({ gameId: 'g1', token: 't', me: 'p1', joinCode: 'HP1234' });
    useStore.setState({ chat: [{ id: 'c' } as never], seatShares: { 3: {} as never }, polledSeats: [3], selectedSeat: 3, globalReports: {} as never });
    expect(await client.playAgain(3)).toBe(true);
    expect(rematch).toHaveBeenCalledWith('g1', 't', { phases: 3 });
    const s = useStore.getState();
    expect([s.gameId, s.token, s.me, s.joinCode]).toEqual(['g2', 't', 'p1', 'HP5678']);
    expect(connect).toHaveBeenCalledWith('g2', 't', expect.any(Function), expect.any(Function));
    expect(s.chat).toEqual([]); expect(s.seatShares).toEqual({}); expect(s.polledSeats).toEqual([]);
    expect(s.selectedSeat).toBeNull(); expect(s.globalReports).toBeNull(); expect(s.snapshot).toBeNull();
    expect(JSON.parse(localStorage.getItem('hp.session')!)).toEqual({ gameId: 'g2', playerId: 'p1', token: 't', joinCode: 'HP5678' });
    expect(disconnect).not.toHaveBeenCalled(); // never "leaves"
  });

  it('a pushed rematch message switches, and a duplicate (REST answer plus push) does not switch twice', async () => {
    const { client, useStore, connect } = await load();
    useStore.getState().setSession({ gameId: 'g1', token: 't', me: 'p1', joinCode: 'HP1234' });
    client.onServerMessage({ type: 'rematch', gameId: 'g2', joinCode: 'HP5678' });
    client.onServerMessage({ type: 'rematch', gameId: 'g2', joinCode: 'HP5678' });
    expect(useStore.getState().gameId).toBe('g2');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a hello of a finished game that has a successor switches to it', async () => {
    const { client, useStore } = await load();
    useStore.getState().setSession({ gameId: 'g1', token: 't', me: 'p1', joinCode: 'HP1234' });
    client.onServerMessage({ type: 'hello', serverTime: 0, snapshot: { gameId: 'g1', status: 'finished', nextGameId: 'g2', nextJoinCode: 'HP5678', players: [], seats: {} } as never, private: null as never });
    expect(useStore.getState().gameId).toBe('g2');
  });

  it('a hello of the new game in campaign routes to the Campaign screen', async () => {
    const { client, useStore, selectScreen } = await load();
    useStore.getState().setSession({ gameId: 'g2', token: 't', me: 'p1', joinCode: 'HP5678' });
    client.onServerMessage({ type: 'hello', serverTime: 0, snapshot: { gameId: 'g2', status: 'campaign', players: [], seats: {} } as never, private: null as never });
    expect(useStore.getState().snapshot?.status).toBe('campaign');
    if (selectScreen) expect(selectScreen(useStore.getState())).toBe('campaign');
  });

  it('playAgain failure shows the error and stays in the old game', async () => {
    const { client, useStore, rematch } = await load();
    const { ApiException } = await import('../transport');
    rematch.mockRejectedValueOnce(new ApiException('FORBIDDEN', 'Admin only'));
    useStore.getState().setSession({ gameId: 'g1', token: 't', me: 'p1', joinCode: 'HP1234' });
    expect(await client.playAgain(2)).toBe(false);
    expect(useStore.getState().error).toBe('Admin only');
    expect(useStore.getState().gameId).toBe('g1');
  });

  it('resumeSession follows nextGameId from the saved game (same token)', async () => {
    const { client, useStore, getLobby, connect } = await load();
    expect(await client.resumeSession()).toBe(true);
    expect(getLobby).toHaveBeenCalledWith('g2', 't');
    expect(useStore.getState().gameId).toBe('g2');
    expect(useStore.getState().joinCode).toBe('HP5678');
    expect(connect).toHaveBeenCalledWith('g2', 't', expect.any(Function), expect.any(Function));
    expect(JSON.parse(localStorage.getItem('hp.session')!).gameId).toBe('g2');
  });

  it('resumeSession falls back to the old game if the next one cannot be read', async () => {
    const { client, useStore, getLobby } = await load();
    getLobby.mockImplementation(async (id: string) => { if (id === 'g2') throw new Error('x'); return lobby('g1', { nextGameId: 'g2' }); });
    expect(await client.resumeSession()).toBe(true);
    expect(useStore.getState().gameId).toBe('g1');
  });
});
