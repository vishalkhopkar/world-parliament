import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, MapConfig, PlayerPublic, PrivateState } from '@hp/shared';

const cfgBox = vi.hoisted(() => ({ cfg: null as unknown as MapConfig }));
vi.mock('../../state/mapConfig', () => ({ useMapConfig: () => cfgBox.cfg, mapConfigFor: () => cfgBox.cfg }));
vi.mock('../../net/client', () => ({ leaveTour: vi.fn(), leaveGame: vi.fn(), campaign: vi.fn(), peekSeat: vi.fn(), buyReport: vi.fn() }));

import { leaveTour } from '../../net/client';
import { useStore } from '../../state/store';
import { useTour } from '../tourStore';
import { visibleSteps } from '../steps';
import { TourOverlay } from '../TourOverlay';
import { CampaignHud } from '../../components/campaign';

const N = 500;
const parties = ['Your Party', 'National Alliance', 'Green Leaf', 'People’s Star', 'Mountain Union', 'Harbour League', 'Sunrise', 'Reform Bell', 'Forest Front'];
const seatsOf = [110, 249, 30, 28, 25, 20, 17, 12, 9];
const players: PlayerPublic[] = parties.map((n, i) => ({ playerId: 'p' + i, nickname: n, isAdmin: i === 0, status: 'active', party: { name: n, colour: '#1F5FBF', symbol: 'sun' } }));
const withReports = (on: boolean): MapConfig => ({
  ...WORLD_CONFIG,
  analyst: { ...WORLD_CONFIG.analyst, seatReport: { ...WORLD_CONFIG.analyst.seatReport, enabled: on }, globalReport: { ...WORLD_CONFIG.analyst.globalReport, enabled: on } },
});

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'campaign', phases: 1,
  timeline: { campaignStart: 0, phaseCloses: [Date.now() + 1e11], campaignEnd: Date.now() + 1e11, countingEnd: Date.now() + 1e11, postCountingEnd: Date.now() + 1e11 },
  players, news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const pv = (over: Partial<PrivateState> = {}): PrivateState => ({
  you: 'p0', budget: WORLD_CONFIG.budget, myActions: [], myReports: [], nextRallyAt: null,
  committed: [{ seat: 48, band: 1, percent: 30, level: 'HIGH' }], reputation: {}, ...over,
});
const tally = (): GameSnapshot['tally'] => ({
  leads: Object.fromEntries(players.map((p, i) => [p.playerId, seatsOf[i]])), wins: Object.fromEntries(players.map(p => [p.playerId, 0])), declared: 0, total: N,
});

function setup(over: { snap?: Partial<GameSnapshot>; priv?: Partial<PrivateState>; reports?: boolean; step?: string } = {}) {
  cfgBox.cfg = withReports(over.reports ?? false);
  useStore.setState({ gameId: 'g', me: 'p0', snapshot: snap(over.snap), priv: pv(over.priv), selectedSeat: null, error: null, clockOffset: 0, repGain: null } as never);
  useTour.setState({ active: true, step: 0, frozenClock: true, countPaused: false, done: {}, controls: { startCounting: vi.fn() } });
  if (over.step) goTo(over.step);
}
const stepsNow = () => visibleSteps(() => undefined, cfgBox.cfg, 9);
function goTo(id: string) {
  const i = stepsNow().findIndex(s => s.id === id);
  if (i < 0) throw new Error('no such step ' + id);
  useTour.setState({ step: i });
}
const callout = () => screen.getByTestId('tour-callout');

beforeEach(() => { vi.mocked(leaveTour).mockClear(); Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true }); });
afterEach(() => { useTour.getState().reset(); useStore.getState().reset(); document.body.classList.remove('tour-sheet'); });

describe('TourOverlay steps', () => {
  it('opens with the welcome step: seat count, majority and party count from the config', () => {
    setup();
    render(<TourOverlay />);
    expect(callout().dataset.step).toBe('welcome');
    expect(callout()).toHaveTextContent('500 parliament seats');
    expect(callout()).toHaveTextContent('251 seats');
    expect(callout()).toHaveTextContent('9 parties');
    expect(screen.getByTestId('tour-count')).toHaveTextContent(`Step 1 of ${stepsNow().length}`);
  });

  it('is not shown when the tour is not active', () => {
    setup();
    useTour.setState({ active: false });
    render(<TourOverlay />);
    expect(screen.queryByTestId('tour-callout')).toBeNull();
  });

  it('Next and Back move between steps; Back is not offered on the first step', async () => {
    setup();
    const user = userEvent.setup();
    render(<TourOverlay />);
    expect(within(callout()).queryByRole('button', { name: 'Back' })).toBeNull();
    await user.click(within(callout()).getByRole('button', { name: 'Next' }));
    expect(callout().dataset.step).toBe('party');
    expect(screen.getByTestId('tour-count')).toHaveTextContent('Step 2 of');
    await user.click(within(callout()).getByRole('button', { name: 'Back' }));
    expect(callout().dataset.step).toBe('welcome');
  });

  it('explains the clocks with the real campaign length from the config', () => {
    setup({ step: 'clocks' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent(`${WORLD_CONFIG.durations.campaignMs / 60000} minutes`);
    expect(callout()).toHaveTextContent('0:00');
  });

  it('budget and costs come from the config', () => {
    setup({ step: 'budget' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent((WORLD_CONFIG.budget).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent((WORLD_CONFIG.costs.rally).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent((WORLD_CONFIG.costs.roadshow).toLocaleString('en-IN'));
  });

  it('skips the analyst-report step while both reports are disabled, and shows it when one is enabled', () => {
    cfgBox.cfg = withReports(false);
    expect(stepsNow().some(s => s.id === 'analyst')).toBe(false);
    cfgBox.cfg = withReports(true);
    expect(stepsNow().some(s => s.id === 'analyst')).toBe(true);
    setup({ reports: true, step: 'analyst' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Analyst reports');
    expect(callout()).toHaveTextContent(String(WORLD_CONFIG.analyst.delayMs / 1000));
  });

  it('shows one report step when only the global report is on', () => {
    cfgBox.cfg = { ...withReports(false), analyst: { ...WORLD_CONFIG.analyst, seatReport: { ...WORLD_CONFIG.analyst.seatReport, enabled: false }, globalReport: { ...WORLD_CONFIG.analyst.globalReport, enabled: true } } };
    expect(stepsNow().filter(s => s.id === 'analyst')).toHaveLength(1);
  });

  it('never walks through the report step with the default (disabled) config', async () => {
    setup();
    const user = userEvent.setup();
    render(<TourOverlay />);
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) { seen.push(callout().dataset.step!); await user.click(within(callout()).getByRole('button', { name: 'Next' })); }
    expect(seen).toContain('chat');
    expect(seen).not.toContain('analyst');
    expect(callout().dataset.step).toBe('committed');
  });

  it('leaves out the chat step in a 2-player game', () => {
    expect(visibleSteps(() => undefined, withReports(false), 2).some(s => s.id === 'chat')).toBe(false);
    expect(visibleSteps(() => undefined, withReports(false), 9).some(s => s.id === 'chat')).toBe(true);
  });

  it('the vote-model step reads the percentages from the config and offers Start counting', async () => {
    setup({ step: 'votes' });
    const start = vi.fn();
    useTour.setState({ controls: { startCounting: start } });
    const user = userEvent.setup();
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent(`0 to ${WORLD_CONFIG.voting.influenceMaxPercent}%`);
    expect(callout()).toHaveTextContent(`0 to ${WORLD_CONFIG.voting.randomMaxPercent * 9}%`);
    await user.click(within(callout()).getByRole('button', { name: 'Start counting' }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('Skip tour leaves the tour', async () => {
    setup();
    const user = userEvent.setup();
    render(<TourOverlay />);
    await user.click(within(callout()).getByRole('button', { name: 'Skip tour' }));
    expect(leaveTour).toHaveBeenCalledTimes(1);
  });

  it('uses a bottom sheet on a phone', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    setup();
    render(<TourOverlay />);
    expect(callout()).toHaveClass('sheet');
    expect(document.body).toHaveClass('tour-sheet');
  });
});

describe('TourOverlay task steps', () => {
  it('committed: waits for a click on a committed seat, then shows the panel text', async () => {
    setup({ step: 'committed' });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done');
    expect(within(callout()).getByRole('button', { name: 'Skip this step' })).toBeInTheDocument();
    act(() => useStore.setState({ selectedSeat: 3 }));
    await new Promise(r => setTimeout(r, 400));
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done'); // not one of mine
    act(() => useStore.setState({ selectedSeat: 48 }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('~30%');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('HIGH');
    expect(within(callout()).getByRole('button', { name: 'Next' })).toBeInTheDocument();
  });

  it('committed: "Show me one" selects a committed seat and completes the task', async () => {
    setup({ step: 'committed' });
    const user = userEvent.setup();
    render(<TourOverlay />);
    await user.click(screen.getByRole('button', { name: 'Show me one' }));
    expect(useStore.getState().selectedSeat).toBe(48);
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
  });

  it('rally: done when a rally appears in my actions; explains the numbers from the config', async () => {
    setup({ step: 'rally' });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done');
    act(() => useStore.setState({
      priv: pv({ myActions: [{ type: 'rally', seat: 5, ts: 1 }] }),
      repGain: { key: 1, type: 'rally', seat: 5, seats: { 5: 42, 6: 17 } },
    }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    const t = screen.getByTestId('tour-task');
    const { local, global, decay } = WORLD_CONFIG.effects.rally;
    const scale = WORLD_CONFIG.display.reputationScale;
    expect(t).toHaveTextContent('+42');
    expect(t).toHaveTextContent(String(Math.round((local + global) * scale)));
    expect(t).toHaveTextContent(`${decay.maxKm} km`);
    expect(t).toHaveTextContent(`+${Math.round(global * scale)}`);
  });

  it('cooldown: done by the refusal message (toast) while the step is shown', async () => {
    setup({ step: 'cooldown' });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done');
    act(() => useStore.setState({ error: 'You can rally once every 15 s; next rally in 12 s' }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent(`${WORLD_CONFIG.cooldowns.rallyMs / 1000} seconds`);
  });

  it('cooldown: also done when a seat panel is open while the Rally button counts down', async () => {
    setup({ step: 'cooldown' });
    render(<TourOverlay />);
    act(() => useStore.setState({ selectedSeat: 3, priv: pv({ nextRallyAt: Date.now() + 10_000 }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
  });

  it('roadshow: done when a roadshow appears; the local effect comes from the config', async () => {
    setup({ step: 'roadshow' });
    render(<TourOverlay />);
    act(() => useStore.setState({ priv: pv({ myActions: [{ type: 'roadshow', seat: 5, ts: 1 }] }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent(String(Math.round(WORLD_CONFIG.effects.roadshow.local * WORLD_CONFIG.display.reputationScale)));
  });

  it('a task can be skipped with "Skip this step"', async () => {
    setup({ step: 'rally' });
    const user = userEvent.setup();
    render(<TourOverlay />);
    await user.click(within(callout()).getByRole('button', { name: 'Skip this step' }));
    expect(callout().dataset.step).toBe('cooldown');
  });
});

describe('TourOverlay counting steps', () => {
  const counting = (over: Partial<GameSnapshot> = {}) => ({ status: 'counting' as const, tally: tally(), ...over });

  it('the campaign steps give way to the counting steps when counting starts', async () => {
    setup({ step: 'votes' });
    render(<TourOverlay />);
    act(() => useStore.setState({ snapshot: snap(counting()) }));
    await waitFor(() => expect(callout().dataset.step).toBe('counting'));
    expect(callout()).toHaveTextContent('majority mark, 251');
    expect(callout()).toHaveTextContent(`${WORLD_CONFIG.durations.countingMs / 60000} minutes`);
  });

  it('the paused step waits for the pause, then names the largest party and the exact arithmetic', async () => {
    setup({ step: 'paused', snap: counting() });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-wait')).toBeInTheDocument();
    expect(within(callout()).getByRole('button', { name: 'Next' })).toBeDisabled();
    act(() => useTour.getState().setCountPaused(true));
    await waitFor(() => expect(within(callout()).getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(callout()).toHaveTextContent('National Alliance');
    expect(callout()).toHaveTextContent('249');
    expect(callout()).toHaveTextContent('2 short of the majority (251)');
    expect(callout()).toHaveTextContent('You have 110');
    expect(callout()).toHaveTextContent('(141 seats)');
    expect(callout()).toHaveTextContent('exactly 251');
  });

  it('the government step lists the posts from the config and follows the offer', async () => {
    setup({ step: 'govern', snap: counting() });
    render(<TourOverlay />);
    for (const p of WORLD_CONFIG.points.portfolios.filter(p => p.id !== 'PM')) expect(callout()).toHaveTextContent(p.label);
    expect(callout()).toHaveTextContent('Deputy Prime Minister (up to 2)');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Fill the posts');
    const offer = (status: 'open' | 'declined' | 'accepted') => ({ offerId: 'o', proposer: 'p0', portfolios: {}, partners: ['p2', 'p3'], accepted: ['p2'], status, createdAt: 1, declinedBy: status === 'declined' ? 'p3' : undefined });
    act(() => useStore.setState({ snapshot: snap(counting({ offers: [offer('open')] })) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveTextContent('1 of 2 have accepted'));
    act(() => useStore.setState({ snapshot: snap(counting({ offers: [offer('declined')] })) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveTextContent(/People.s Star declined/));
    act(() => useStore.setState({ snapshot: snap(counting({ offers: [offer('accepted')] })) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('251');
  });

  it('jumps to the result step when the game finishes, with the coalition headline and the buttons', async () => {
    setup({ step: 'resume', snap: counting() });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-wait')).toBeInTheDocument();
    const tl = { campaignStart: 0, phaseCloses: [1], campaignEnd: 1, countingEnd: 1, postCountingEnd: 1 };
    const wins = Object.fromEntries(players.map((p, i) => [p.playerId, seatsOf[i]]));
    act(() => useStore.setState({
      snapshot: snap({
        status: 'finished', timeline: tl, tally: { leads: {}, wins, declared: N, total: N },
        result: {
          outcome: 'coalition', tally: wins, government: null, winners: ['p0'],
          points: players.map(p => ({ playerId: p.playerId, portfolioPoints: p.playerId === 'p0' ? 100 : 0, seatPoints: 0, governmentFloor: 0, total: p.playerId === 'p0' ? 154 : 0 })),
        },
      }),
    }));
    await waitFor(() => expect(callout().dataset.step).toBe('result'));
    expect(callout()).toHaveTextContent('Your coalition governs');
    expect(callout()).toHaveTextContent('single largest party');
    expect(callout()).toHaveTextContent('National Alliance');
    expect(callout()).toHaveTextContent('249 seats');
    expect(callout()).toHaveTextContent('You scored 154');
    expect(within(callout()).getByRole('button', { name: 'Restart tour' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(callout()).getByRole('button', { name: 'Play a real game' }));
    expect(leaveTour).toHaveBeenCalledTimes(1);
  });

  it('does not offer Back across the campaign/counting boundary', () => {
    setup({ step: 'counting', snap: counting() });
    render(<TourOverlay />);
    expect(within(callout()).queryByRole('button', { name: 'Back' })).toBeNull();
  });
});

describe('Campaign HUD in tour mode', () => {
  const now = Date.now();
  const hudSnap = () => snap({ timeline: { campaignStart: now - 1000, phaseCloses: [now + 3e11], campaignEnd: now + 3e11, countingEnd: now + 3e11, postCountingEnd: now + 3e11 } });

  it('shows 0:00 on both timers while the tour clock is frozen', () => {
    setup();
    const { container } = render(<CampaignHud snap={hudSnap()} priv={pv()} now={now} />);
    const strongs = ['hud-campaign', 'hud-phase'].map(k => container.querySelector('[data-tour="' + k + '"] strong')?.textContent);
    expect(strongs).toEqual(['0:00', '0:00']);
  });

  it('shows the real countdown otherwise', () => {
    setup();
    useTour.setState({ frozenClock: false });
    const { container } = render(<CampaignHud snap={hudSnap()} priv={pv()} now={now} />);
    const strongs = ['hud-campaign', 'hud-phase'].map(k => container.querySelector('[data-tour="' + k + '"] strong')?.textContent);
    expect(strongs[0]).not.toBe('0:00');
  });

  it('marks the HUD items the tour points at', () => {
    setup();
    const { container } = render(<CampaignHud snap={hudSnap()} priv={pv()} now={now} />);
    for (const k of ['hud-party', 'hud-campaign', 'hud-phase', 'hud-budget']) expect(container.querySelector(`[data-tour="${k}"]`)).not.toBeNull();
  });
});
