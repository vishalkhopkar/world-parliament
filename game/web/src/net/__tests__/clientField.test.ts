// fieldCandidates / withdrawCandidates: one message with a clientRef, and the seats count as in flight until it is answered.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@hp/shared';
import type { Transport } from '../transport';
import { fieldCandidates, setTransport, withdrawCandidates } from '../client';
import { useStore } from '../../state/store';

const send = vi.fn<(m: ClientMessage) => void>();
beforeEach(() => { send.mockClear(); useStore.getState().reset(); setTransport({ send } as unknown as Transport); });

describe('fielding through the client', () => {
  it('fieldCandidates sends the seats with a clientRef and marks them in flight', () => {
    fieldCandidates([3, 4]);
    const m = send.mock.calls[0][0] as Extract<ClientMessage, { action: 'field' }>;
    expect(m.action).toBe('field');
    expect(m.seats).toEqual([3, 4]);
    expect(m.clientRef).toBeTruthy();
    expect([...useStore.getState().fieldPending].sort()).toEqual([3, 4]);
  });
  it('withdrawCandidates sends the seats with a clientRef', () => {
    withdrawCandidates([5]);
    const m = send.mock.calls[0][0] as Extract<ClientMessage, { action: 'withdraw' }>;
    expect(m.action).toBe('withdraw');
    expect(m.seats).toEqual([5]);
    expect(m.clientRef).toBeTruthy();
  });
  it('an empty list sends nothing', () => {
    fieldCandidates([]);
    withdrawCandidates([]);
    expect(send).not.toHaveBeenCalled();
  });
  it('the ack with the same clientRef ends the flight', () => {
    fieldCandidates([3]);
    const m = send.mock.calls[0][0] as Extract<ClientMessage, { action: 'field' }>;
    useStore.getState().applyServer({ type: 'fieldAck', clientRef: m.clientRef, ok: true, budget: 1, added: [{ seat: 3 }], removed: [] });
    expect(useStore.getState().fieldPending.size).toBe(0);
  });
});
