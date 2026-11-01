// The pre-campaign screen: its timer and budget, live counts (avatar, name, tick, count; no stick figure) and majority, one-to-one chat, own
// committed seats shaded, only the player's own figures and the brush handed to the map, the money smoke only when the config switches it on,
// Field all seats, Done fielding, and no reputation anywhere.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MAP_CONFIGS, WORLD_CONFIG } from '@hp/shared';
import type { GameMapPackage } from '@hp/shared';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

const mapProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), fieldCandidates: vi.fn(), withdrawCandidates: vi.fn(), doneFielding: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: (p: Record<string, unknown>) => { mapProps.last = p; return <div data-testid="seatmap" />; } }));

import { doneFielding, fieldCandidates } from '../../net/client';
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
  fielding: { 1: [{ playerId: 'b' }, { playerId: 'a' }], 2: [{ playerId: 'b' }] }, fieldingDone: [], contestedSeats: 2, majority: 2,
  polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'a', budget: 10_000, myActions: [], myReports: [], ...over });
const SMOKE_MAP = 'smoke-on';
MAP_CONFIGS[SMOKE_MAP] = { ...WORLD_CONFIG, mapId: SMOKE_MAP, display: { ...WORLD_CONFIG.display, fieldingSmoke: true } };
const pkgOf = (n: number) => ({ mapId: WORLD_CONFIG.mapId, seatCount: n, version: 1, seats: Array.from({ length: n }, (_, i) => ({ id: i + 1, x: i, y: i })), phaseGroups: {}, topo: { coarse: '' } }) as unknown as GameMapPackage;
const setup = (s = snap(), p = priv(), pkg: GameMapPackage | null = null) => {
  useStore.getState().reset();
  useStore.setState({ me: 'a', gameId: 'g', snapshot: s, priv: p, gamePkg: pkg, names: {}, chat: [], selectedSeat: null } as never);
  return render(<PreCampaign />);
};
const counts = () => [...document.querySelectorAll('[data-tour="candidate-counts"] li')].map(li => [li.getAttribute('data-player'), li.querySelector('.cc-count')!.textContent]);
type Brush = { radiusPx: number; onPaint(s: number[]): void; onStrokeEnd(): void };

const fieldAll = () => document.querySelector<HTMLButtonElement>('.fp-field-all');
const doneBtn = () => document.querySelector<HTMLButtonElement>('.fp-done');

beforeEach(() => { mapProps.last = null; vi.mocked(fieldCandidates).mockClear(); vi.mocked(doneFielding).mockClear(); });

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
    for (const hook of ['hud-party', 'hud-budget', 'map', 'candidate-counts', 'precampaign-chat', 'field-all', 'done-fielding']) expect(document.querySelector(`[data-tour="${hook}"]`)).toBeInTheDocument();
  });
  it('lists each party with its live candidate count, own party first', () => {
    setup();
    expect(counts()).toEqual([['a', '1'], ['b', '2'], ['c', '0']]);
    act(() => useStore.getState().applyServer({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 3 }], removed: [], contestedSeats: 3, majority: 2 }));
    expect(counts()).toEqual([['a', '1'], ['b', '2'], ['c', '1']]);
  });
  it('shows each party in the counts as avatar, party name and count, and no stick figure', () => {
    setup(snap({ players: [pl('a', '#1F5FBF'), pl('b', '#E8710A'), pl('c', '#118833')].map(p => ({ ...p, party: { ...p.party!, avatar: 'modi' } })) }));
    const rows = [...document.querySelectorAll('[data-tour="candidate-counts"] li[data-player]')];
    expect(rows).toHaveLength(3);
    for (const li of rows) expect(li.querySelector('.party-avatar img')).toBeInTheDocument();
    expect(rows[1].querySelector('.cc-name')).toHaveTextContent('b Party');
    expect(document.querySelector('[data-tour="candidate-counts"] .candidate-icon')).toBeNull();
    expect(document.querySelector('[data-tour="candidate-counts"] svg')).toBeNull();
  });
  it('shows a tick next to the parties that are done, live, and nowhere else', () => {
    setup(snap({ fieldingDone: ['b'] }));
    const tick = (id: string) => document.querySelector(`li[data-player="${id}"] .cc-done`);
    expect(tick('b')).toBeInTheDocument();
    expect(tick('a')).toBeNull();
    act(() => useStore.getState().applyServer({ type: 'fieldingDone', playerId: 'c', done: true, doneCount: 2, needed: 3 }));
    expect(tick('c')).toBeInTheDocument();
    act(() => useStore.getState().applyServer({ type: 'fieldingDone', playerId: 'b', done: false, doneCount: 1, needed: 3 }));
    expect(tick('b')).toBeNull();
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
  it('gives the map only the own figures, the brush at the configured size, and shades own committed seats', () => {
    setup(snap(), priv({ committed: [{ seat: 3, band: 5, percent: 50, level: 'HIGH' }] }));
    const figures = mapProps.last?.candidates as Record<number, { id: string }[]>;
    expect(Object.keys(figures)).toEqual(['1']);
    expect(figures[1].map(c => c.id)).toEqual(['a']);
    expect((mapProps.last?.brush as Brush).radiusPx).toBe(WORLD_CONFIG.display.brushRadiusPx);
    expect(mapProps.last?.fills).toEqual({ 3: committedFill('#1F5FBF', 'HIGH') });
    expect(mapProps.last?.fillStyle).toBe('committed');
  });
  it('shows no reputation badges', () => {
    setup(snap(), priv({ reputation: { 1: 5 } }));
    expect(mapProps.last?.badges).toBeUndefined();
  });
  it('shows no rival figure on the map when the rivals field more', () => {
    setup();
    act(() => useStore.getState().applyServer({ type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 1 }, { seat: 5 }], removed: [], contestedSeats: 3, majority: 2 }));
    expect(Object.keys(mapProps.last?.candidates as object)).toEqual(['1']);
  });
  it('gives the map no money smoke while display.fieldingSmoke is off, whatever the fieldAck says', () => {
    expect(WORLD_CONFIG.display.fieldingSmoke).toBe(false);
    setup();
    act(() => useStore.getState().applyServer({ type: 'fieldAck', ok: true, budget: 9_000, added: [{ seat: 7 }], removed: [] }));
    expect(mapProps.last?.gains).toBeNull();
  });
  it('turns the fieldAck into a red smoke of the configured cost on the map when display.fieldingSmoke is on', () => {
    setup(snap({ mapId: SMOKE_MAP }));
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
  it('explains Field all seats and Done fielding in the hint', () => {
    setup();
    const hint = document.querySelector('.precampaign-hint')!;
    expect(hint).toHaveTextContent('Field all seats');
    expect(hint).toHaveTextContent('Done fielding');
    expect(hint).toHaveTextContent(/campaign starts as soon as everybody is done/);
  });
  it('shows the clocks of the NEW timeline when the campaign starts early', () => {
    setup(snap());
    const t = snap().timeline!;
    act(() => useStore.getState().applyServer({ type: 'status', status: 'campaign', timeline: { ...t, preCampaignEnd: Date.now(), campaignStart: Date.now() - 1, campaignEnd: Date.now() + 150_000 } }));
    expect(screen.getByText('Campaign ends in')).toBeInTheDocument();
    expect(document.querySelector('[data-tour="hud-campaign"]')).toHaveTextContent(/2:(29|3[0-2])/);
  });
});

describe('Field all seats', () => {
  it('shows the price of the seats not fielded yet and sends one request with exactly those seats', () => {
    setup(snap(), priv({ budget: 10 * COST }), pkgOf(5));
    expect(fieldAll()).toHaveTextContent('4 seats');
    expect(fieldAll()).toHaveTextContent((4 * COST).toLocaleString('en-IN'));
    act(() => fieldAll()!.click());
    expect(fieldCandidates).toHaveBeenCalledTimes(1);
    expect(fieldCandidates).toHaveBeenCalledWith([2, 3, 4, 5]); // seat 1 is already ours
  });
  it('skips seats whose request is still in flight', () => {
    setup(snap(), priv({ budget: 10 * COST }), pkgOf(5));
    act(() => useStore.getState().trackField('r', [3]));
    expect(fieldAll()).toHaveTextContent('3 seats');
    act(() => fieldAll()!.click());
    expect(fieldCandidates).toHaveBeenCalledWith([2, 4, 5]);
  });
  it('sends nothing and shows one clear toast when the budget cannot pay for all of them', () => {
    setup(snap(), priv({ budget: 2 * COST }), pkgOf(5));
    act(() => fieldAll()!.click());
    expect(fieldCandidates).not.toHaveBeenCalled();
    expect(useStore.getState().error).toMatch(/Not enough budget/);
  });
  it('is disabled when you already have every seat, and without a map package', () => {
    setup(snap({ fielding: { 1: [{ playerId: 'a' }], 2: [{ playerId: 'a' }] } }), priv(), pkgOf(2));
    expect(fieldAll()).toBeDisabled();
    setup(snap(), priv(), null);
    expect(fieldAll()).toBeDisabled();
  });
  it('is not offered to a player who is out', () => {
    setup(snap({ players: [pl('a', '#1F5FBF', 'eliminated'), pl('b', '#E8710A'), pl('c', '#118833')] }), priv(), pkgOf(5));
    expect(fieldAll()).toBeNull();
  });
});

describe('Done fielding', () => {
  it('is disabled with a visible reason while you have no candidates', () => {
    setup(snap({ fielding: { 2: [{ playerId: 'b' }] } }));
    expect(doneBtn()).toBeDisabled();
    expect(document.querySelector('.fp-done-reason')).toHaveTextContent(/Field at least one candidate/);
    act(() => doneBtn()!.click());
    expect(doneFielding).not.toHaveBeenCalled();
  });
  it('says Done fielding, and sends done true when pressed', () => {
    setup();
    expect(doneBtn()).toHaveTextContent('Done fielding');
    expect(doneBtn()).toBeEnabled();
    expect(document.querySelector('.fp-done-reason')).toBeNull();
    act(() => doneBtn()!.click());
    expect(doneFielding).toHaveBeenCalledWith(true);
  });
  it('toggles to Not done yet once you are done, and pressing that takes it back', () => {
    setup(snap({ fieldingDone: ['a'] }));
    expect(doneBtn()).toHaveTextContent('Not done yet');
    act(() => doneBtn()!.click());
    expect(doneFielding).toHaveBeenCalledWith(false);
  });
  it('goes back to Done fielding when your Done is cleared (the server says so, or you field or withdraw)', () => {
    setup(snap({ fieldingDone: ['a'] }));
    act(() => useStore.getState().applyServer({ type: 'fieldingDone', playerId: 'a', done: false, doneCount: 0, needed: 3 }));
    expect(doneBtn()).toHaveTextContent('Done fielding');
    act(() => useStore.getState().applyServer({ type: 'fieldingDone', playerId: 'a', done: true, doneCount: 1, needed: 3 }));
    expect(doneBtn()).toHaveTextContent('Not done yet');
    act(() => useStore.getState().clearMyDone());
    expect(doneBtn()).toHaveTextContent('Done fielding');
  });
  it('shows n of m done, live', () => {
    setup(snap({ fieldingDone: ['b'] }));
    const line = () => document.querySelector('.cc-done-count')!;
    expect(line()).toHaveTextContent('1 of 3 done');
    act(() => useStore.getState().applyServer({ type: 'fieldingDone', playerId: 'a', done: true, doneCount: 2, needed: 3 }));
    expect(line()).toHaveTextContent('2 of 3 done');
  });
  it('counts only the connected players in m, as the server does', () => {
    setup(snap({ fieldingDone: [], players: [pl('a', '#1F5FBF'), pl('b', '#E8710A'), pl('c', '#118833', 'disconnected')] }));
    expect(document.querySelector('.cc-done-count')).toHaveTextContent('0 of 2 done');
  });
  it('is not offered to a player who is out', () => {
    setup(snap({ players: [pl('a', '#1F5FBF', 'eliminated'), pl('b', '#E8710A'), pl('c', '#118833')] }));
    expect(doneBtn()).toBeNull();
  });
  it('has both buttons above the counts list', () => {
    setup();
    const all = [...document.querySelector('[data-tour="side"]')!.querySelectorAll('.fp-field-all, .fp-done, .candidate-counts')];
    expect(all.map(e => e.classList.contains('candidate-counts'))).toEqual([false, false, true]);
  });
});
