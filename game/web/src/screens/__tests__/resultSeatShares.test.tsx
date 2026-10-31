// Result screen: the vote-share hint, seat click -> pie popup, selection cleared when leaving.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ leaveGame: vi.fn(), peekSeat: vi.fn(), playAgain: vi.fn(), isTour: false }));
vi.mock('../../map/SeatMap', () => ({
  SeatMap: (p: { onSeatClick?: (s: number) => void; selectedSeat?: number | null }) => (
    <div data-testid="seatmap" data-selected={String(p.selectedSeat)}>
      <button onClick={() => p.onSeatClick?.(7)}>seat 7</button>
      <button onClick={() => p.onSeatClick?.(8)}>seat 8</button>
    </div>
  ),
}));

import { peekSeat } from '../../net/client';
import { useStore } from '../../state/store';
import { Result } from '../Result';

const a: PlayerPublic = { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } };

const snap = (): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'finished', phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: 3, postCountingEnd: 4 },
  players: [a], news: [], polledPhases: [], seats: { 7: { seat: 7, status: 'won', playerId: 'a' } },
  tally: { leads: {}, wins: { a: 1 }, declared: 1, total: 500 }, offers: [], government: null,
  result: { outcome: 'majority', tally: { a: 1 }, winners: ['a'], government: null, points: [{ playerId: 'a', portfolioPoints: 0, seatPoints: 1, governmentFloor: 0, total: 1 }] },
});

beforeEach(() => {
  vi.mocked(peekSeat).mockClear();
  useStore.setState({ me: 'a', gameId: 'g', names: { 7: 'Mumbai South' }, seatShares: {}, selectedSeat: null, snapshot: snap() });
});

describe('Result screen seat vote share', () => {
  it('shows the hint at the top and no popup until a seat is clicked', () => {
    render(<Result />);
    expect(screen.getByRole('note')).toHaveTextContent(/click any seat that has a lead or a result/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking a declared seat opens its pie popup inside the map container and asks the server', () => {
    const { container } = render(<Result />);
    fireEvent.click(screen.getByText('seat 7'));
    const dlg = screen.getByRole('dialog', { name: 'Mumbai South' });
    expect(container.querySelector('.result-map')).toContainElement(dlg);
    expect(screen.getByTestId('seatmap')).toHaveAttribute('data-selected', '7');
    expect(peekSeat).toHaveBeenCalledWith(7);
  });

  it('clicking a seat with no declaration shows nothing and sends nothing', () => {
    render(<Result />);
    fireEvent.click(screen.getByText('seat 8'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(peekSeat).not.toHaveBeenCalled();
  });

  it('closing the popup clears the selection', () => {
    render(<Result />);
    fireEvent.click(screen.getByText('seat 7'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().selectedSeat).toBeNull();
  });

  it('clears the selection when the screen unmounts', () => {
    const { unmount } = render(<Result />);
    fireEvent.click(screen.getByText('seat 7'));
    expect(useStore.getState().selectedSeat).toBe(7);
    act(() => unmount());
    expect(useStore.getState().selectedSeat).toBeNull();
  });
});
