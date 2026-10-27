// ?tour picks the offline TourTransport, never a server, and never saves or resumes a session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gridPackage } from '../../../test/fakePackage';

const pkg = gridPackage(8, 8);

async function load(search: string) {
  vi.resetModules();
  window.history.replaceState({}, '', '/' + search);
  const client = await import('../client');
  const { TourTransport } = await import('../tour');
  const { MockTransport } = await import('../mock');
  const store = (await import('../../state/store')).useStore;
  const tour = (await import('../../tour/tourStore')).useTour;
  const boot = await import('../../tour/boot');
  return { client, TourTransport, MockTransport, store, tour, boot };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('transport selection', () => {
  it('?tour uses the TourTransport', async () => {
    const { client, TourTransport } = await load('?tour');
    expect(client.isTour).toBe(true);
    expect(client.isRemote).toBe(false);
    expect(client.transport).toBeInstanceOf(TourTransport);
  });

  it('?tour wins over ?server and ?mock: the tour is offline', async () => {
    const { client, TourTransport } = await load('?tour&server=local&mock');
    expect(client.isRemote).toBe(false);
    expect(client.transport).toBeInstanceOf(TourTransport);
    const b = await load('?server=local&tour');
    expect(b.client.isRemote).toBe(false);
    expect(b.client.transport).toBeInstanceOf(b.TourTransport);
  });

  it('without ?tour nothing changes: the in-browser mock, or the real server with ?server', async () => {
    const a = await load('');
    expect(a.client.isTour).toBe(false);
    expect(a.client.transport).toBeInstanceOf(a.MockTransport);
    const b = await load('?server=local');
    expect(b.client.isTour).toBe(false);
    expect(b.client.isRemote).toBe(true);
  });
});

describe('tour session', () => {
  it('never resumes a saved game and never saves one', async () => {
    localStorage.setItem('hp.session', JSON.stringify({ gameId: 'g1', playerId: 'p1', token: 't', joinCode: 'ABCD' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => pkg })));
    const { client, store } = await load('?tour');
    expect(await client.resumeSession()).toBe(false);
    await client.createGame('You', 1, 'world-500');
    expect(store.getState().gameId).toBeTruthy();
    expect(localStorage.getItem('hp.session')).toBe(JSON.stringify({ gameId: 'g1', playerId: 'p1', token: 't', joinCode: 'ABCD' })); // untouched
  });

  it('startTourGame creates the practice game, switches the overlay and the frozen clock on, and delivers the first state', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => pkg }));
    vi.stubGlobal('fetch', fetchMock);
    const { store, tour, boot } = await load('?tour');
    await boot.startTourGame();
    expect(tour.getState().active).toBe(true);
    expect(tour.getState().frozenClock).toBe(true);
    await vi.waitFor(() => expect(store.getState().snapshot?.status).toBe('campaign'));
    expect(store.getState().snapshot?.players).toHaveLength(9);
    expect(store.getState().priv?.committed?.length).toBeGreaterThan(0);
    // only the map package was fetched: no server call
    expect(fetchMock.mock.calls.every(c => String((c as unknown[])[0]).includes('/maps/'))).toBe(true);
    // a second call (React StrictMode) does not start another game
    const gameId = store.getState().gameId;
    await boot.startTourGame();
    expect(store.getState().gameId).toBe(gameId);
  });

  it('leaving the tour goes to the home page without ?tour', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => pkg })));
    const { client } = await load('?tour');
    await client.createGame('You', 1, 'world-500');
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...real, pathname: '/play/', search: '?tour', assign } });
    try {
      client.leaveGame();
      expect(assign).toHaveBeenCalledWith('/play/');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real });
    }
  });
});
