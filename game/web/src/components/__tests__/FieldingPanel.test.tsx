// The seat panel of the pre-campaign reads the store and stays open: it switches between Field and Withdraw by itself, in both directions,
// lists every party fielded in the seat, and says why Field is disabled. It never shows reputation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WORLD_CONFIG, formatMoneyForTest } from './fieldingFixtures';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

vi.mock('../../net/client', () => ({ fieldCandidates: vi.fn(), withdrawCandidates: vi.fn() }));

import { fieldCandidates, withdrawCandidates } from '../../net/client';
import { useStore } from '../../state/store';
import { FieldingPanel } from '../FieldingPanel';

const COST = WORLD_CONFIG.costs.candidate;
const pl = (id: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: false, status, party: { name: id + ' Party', colour: '#E8710A', symbol: 'sun' } });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: WORLD_CONFIG.mapId, status: 'preCampaign', phases: 1, timeline: null, players: [pl('a'), pl('b'), pl('c')], news: [],
  fielding: {}, fieldingDone: [], contestedSeats: 0, majority: 1, polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'a', budget: 10_000, myActions: [], myReports: [], ...over });
const setup = (s: GameSnapshot, p: PrivateState = priv()) => {
  useStore.getState().reset();
  useStore.setState({ me: 'a', gameId: 'g', snapshot: s, priv: p, names: { 5: 'Lhasa' } } as never);
  return render(<FieldingPanel seat={5} phaseOf={null} onClose={() => undefined} />);
};
const q = (sel: string) => document.querySelector<HTMLButtonElement>(sel);
const apply = (m: Parameters<ReturnType<typeof useStore.getState>['applyServer']>[0]) => act(() => useStore.getState().applyServer(m));

beforeEach(() => { vi.mocked(fieldCandidates).mockClear(); vi.mocked(withdrawCandidates).mockClear(); });

describe('fielding panel', () => {
  it('offers Field with its cost where the player has no candidate, and sends it', () => {
    setup(snap());
    expect(q('.fp-withdraw')).toBeNull();
    expect(q('.fp-field')).toHaveTextContent(formatMoneyForTest(COST));
    fireEvent.click(q('.fp-field')!);
    expect(fieldCandidates).toHaveBeenCalledWith([5]);
  });
  it('shows the own candidate by name and offers Withdraw where the player has one, and sends it', () => {
    setup(snap({ fielding: { 5: [{ playerId: 'a', name: 'Asha Rao' }] } }));
    expect(q('.fp-field')).toBeNull();
    expect(screen.getByText('Your candidate:')).toHaveTextContent('Asha Rao');
    fireEvent.click(q('.fp-withdraw')!);
    expect(withdrawCandidates).toHaveBeenCalledWith([5]);
  });
  it('switches from Field to Withdraw by itself when the candidate is fielded', () => {
    setup(snap());
    apply({ type: 'fieldAck', ok: true, budget: 9_950, added: [{ seat: 5, name: 'Asha Rao' }], removed: [] });
    expect(q('.fp-field')).toBeNull();
    expect(q('.fp-withdraw')).toBeInTheDocument();
  });
  it('switches from Withdraw back to Field by itself when the candidate is withdrawn', () => {
    setup(snap({ fielding: { 5: [{ playerId: 'a' }] } }));
    apply({ type: 'fieldingUpdate', playerId: 'a', added: [], removed: [5], contestedSeats: 0, majority: 1 });
    expect(q('.fp-withdraw')).toBeNull();
    expect(q('.fp-field')).toBeInTheDocument();
  });
  it('lists every party fielded here with its candidate, in both states, live', () => {
    setup(snap({ fielding: { 5: [{ playerId: 'b', name: 'Ben Roy' }] } }));
    const list = () => q('.fp-candidates')!;
    expect(list()).toHaveTextContent('b Party');
    expect(list()).toHaveTextContent('Ben Roy');
    apply({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 5, name: 'Chitra Das' }], removed: [], contestedSeats: 1, majority: 1 });
    expect(list()).toHaveTextContent('Chitra Das');
    apply({ type: 'fieldingUpdate', playerId: 'a', added: [{ seat: 5, name: 'Asha Rao' }], removed: [], contestedSeats: 1, majority: 1 });
    expect(list()).toHaveTextContent('a Party (you)');
  });
  it('says so when nobody is fielded here', () => {
    setup(snap());
    expect(q('.fp-candidates')).toHaveTextContent('No party has a candidate here.');
  });
  it('disables Field with the reason when the budget cannot pay', () => {
    setup(snap(), priv({ budget: COST - 1 }));
    expect(q('.fp-field')).toBeDisabled();
    expect(screen.getByText(/Not enough budget/)).toBeInTheDocument();
  });
  it('keeps Withdraw usable with an empty budget, because it refunds', () => {
    setup(snap({ fielding: { 5: [{ playerId: 'a' }] } }), priv({ budget: 0 }));
    expect(q('.fp-withdraw')).toBeEnabled();
  });
  it('disables the button while an answer for this seat is on its way', () => {
    setup(snap());
    act(() => useStore.getState().trackField('r', [5]));
    expect(q('.fp-field')).toBeDisabled();
  });
  it('disables Field for a party that is out', () => {
    setup(snap({ players: [pl('a', 'eliminated'), pl('b'), pl('c')] }));
    expect(q('.fp-field')).toBeDisabled();
  });
  it('shows own committed voters and no reputation', () => {
    setup(snap(), priv({ committed: [{ seat: 5, band: 3, percent: 30, level: 'HIGH' }], reputation: { 5: 9 } }));
    expect(screen.getByText(/Committed voters: ~30%/)).toHaveTextContent('HIGH');
    expect(screen.queryByText(/Reputation/)).toBeNull();
  });
  it('carries the hook the tour and e2e use', () => {
    setup(snap());
    expect(document.querySelector('[data-tour="fielding-panel"]')).toBeInTheDocument();
  });
});
