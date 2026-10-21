import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic, SeatSharesMessage } from '@hp/shared';

vi.mock('../../net/client', () => ({ peekSeat: vi.fn() }));

import { peekSeat } from '../../net/client';
import { useStore } from '../../state/store';
import { useMapConfig } from '../../state/mapConfig';
import { SeatSharesModal } from '../SeatSharesModal';
import { SeatShareHint } from '../SeatShareHint';

const a: PlayerPublic = { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } };
const b: PlayerPublic = { playerId: 'b', nickname: 'Bo', isAdmin: false, status: 'active', party: { name: 'Blue Front', colour: '#1F5FBF', symbol: 'anchor' } };

const snap = (seats: GameSnapshot['seats']): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: 3, postCountingEnd: 4 },
  players: [a, b], news: [], polledPhases: [], seats, tally: { leads: {}, wins: {}, declared: 0, total: 500 },
  offers: [], government: null, result: null,
});
const answer = (seat: number, status: 'leading' | 'won', shares: Record<string, number>, candidates?: Record<string, string>): SeatSharesMessage =>
  ({ type: 'seatShares', seat, status, shares, ...(candidates ? { candidates } : {}) });
const setAnswer = (m: SeatSharesMessage) => act(() => { useStore.setState(s => ({ seatShares: { ...s.seatShares, [m.seat]: m } })); });
const setDecl = (seat: number, status: 'leading' | 'won') =>
  act(() => { useStore.setState({ snapshot: snap({ [seat]: { seat, status, playerId: 'a' } }) }); });

let refreshMs = 1000;
function Probe() { refreshMs = useMapConfig().counting.pieRefreshMs; return null; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(peekSeat).mockClear();
  useStore.setState({ me: 'a', gameId: 'g', names: { 7: 'Mumbai South' }, seatShares: {}, snapshot: snap({ 7: { seat: 7, status: 'leading', playerId: 'a' } }) });
});
afterEach(() => vi.useRealTimers());

describe('SeatSharesModal', () => {
  it('renders nothing and never asks the server for a seat without a declaration', () => {
    const { container } = render(<SeatSharesModal seat={8} onClose={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(peekSeat).not.toHaveBeenCalled();
  });

  it('asks once on mount and shows Loading until the first answer', () => {
    render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    expect(peekSeat).toHaveBeenCalledTimes(1);
    expect(peekSeat).toHaveBeenCalledWith(7);
    expect(screen.getByRole('dialog', { name: 'Mumbai South' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText(/Leading — counting in progress, numbers can still swing/)).toBeInTheDocument();
  });

  it('draws the pie with party colours, names, candidates and one-decimal percentages, biggest first', () => {
    const { container } = render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    setAnswer(answer(7, 'leading', { a: 0.3, b: 0.7 }, { a: 'R. Rao', b: 'S. Sen' }));
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('img', { name: 'Vote share in Mumbai South' })).toBeInTheDocument();
    const rows = [...container.querySelectorAll('.pie-legend li')].map(li => li.textContent);
    expect(rows).toEqual(['Blue Front · S. Sen70.0%', 'Lotus Front · R. Rao30.0%']);
    const fills = [...container.querySelectorAll('path.pie-slice')].map(p => p.getAttribute('fill'));
    expect(fills).toEqual(['#E8710A', '#1F5FBF']);
  });

  it('skips a share whose party is not in the game and works without candidate names', () => {
    const { container } = render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    setAnswer(answer(7, 'leading', { a: 0.5, b: 0.4, ghost: 0.1 }));
    expect(container.querySelectorAll('.pie-legend li')).toHaveLength(2);
  });

  it('re-fetches a leading seat every counting.pieRefreshMs and stops on unmount', () => {
    const { unmount } = render(<><Probe /><SeatSharesModal seat={7} onClose={() => undefined} /></>);
    expect(peekSeat).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(refreshMs * 3); });
    expect(peekSeat).toHaveBeenCalledTimes(4);
    unmount();
    act(() => { vi.advanceTimersByTime(refreshMs * 5); });
    expect(peekSeat).toHaveBeenCalledTimes(4);
  });

  it('a seat that is already confirmed is fetched once and never polled', () => {
    setDecl(7, 'won');
    render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    setAnswer(answer(7, 'won', { a: 0.6, b: 0.4 }));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(peekSeat).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Confirmed — final result')).toBeInTheDocument();
  });

  it('when the snapshot turns the seat won: one last fetch, then it stops polling', () => {
    render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    setAnswer(answer(7, 'leading', { a: 0.5, b: 0.5 }));
    act(() => { vi.advanceTimersByTime(refreshMs * 2); });
    expect(peekSeat).toHaveBeenCalledTimes(3);
    setDecl(7, 'won');
    expect(peekSeat).toHaveBeenCalledTimes(4); // the final fetch
    act(() => { vi.advanceTimersByTime(refreshMs * 5); });
    expect(peekSeat).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Confirmed — final result')).toBeInTheDocument();
  });

  it('when an answer with status won arrives: one last fetch, then it stops polling', () => {
    render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(refreshMs); });
    expect(peekSeat).toHaveBeenCalledTimes(2);
    setAnswer(answer(7, 'won', { a: 0.55, b: 0.45 }));
    expect(peekSeat).toHaveBeenCalledTimes(3);
    act(() => { vi.advanceTimersByTime(refreshMs * 5); });
    expect(peekSeat).toHaveBeenCalledTimes(3);
  });

  it('switching seat asks for the new seat and polls only that one', () => {
    useStore.setState({ snapshot: snap({ 7: { seat: 7, status: 'leading', playerId: 'a' }, 9: { seat: 9, status: 'leading', playerId: 'b' } }) });
    const { rerender } = render(<SeatSharesModal seat={7} onClose={() => undefined} />);
    rerender(<SeatSharesModal seat={9} onClose={() => undefined} />);
    expect(peekSeat).toHaveBeenLastCalledWith(9);
    vi.mocked(peekSeat).mockClear();
    act(() => { vi.advanceTimersByTime(refreshMs); });
    expect(peekSeat).toHaveBeenCalledTimes(1);
    expect(peekSeat).toHaveBeenCalledWith(9);
  });

  it('closes with the button, Escape and a backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<SeatSharesModal seat={7} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(container.querySelector('.ssm-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('SeatShareHint', () => {
  it('is a note with the tip text', () => {
    render(<SeatShareHint />);
    expect(screen.getByRole('note')).toHaveTextContent('Tip: click any seat that has a lead or a result to see its vote share.');
  });
});
