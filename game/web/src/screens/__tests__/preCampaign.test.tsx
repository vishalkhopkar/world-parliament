// The pre-campaign screen: its timer and budget, live candidate counts and majority, one-to-one chat, own committed seats shaded, the
// figures and the brush handed to the map, the money smoke, and no reputation anywhere.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

const mapProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), fieldCandidates: vi.fn(), withdrawCandidates: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: (p: Record<string, unknown>) => { mapProps.last = p; return <div data-testid="seatmap" />; } }));

import { fieldCandidates } from '../../net/client';
import { committedFill } from '../../lib/committedShade';
import { useStore } from '../../state/store';
import { useTour } from '../../tour/tourStore';
import { PreCampaign } from '../PreCampaign';

const COST = WORLD_CONFIG.costs.candidate;
const pl = (id: string, colour: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status, party: { name: id + ' Party', colour, symbol: 'sun' } });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: WORLD_CONFIG.mapId, status: 'preCampaign', phases: 1,
  timeline: { preCampaignEnd: Date.now() + 65_000, campaignStart: Date.now() + 70_000, phaseCloses: [Date.now() + 1e6], campaignEnd: Date.now() + 1e6, countingEnd: Date.now() + 2e6, postCountingEnd: Date.now() + 3e6 },
  players: [pl('a', '#1F5FBF'), pl('b', '#E8710A'), pl('c', '#118833')], news: [],
  fielding: { 1: [{ playerId: 'b' }, { playerId: 'a' }], 2: [{ playerId: 'b' }] }, contestedSeats: 2, majority: 2,
  polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'a', budget: 10_000, myActions: [], myReports: [], ...over });
const setup = (s = snap(), p = priv()) => {
  useStore.getState().reset();
  useStore.setState({ me: 'a', gameId: 'g', snapshot: s, priv: p, gamePkg: null, names: {}, chat: [], selectedSeat: null } as never);
  return render(<PreCampaign />);
};
const counts = () => [...document.querySelectorAll('[data-tour="candidate-counts"] li')].map(li => [li.getAttribute('data-player'), li.querySelector('.cc-count')!.textContent]);
type Brush = { radiusPx: number; onPaint(s: number[]): void; onStrokeEnd(): void };

beforeEach(() => { mapProps.last = null; vi.mocked(fieldCandidates).mockClear(); });

describe('pre-campaign screen', () => {
  it('shows the time left in the pre-campaign and the budget, and no campaign timers', () => {
    setup();
    expect(screen.getByText('Pre-campaign ends in')).toBeInTheDocument();
    expect(screen.queryByText('Campaign ends in')).toBeNull();
    expect(document.querySelector('[data-tour="hud-budget"]')).toHaveTextContent('10,000');
  });
  it('the timer reads 0:00 under the guided tour, which has no running clock', () => {
    useTour.setState({ frozenClock: true } as never);
    setup();
    expect(document.querySelector('[data-tour="hud-precampaign"]')).toHaveTextContent('0:00');
    useTour.setState({ frozenClock: false } as never);
  });
  it('has the hooks the tour uses', () => {
    setup();
    for (const hook of ['hud-party', 'hud-budget', 'map', 'candidate-counts', 'precampaign-chat']) expect(document.querySelector(`[data-tour="${hook}"]`)).toBeInTheDocument();
  });
  it('lists each party with its live candidate count, own party first, with a figure in its colour', () => {
    setup();
    expect(counts()).toEqual([['a', '1'], ['b', '2'], ['c', '0']]);
    expect(document.querySelectorAll('[data-tour="candidate-counts"] .candidate-icon svg')).toHaveLength(3);
    act(() => useStore.getState().applyServer({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 3 }], removed: [], contestedSeats: 3, majority: 2 }));
    expect(counts()).toEqual([['a', '1'], ['b', '2'], ['c', '1']]);
  });
  it('shows the current majority and contested seats, and updates them live', () => {
    setup();
    const line = () => document.querySelector('.cc-majority')!;
    expect(line()).toHaveTextContent('Majority: 2 of 2 contested seats');
    act(() => useStore.getState().applyServer({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 3 }, { seat: 4 }], removed: [], contestedSeats: 4, majority: 3 }));
    expect(line()).toHaveTextContent('Majority: 3 of 4 contested seats');
  });
  it('has the one-to-one chat, whatever the campaign chat setting is', () => {
    setup();
    expect(document.querySelector('[data-tour="precampaign-chat"]')).toHaveTextContent('Chats');
    expect(screen.queryByText('Group chat')).toBeNull();
  });
  it('explains that a party with no candidates is out', () => {
    setup();
    expect(screen.getByText(/no candidates when this phase ends is out/)).toBeInTheDocument();
  });
  it('gives the map the figures, own party first, the brush at the configured size, and shades own committed seats', () => {
    setup(snap(), priv({ committed: [{ seat: 3, band: 5, percent: 50, level: 'HIGH' }] }));
    expect((mapProps.last?.candidates as Record<number, { id: string }[]>)[1].map(c => c.id)).toEqual(['a', 'b']);
    expect((mapProps.last?.brush as Brush).radiusPx).toBe(WORLD_CONFIG.display.brushRadiusPx);
    expect(mapProps.last?.fills).toEqual({ 3: committedFill('#1F5FBF', 'HIGH') });
    expect(mapProps.last?.fillStyle).toBe('committed');
  });
  it('shows no reputation badges', () => {
    setup(snap(), priv({ reputation: { 1: 5 } }));
    expect(mapProps.last?.badges).toBeUndefined();
  });
  it('turns the fieldAck into a red smoke of the configured cost on the map', () => {
    setup();
    act(() => useStore.getState().applyServer({ type: 'fieldAck', ok: true, budget: 9_000, added: [{ seat: 7 }], removed: [] }));
    expect(mapProps.last?.gains).toMatchObject({ spends: { 7: COST }, refunds: {} });
  });
  it('sends painted seats at the end of a stroke, skipping seats already fielded', () => {
    setup();
    const brush = mapProps.last?.brush as Brush;
    brush.onPaint([1, 2, 3]);
    brush.onStrokeEnd();
    expect(fieldCandidates).toHaveBeenCalledTimes(1);
    expect(fieldCandidates).toHaveBeenCalledWith([2, 3]);
  });
  it('stops a stroke with one message when the budget runs out', () => {
    setup(snap(), priv({ budget: COST }));
    const brush = mapProps.last?.brush as Brush;
    brush.onPaint([2, 3, 4]);
    brush.onPaint([5]);
    brush.onStrokeEnd();
    expect(fieldCandidates).toHaveBeenCalledWith([2]);
    expect(useStore.getState().error).toMatch(/Not enough budget/);
  });
  it('counts seats in flight against the budget', () => {
    setup(snap(), priv({ budget: COST }));
    act(() => useStore.getState().trackField('r', [9]));
    const brush = mapProps.last?.brush as Brush;
    brush.onPaint([2]);
    brush.onStrokeEnd();
    expect(fieldCandidates).not.toHaveBeenCalled();
  });
  it('opens the fielding panel for the selected seat', () => {
    setup();
    expect(document.querySelector('[data-tour="fielding-panel"]')).toBeNull();
    act(() => useStore.getState().selectSeat(2));
    expect(document.querySelector('[data-tour="fielding-panel"]')).toBeInTheDocument();
  });
});
