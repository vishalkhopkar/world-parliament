import { beforeEach, describe, expect, it } from 'vitest';
import type { GlobalReports } from '@hp/shared';
import { useStore } from '../store';

const rep = (asOf: number): GlobalReports => ({ asOf, sampleIntervalMs: 30000, agencies: [{ id: 'kal-tak', name: 'Kal Tak', points: [{ t: 1, seats: { a: 10 } }], ranges: { a: [8, 12] } }] });

beforeEach(() => useStore.getState().reset());

describe('global reports in the store', () => {
  it('starts null, keeps the latest answer, clears on reset and new session', () => {
    expect(useStore.getState().globalReports).toBeNull();
    useStore.getState().applyServer({ type: 'globalReports', reports: rep(1) });
    useStore.getState().applyServer({ type: 'globalReports', reports: rep(2) });
    expect(useStore.getState().globalReports?.asOf).toBe(2);
    useStore.getState().setSession({ gameId: 'g2' } as never);
    expect(useStore.getState().globalReports).toBeNull();
    useStore.getState().applyServer({ type: 'globalReports', reports: rep(3) });
    useStore.getState().reset();
    expect(useStore.getState().globalReports).toBeNull();
  });
});
