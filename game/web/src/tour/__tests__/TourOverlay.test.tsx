import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WORLD_CONFIG, fullyFieldedBudget, majorityOf } from '@hp/shared';
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
  players, news: [], fielding: {}, fieldingDone: [], contestedSeats: N, majority: majorityOf(N), polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const pv = (over: Partial<PrivateState> = {}): PrivateState => ({
  you: 'p0', budget: WORLD_CONFIG.budget, myActions: [], myReports: [], nextRallyAt: null,
  committed: [{ seat: 48, band: 1, percent: 30, level: 'HIGH' }], reputation: {}, ...over,
});
const tally = (): GameSnapshot['tally'] => ({
  leads: Object.fromEntries(players.map((p, i) => [p.playerId, seatsOf[i]])), wins: Object.fromEntries(players.map(p => [p.playerId, 0])), declared: 0, total: N,
});

const withDone = (on: boolean, base: MapConfig = withReports(false)): MapConfig => ({ ...base, preCampaign: { ...base.preCampaign, doneEnabled: on } });

function setup(over: { snap?: Partial<GameSnapshot>; priv?: Partial<PrivateState>; reports?: boolean; step?: string; doneOff?: boolean } = {}) {
  cfgBox.cfg = withDone(!over.doneOff, withReports(over.reports ?? false));
  // the game is in the pre-campaign while the tour shows its pre-campaign steps, in the campaign otherwise
  const phase = over.step ? stepsNow().find(s => s.id === over.step)?.phase : 'preCampaign';
  const status = over.snap?.status ?? (phase === 'preCampaign' ? 'preCampaign' : 'campaign');
  useStore.setState({ gameId: 'g', me: 'p0', snapshot: snap({ ...over.snap, status }), priv: pv(over.priv), selectedSeat: null, error: null, clockOffset: 0, repGain: null } as never);
  useTour.setState({ active: true, step: 0, frozenClock: true, countPaused: false, done: {}, controls: { startCounting: vi.fn(), startCampaign: vi.fn() } });
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

  it('budget and costs come from the config: what is left after the candidates, and the three action prices', () => {
    setup({ step: 'budget', priv: { budget: fullyFieldedBudget(WORLD_CONFIG) } });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent(fullyFieldedBudget(WORLD_CONFIG).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent((WORLD_CONFIG.costs.rally).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent((WORLD_CONFIG.costs.minorRally).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent((WORLD_CONFIG.costs.roadshow).toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent(/major rally/i);
  });

  it('the ticker step says only major rallies are news, minor rallies and roadshows are secret', () => {
    setup({ step: 'ticker' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Every major rally is public news');
    expect(callout()).toHaveTextContent('Minor rallies and roadshows are secret');
  });

  it('the old my-actions step is retired (the panel is hidden in the game)', () => {
    cfgBox.cfg = WORLD_CONFIG;
    expect(stepsNow().some(s => s.id === 'my-actions')).toBe(false);
    expect(stepsNow().some(s => (s.anchor ?? []).some(a => a.includes('my-actions')))).toBe(false);
  });

  it('has a free global-reports step (news agencies) anchored on the button, left out when news is switched off', () => {
    cfgBox.cfg = WORLD_CONFIG;
    const step = stepsNow().find(s => s.id === 'global-reports');
    expect(step?.anchor).toEqual(['[data-tour="global-reports"]']);
    expect(step?.title).toBe('News agencies'); // the button is called "News agencies" (not to be confused with the paid Global report)
    cfgBox.cfg = { ...WORLD_CONFIG, news: { ...WORLD_CONFIG.news, enabled: false } };
    expect(stepsNow().some(s => s.id === 'global-reports')).toBe(false);
    setup({ step: 'chat' });
    cfgBox.cfg = WORLD_CONFIG;
    goTo('global-reports');
    render(<TourOverlay />);
    for (const a of WORLD_CONFIG.news.agencies) expect(callout()).toHaveTextContent(a.name);
    expect(callout()).toHaveTextContent(String(Math.round(WORLD_CONFIG.news.sampleIntervalMs / 1000)));
    expect(callout()).toHaveTextContent(/free/i);
    expect(callout()).toHaveTextContent('News agencies');
    expect(callout()).not.toHaveTextContent('Global reports');
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
    setup({ step: 'clocks' });
    const user = userEvent.setup();
    render(<TourOverlay />);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { seen.push(callout().dataset.step!); await user.click(within(callout()).getByRole('button', { name: 'Next' })); }
    expect(seen).toContain('chat');
    expect(seen).toContain('global-reports');
    expect(seen).not.toContain('analyst');
    expect(callout().dataset.step).toBe('committed');
  });

  it('leaves out the chat step in a 2-player game', () => {
    expect(visibleSteps(() => undefined, withReports(false), 2).some(s => s.id === 'chat')).toBe(false);
    expect(visibleSteps(() => undefined, withReports(false), 9).some(s => s.id === 'chat')).toBe(true);
  });

  it('the chat step follows Chat.Campaigning: group chat with @ tags, one-to-one, or no step when OFF', () => {
    const chatCfg = (campaigning: MapConfig['chat']['campaigning']): MapConfig => ({ ...withReports(false), chat: { campaigning } });
    expect(visibleSteps(() => undefined, chatCfg('OFF'), 9).some(s => s.id === 'chat')).toBe(false);
    setup({ step: 'chat' });
    const { unmount } = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('group chat');
    expect(callout()).toHaveTextContent('Type @ to tag a party');
    expect(callout()).toHaveTextContent('Once counting starts, the chat becomes one-to-one');
    unmount();
    cfgBox.cfg = chatCfg('INDV');
    goTo('chat');
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('one-to-one with every party');
    expect(callout()).not.toHaveTextContent('Type @');
  });

  it('the vote-model step reads the percentages from the config and offers Start counting', async () => {
    setup({ step: 'votes' });
    const start = vi.fn();
    useTour.setState({ controls: { startCounting: start, startCampaign: vi.fn() } });
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
    expect(t).toHaveTextContent(`+${Math.round(local * scale)}`);
    expect(t).not.toHaveTextContent('×'); // no formula, only the displayed numbers
    expect(t).toHaveTextContent(/first .* slightly bigger gain/);
    expect(t).toHaveTextContent(/grow slightly as the campaign goes on/);
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

// Rule: the tour opens with the pre-campaign phase (3+ players): what it is for, painting candidates, their cost, withdrawing,
// the rivals' live counts, the one-to-one chat, the deadline rule, and Next moves on to the campaign. Numbers come from the config.
describe('TourOverlay pre-campaign steps', () => {
  const fieldedBy = (who: string, seats: number[]) => Object.fromEntries(seats.map(s => [s, [{ playerId: who, name: 'Cand ' + s }]]));
  const ids = () => stepsNow().map(s => s.id);
  const setPointer = (fine: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: fine && q.includes('fine'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  afterEach(() => { vi.unstubAllGlobals(); });

  it('comes first: the pre-campaign steps in the designed order, then the campaign steps, with the my-actions step gone', () => {
    cfgBox.cfg = withReports(false);
    const pre = stepsNow().filter(s => s.phase === 'preCampaign').map(s => s.id);
    expect(pre).toEqual(['welcome', 'party', 'precampaign', 'field-seats', 'field-all', 'candidate-cost', 'withdraw-seat', 'candidate-counts', 'done-fielding', 'precampaign-chat', 'no-candidates', 'to-campaign']);
    expect(ids().slice(0, pre.length)).toEqual(pre);
    expect(stepsNow()[pre.length].phase).toBe('campaign');
  });

  it('anchors the steps on the hooks the pre-campaign screen provides', () => {
    cfgBox.cfg = withReports(false);
    const anchor = (id: string) => stepsNow().find(s => s.id === id)?.anchor;
    expect(anchor('candidate-counts')).toEqual(['[data-tour="candidate-counts"]']);
    expect(anchor('precampaign-chat')).toEqual(['[data-tour="precampaign-chat"]']);
    expect(anchor('candidate-cost')).toEqual(['[data-tour="hud-budget"]']);
    expect(anchor('field-seats')).toEqual(['[data-tour="map"]']);
    expect(anchor('field-all')).toEqual(['[data-tour="field-all"]']);
    expect(anchor('done-fielding')).toEqual(['[data-tour="done-fielding"]']);
  });

  it('a 2-player game has no pre-campaign steps', () => {
    cfgBox.cfg = withReports(false);
    const two = visibleSteps(() => undefined, cfgBox.cfg, 2);
    expect(two.some(s => s.phase === 'preCampaign' && s.id !== 'welcome' && s.id !== 'party')).toBe(false);
    expect(visibleSteps(() => undefined, cfgBox.cfg, 9).some(s => s.id === 'field-seats')).toBe(true);
  });

  it('explains what the phase is for: where to stand and informal pre-poll alliances, with its length from the config', () => {
    setup({ step: 'precampaign' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('pre-campaign');
    expect(callout()).toHaveTextContent(`${WORLD_CONFIG.durations.preCampaignMs / 60000} minutes`);
    expect(callout()).toHaveTextContent('where to stand');
    expect(callout()).toHaveTextContent('informal pre-poll alliances');
  });

  it('painting step: the brush wording on a desktop, tap-and-Field wording on a phone', () => {
    setPointer(true);
    setup({ step: 'field-seats' });
    const { unmount } = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('paint over the map');
    expect(callout()).not.toHaveTextContent('Tap a seat');
    unmount();
    setPointer(false);
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Tap a seat');
    expect(callout()).toHaveTextContent('press Field');
    expect(callout()).not.toHaveTextContent('paint over the map');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Field at least 5 seats');
  });

  it('painting task: done once at least a few of your own seats hold a candidate; the cost comes from the config', async () => {
    setup({ step: 'field-seats' });
    render(<TourOverlay />);
    const mine = (n: number) => fieldedBy('p0', Array.from({ length: n }, (_, i) => i + 1));
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: { ...mine(3), ...fieldedBy('p1', [200, 201, 202, 203, 204, 205]) } }) }));
    await new Promise(r => setTimeout(r, 400));
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done'); // rivals' candidates do not count
    expect(screen.getByTestId('tour-task')).toHaveTextContent('3 so far');
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine(5) }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('5 seats now have your candidate');
    expect(screen.getByTestId('tour-task')).toHaveTextContent(WORLD_CONFIG.costs.candidate.toLocaleString('en-IN'));
  });

  it('painting step: you see only your own figures on the map, the seat panel lists everyone who stands there (phone and desktop)', () => {
    setPointer(true);
    setup({ step: 'field-seats' });
    const { unmount } = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('only your own figures');
    expect(callout()).toHaveTextContent('lists every party');
    expect(callout()).not.toHaveTextContent('-50');
    unmount();
    setPointer(false);
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('only your own figures');
  });

  // Rule: one click fields every seat you do not hold yet for the price on the button, all or nothing: a shortcut to painting.
  it('Field all step: explains the one-click shortcut and points at the button, without formulas', () => {
    setup({ step: 'field-all' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Field all seats');
    expect(callout()).toHaveTextContent('every seat you do not hold yet');
    expect(callout()).toHaveTextContent('price shown on the button');
    expect(callout()).toHaveTextContent('shortcut');
    expect(callout()).toHaveTextContent('nothing is fielded');
    expect(callout()).not.toHaveTextContent('×');
    expect(screen.queryByTestId('tour-task')).toBeNull();
  });

  it('cost step: price per candidate, the budget and what a candidate in every seat leaves, all from the config', () => {
    setup({ step: 'candidate-cost' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent(WORLD_CONFIG.costs.candidate.toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent(WORLD_CONFIG.budget.toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent(fullyFieldedBudget(WORLD_CONFIG).toLocaleString('en-IN'));
    expect(callout()).not.toHaveTextContent('×');
  });

  it('withdraw task: done after fielding and then withdrawing (fewer candidates than the peak), refund from the config', async () => {
    setup({ step: 'withdraw-seat' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent("candidate's name");
    expect(callout()).toHaveTextContent('every other party standing there');
    expect(callout()).toHaveTextContent(WORLD_CONFIG.costs.candidate.toLocaleString('en-IN'));
    const mine = (n: number) => fieldedBy('p0', Array.from({ length: n }, (_, i) => i + 1));
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine(4) }) }));
    await new Promise(r => setTimeout(r, 400));
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done');
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine(3) }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('back in your budget');
  });

  it('counts step: anchored on the live counts, quoting the current contested seats and majority', () => {
    setup({ step: 'candidate-counts', snap: { status: 'preCampaign', contestedSeats: 321, majority: 161 } });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('live');
    expect(callout()).toHaveTextContent('321');
    expect(callout()).toHaveTextContent('161');
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', contestedSeats: 400, majority: 201 }) }));
    expect(callout()).toHaveTextContent('400');
    expect(callout()).toHaveTextContent('201');
  });

  // Rule: the counts panel shows each party's avatar with its live candidate count (no figures), and a tick beside a party that is done.
  it('counts step: avatars with live counts and a tick when a party is done; no stick figures or smoke', () => {
    setup({ step: 'candidate-counts', snap: { status: 'preCampaign' } });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('avatar');
    expect(callout()).toHaveTextContent('tick');
    expect(callout()).toHaveTextContent('Done fielding');
    expect(callout()).not.toHaveTextContent('figure');
    expect(callout()).not.toHaveTextContent('-50');
  });

  // Rule: "Done fielding": press it when you have fielded what you want; the campaign starts as soon as every party has pressed it,
  // otherwise when the countdown ends. The task is done when your own Done is in the snapshot, on a phone as on a desktop.
  it('Done fielding step: anchored on the button, says the campaign starts when every party has pressed it or the countdown ends', () => {
    setup({ step: 'done-fielding', snap: { status: 'preCampaign' } });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Done fielding');
    expect(callout()).toHaveTextContent('as soon as every party has pressed it');
    expect(callout()).toHaveTextContent('countdown ends');
    expect(callout()).toHaveTextContent('take it back');
    expect(screen.getByTestId('tour-task')).toBeInTheDocument();
  });

  it('Done task hint: field a seat first while you hold none, then press Done fielding', () => {
    const mine = { 1: [{ playerId: 'p0', name: 'A' }] };
    setup({ step: 'done-fielding', snap: { status: 'preCampaign' } });
    const { unmount } = render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Field at least one seat first');
    unmount();
    setup({ step: 'done-fielding', snap: { status: 'preCampaign', fielding: mine } });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Press Done fielding');
    expect(screen.getByTestId('tour-task')).not.toHaveTextContent('Field at least one seat first');
  });

  it('Done task: done once you are in the snapshot fieldingDone list; it then shows how many parties are done, live', async () => {
    const mine = { 1: [{ playerId: 'p0', name: 'A' }] };
    setup({ step: 'done-fielding', snap: { status: 'preCampaign', fielding: mine } });
    render(<TourOverlay />);
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine, fieldingDone: ['p3'] }) }));
    await new Promise(r => setTimeout(r, 400));
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done'); // a rival's Done does not count
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine, fieldingDone: ['p3', 'p0'] }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('2 of 9 parties are done');
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine, fieldingDone: ['p3', 'p0', 'p4'] }) }));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('3 of 9 parties are done');
  });

  it('Done task works on a phone too: the same hint and completion with the bottom sheet, nothing about a panel on the right', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const mine = { 1: [{ playerId: 'p0', name: 'A' }] };
    setup({ step: 'done-fielding', snap: { status: 'preCampaign', fielding: mine } });
    render(<TourOverlay />);
    expect(callout().className).toContain('sheet');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Press Done fielding');
    expect(callout()).not.toHaveTextContent(/on the right|right panel|right-hand/i);
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine, fieldingDone: ['p0'] }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
  });

  it('Done fielding can be skipped, and Next replaces Skip once the task is done', async () => {
    const mine = { 1: [{ playerId: 'p0', name: 'A' }] };
    setup({ step: 'done-fielding', snap: { status: 'preCampaign', fielding: mine } });
    const user = userEvent.setup();
    render(<TourOverlay />);
    expect(within(callout()).getByRole('button', { name: 'Skip this step' })).toBeInTheDocument();
    act(() => useStore.setState({ snapshot: snap({ status: 'preCampaign', fielding: mine, fieldingDone: ['p0'] }) }));
    await waitFor(() => expect(within(callout()).getByRole('button', { name: 'Next' })).toBeInTheDocument());
    await user.click(within(callout()).getByRole('button', { name: 'Next' }));
    expect(callout().dataset.step).toBe('precampaign-chat');
  });

  it('the campaign opening early (everybody done) moves the tour from the Done step to the first campaign step', async () => {
    setup({ step: 'done-fielding', snap: { status: 'preCampaign' } });
    render(<TourOverlay />);
    act(() => useStore.setState({ snapshot: snap({ status: 'campaign' }) }));
    await waitFor(() => expect(callout().dataset.step).toBe('clocks'));
  });

  it('the last step also says a real game starts the campaign once every party is done, and the tour fields the rest for you', () => {
    setup({ step: 'to-campaign' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('every party has pressed Done fielding');
    expect(callout()).toHaveTextContent('fields candidates for you');
  });

  // Rule: preCampaign.doneEnabled = false switches Done fielding off: the done-fielding step (and its task) is skipped, and no other step
  // mentions Done or ticks. With the switch on (the default) the steps above are unchanged.
  it('Done switch off: the done-fielding step is skipped, the others stay in order, and no step carries the done task', () => {
    cfgBox.cfg = withDone(false);
    const pre = stepsNow().filter(s => s.phase === 'preCampaign').map(s => s.id);
    expect(pre).toEqual(['welcome', 'party', 'precampaign', 'field-seats', 'field-all', 'candidate-cost', 'withdraw-seat', 'candidate-counts', 'precampaign-chat', 'no-candidates', 'to-campaign']);
    expect(stepsNow().some(s => s.task?.id === 'done')).toBe(false);
    cfgBox.cfg = withDone(true);
    expect(stepsNow().some(s => s.task?.id === 'done')).toBe(true);
    expect(stepsNow().map(s => s.id)).toContain('done-fielding');
  });

  it('Done switch off: no pre-campaign step mentions Done fielding or a tick', () => {
    const preIds = (() => { cfgBox.cfg = withDone(false); return stepsNow().filter(s => s.phase === 'preCampaign').map(s => s.id); })();
    for (const id of preIds) {
      setup({ step: id, doneOff: true, snap: { status: 'preCampaign' } });
      const { unmount } = render(<TourOverlay />);
      expect(callout().textContent, id).not.toMatch(/done|tick/i);
      unmount();
    }
  });

  it('Done switch off: the counts and last pre-campaign steps still explain their own part', () => {
    setup({ step: 'candidate-counts', doneOff: true, snap: { status: 'preCampaign' } });
    const first = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('avatar');
    expect(callout()).toHaveTextContent('live');
    expect(callout()).toHaveTextContent('majority');
    first.unmount();
    setup({ step: 'to-campaign', doneOff: true });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('when the clock ends the pre-campaign');
    expect(callout()).toHaveTextContent('fields candidates for you');
  });

  it('Done switch on: the counts and last steps mention the tick and Done fielding', () => {
    setup({ step: 'candidate-counts', snap: { status: 'preCampaign' } });
    const first = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('tick');
    first.unmount();
    setup({ step: 'to-campaign' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('every party has pressed Done fielding');
  });

  it('chat step: one-to-one, informal, nothing enforces the alliances', () => {
    setup({ step: 'precampaign-chat' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('one-to-one');
    expect(callout()).toHaveTextContent('informal');
    expect(callout()).toHaveTextContent('nothing enforces them');
  });

  it('deadline step: a party with no candidates is out, an unfought seat is vacant, 2-player games skip the phase', () => {
    setup({ step: 'no-candidates' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('no candidate anywhere is out of the game');
    expect(callout()).toHaveTextContent('vacant');
    expect(callout()).toHaveTextContent('majority is worked out from the seats that are contested');
    expect(callout()).toHaveTextContent('only 2 players has no pre-campaign');
  });

  it('the last step says the tour fields the rest for you, and its Next starts the campaign', async () => {
    setup({ step: 'to-campaign' });
    const startCampaign = vi.fn();
    useTour.setState({ controls: { startCounting: vi.fn(), startCampaign } });
    const user = userEvent.setup();
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('fields candidates for you');
    expect(callout()).toHaveTextContent(WORLD_CONFIG.costs.candidate.toLocaleString('en-IN'));
    await user.click(within(callout()).getByRole('button', { name: 'Next' }));
    expect(startCampaign).toHaveBeenCalledTimes(1);
  });

  it('when the campaign starts the tour moves from the pre-campaign steps to the first campaign step', async () => {
    setup({ step: 'to-campaign' });
    render(<TourOverlay />);
    act(() => useStore.setState({ snapshot: snap({ status: 'campaign' }) }));
    await waitFor(() => expect(callout().dataset.step).toBe('clocks'));
    expect(within(callout()).queryByRole('button', { name: 'Back' })).toBeNull(); // no way back into the pre-campaign
  });

  it('Back stays inside the pre-campaign steps and is not offered on the first one', async () => {
    setup({ step: 'candidate-counts' });
    const user = userEvent.setup();
    render(<TourOverlay />);
    await user.click(within(callout()).getByRole('button', { name: 'Back' }));
    expect(callout().dataset.step).toBe('withdraw-seat');
    goTo('welcome');
    await waitFor(() => expect(within(callout()).queryByRole('button', { name: 'Back' })).toBeNull());
  });

  it('counting starting while a pre-campaign step is shown still jumps to the counting steps', async () => {
    setup({ step: 'field-seats' });
    render(<TourOverlay />);
    act(() => useStore.setState({ snapshot: snap({ status: 'counting', tally: tally() }) }));
    await waitFor(() => expect(callout().dataset.step).toBe('counting'));
  });
});

// Rule: the campaign steps call the big rally "Major rally", add the cheap, hidden, cooldown-free Minor rally, and say you can
// only campaign where you have a candidate.
describe('TourOverlay campaign steps for the new actions', () => {
  it('the rally steps use the Major rally label and say candidates are needed to campaign', () => {
    setup({ step: 'rally' });
    const { unmount } = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('press Major rally');
    expect(callout()).toHaveTextContent('only campaign in a seat where your party has a candidate');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('press Major rally');
    unmount();
    goTo('cooldown');
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Major rally button');
  });

  it('the roadshow step notes the candidate requirement', () => {
    setup({ step: 'roadshow' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('only in a seat where your party has a candidate');
  });

  it('comes between the cooldown and the roadshow, with no cooldown and no news', () => {
    cfgBox.cfg = withReports(false);
    const order = stepsNow().map(s => s.id);
    expect(order.indexOf('minor-rally')).toBe(order.indexOf('cooldown') + 1);
    expect(order.indexOf('roadshow')).toBe(order.indexOf('minor-rally') + 1);
    setup({ step: 'minor-rally' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent(WORLD_CONFIG.costs.minorRally.toLocaleString('en-IN'));
    expect(callout()).toHaveTextContent('no cooldown');
    expect(callout()).toHaveTextContent('secret');
    expect(callout()).toHaveTextContent('Minor rally');
  });

  it('minor rally task: done when a minor rally appears; the local effect, the reach and the prices come from the config', async () => {
    setup({ step: 'minor-rally' });
    render(<TourOverlay />);
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done');
    act(() => useStore.setState({ priv: pv({ myActions: [{ type: 'rally', seat: 5, ts: 1 }] }) }));
    await new Promise(r => setTimeout(r, 400));
    expect(screen.getByTestId('tour-task')).not.toHaveClass('done'); // a major rally is not it
    act(() => useStore.setState({ priv: pv({ myActions: [{ type: 'minorRally', seat: 5, ts: 1 }] }) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    const t = screen.getByTestId('tour-task');
    const { local, decay } = WORLD_CONFIG.effects.minorRally;
    expect(t).toHaveTextContent(`+${Math.round(local * WORLD_CONFIG.display.reputationScale)}`);
    expect(t).toHaveTextContent(`${decay.maxKm} km`);
    expect(t).toHaveTextContent(WORLD_CONFIG.costs.minorRally.toLocaleString('en-IN'));
    expect(t).toHaveTextContent(WORLD_CONFIG.costs.rally.toLocaleString('en-IN'));
    expect(t).toHaveTextContent('rivals never find out');
    expect(t).not.toHaveTextContent('×');
  });

  it('shows the reputation jump of the minor rally when the store reports it', async () => {
    setup({ step: 'minor-rally' });
    render(<TourOverlay />);
    act(() => useStore.setState({
      priv: pv({ myActions: [{ type: 'minorRally', seat: 5, ts: 1 }] }),
      repGain: { key: 1, type: 'minorRally', seat: 5, seats: { 5: 21 } } as never,
    }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('+21');
  });

  it('the vote-model step says only the parties with a candidate in a seat take part in its vote', () => {
    setup({ step: 'votes' });
    render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Only the parties that have a candidate in a seat take part in its vote');
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

  it('before the offer, a step asks to keep monitoring the chat: offers and "Accepted" arrive there, with badges', async () => {
    const ids = stepsNow().map(s => s.id);
    expect(ids.indexOf('watch-chat')).toBe(ids.indexOf('govern') - 1);
    expect(ids.indexOf('watch-chat')).toBeGreaterThan(ids.indexOf('paused'));
    expect(stepsNow().find(s => s.id === 'watch-chat')?.anchor).toEqual(['[data-tour="chat"]']);
    setup({ step: 'watch-chat', snap: counting() });
    const { unmount } = render(<TourOverlay />);
    expect(callout()).toHaveTextContent('Keep monitoring the chat');
    expect(callout()).toHaveTextContent('one-to-one');
    expect(callout()).toHaveTextContent('Government offers arrive in the chat');
    expect(callout()).toHaveTextContent('“Accepted”');
    expect(callout()).toHaveTextContent('keep monitoring the chat for offers');
    expect(callout()).not.toHaveTextContent('Offers card');
    unmount();
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
    expect(screen.getByTestId('tour-task')).toHaveTextContent('each acceptance says Accepted');
    act(() => useStore.setState({ snapshot: snap(counting({ offers: [offer('declined')] })) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveTextContent(/People.s Star declined/));
    act(() => useStore.setState({ snapshot: snap(counting({ offers: [offer('accepted')] })) }));
    await waitFor(() => expect(screen.getByTestId('tour-task')).toHaveClass('done'));
    expect(screen.getByTestId('tour-task')).toHaveTextContent('251');
    expect(screen.getByTestId('tour-task')).toHaveTextContent('Each chat with them now says Accepted');
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
