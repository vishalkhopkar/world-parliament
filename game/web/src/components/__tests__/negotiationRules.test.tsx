// Coalition rules in the UI: a government may never include every party; offer status texts; largest-party hint.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CoalitionOffer, GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn() }));

import { proposeGovernment } from '../../net/client';
import { Negotiation } from '../Negotiation';
import { useStore } from '../../state/store';

const pl = (id: string, n: string): PlayerPublic => ({ playerId: id, nickname: n, isAdmin: id === 'a', status: 'active', party: { name: n + ' Party', colour: '#E8710A', symbol: 'sun' } });
const A = pl('a', 'Asha'), B = pl('b', 'Ben'), C = pl('c', 'Chitra'), D = pl('d', 'Dev');

const snapOf = (players: PlayerPublic[], wins: Record<string, number>, offers: CoalitionOffer[] = []) => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', players, offers, government: null,
  tally: { wins, leads: {}, declared: 100, total: 500 },
} as unknown as GameSnapshot);
const show = (s: GameSnapshot) => { useStore.setState({ me: 'a', snapshot: s, lobby: null, gamePkg: null, chat: [] } as never); return render(<Negotiation snap={s} />); };
const invite = (n: string) => fireEvent.click(screen.getByRole('button', { name: n + ' Party' }));
const send = () => screen.getByRole('button', { name: 'Send offer' });
const STAY_OUT = 'At least one party must stay out of the government.';

beforeEach(() => vi.mocked(proposeGovernment).mockClear());

describe('offer builder: at least one party stays out', () => {
  it('3 players: inviting both others is blocked with the hint; one partner is fine', () => {
    show(snapOf([A, B, C], { a: 200, b: 100, c: 100 }));
    invite('Ben');
    expect(send()).toBeEnabled();
    expect(screen.queryByText(STAY_OUT)).toBeNull();
    invite('Chitra');
    expect(send()).toBeDisabled();
    expect(screen.getByText(STAY_OUT)).toBeInTheDocument();
  });

  it('4 players: two of three others is fine, all three is blocked', () => {
    show(snapOf([A, B, C, D], { a: 200, b: 100, c: 100, d: 100 }));
    invite('Ben'); invite('Chitra');
    expect(send()).toBeEnabled();
    invite('Dev');
    expect(send()).toBeDisabled();
    expect(screen.getByText(STAY_OUT)).toBeInTheDocument();
  });

  it('portfolio holders count as members too', () => {
    show(snapOf([A, B, C], { a: 200, b: 100, c: 100 }));
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'b' } });
    fireEvent.change(selects[1], { target: { value: 'c' } });
    expect(send()).toBeDisabled();
    expect(screen.getByText(STAY_OUT)).toBeInTheDocument();
  });

  it('keeps the partner and majority hints', () => {
    show(snapOf([A, B, C], { a: 10, b: 10, c: 400 }));
    expect(screen.getByText('Add at least one partner.')).toBeInTheDocument();
    invite('Ben');
    expect(screen.getByText('Not enough seats for a majority yet.')).toBeInTheDocument();
  });

  it('shows which largest party is left out of the offer', () => {
    show(snapOf([A, B, C], { a: 100, b: 150, c: 300 }));
    invite('Ben');
    expect(screen.getByText('Largest party Chitra Party is left out of this offer')).toBeInTheDocument();
    invite('Ben'); invite('Chitra');
    expect(screen.queryByText(/Largest party/)).toBeNull();
  });
});

const offer = (o: Partial<CoalitionOffer>): CoalitionOffer => ({ offerId: 'o1', proposer: 'a', portfolios: { PM: ['a'] }, partners: ['b'], accepted: [], status: 'open', createdAt: 1, ...o });

describe('offer view texts', () => {
  const players = [A, B, C];
  const wins = { a: 100, b: 100, c: 300 };
  it('declined shows who declined', () => {
    show(snapOf(players, wins, [offer({ status: 'declined', declinedBy: 'b' })]));
    expect(screen.getByText('Declined by Ben Party')).toBeInTheDocument();
  });
  it('superseded shows "Replaced by a newer offer" only with supersededBy', () => {
    const { unmount } = show(snapOf(players, wins, [offer({ status: 'superseded', supersededBy: 'o2' })]));
    expect(screen.getByText('Replaced by a newer offer')).toBeInTheDocument();
    unmount();
    show(snapOf(players, wins, [offer({ status: 'superseded' })]));
    expect(screen.queryByText('Replaced by a newer offer')).toBeNull();
  });
  it('accepted explains the confirmation rule', () => {
    show(snapOf(players, wins, [offer({ status: 'accepted', accepted: ['b'] })]));
    expect(screen.getByText('Everyone accepted. The government is confirmed once ALL seats are declared, if its members hold a majority of WON seats.')).toBeInTheDocument();
  });
  it('offer shows the largest-party-left-out hint when that party is not a member', () => {
    show(snapOf(players, wins, [offer({})]));
    expect(screen.getAllByText('Largest party Chitra Party is left out of this offer').length).toBeGreaterThan(0);
  });
});
