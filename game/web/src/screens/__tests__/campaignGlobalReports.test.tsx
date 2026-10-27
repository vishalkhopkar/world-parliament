// Campaign screen: the "News agencies" button and its modal (4 agency charts, ranges, Escape, polling, hidden when disabled).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { GameSnapshot, GlobalReports, PlayerPublic, PrivateState } from '@hp/shared';

const mocks = vi.hoisted(() => ({ cfg: { news: { enabled: true, sampleIntervalMs: 30000, agencies: [] as unknown[] } } as Record<string, unknown> }));
vi.mock('../../net/client', () => ({ chat: vi.fn(), leaveGame: vi.fn(), peekSeat: vi.fn(), campaign: vi.fn(), buyReport: vi.fn(), requestGlobalReports: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: () => <div data-testid="seatmap" /> }));
vi.mock('../../state/mapConfig', async (orig) => {
  const real = await orig<typeof import('../../state/mapConfig')>();
  return { ...real, useMapConfig: () => ({ ...real.useMapConfig(), news: mocks.cfg.news }) };
});

import { requestGlobalReports } from '../../net/client';
import { useStore } from '../../state/store';
import { Campaign } from '../Campaign';
import { NEWS_POLL_LAG_MS } from '../../lib/newsPoll';
import { rangeText } from '../../components/GlobalReportsModal';

const pl = (id: string, colour: string, name: string): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: id === 'a', status: 'active', party: { name, colour, symbol: 'sun' } });
const snap = (tl?: { start: number; end: number }): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'campaign', phases: 1,
  timeline: tl
    ? { campaignStart: tl.start, phaseCloses: [tl.end], campaignEnd: tl.end, countingEnd: tl.end + 1e6, postCountingEnd: tl.end + 2e6 }
    : { campaignStart: 1000, phaseCloses: [Date.now() + 1e6], campaignEnd: Date.now() + 1e6, countingEnd: Date.now() + 2e6, postCountingEnd: Date.now() + 3e6 },
  players: [pl('a', 'blue', 'Alpha'), pl('b', 'orange', 'Bravo')], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null,
});
const pkg = { phaseGroups: { '1': [[1]] }, seats: [{ id: 1, x: 1, y: 1, lon: 1, lat: 1, neighbours: [] }] };
const priv: PrivateState = { you: 'a', budget: 100, myActions: [], myReports: [] };
const names = ['Kal Tak', 'Toofan Express', 'Woof News', 'World Today'];
const reports = (): GlobalReports => ({
  asOf: 31000, sampleIntervalMs: 30000,
  agencies: names.map((n, i) => ({
    id: 'ag' + i, name: n,
    points: [{ t: 1000, seats: { a: 250, b: 250 } }, { t: 31000, seats: { a: 300, b: 200 } }],
    ranges: { a: [250, 340], b: [160, 230] as [number, number] },
  })),
});
const setup = (tl?: { start: number; end: number }) => useStore.setState({ me: 'a', gameId: 'g', snapshot: snap(tl), clockOffset: 0, priv, lobby: null, gamePkg: pkg, names: {}, chat: [], selectedSeat: null, polledSeats: [], globalReports: null } as never);

beforeEach(() => { mocks.cfg.news = { enabled: true, sampleIntervalMs: 30000, agencies: [] }; vi.mocked(requestGlobalReports).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('Campaign global reports', () => {
  it('hides the button when news is disabled', () => {
    mocks.cfg.news = { enabled: false, sampleIntervalMs: 30000, agencies: [] };
    setup();
    const { container } = render(<Campaign />);
    expect(container.querySelector('[data-tour="global-reports"]')).toBeNull();
  });
  it('opens on click, requests at once, shows loading then 4 charts with ranges sorted by midpoint', () => {
    setup();
    const { container } = render(<Campaign />);
    const btn = container.querySelector('[data-tour="global-reports"]') as HTMLElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(requestGlobalReports).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'News agencies' })).toBeTruthy();
    expect(screen.getByText('Loading…')).toBeTruthy();
    act(() => useStore.getState().applyServer({ type: 'globalReports', reports: reports() }));
    expect(screen.getAllByTestId('gr-chart')).toHaveLength(4);
    for (const n of names) expect(screen.getByText(n)).toBeTruthy();
    const first = screen.getAllByTestId('gr-agency')[0];
    const rows = within(first).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('Alpha');
    expect(rows[0].textContent).toContain('250–340');
    expect(rows[1].textContent).toContain('160–230');
  });
  it('closes on Escape and stops polling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    setup({ start: 100_000, end: 100_000 + 600_000 });
    useStore.setState({ globalReports: reports() } as never);
    const { container } = render(<Campaign />);
    fireEvent.click(container.querySelector('[data-tour="global-reports"]') as HTMLElement);
    expect(requestGlobalReports).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(NEWS_POLL_LAG_MS); }); // opened exactly on the grid time 0: the next ask is just after it
    expect(requestGlobalReports).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(90000); });
    expect(requestGlobalReports).toHaveBeenCalledTimes(2);
  });
  it('polls just after each sample-grid time (not every interval from opening) and stops once the campaign has ended', () => {
    vi.useFakeTimers();
    const S = 1_000_000;
    vi.setSystemTime(S + 10_000); // opened 10 s into a 30 s interval
    setup({ start: S, end: S + 70_000 }); // the end is off the grid (30, 60, then 70)
    useStore.setState({ globalReports: reports() } as never);
    const { container } = render(<Campaign />);
    fireEvent.click(container.querySelector('[data-tour="global-reports"]') as HTMLElement);
    expect(requestGlobalReports).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(20_000 + NEWS_POLL_LAG_MS - 1); }); // not yet (grid 30 s + lag)
    expect(requestGlobalReports).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1); }); // S + 30 s + lag
    expect(requestGlobalReports).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(30_000 - 1); });
    expect(requestGlobalReports).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(1); }); // S + 60 s + lag
    expect(requestGlobalReports).toHaveBeenCalledTimes(3);
    act(() => { vi.advanceTimersByTime(10_000); }); // the closing point at the campaign end
    expect(requestGlobalReports).toHaveBeenCalledTimes(4);
    act(() => { vi.advanceTimersByTime(300_000); }); // frozen: no more requests
    expect(requestGlobalReports).toHaveBeenCalledTimes(4);
  });
  it('does not poll at all when the campaign has already ended (frozen series): one request on open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    setup({ start: 1_000_000, end: 1_600_000 });
    useStore.setState({ globalReports: reports() } as never);
    const { container } = render(<Campaign />);
    fireEvent.click(container.querySelector('[data-tour="global-reports"]') as HTMLElement);
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(requestGlobalReports).toHaveBeenCalledTimes(1);
  });
  it('uses the server clock (clockOffset), not the local one, to find the next grid time', () => {
    vi.useFakeTimers();
    const S = 1_000_000;
    vi.setSystemTime(S + 5_000);
    setup({ start: S, end: S + 600_000 });
    useStore.setState({ globalReports: reports(), clockOffset: 20_000 } as never); // server is 20 s ahead: 25 s into the interval
    const { container } = render(<Campaign />);
    fireEvent.click(container.querySelector('[data-tour="global-reports"]') as HTMLElement);
    act(() => { vi.advanceTimersByTime(5_000 + NEWS_POLL_LAG_MS); });
    expect(requestGlobalReports).toHaveBeenCalledTimes(2);
  });
  it('rangeText shows "lo–hi" and a dash for an unknown party', () => {
    expect(rangeText([3, 9])).toBe('3–9');
    expect(rangeText(undefined)).toBe('–');
  });
});
