// Done fielding in the store: the snapshot's list, the live fieldingDone message with its counts, and what the campaign opening does with them.
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameSnapshot, GameTimeline, PlayerPublic, ServerMessage } from '@hp/shared';
import { useStore } from '../store';
import { doneProgress } from '../../lib/fielding';

const pl = (id: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status, party: { name: id, colour: '#1F5FBF', symbol: 'sun' } });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'preCampaign', phases: 1, timeline: null, players: [pl('a'), pl('b'), pl('c')], news: [], fielding: {}, fieldingDone: [],
  contestedSeats: 0, majority: 1, polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const apply = (m: ServerMessage) => useStore.getState().applyServer(m);
const done = (playerId: string, d: boolean, doneCount: number, needed = 3): ServerMessage => ({ type: 'fieldingDone', playerId, done: d, doneCount, needed });
const tl = (n: number): GameTimeline => ({ preCampaignEnd: n, campaignStart: n + 5, phaseCloses: [n + 100], campaignEnd: n + 100, countingEnd: n + 200, postCountingEnd: n + 300 });
const progress = () => doneProgress(useStore.getState().snapshot!, useStore.getState().doneStats);
beforeEach(() => { useStore.getState().reset(); useStore.setState({ me: 'a', snapshot: snap() } as never); });

describe('Done fielding in the store', () => {
  it('a fieldingDone message adds the player to the list and keeps its counts', () => {
    apply(done('b', true, 1));
    expect(useStore.getState().snapshot?.fieldingDone).toEqual(['b']);
    expect(progress()).toEqual({ doneCount: 1, needed: 3 });
  });
  it('a second message for the same player does not list them twice', () => {
    apply(done('b', true, 1));
    apply(done('b', true, 1));
    expect(useStore.getState().snapshot?.fieldingDone).toEqual(['b']);
  });
  it('a message with done false takes the player off the list', () => {
    apply(done('b', true, 1));
    apply(done('c', true, 2));
    apply(done('b', false, 1));
    expect(useStore.getState().snapshot?.fieldingDone).toEqual(['c']);
    expect(useStore.getState().doneStats).toEqual({ doneCount: 1, needed: 3 });
  });
  it('the snapshot of a fresh hello brings the list; the counts are then worked out from it and the connected players', () => {
    useStore.setState({ snapshot: snap({ fieldingDone: ['b'], players: [pl('a'), pl('b'), pl('c', 'disconnected')] }) } as never);
    expect(progress()).toEqual({ doneCount: 1, needed: 2 });
  });
  it('a hello forgets the counts of an earlier message', () => {
    apply(done('b', true, 1, 9));
    apply({ type: 'hello', snapshot: snap({ fieldingDone: ['b', 'c'] }), private: { you: 'a', budget: 1, myActions: [], myReports: [] }, serverTime: 1 } as never);
    expect(useStore.getState().doneStats).toBeNull();
    expect(progress()).toEqual({ doneCount: 2, needed: 3 });
  });
  it('a players message (someone dropped out) makes the counts be worked out again', () => {
    apply(done('b', true, 1, 3));
    apply({ type: 'players', players: [pl('a'), pl('b'), pl('c', 'disconnected')] });
    expect(progress()).toEqual({ doneCount: 1, needed: 2 });
  });
  it('the campaign opening, early or not, empties the list and brings the new timeline', () => {
    apply(done('b', true, 1));
    apply({ type: 'status', status: 'campaign', timeline: tl(1000) });
    expect(useStore.getState().snapshot?.fieldingDone).toEqual([]);
    expect(useStore.getState().snapshot?.timeline).toEqual(tl(1000));
    expect(useStore.getState().doneStats).toBeNull();
  });
  it('clearing your own Done locally lowers the shown count too', () => {
    apply(done('a', true, 2));
    useStore.getState().clearMyDone();
    expect(useStore.getState().snapshot?.fieldingDone).toEqual([]);
    expect(useStore.getState().doneStats).toEqual({ doneCount: 1, needed: 3 });
  });
});
