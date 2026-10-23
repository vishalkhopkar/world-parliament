// Campaign screen: own committed seats are shaded in the party colour (polled seats keep the hatch), as non-result fills.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

const mapProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), leaveGame: vi.fn(), peekSeat: vi.fn(), campaign: vi.fn(), buyReport: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: (p: Record<string, unknown>) => { mapProps.last = p; return <div data-testid="seatmap" />; } }));

import { useStore } from '../../state/store';
import { committedFill } from '../../lib/committedShade';
import { Campaign } from '../Campaign';

const pl = (id: string, colour: string): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status: 'active', party: { name: id, colour, symbol: 'sun' } });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'campaign', phases: 1,
  timeline: { campaignStart: 0, phaseCloses: [Date.now() + 1e5], campaignEnd: Date.now() + 1e5, countingEnd: Date.now() + 2e5, postCountingEnd: Date.now() + 3e5 },
  players: [pl('a', '#1F5FBF'), pl('b', '#E8710A')], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (committed?: PrivateState['committed']): PrivateState => ({ you: 'a', budget: 100, myActions: [], myReports: [], committed });
const setup = (p: PrivateState, polled: number[] = []) =>
  useStore.setState({ me: 'a', gameId: 'g', snapshot: snap(), priv: p, lobby: null, gamePkg: null, names: {}, chat: [], selectedSeat: null, polledSeats: polled } as never);

beforeEach(() => { mapProps.last = null; });

describe('Campaign map shading of committed voters', () => {
  it('fills own committed seats with the shaded party colour', () => {
    setup(priv([{ seat: 3, band: 5, percent: 50, level: 'HIGH' }, { seat: 4, band: 1, percent: 10, level: 'LOW' }]));
    render(<Campaign />);
    expect(mapProps.last?.fills).toEqual({ 3: committedFill('#1F5FBF', 'HIGH'), 4: committedFill('#1F5FBF', 'LOW') });
    expect(mapProps.last?.fillStyle).toBe('committed');
  });
  it('leaves polled seats out of the fills so they keep the hatch', () => {
    setup(priv([{ seat: 3, band: 5, percent: 50, level: 'HIGH' }, { seat: 4, band: 2, percent: 20, level: 'MEDIUM' }]), [3]);
    render(<Campaign />);
    expect(Object.keys(mapProps.last?.fills as object)).toEqual(['4']);
    expect((mapProps.last?.dimmed as Set<number>).has(3)).toBe(true);
  });
  it('passes no fills when nothing is committed', () => {
    setup(priv([]));
    render(<Campaign />);
    expect(mapProps.last?.fills).toBeUndefined();
    expect(mapProps.last?.fillStyle).toBeUndefined();
  });
});
