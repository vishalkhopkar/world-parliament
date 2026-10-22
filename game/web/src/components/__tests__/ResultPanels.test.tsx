// The result panel set: staggered per-slot clocks, config-driven timing, newest-first feed, wide-screen + counting-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MAP_CONFIGS } from '@hp/shared';
import type { GameSnapshot, PlayerPublic, SeatSharesMessage } from '@hp/shared';
import { FAKE_CONFIG } from '../../../test/fakeMap';

const peek = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../net/client', () => ({ peekSeat: peek.fn }));

import { useStore } from '../../state/store';
import { ResultPanels } from '../ResultPanels';

const p1: PlayerPublic = { playerId: 'p1', nickname: 'A', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } };
const p2: PlayerPublic = { playerId: 'p2', nickname: 'B', isAdmin: false, status: 'active', party: { name: 'Blue Front', colour: '#1F5FBF', symbol: 'anchor' } };
const p3: PlayerPublic = { playerId: 'p3', nickname: 'C', isAdmin: false, status: 'active', party: { name: 'Old Guard', colour: '#1E8C45', symbol: 'leaf' } };

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: 3, postCountingEnd: 4 },
  players: [p1, p2, p3], news: [], polledPhases: [],
  seats: { 1: { seat: 1, status: 'leading', playerId: 'p1' }, 2: { seat: 2, status: 'leading', playerId: 'p1' } },
  tally: null, offers: [], government: null, result: null, ...over,
});

let wide = true;
let answers = true;

beforeEach(() => {
  vi.useFakeTimers();
  wide = true; answers = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: wide, addEventListener: () => {}, removeEventListener: () => {} })));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('result-panels') ? 650 : 0; } });
  peek.fn.mockReset();
  peek.fn.mockImplementation((seat: number) => {
    if (!answers) return;
    const m: SeatSharesMessage = { type: 'seatShares', seat, status: useStore.getState().snapshot!.seats[seat].status, shares: { p1: 0.5, p2: 0.3, p3: 0.2 },
      candidates: { p1: 'Asha Rao', p2: 'Ben Cole', p3: 'Jamaluddin Mohammed Hussain' } };
    useStore.setState(s => ({ seatShares: { ...s.seatShares, [seat]: m } }));
  });
  useStore.setState({ me: 'p1', gameId: 'g', seatShares: {}, names: { 1: 'Konkan', 2: 'Malnad', 3: 'Western' }, snapshot: snap() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight; });

const D = FAKE_CONFIG.counting.panelDisplayMs; // configured display time (game.properties)
const run = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const cards = (c: HTMLElement) => c.querySelectorAll('.rp');

describe('ResultPanels timing', () => {
  it('slot k first shows at k x stagger and then refreshes on its own panelDisplayMs clock', async () => {
    const { container } = render(<ResultPanels />);
    expect(cards(container)).toHaveLength(0);
    await run(0);
    expect(cards(container)).toHaveLength(1);
    await run(499);
    expect(cards(container)).toHaveLength(1);
    await run(1);
    expect(cards(container)).toHaveLength(2);
    await run(500);
    expect(cards(container)).toHaveLength(3); // 650 px column -> 3 panels
    expect(peek.fn).toHaveBeenCalledTimes(3);
    await run(D - 1001); // t = D - 1
    expect(peek.fn).toHaveBeenCalledTimes(3);
    await run(1); // t = D: slot 0 again
    expect(peek.fn).toHaveBeenCalledTimes(4);
    await run(500); // D + 500: slot 1
    expect(peek.fn).toHaveBeenCalledTimes(5);
    await run(500); // D + 1000: slot 2
    expect(peek.fn).toHaveBeenCalledTimes(6);
    expect(cards(container)).toHaveLength(3);
  });

  it('reads the timing from the map config', async () => {
    MAP_CONFIGS['fake-fast'] = { ...FAKE_CONFIG, mapId: 'fake-fast', counting: { ...FAKE_CONFIG.counting, panelDisplayMs: 1000, panelStaggerMs: 100 } };
    useStore.setState({ snapshot: snap({ mapId: 'fake-fast' }) });
    render(<ResultPanels />);
    await run(0);
    expect(peek.fn).toHaveBeenCalledTimes(1);
    await run(200);
    expect(peek.fn).toHaveBeenCalledTimes(3);
    await run(800); // t = 1000: slot 0 refreshes
    expect(peek.fn).toHaveBeenCalledTimes(4);
    await run(100); // slot 1
    expect(peek.fn).toHaveBeenCalledTimes(5);
    delete MAP_CONFIGS['fake-fast'];
  });

  it('skips a card whose answer does not arrive and tries the next', async () => {
    answers = false;
    const { container } = render(<ResultPanels />);
    await run(0);
    expect(peek.fn).toHaveBeenCalledTimes(1);
    await run(1500);
    expect(peek.fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cards(container)).toHaveLength(0);
  });
});

describe('ResultPanels content', () => {
  it('shows the newest event first, then its companion on the next slot', async () => {
    const { container } = render(<ResultPanels />);
    await run(1010); // all three slots have their first card
    const s = useStore.getState().snapshot!;
    act(() => useStore.setState({ snapshot: { ...s, seats: { ...s.seats, 3: { seat: 3, status: 'leading', playerId: 'p2' } } } }));
    await run(D - 1000); // t = D + 10: slot 0 refreshes: LEADS for the new seat 3 (leader p2)
    const first = cards(container)[0] as HTMLElement;
    expect(first).toHaveAttribute('data-kind', 'LEADS');
    expect(first).toHaveTextContent('Western');
    expect(first).toHaveTextContent('BEN COLE');
    expect(first).toHaveTextContent('Blue Front');
    await run(500); // slot 1 (D + 500): the companion TRAILS of seat 3
    const second = cards(container)[1] as HTMLElement;
    expect(second).toHaveAttribute('data-kind', 'TRAILS');
    expect(second).toHaveTextContent('Western');
  });

  it('shows WON and LOST for a won seat', async () => {
    const { container } = render(<ResultPanels />);
    await run(1010); // all three slots have their first card
    const s = useStore.getState().snapshot!;
    act(() => useStore.setState({ snapshot: { ...s, seats: { ...s.seats, 1: { seat: 1, status: 'won', playerId: 'p1' } } } }));
    await run(D - 1000); // t = D + 10:
    expect((cards(container)[0] as HTMLElement).dataset.kind).toBe('WON');
    await run(500);
    expect((cards(container)[1] as HTMLElement).dataset.kind).toBe('LOST');
  });
});

describe('ResultPanels visibility', () => {
  it('renders nothing and sends no peeks below 1200 px', async () => {
    wide = false;
    const { container } = render(<ResultPanels />);
    await run(10_000);
    expect(container).toBeEmptyDOMElement();
    expect(peek.fn).not.toHaveBeenCalled();
  });

  it('renders nothing and sends no peeks when the game is not counting', async () => {
    useStore.setState({ snapshot: snap({ status: 'postCounting' }) });
    const { container } = render(<ResultPanels />);
    await run(10_000);
    expect(container).toBeEmptyDOMElement();
    expect(peek.fn).not.toHaveBeenCalled();
  });
});
