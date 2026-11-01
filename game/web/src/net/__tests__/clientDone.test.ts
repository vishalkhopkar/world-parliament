// doneFielding through the client: one message with the explicit value and a clientRef; fielding or withdrawing while Done takes your own Done back at once.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, GameSnapshot } from '@hp/shared';
import type { Transport } from '../transport';
import { doneFielding, fieldCandidates, setTransport, withdrawCandidates } from '../client';
import { useStore } from '../../state/store';

const send = vi.fn<(m: ClientMessage) => void>();
const snap = (fieldingDone: string[]): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'preCampaign', phases: 1, timeline: null, players: [], news: [], fielding: {}, fieldingDone,
  contestedSeats: 0, majority: 1, polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null,
});
beforeEach(() => { send.mockClear(); useStore.getState().reset(); setTransport({ send } as unknown as Transport); });

describe('doneFielding through the client', () => {
  it('sends the explicit value with a clientRef', () => {
    doneFielding(true);
    doneFielding(false);
    const [a, b] = send.mock.calls.map(c => c[0] as Extract<ClientMessage, { action: 'doneFielding' }>);
    expect(a).toMatchObject({ action: 'doneFielding', done: true });
    expect(b).toMatchObject({ action: 'doneFielding', done: false });
    expect(a.clientRef).toBeTruthy();
    expect(b.clientRef).not.toBe(a.clientRef);
  });
  it('a refused Done shows the server message as one toast', () => {
    doneFielding(true);
    const m = send.mock.calls[0][0] as Extract<ClientMessage, { action: 'doneFielding' }>;
    useStore.getState().applyServer({ type: 'error', clientRef: m.clientRef, error: 'BAD_REQUEST', message: 'Field a candidate first' });
    expect(useStore.getState().error).toBe('Field a candidate first');
  });
  it('fielding while Done takes your own Done back at once, before the server confirms', () => {
    useStore.setState({ me: 'a', snapshot: snap(['a', 'b']) } as never);
    fieldCandidates([3]);
    expect(useStore.getState().snapshot?.fieldingDone).toEqual(['b']);
  });
  it('withdrawing while Done takes your own Done back at once', () => {
    useStore.setState({ me: 'a', snapshot: snap(['a']) } as never);
    withdrawCandidates([3]);
    expect(useStore.getState().snapshot?.fieldingDone).toEqual([]);
  });
  it('fielding when you are not Done changes nothing', () => {
    useStore.setState({ me: 'a', snapshot: snap(['b']) } as never);
    fieldCandidates([3]);
    expect(useStore.getState().snapshot?.fieldingDone).toEqual(['b']);
  });
});
