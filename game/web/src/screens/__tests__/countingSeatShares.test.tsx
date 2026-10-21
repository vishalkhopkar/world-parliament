// Counting screen: the vote-share hint, seat click -> pie popup (leading and confirmed seats), selection cleared when leaving.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ leaveGame: vi.fn(), peekSeat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn(), chat: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({
  SeatMap: (p: { onSeatClick?: (s: number) => void; selectedSeat?: number | null }) => (
    <div data-testid="seatmap" data-selected={String(p.selectedSeat)}>
      {[1, 2, 3].map(s => <button key={s} onClick={() => p.onSeatClick?.(s)}>seat {s}</button>)}
    </div>
  ),
}));
vi.mock('../../components/ResultPanels', () => ({ ResultPanels: () => <div data-testid="result-panels" /> }));

import { peekSeat } from '../../net/client';
import { useStore } from '../../state/store';
import { Counting } from '../Counting';

const a: PlayerPublic = { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } };
const b: PlayerPublic = { playerId: 'b', nickname: 'Bhim', isAdmin: false, status: 'active', party: { name: 'Blue Wave', colour: '#1F5FBF', symbol: 'leaf' } };

const snap = (status: GameSnapshot['status'] = 'counting'): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status, phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: Date.now() + 60_000, postCountingEnd: Date.now() + 120_000 },
  players: [a, b], news: [], polledPhases: [],
  seats: { 1: { seat: 1, status: 'leading', playerId: 'a' }, 2: { seat: 2, status: 'won', playerId: 'b' } },
  tally: { leads: { a: 1 }, wins: { b: 1 }, declared: 1, total: 3 }, offers: [], government: null, result: null,
});

beforeEach(() => {
  vi.mocked(peekSeat).mockClear();
  useStore.setState({ me: 'a', gameId: 'g', names: { 1: 'Kuru', 2: 'Delhi East' }, seatShares: {}, selectedSeat: null, snapshot: snap() });
});

describe('Counting screen seat vote share', () => {
  it('shows the hint and the result panels, and no popup until a seat is clicked', () => {
    render(<Counting />);
    expect(screen.getByRole('note')).toHaveTextContent(/click any seat that has a lead or a result/);
    expect(screen.getByTestId('result-panels')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([[1, 'Kuru', 'Leading'], [2, 'Delhi East', 'Confirmed']])('clicking declared seat %i opens its pie popup (%s, %s) and asks the server', (seat, name, badge) => {
    render(<Counting />);
    fireEvent.click(screen.getByText(`seat ${seat}`));
    const dlg = screen.getByRole('dialog', { name });
    expect(dlg).toHaveTextContent(badge);
    expect(peekSeat).toHaveBeenCalledWith(seat);
  });

  it('clicking a seat with no lead shows no pie and sends nothing', () => {
    render(<Counting />);
    fireEvent.click(screen.getByText('seat 3'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(peekSeat).not.toHaveBeenCalled();
  });

  it('the popup closes (selection cleared) with its close button, and leaving the screen clears the selection', () => {
    const { unmount } = render(<Counting />);
    fireEvent.click(screen.getByText('seat 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useStore.getState().selectedSeat).toBeNull();
    fireEvent.click(screen.getByText('seat 2'));
    expect(useStore.getState().selectedSeat).toBe(2);
    unmount();
    expect(useStore.getState().selectedSeat).toBeNull();
  });

  it('result panels are only mounted while counting (not during post-counting negotiation)', () => {
    useStore.setState({ snapshot: snap('postCounting') });
    render(<Counting />);
    expect(screen.queryByTestId('result-panels')).toBeNull();
  });
});
