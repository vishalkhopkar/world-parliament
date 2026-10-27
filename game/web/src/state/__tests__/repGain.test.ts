import { beforeEach, describe, expect, it } from 'vitest';
import type { PrivateState } from '@hp/shared';
import { useStore } from '../store';

const priv = (reputation: PrivateState['reputation']): PrivateState => ({ you: 'a', budget: 100, myActions: [], myReports: [], reputation });
beforeEach(() => useStore.getState().reset());

describe('repGain after own rally/roadshow', () => {
  it('rally ack -> positive deltas new - old', () => {
    useStore.setState({ priv: priv({ 1: 10, 2: 4 }) } as never);
    useStore.getState().trackAction('r1', { type: 'rally', seat: 1 });
    useStore.getState().applyServer({ type: 'actionAck', clientRef: 'r1', ok: true, budget: 50, reputation: { 1: 30, 2: 4, 3: 1 } });
    const g = useStore.getState().repGain!;
    expect(g.type).toBe('rally'); expect(g.seat).toBe(1);
    expect(g.seats).toEqual({ 1: 20, 3: 1 });
  });
  it('roadshow ack, and a new key on every gain', () => {
    useStore.setState({ priv: priv({}) } as never);
    useStore.getState().trackAction('a', { type: 'roadshow', seat: 5 });
    useStore.getState().applyServer({ type: 'actionAck', clientRef: 'a', ok: true, budget: 50, reputation: { 5: 6 } });
    const g1 = useStore.getState().repGain!;
    expect(g1.type).toBe('roadshow'); expect(g1.seats).toEqual({ 5: 6 });
    useStore.getState().trackAction('b', { type: 'roadshow', seat: 5 });
    useStore.getState().applyServer({ type: 'actionAck', clientRef: 'b', ok: true, budget: 40, reputation: { 5: 12 } });
    expect(useStore.getState().repGain!.key).not.toBe(g1.key);
    expect(useStore.getState().repGain!.seats).toEqual({ 5: 6 });
  });
  it('untracked ack, or ack without reputation -> no gain; reset clears', () => {
    useStore.setState({ priv: priv({}) } as never);
    useStore.getState().applyServer({ type: 'actionAck', ok: true, budget: 50, reputation: { 5: 6 } });
    expect(useStore.getState().repGain).toBeNull();
    useStore.getState().trackAction('c', { type: 'rally', seat: 5 });
    useStore.getState().applyServer({ type: 'actionAck', clientRef: 'c', ok: true, budget: 50 });
    expect(useStore.getState().repGain).toBeNull();
    useStore.setState({ priv: priv({}) } as never);
    useStore.getState().trackAction('d', { type: 'rally', seat: 5 });
    useStore.getState().applyServer({ type: 'actionAck', clientRef: 'd', ok: true, budget: 50, reputation: { 5: 6 } });
    expect(useStore.getState().repGain).not.toBeNull();
    useStore.getState().reset();
    expect(useStore.getState().repGain).toBeNull();
  });
});
