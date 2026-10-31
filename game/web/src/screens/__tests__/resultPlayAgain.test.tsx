// Result screen: Play again (host only, finished game with a result, never in the tour).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

const h = vi.hoisted(() => ({ tour: false, playAgain: vi.fn(async (_n: number) => true) }));
vi.mock('../../net/client', () => ({
  leaveGame: vi.fn(), peekSeat: vi.fn(),
  get isTour() { return h.tour; },
  playAgain: (n: number) => h.playAgain(n),
}));
vi.mock('../../map/SeatMap', () => ({ SeatMap: () => <div /> }));

import { useStore } from '../../state/store';
import { Result } from '../Result';

const a: PlayerPublic = { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } };
const b: PlayerPublic = { playerId: 'b', nickname: 'Ravi', isAdmin: false, status: 'active', party: { name: 'Blue', colour: '#0A71E8', symbol: 'anchor' } };

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'finished', phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: 3, postCountingEnd: 4 },
  players: [a, b], news: [], polledPhases: [], seats: {},
  tally: { leads: {}, wins: { a: 1 }, declared: 1, total: 500 }, offers: [], government: null,
  result: { outcome: 'majority', tally: { a: 1 }, winners: ['a'], government: null, points: [{ playerId: 'a', portfolioPoints: 0, seatPoints: 1, governmentFloor: 0, total: 1 }] },
  ...over,
});
const setup = (me: string, s: GameSnapshot) => useStore.setState({ me, gameId: 'g', names: {}, seatShares: {}, selectedSeat: null, snapshot: s });

beforeEach(() => { h.tour = false; h.playAgain.mockClear(); h.playAgain.mockImplementation(async () => true); });

describe('Result: Play again', () => {
  it('host sees the control, defaulting to the previous phases, and starts with the chosen number', async () => {
    setup('a', snap());
    render(<Result />);
    const sel = screen.getByRole('combobox');
    expect(sel).toHaveValue('2');
    fireEvent.change(sel, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }));
    await waitFor(() => expect(h.playAgain).toHaveBeenCalledWith(3));
    expect(screen.getByRole('button', { name: 'Back to start' })).toBeInTheDocument();
  });

  it('is disabled while the request is in flight', async () => {
    let done!: () => void;
    h.playAgain.mockImplementation(() => new Promise<boolean>(r => { done = () => r(true); }));
    setup('a', snap());
    render(<Result />);
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }));
    const busy = await screen.findByRole('button', { name: 'Starting…' });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    fireEvent.click(busy);
    expect(h.playAgain).toHaveBeenCalledTimes(1);
    done();
    await screen.findByRole('button', { name: 'Play again' });
  });

  it('a non-host only sees a waiting note', () => {
    setup('b', snap());
    render(<Result />);
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
    expect(screen.getByTestId('play-again-wait')).toHaveTextContent('Waiting for the host to play again');
  });

  it('the host also waits once the next game exists', () => {
    setup('a', snap({ nextGameId: 'g2', nextJoinCode: 'HP9' }));
    render(<Result />);
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
    expect(screen.getByTestId('play-again-wait')).toBeInTheDocument();
  });

  it('is hidden in the guided tour (the tour player is the host) for everyone', () => {
    h.tour = true;
    setup('a', snap());
    render(<Result />);
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
    expect(screen.queryByTestId('play-again-wait')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to start' })).toBeInTheDocument();
    expect(document.querySelector('.page.result .banner')).not.toBeNull();
  });

  it('an abandoned game (no result) offers no Play again', () => {
    setup('a', snap({ status: 'abandoned', result: undefined }));
    render(<Result />);
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull();
    expect(screen.queryByTestId('play-again-wait')).toBeNull();
  });
});
