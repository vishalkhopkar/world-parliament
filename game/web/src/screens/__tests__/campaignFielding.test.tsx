// The campaign screen after fielding: seats without an own candidate are dimmed, no figures, My actions stays mounted but hidden, a party
// that is out gets a notice and keeps the chat; majority and seat totals read the contested seats, and vacant seats show hatched, not as an error.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

const mapProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), leaveGame: vi.fn(), peekSeat: vi.fn(), campaign: vi.fn(), buyReport: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn(), requestGlobalReports: vi.fn(), playAgain: vi.fn(), isTour: false }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: (p: Record<string, unknown>) => { mapProps.last = p; return <div data-testid="seatmap" />; } }));
vi.mock('../../components/ResultPanels', () => ({ ResultPanels: () => <div /> }));

import { useStore } from '../../state/store';
import { Campaign } from '../Campaign';
import { Counting, TallyBar } from '../Counting';
import { Result } from '../Result';

const pl = (id: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status, party: { name: id + ' Party', colour: '#E8710A', symbol: 'sun' } });
const three = [pl('a'), pl('b'), pl('c')];
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: WORLD_CONFIG.mapId, status: 'campaign', phases: 1,
  timeline: { campaignStart: 0, phaseCloses: [Date.now() + 1e5], campaignEnd: Date.now() + 1e5, countingEnd: Date.now() + 2e5, postCountingEnd: Date.now() + 3e5 },
  players: three, news: [], fielding: { 1: [{ playerId: 'a' }, { playerId: 'b' }], 2: [{ playerId: 'b' }] }, fieldingDone: [], contestedSeats: 2, majority: 2,
  polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'a', budget: 100, myActions: [], myReports: [], ...over });
const pkg = { mapId: WORLD_CONFIG.mapId, seatCount: 3, phaseGroups: { '1': [[1, 2, 3]] }, seats: [1, 2, 3].map(id => ({ id, x: id, y: id, lon: id, lat: id, neighbours: [] })) };
const setup = (s = snap(), p = priv()) => useStore.setState({ me: 'a', gameId: 'g', snapshot: s, priv: p, lobby: null, gamePkg: pkg, names: {}, chat: [], selectedSeat: null, polledSeats: [] } as never);

beforeEach(() => { mapProps.last = null; });

describe('Campaign with fielding', () => {
  it('passes the seats the party contests to the map, which dims the others', () => {
    setup();
    render(<Campaign />);
    expect([...(mapProps.last?.contesting as Set<number>)]).toEqual([1]);
  });
  it('hides every candidate figure', () => {
    setup();
    render(<Campaign />);
    expect(mapProps.last?.candidates).toBeUndefined();
  });
  it('keeps My actions mounted but hidden, so the chat can fill the panel', () => {
    setup();
    render(<Campaign />);
    const box = document.querySelector('[data-tour="my-actions"]')!;
    expect(box).toHaveClass('my-actions-hidden');
    expect(box).toHaveTextContent('My actions (0)');
  });
  it('names a minor rally in My actions', () => {
    setup(snap(), priv({ myActions: [{ type: 'minorRally', seat: 1, ts: 1 }, { type: 'rally', seat: 1, ts: 2 }] }));
    render(<Campaign />);
    const box = document.querySelector('[data-tour="my-actions"]')!;
    expect(box).toHaveTextContent('Minor rally');
    expect(box).toHaveTextContent('Major rally');
  });
  it('has no notice for a party that is in the game', () => {
    setup();
    render(<Campaign />);
    expect(screen.queryByTestId('eliminated-banner')).toBeNull();
  });
});

describe('a party that is out', () => {
  const out = [pl('a', 'eliminated'), pl('b'), pl('c')];
  it('sees that fielding no candidates put it out, and keeps the chat', () => {
    setup(snap({ players: out, fielding: { 2: [{ playerId: 'b' }] } }));
    render(<Campaign />);
    expect(screen.getByTestId('eliminated-banner')).toHaveTextContent("You fielded no candidates, so you're out of this election");
    expect(document.querySelector('[data-tour="chat"]')).toBeInTheDocument();
  });
  it('sees a generic line when it had campaigned before going out', () => {
    setup(snap({ players: out, fielding: {} }), priv({ myActions: [{ type: 'roadshow', seat: 1, ts: 1 }] }));
    render(<Campaign />);
    expect(screen.getByTestId('eliminated-banner')).toHaveTextContent("You're out of this election");
    expect(screen.getByTestId('eliminated-banner')).not.toHaveTextContent('fielded no candidates');
  });
  it('has nothing left to buy', () => {
    setup(snap({ players: out }));
    render(<Campaign />);
    expect(screen.queryByText('News agencies')).toBeNull();
    expect(screen.queryByText('Analyst')).toBeNull();
  });
  it('keeps the chat during counting but cannot propose a government', () => {
    setup(snap({ players: out, status: 'counting', tally: { leads: {}, wins: {}, declared: 0, total: 2 } }));
    render(<Counting />);
    expect(screen.getByTestId('eliminated-banner')).toBeInTheDocument();
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.queryByText(/Propose a government/)).toBeNull();
  });
});

describe('contested seats in the tally', () => {
  it('marks the majority the game fixed, not one computed from the map', () => {
    render(<TallyBar snap={snap({ status: 'counting', tally: { leads: {}, wins: { a: 1 }, declared: 1, total: 2 } })} />);
    expect(screen.getByText('Majority 2')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 seats declared')).toBeInTheDocument();
  });
  it('counts contested seats before any tally exists', () => {
    render(<TallyBar snap={snap({ status: 'counting' })} />);
    expect(screen.getByText('0 of 2 seats declared')).toBeInTheDocument();
  });
});

describe('vacant seats', () => {
  const result = { outcome: 'noGovernment' as const, tally: {}, winners: [], government: null, points: [] };
  it('are hatched on the counting map', () => {
    setup(snap({ status: 'counting', tally: { leads: {}, wins: {}, declared: 0, total: 2 } }));
    render(<Counting />);
    expect([...(mapProps.last?.dimmed as Set<number>)]).toEqual([3]);
  });
  it('are named as vacant when picked during counting', () => {
    setup(snap({ status: 'counting', tally: { leads: {}, wins: {}, declared: 0, total: 2 } }));
    useStore.setState({ selectedSeat: 3 } as never);
    render(<Counting />);
    expect(screen.getByText(/vacant/)).toBeInTheDocument();
  });
  it('are hatched on the result map, and the result still renders', () => {
    setup(snap({ status: 'finished', result }));
    render(<Result />);
    expect([...(mapProps.last?.dimmed as Set<number>)]).toEqual([3]);
    expect(screen.getByText('No government formed. Everyone loses.')).toBeInTheDocument();
  });
  it('do not exist when every seat is contested', () => {
    setup(snap({ status: 'finished', result, contestedSeats: 3 }));
    render(<Result />);
    expect((mapProps.last?.dimmed as Set<number>).size).toBe(0);
  });
});
