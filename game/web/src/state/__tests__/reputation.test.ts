import { beforeEach, describe, expect, it } from 'vitest';
import type { PrivateState } from '@hp/shared';
import { useStore } from '../store';

const priv = (reputation?: PrivateState['reputation']): PrivateState => ({ you: 'a', budget: 100, myActions: [], myReports: [], reputation });

beforeEach(() => useStore.getState().reset());

describe('own reputation in the store', () => {
  it('an actionAck with reputation updates priv.reputation at once', () => {
    useStore.setState({ priv: priv({}) } as never);
    useStore.getState().applyServer({ type: 'actionAck', ok: true, budget: 80, reputation: { 3: 10 } });
    expect(useStore.getState().priv?.reputation).toEqual({ 3: 10 });
    expect(useStore.getState().priv?.budget).toBe(80);
  });
  it('an ack without reputation keeps the old values', () => {
    useStore.setState({ priv: priv({ 3: 10 }) } as never);
    useStore.getState().applyServer({ type: 'actionAck', ok: true, budget: 80 });
    expect(useStore.getState().priv?.reputation).toEqual({ 3: 10 });
  });
  it('an actionAck carries the server nextRallyAt into priv (kept when absent)', () => {
    useStore.setState({ priv: priv({}) } as never);
    useStore.getState().applyServer({ type: 'actionAck', ok: true, budget: 80, nextRallyAt: 5000 });
    expect(useStore.getState().priv?.nextRallyAt).toBe(5000);
    useStore.getState().applyServer({ type: 'actionAck', ok: true, budget: 70 });
    expect(useStore.getState().priv?.nextRallyAt).toBe(5000);
  });
});
