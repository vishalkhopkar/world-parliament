import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameSnapshot, SeatDeclaration, ServerMessage } from '@hp/shared';
import type { Transport } from '../transport';

const decl = (seat: number, status: 'won' | 'leading' = 'won'): SeatDeclaration => ({ seat, playerId: 'p1', status } as SeatDeclaration);
const tally = (declared: number) => ({ leads: {}, wins: { p1: declared }, declared, total: 5 });
const update = (seat: number, declared: number, status: 'won' | 'leading' = 'won'): ServerMessage =>
  ({ type: 'seatUpdate', declaration: decl(seat, status), tally: tally(declared) });

describe('counting gap self-heal (missed seatUpdate frames must not leave undeclared seats on the map)', () => {
  let mod: typeof import('../client');
  let store: typeof import('../../state/store');
  let t: Transport & { reconnect: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    window.history.pushState({}, '', '/?server=https://api.test'); // real (remote) transport selected
    mod = await import('../client');
    store = await import('../../state/store');
    t = { reconnect: vi.fn(), connect: vi.fn(), send: vi.fn(), disconnect: vi.fn() } as never;
    mod.setTransport(t);
    store.useStore.setState({
      snapshot: { gameId: 'g', mapId: 'm', status: 'counting', phases: 1, timeline: null, players: [], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null } as unknown as GameSnapshot,
    });
  });
  afterEach(() => { vi.useRealTimers(); window.history.pushState({}, '', '/'); });

  it('countingGap: true only when the tally claims more declared seats than the map holds', () => {
    const snap = (declared: number, won: number) => ({ tally: tally(declared), seats: Object.fromEntries(Array.from({ length: won }, (_, i) => [i + 1, decl(i + 1)])) }) as unknown as GameSnapshot;
    expect(mod.countingGap(snap(5, 5))).toBe(false);
    expect(mod.countingGap(snap(5, 3))).toBe(true);
    expect(mod.countingGap({ tally: null, seats: {} } as unknown as GameSnapshot)).toBe(false);
  });

  it('resyncs (reconnects) when the gap persists after the frames stop arriving', () => {
    mod.onServerMessage(update(1, 5));   // tally says 5 declared, but the client only holds seat 1
    vi.advanceTimersByTime(3_000);
    expect(t.reconnect).not.toHaveBeenCalled(); // frames of one step arrive together: give them time
    vi.advanceTimersByTime(2_000);
    expect(t.reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when every declared seat arrived', () => {
    for (let i = 1; i <= 5; i++) mod.onServerMessage(update(i, i));
    vi.advanceTimersByTime(10_000);
    expect(t.reconnect).not.toHaveBeenCalled();
  });

  it('does not hammer the server: at most one resync per 20 seconds', () => {
    mod.onServerMessage(update(1, 5));
    vi.advanceTimersByTime(5_000);
    mod.onServerMessage(update(1, 5));
    vi.advanceTimersByTime(5_000);
    expect(t.reconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    mod.onServerMessage(update(1, 5));
    vi.advanceTimersByTime(5_000);
    expect(t.reconnect).toHaveBeenCalledTimes(2);
  });
});
