// Result government card, Lobby limits and Counting tally follow the current game's map config.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';
import { FAKE_MAP_ID, registerFakeMap } from '../../../test/fakeMap';

vi.mock('../../net/client', () => ({
  admit: vi.fn(), refreshLobby: vi.fn(async () => undefined), setAdmission: vi.fn(), setPhases: vi.fn(), start: vi.fn(), leaveGame: vi.fn(), playAgain: vi.fn(), isTour: false,
}));
vi.mock('../../map/SeatMap', () => ({ SeatMap: () => <div /> }));

import { useStore } from '../../state/store';
import { Lobby } from '../Lobby';
import { Result } from '../Result';
import { TallyBar } from '../Counting';

registerFakeMap();

const pl = (id: string, n: string): PlayerPublic => ({ playerId: id, nickname: n, isAdmin: id === 'p1', status: 'active', party: { name: n + ' Party', colour: '#E8710A', symbol: 'sun', avatar: 'modi' } });
const players = [pl('p1', 'Asha'), pl('p2', 'Ben'), pl('p3', 'Chitra')];
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: FAKE_MAP_ID, status: 'lobby', phases: 2, timeline: null, players, news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});

beforeEach(() => useStore.setState({ me: 'p1', gameId: 'g', joinCode: 'HP1', snapshot: null, lobby: null, gamePkg: null }));

describe('screens follow the current map config', () => {
  it('Result shows the fake map portfolio labels', () => {
    const result = {
      outcome: 'coalition' as const, tally: { p1: 50, p2: 30, p3: 20 }, winners: ['p1'],
      government: { pm: 'p1', members: ['p1', 'p2'], portfolios: { PM: ['p1'], MAGIC: ['p2'] }, formedAt: 1, viaNegotiation: true },
      points: [{ playerId: 'p1', portfolioPoints: 100, seatPoints: 100, governmentFloor: 10, total: 210 }],
    };
    useStore.setState({ snapshot: snap({ status: 'finished', result }), names: {} });
    render(<Result />);
    expect(screen.getByText(/Chancellor:/)).toBeInTheDocument();
    expect(screen.getByText(/Minister of Magic:/)).toBeInTheDocument();
    expect(screen.queryByText(/Prime Minister:/)).toBeNull();
  });

  it('Lobby shows the map seat count and player limits, and needs the map minimum of players', () => {
    useStore.setState({ snapshot: snap({ players: players.slice(0, 2) }) });
    render(<Lobby />);
    expect(screen.getByText(/3-4 players\. 100 seats\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Players (2/4)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start the campaign' })).toBeDisabled(); // fake map needs 3
  });

  it('Lobby start is possible once the fake map minimum is reached', () => {
    useStore.setState({ snapshot: snap() });
    render(<Lobby />);
    expect(screen.getByRole('button', { name: 'Start the campaign' })).toBeEnabled();
  });

  it('tally bar marks the majority of the map seat count before counting data exists', () => {
    useStore.setState({ snapshot: snap({ status: 'counting' }) });
    render(<TallyBar snap={snap({ status: 'counting' })} />);
    expect(screen.getByText('Majority 51')).toBeInTheDocument(); // 100 seats
    expect(screen.getByText(/0 of 100 seats declared/)).toBeInTheDocument();
  });
});
