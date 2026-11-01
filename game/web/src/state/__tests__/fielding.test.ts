// The store follows the pre-campaign: its screen, fieldAck (budget, own smoke) and fieldingUpdate (who is where, contested seats, majority).
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameSnapshot, PrivateState } from '@hp/shared';
import { currentScreen, useStore } from '../store';

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'preCampaign', phases: 1, timeline: null, players: [], news: [], fielding: {}, contestedSeats: 0, majority: 1,
  polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv: PrivateState = { you: 'a', budget: 1000, myActions: [], myReports: [] };
const st = () => useStore.getState();
const apply = (m: Parameters<ReturnType<typeof st>['applyServer']>[0]) => st().applyServer(m);

beforeEach(() => { st().reset(); useStore.setState({ gameId: 'g', me: 'a', snapshot: snap(), priv } as never); });

describe('pre-campaign in the store', () => {
  it('the pre-campaign status has its own screen', () => {
    expect(currentScreen(st())).toBe('preCampaign');
  });
  it("fieldingUpdate records anybody's candidates with the new contested seats and majority", () => {
    apply({ type: 'fieldingUpdate', playerId: 'b', added: [{ seat: 3, name: 'Ravi' }], removed: [], contestedSeats: 1, majority: 1 });
    expect(st().snapshot!.fielding[3]).toEqual([{ playerId: 'b', name: 'Ravi' }]);
    expect(st().snapshot!.contestedSeats).toBe(1);
    apply({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 4 }, { seat: 5 }, { seat: 6 }], removed: [], contestedSeats: 4, majority: 3 });
    expect(st().snapshot!.majority).toBe(3);
    apply({ type: 'fieldingUpdate', playerId: 'b', added: [], removed: [3], contestedSeats: 3, majority: 2 });
    expect(st().snapshot!.fielding[3]).toBeUndefined();
    expect(st().snapshot!.contestedSeats).toBe(3);
  });
  it('a fieldingUpdate from someone else makes no smoke and leaves the budget alone', () => {
    apply({ type: 'fieldingUpdate', playerId: 'b', added: [{ seat: 3 }], removed: [], contestedSeats: 1, majority: 1 });
    expect(st().fieldFx).toBeNull();
    expect(st().priv!.budget).toBe(1000);
  });
  it('fieldAck sets the budget and fires the smoke on each seat, with a new key each time', () => {
    apply({ type: 'fieldAck', ok: true, budget: 900, added: [{ seat: 1 }, { seat: 2 }], removed: [] });
    expect(st().priv!.budget).toBe(900);
    const fx = st().fieldFx!;
    expect(fx.spent).toEqual([1, 2]);
    expect(fx.refunded).toEqual([]);
    apply({ type: 'fieldAck', ok: true, budget: 950, added: [], removed: [2] });
    expect(st().fieldFx!.refunded).toEqual([2]);
    expect(st().fieldFx!.key).not.toBe(fx.key);
  });
  it('the ack and the broadcast of the same change do not double the candidate, in either order', () => {
    apply({ type: 'fieldAck', ok: true, budget: 950, added: [{ seat: 1, name: 'Asha' }], removed: [] });
    apply({ type: 'fieldingUpdate', playerId: 'a', added: [{ seat: 1, name: 'Asha' }], removed: [], contestedSeats: 1, majority: 1 });
    expect(st().snapshot!.fielding[1]).toEqual([{ playerId: 'a', name: 'Asha' }]);
    apply({ type: 'fieldingUpdate', playerId: 'a', added: [{ seat: 2 }], removed: [], contestedSeats: 2, majority: 2 });
    apply({ type: 'fieldAck', ok: true, budget: 900, added: [{ seat: 2 }], removed: [] });
    expect(st().snapshot!.fielding[2]).toEqual([{ playerId: 'a' }]);
  });
  it('a duplicate ack fires no smoke', () => {
    apply({ type: 'fieldAck', ok: true, duplicate: true, budget: 950, added: [{ seat: 1 }], removed: [] });
    expect(st().fieldFx).toBeNull();
    expect(st().priv!.budget).toBe(950);
  });
  it('an ack with no change (every seat skipped) fires no smoke', () => {
    apply({ type: 'fieldAck', ok: true, budget: 1000, added: [], removed: [] });
    expect(st().fieldFx).toBeNull();
  });
  it('seats stay in flight until their ack arrives', () => {
    st().trackField('r1', [1, 2]);
    st().trackField('r2', [3]);
    expect([...st().fieldPending].sort()).toEqual([1, 2, 3]);
    apply({ type: 'fieldAck', clientRef: 'r1', ok: true, budget: 900, added: [{ seat: 1 }, { seat: 2 }], removed: [] });
    expect([...st().fieldPending]).toEqual([3]);
  });
  it('an error with the clientRef lets go of its seats and shows the message', () => {
    st().trackField('r1', [1]);
    apply({ type: 'error', error: 'INSUFFICIENT_FUNDS', message: 'No money', clientRef: 'r1' });
    expect(st().fieldPending.size).toBe(0);
    expect(st().error).toBe('No money');
  });
  it('every refusal frees its seats for a later stroke, but several in a row make only one toast', () => {
    for (const [ref, error] of [['r1', 'RATE_LIMITED'], ['r2', 'BAD_REQUEST'], ['r3', 'WRONG_PHASE']] as const) {
      st().trackField(ref, [ref === 'r1' ? 1 : ref === 'r2' ? 2 : 3]);
      apply({ type: 'error', error, message: 'Refused ' + ref, clientRef: ref, retryAt: 1 });
      expect(st().fieldPending.size).toBe(0);
      if (ref === 'r1') { expect(st().error).toBe('Refused r1'); st().setError(null); } // the player dismissed the toast
    }
    expect(st().error).toBeNull();
  });
  it('an error that is not about fielding always shows', () => {
    st().trackField('r1', [1]);
    apply({ type: 'error', error: 'RATE_LIMITED', message: 'First', clientRef: 'r1' });
    apply({ type: 'error', error: 'WRONG_PHASE', message: 'Other' });
    expect(st().error).toBe('Other');
  });
  it('the empty fieldingUpdate at the deadline only sets the final numbers', () => {
    useStore.setState({ snapshot: snap({ fielding: { 1: [{ playerId: 'a' }] }, contestedSeats: 9, majority: 5 }) } as never);
    apply({ type: 'fieldingUpdate', playerId: 'admin', added: [], removed: [], contestedSeats: 1, majority: 1 });
    expect(st().snapshot!.fielding).toEqual({ 1: [{ playerId: 'a' }] });
    expect(st().snapshot!.contestedSeats).toBe(1);
    expect(st().snapshot!.majority).toBe(1);
    expect(st().fieldFx).toBeNull();
  });
  it('a grace-timeout elimination removes the seats of that party, with no smoke', () => {
    useStore.setState({ snapshot: snap({ fielding: { 1: [{ playerId: 'b' }], 2: [{ playerId: 'b' }, { playerId: 'a' }] } }) } as never);
    apply({ type: 'fieldingUpdate', playerId: 'b', added: [], removed: [1, 2], contestedSeats: 1, majority: 1 });
    expect(st().snapshot!.fielding).toEqual({ 2: [{ playerId: 'a' }] });
    expect(st().fieldFx).toBeNull();
  });
  it('the bulk updates after a big hello or at a 2-player start fire no smoke, even for own seats, and take little time', () => {
    const seats = Array.from({ length: 5000 }, (_, i) => ({ seat: i + 1 }));
    const t0 = performance.now();
    for (const playerId of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) apply({ type: 'fieldingUpdate', playerId, added: seats, removed: [], contestedSeats: 5000, majority: 2501 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(st().snapshot!.fielding[1]).toHaveLength(9);
    expect(st().fieldFx).toBeNull();
  });
  it('a game that ends at the deadline goes straight to the result screen', () => {
    apply({ type: 'status', status: 'finished', timeline: null });
    expect(currentScreen(st())).toBe('result');
  });
  it('a new hello forgets answers lost with the old socket', () => {
    st().trackField('r1', [1]);
    apply({ type: 'hello', serverTime: Date.now(), snapshot: snap(), private: priv });
    expect(st().fieldPending.size).toBe(0);
  });
  it('the campaign status ends the seats in flight', () => {
    st().trackField('r1', [1]);
    apply({ type: 'status', status: 'campaign', timeline: null });
    expect(st().fieldPending.size).toBe(0);
    expect(currentScreen(st())).toBe('campaign');
  });
});

describe('minor rally in the store', () => {
  it('a minor rally ack extends my actions and fires the reputation smoke like the other actions', () => {
    st().trackAction('m1', { type: 'minorRally', seat: 5 });
    apply({ type: 'actionAck', clientRef: 'm1', ok: true, budget: 500, reputation: { 5: 4 } });
    expect(st().priv!.myActions.map(a => a.type)).toEqual(['minorRally']);
    expect(st().repGain).toMatchObject({ type: 'minorRally', seat: 5, seats: { 5: 4 } });
  });
});
