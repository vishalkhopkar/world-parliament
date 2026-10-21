import { beforeEach, describe, expect, it } from 'vitest';
import type { SeatSharesMessage } from '@hp/shared';
import { useStore } from '../store';

const msg = (seat: number, status: 'leading' | 'won', shares: Record<string, number>, candidates?: Record<string, string>): SeatSharesMessage =>
  ({ type: 'seatShares', seat, status, shares, ...(candidates ? { candidates } : {}) });

beforeEach(() => useStore.getState().reset());

describe('seat vote shares in the store (answers to peekSeat)', () => {
  it('starts empty', () => {
    expect(useStore.getState().seatShares).toEqual({});
  });

  it('keeps the latest answer per seat, replacing an older one for the same seat', () => {
    const { applyServer } = useStore.getState();
    applyServer(msg(7, 'leading', { a: 0.6, b: 0.4 }));
    applyServer(msg(9, 'leading', { a: 0.2, b: 0.8 }));
    applyServer(msg(7, 'leading', { a: 0.55, b: 0.45 }, { a: 'Asha', b: 'Bhim' }));
    const s = useStore.getState().seatShares;
    expect(Object.keys(s).sort()).toEqual(['7', '9']);
    expect(s[7]).toMatchObject({ status: 'leading', shares: { a: 0.55, b: 0.45 }, candidates: { a: 'Asha', b: 'Bhim' } });
  });

  it('a seat that has been confirmed replaces its lead answer', () => {
    const { applyServer } = useStore.getState();
    applyServer(msg(3, 'leading', { a: 0.5, b: 0.5 }));
    applyServer(msg(3, 'won', { a: 0.7, b: 0.3 }));
    expect(useStore.getState().seatShares[3]).toMatchObject({ status: 'won', shares: { a: 0.7, b: 0.3 } });
  });

  it('is forgotten when the player leaves or joins another game', () => {
    useStore.getState().applyServer(msg(3, 'won', { a: 1 }));
    useStore.getState().setSession({ gameId: 'g2', token: 't', me: 'p', joinCode: 'X' });
    expect(useStore.getState().seatShares).toEqual({});
    useStore.getState().applyServer(msg(3, 'won', { a: 1 }));
    useStore.getState().reset();
    expect(useStore.getState().seatShares).toEqual({});
  });
});
