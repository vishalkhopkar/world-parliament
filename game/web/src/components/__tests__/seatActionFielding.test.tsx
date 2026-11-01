// The campaign seat panel: major rally, minor rally and roadshow; the minor rally has no cooldown; no campaigning where the party has no
// candidate; it lists who is contesting; a party that is out cannot act.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

vi.mock('../../net/client', () => ({ buyReport: vi.fn(), campaign: vi.fn() }));

import { campaign } from '../../net/client';
import { useStore } from '../../state/store';
import { SeatActionModal } from '../SeatActionModal';

const pl = (id: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: false, status, party: { name: id + ' Party', colour: '#E8710A', symbol: 'sun' } });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: WORLD_CONFIG.mapId, status: 'campaign', phases: 2, timeline: null, players: [pl('a'), pl('b')], news: [],
  fielding: { 1: [{ playerId: 'a', name: 'Asha Rao' }, { playerId: 'b', name: 'Ben Roy' }], 2: [{ playerId: 'b', name: 'Ben Roy' }] },
  contestedSeats: 2, majority: 2, polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'a', budget: 50_000, myActions: [], myReports: [], reputation: { 1: 7, 2: 8 }, ...over });
const open = (seat: number, s = snap(), p = priv(), now = 1_000) => {
  useStore.setState({ me: 'a', gameId: 'g', snapshot: s, names: {} });
  return render(<SeatActionModal seat={seat} snap={s} priv={p} now={now} phaseOf={null} polled={new Set()} onClose={() => undefined} />);
};
const q = (sel: string) => document.querySelector<HTMLButtonElement>(sel)!;

beforeEach(() => vi.mocked(campaign).mockClear());

describe('seat panel actions', () => {
  it('labels the three actions Major rally, Minor rally and Roadshow, each with a descriptive line', () => {
    open(1);
    for (const [sel, label] of [['.sam-rally', 'Major rally'], ['.sam-minorRally', 'Minor rally'], ['.sam-roadshow', 'Roadshow']]) {
      expect(q(sel)).toHaveTextContent(label);
      expect(q(sel).querySelector('small')!.textContent!.length).toBeGreaterThan(10);
    }
  });
  it('the minor rally sends its own action type', () => {
    open(1);
    fireEvent.click(q('.sam-minorRally'));
    expect(campaign).toHaveBeenCalledWith('minorRally', 1);
  });
  it('the minor rally has no cooldown: it stays enabled while the major rally is waiting', () => {
    const t = 5_000_000;
    open(1, snap(), priv({ myActions: [{ type: 'rally', seat: 1, ts: t }] }), t + 1_000);
    expect(q('.sam-rally')).toBeDisabled();
    expect(q('.sam-minorRally')).toBeEnabled();
  });
  it('a recent minor rally does not start the major rally cooldown', () => {
    const t = 5_000_000;
    open(1, snap(), priv({ myActions: [{ type: 'minorRally', seat: 1, ts: t }] }), t + 1_000);
    expect(q('.sam-rally')).toBeEnabled();
  });
  it('the minor rally is disabled when the budget cannot pay for it', () => {
    open(1, snap(), priv({ budget: WORLD_CONFIG.costs.minorRally - 1 }));
    expect(q('.sam-minorRally')).toBeDisabled();
    expect(q('.sam-roadshow')).toBeEnabled();
  });
  it('every campaign action is disabled with "No candidate here" where the party has none', () => {
    open(2);
    for (const sel of ['.sam-rally', '.sam-minorRally', '.sam-roadshow']) {
      expect(q(sel)).toBeDisabled();
      expect(q(sel)).toHaveTextContent('No candidate here');
    }
  });
  it('shows no reputation where the party has no candidate, because it does not count there', () => {
    open(2);
    expect(screen.queryByText(/Reputation/)).toBeNull();
  });
  it('shows the reputation where the party has a candidate', () => {
    open(1);
    expect(screen.getByText('Reputation 7 among swing voters')).toBeInTheDocument();
  });
  it('lists who is contesting the seat with their candidates', () => {
    open(2);
    const list = q('.sam-candidates');
    expect(list).toHaveTextContent('b Party');
    expect(list).toHaveTextContent('Ben Roy');
    expect(list).not.toHaveTextContent('a Party');
  });
  it('says so when a seat is vacant', () => {
    open(3);
    expect(q('.sam-candidates')).toHaveTextContent('No party has a candidate here.');
  });
  it('a party that is out cannot act anywhere', () => {
    open(1, snap({ players: [pl('a', 'eliminated'), pl('b')] }));
    for (const sel of ['.sam-rally', '.sam-minorRally', '.sam-roadshow']) expect(q(sel)).toBeDisabled();
  });
});
