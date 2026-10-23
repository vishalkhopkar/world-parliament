// Campaign screen: the player's OWN reputation among swing voters as a party-coloured badge on every seat.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

const mapProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), leaveGame: vi.fn(), peekSeat: vi.fn(), campaign: vi.fn(), buyReport: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: (p: Record<string, unknown>) => { mapProps.last = p; return <div data-testid="seatmap" />; } }));

import { useStore } from '../../state/store';
import { colourHex } from '../../lib';
import { Campaign } from '../Campaign';

const pl = (id: string, colour: string): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status: 'active', party: { name: id, colour, symbol: 'sun' } });
const snap = (): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'campaign', phases: 1,
  timeline: { campaignStart: 0, phaseCloses: [Date.now() + 1e5], campaignEnd: Date.now() + 1e5, countingEnd: Date.now() + 2e5, postCountingEnd: Date.now() + 3e5 },
  players: [pl('a', 'blue'), pl('b', 'orange')], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null,
});
const pkg = { phaseGroups: { '1': [[1, 2, 3]] }, seats: [1, 2, 3].map((id) => ({ id, x: id, y: id, lon: id, lat: id, neighbours: [] })) };
const priv = (reputation?: PrivateState['reputation']): PrivateState => ({ you: 'a', budget: 100, myActions: [], myReports: [], reputation });
const setup = (p: PrivateState) =>
  useStore.setState({ me: 'a', gameId: 'g', snapshot: snap(), priv: p, lobby: null, gamePkg: pkg, names: {}, chat: [], selectedSeat: null, polledSeats: [] } as never);
type Badges = Record<number, { text: string; colour: string }>;

beforeEach(() => { mapProps.last = null; });

describe('Campaign reputation badges', () => {
  it('shows "0" in the party colour on every seat before any action', () => {
    setup(priv({}));
    render(<Campaign />);
    const b = mapProps.last?.badges as Badges;
    expect(Object.keys(b)).toEqual(['1', '2', '3']);
    for (const v of Object.values(b)) { expect(v.text).toBe('0'); expect(v.colour).toBe(colourHex('blue')); }
  });
  it('shows the own value where there is one and 0 elsewhere; updates after a new ack', () => {
    setup(priv({ 2: 10 }));
    const { rerender } = render(<Campaign />);
    expect((mapProps.last?.badges as Badges)[2].text).toBe('10');
    expect((mapProps.last?.badges as Badges)[1].text).toBe('0');
    useStore.setState({ priv: priv({ 2: 20, 3: 4 }) } as never);
    rerender(<Campaign />);
    expect((mapProps.last?.badges as Badges)[2].text).toBe('20');
    expect((mapProps.last?.badges as Badges)[3].text).toBe('4');
  });
  it("never uses another party's colour", () => {
    setup(priv({ 1: 5 }));
    render(<Campaign />);
    for (const v of Object.values(mapProps.last?.badges as Badges)) expect(v.colour).not.toBe(colourHex('orange'));
  });
});
