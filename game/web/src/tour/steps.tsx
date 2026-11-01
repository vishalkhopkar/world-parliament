// The guided tour's script. Every number comes from the map's config (game.properties) or from the live practice game,
// never hard-coded, so the tour stays true when the rules are retuned.
import type { ReactNode } from 'react';
import { fullyFieldedBudget, hasPreCampaign, majorityOf } from '@hp/shared';
import type { GameSnapshot, MapConfig, PlayerId, PrivateState, SeatId } from '@hp/shared';
import { formatMoney } from '../lib';
import type { RepGainState } from '../state/store';
import { SMALL_PARTIES } from './tourScript';
import { FIELD_TASK_SEATS, fieldedByMe } from './tasks';

export type TaskId = 'field' | 'done' | 'withdraw' | 'committed' | 'rally' | 'cooldown' | 'minorRally' | 'roadshow' | 'govern';
export type TourPhase = 'preCampaign' | 'campaign' | 'counting' | 'result';

export interface PartyRow { id: PlayerId; name: string; seats: number }

/** Everything a step needs to write its text. */
export interface TourCtx {
  cfg: MapConfig;
  /** Seats on the map, majority mark and money formatting. */
  n: number;
  maj: number;
  money(n: number): string;
  snap: GameSnapshot | null;
  priv: PrivateState | null;
  me: PlayerId | null;
  selectedSeat: SeatId | null;
  selectSeat(s: SeatId | null): void;
  repGain: RepGainState | null;
  playerCount: number;
  /** Parties by seats (won + leading, or the final tally), most first. */
  rows: PartyRow[];
  /** Your row, the largest rival and the sum of everybody else. */
  mine: PartyRow | undefined;
  largest: PartyRow | undefined;
  smallSum: number;
}

export interface TourStep {
  id: string;
  phase: TourPhase;
  title: string;
  body(c: TourCtx): ReactNode;
  /** CSS selectors; the highlight is the union of what they match. No anchor = centred card. */
  anchor?: string[];
  /** Dim the rest of the page around the anchor. */
  dim?: boolean;
  /** Block clicks outside the callout (explanations only; task steps leave the page usable). */
  block?: boolean;
  task?: { id: TaskId; hint(c: TourCtx): ReactNode; done(c: TourCtx): ReactNode; helper?: { label: string; run(c: TourCtx): void } };
  /** Wait for the scripted count to pause here / for the game to finish before Next works. */
  gate?: 'paused' | 'finished';
  /** Replaces Next with a button that does something (e.g. start the count). */
  action?: { label: string; run(): void };
  final?: boolean;
  /** Always put the card in the bottom-right corner of the window (the highlighted thing is a wide banner). */
  corner?: boolean;
  /** false = leave this step out for this map / config. */
  enabled?(c: { cfg: MapConfig; playerCount: number }): boolean;
}

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "30% and 25%" for the bands of one level. */
function bandText(cfg: MapConfig, level: 'HIGH' | 'MEDIUM' | 'LOW') {
  const ps = cfg.committed.bands.filter(b => b.level === level).map(b => `${b.percent}%`);
  return ps.length ? ps.join(' / ') : '-';
}

function reportsOn(cfg: MapConfig): boolean {
  const a = cfg.analyst as { seatReport?: { enabled?: boolean }; globalReport?: { enabled?: boolean } };
  return a.seatReport?.enabled === true || a.globalReport?.enabled === true;
}

/** Latest offer of the player (for the live hint of the coalition step). */
function lastOffer(c: TourCtx) {
  const offers = [...(c.snap?.offers ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  return offers[0];
}

function nameOf(c: TourCtx, id: PlayerId | undefined) {
  return c.snap?.players.find(p => p.playerId === id)?.party?.name ?? 'A party';
}

/** The brush needs a mouse; with no fine pointer (a phone or tablet) candidates are fielded by tapping a seat and pressing Field. */
export function usesBrush(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: fine)').matches;
}

/** The pre-campaign steps exist only in games that have the phase (3 or more players). */
const preCampaignOnly = ({ playerCount }: { cfg: MapConfig; playerCount: number }) => hasPreCampaign(playerCount);
/** The Done fielding feature (button, ticks, early start) exists only when the config switches it on (preCampaign.doneEnabled). */
const doneFieldingOn = ({ cfg, playerCount }: { cfg: MapConfig; playerCount: number }) => hasPreCampaign(playerCount) && cfg.preCampaign.doneEnabled;

/** Candidates you hold now (from the live snapshot). */
const heldNow = (c: TourCtx) => fieldedByMe(c.snap, c.me ?? undefined);

export function buildSteps(startCounting: () => void, startCampaign: () => void = () => undefined): TourStep[] {
  return [
    {
      id: 'welcome', phase: 'preCampaign', title: 'Welcome to HUNG PARLIAMENT', dim: true, block: true,
      body: c => (
        <>
          <p>The map is divided into <b>{c.n} parliament seats</b> of roughly equal population. To govern alone a party needs a majority: <b>{majorityOf(c.n)} seats</b> (half of {c.n}, plus one).</p>
          <p>This is a practice election with <b>{c.playerCount} parties</b>: you and {c.playerCount - 1} rivals. In a real game you choose your own party's name, colour, symbol and avatar. Nothing here is saved.</p>
        </>
      ),
    },
    {
      id: 'party', phase: 'preCampaign', title: 'This is your party', anchor: ['[data-tour="hud-party"]'], dim: true, block: true,
      body: c => <p>You lead <b>{c.mine?.name ?? 'your party'}</b>. Everything shown in your colour on the map belongs to it.</p>,
    },
    {
      id: 'precampaign', phase: 'preCampaign', title: 'Before the campaign: where to stand', anchor: ['[data-tour="map"]'], dim: true, block: true,
      enabled: preCampaignOnly,
      body: c => (
        <>
          <p>The game starts with a <b>pre-campaign</b> (<b>{minutes(c.cfg.durations.preCampaignMs)} minutes</b> in a real game). Your party can only campaign in seats where it has a <b>candidate</b>, so first you choose <b>where to stand</b>.</p>
          <p>You can also talk one-to-one with the other parties and form <b>informal pre-poll alliances</b>: who stands where, and who will back whom afterwards.</p>
        </>
      ),
    },
    {
      id: 'field-seats', phase: 'preCampaign', title: 'Field your candidates', anchor: ['[data-tour="map"]'], enabled: preCampaignOnly,
      body: () => (
        <>
          {usesBrush()
            ? <p>Hold the left mouse button and <b>paint over the map</b> with the brush: every seat it touches gets a candidate, shown as a figure in your colour. Drag with the <b>right</b> button (or Space + drag) to move the map; the wheel zooms. A click without dragging opens the seat's panel instead.</p>
            : <p><b>Tap a seat</b> to open its panel and press <b>Field</b> to put a candidate there. The seat then shows a figure in your colour.</p>}
          <p>The map shows <b>only your own figures</b>: a seat's panel lists every party standing there.</p>
        </>
      ),
      task: {
        id: 'field',
        hint: c => <>{usesBrush() ? 'Paint' : 'Field'} at least {FIELD_TASK_SEATS} seats ({heldNow(c)} so far).</>,
        done: c => <>{heldNow(c)} seats now have your candidate: a figure in your colour stands on each. Each one cost <b>{c.money(c.cfg.costs.candidate)}</b>, which your budget at the top already shows.</>,
      },
    },
    {
      id: 'field-all', phase: 'preCampaign', title: 'Or field every seat at once', anchor: ['[data-tour="field-all"]'], dim: true, block: true,
      enabled: preCampaignOnly,
      body: () => (
        <>
          <p>The <b>Field all seats</b> button puts a candidate in <b>every seat you do not hold yet</b> with one click, for the <b>price shown on the button</b>. It is a shortcut to painting.</p>
          <p>It is all or nothing: if your budget cannot pay for all of it, nothing is fielded. Standing everywhere leaves less for the campaign itself, so most parties paint only where they can win.</p>
        </>
      ),
    },
    {
      id: 'candidate-cost', phase: 'preCampaign', title: 'What a candidate costs', anchor: ['[data-tour="hud-budget"]'], dim: true, block: true,
      enabled: preCampaignOnly,
      body: c => (
        <>
          <p>Every candidate costs <b>{c.money(c.cfg.costs.candidate)}</b>, paid at once from your budget of <b>{c.money(c.cfg.budget)}</b>. A candidate in all {c.n} seats would leave you <b>{c.money(fullyFieldedBudget(c.cfg))}</b> for the campaign itself.</p>
          <p>Stand only where you can win and keep the rest for rallies and roadshows.</p>
        </>
      ),
    },
    {
      id: 'withdraw-seat', phase: 'preCampaign', title: 'Check a seat, or withdraw', anchor: ['[data-tour="map"]'], enabled: preCampaignOnly,
      body: c => (
        <p>{usesBrush() ? 'Click' : 'Tap'} a seat where you have a candidate. Its panel shows your <b>candidate's name</b> and <b>every other party standing there</b>. Press <b>Withdraw</b> to take your candidate back: you get the <b>{c.money(c.cfg.costs.candidate)}</b> back, and you can field the seat again until the pre-campaign ends.</p>
      ),
      task: {
        id: 'withdraw',
        hint: () => <>Open a seat you have fielded and press Withdraw.</>,
        done: c => <>Withdrawn: the <b>{c.money(c.cfg.costs.candidate)}</b> is back in your budget and the seat lost your figure.</>,
      },
    },
    {
      id: 'candidate-counts', phase: 'preCampaign', title: 'The rivals are fielding too', anchor: ['[data-tour="candidate-counts"]'], dim: true, block: true,
      enabled: preCampaignOnly,
      body: c => (
        <>
          <p>This panel lists every party with its <b>avatar</b> and the number of its candidates, <b>live</b>. The other parties are fielding right now: watch their numbers move.{c.cfg.preCampaign.doneEnabled && <> A <b>tick</b> beside a party means it has pressed <b>Done fielding</b>.</>}</p>
          <p>The majority mark moves with them, because it depends on how many seats have at least one candidate{c.snap ? <> (now <b>{c.snap.contestedSeats}</b> seats, so <b>{c.snap.majority}</b> for a majority)</> : null}.</p>
        </>
      ),
    },
    {
      id: 'done-fielding', phase: 'preCampaign', title: 'Done fielding', anchor: ['[data-tour="done-fielding"]'], enabled: doneFieldingOn,
      body: () => (
        <>
          <p>When you have fielded the candidates you want, press <b>Done fielding</b>. The campaign starts <b>as soon as every party has pressed it</b>; otherwise it starts when the countdown ends.</p>
          <p>Everybody sees a tick beside your party. You can <b>take it back</b> with the same button, and fielding or withdrawing a candidate takes it back too.</p>
        </>
      ),
      task: {
        id: 'done',
        hint: c => heldNow(c) === 0 ? <>Field at least one seat first, then press Done fielding.</> : <>Press Done fielding.</>,
        done: c => (
          <>You are done: <b>{c.snap?.fieldingDone?.length ?? 1}</b> of <b>{c.playerCount}</b> parties are done so far. In this practice game the rivals press it one after another, and the tour then waits for you before the campaign starts.</>
        ),
      },
    },
    {
      id: 'precampaign-chat', phase: 'preCampaign', title: 'Talk to the other parties', anchor: ['[data-tour="precampaign-chat"]'], dim: true, block: true,
      enabled: preCampaignOnly,
      body: () => (
        <>
          <p>Pick a party in the chat and talk <b>one-to-one</b>. Agree who stands where, or who will support whom once the votes are counted.</p>
          <p>These alliances are <b>informal</b>: nothing enforces them, and a party can change its mind, or bluff. The practice rivals answer you but keep no promises.</p>
        </>
      ),
    },
    {
      id: 'no-candidates', phase: 'preCampaign', title: 'The deadline', dim: true, block: true, enabled: preCampaignOnly,
      body: () => (
        <>
          <p>When the pre-campaign ends, a party with <b>no candidate anywhere is out of the game</b>.</p>
          <p>A seat where <b>nobody</b> stands is <b>vacant</b>: it elects no one, and the majority is worked out from the seats that are contested.</p>
          <p>A game with only 2 players has no pre-campaign: every seat is fielded for both of them automatically.</p>
        </>
      ),
    },
    {
      id: 'to-campaign', phase: 'preCampaign', title: 'On to the campaign', dim: true, block: true, enabled: preCampaignOnly,
      body: c => (
        <p>In a real game the campaign starts {c.cfg.preCampaign.doneEnabled ? 'as soon as every party has pressed Done fielding, or ' : ''}when the clock ends the pre-campaign. Here, press <b>Next</b>: the tour <b>fields candidates for you</b> in every seat you have not fielded yourself, paying <b>{c.money(c.cfg.costs.candidate)}</b> for each, so that you can campaign anywhere. Then the campaign begins.</p>
      ),
      action: { label: 'Next', run: startCampaign },
    },
    {
      id: 'clocks', phase: 'campaign', title: 'The clocks', anchor: ['[data-tour="hud-campaign"]', '[data-tour="hud-phase"]'], dim: true, block: true,
      body: c => (
        <>
          <p>A real campaign runs for <b>{minutes(c.cfg.durations.campaignMs)} minutes</b>, split into {c.cfg.phases.min} to {c.cfg.phases.max} polling phases (the host chooses). When a phase ends, its seats stop taking campaign actions and are polled.</p>
          <p>A practice game has no running time, so both clocks read <b>0:00</b> here.</p>
        </>
      ),
    },
    {
      id: 'budget', phase: 'campaign', title: 'Your budget', anchor: ['[data-tour="hud-budget"]'], dim: true, block: true,
      body: c => (
        <p>You have <b>{c.money(c.priv?.budget ?? fullyFieldedBudget(c.cfg))}</b> left for the campaign. A major rally costs <b>{c.money(c.cfg.costs.rally)}</b>, a minor rally <b>{c.money(c.cfg.costs.minorRally)}</b> and a roadshow <b>{c.money(c.cfg.costs.roadshow)}</b>. Spending is final, so make every rupee count.</p>
      ),
    },
    {
      id: 'ticker', phase: 'campaign', title: 'The news ticker', anchor: ['[data-tour="ticker"]'], dim: true, block: true,
      body: () => <p>Every major rally is public news: rivals' major rallies scroll past here with the seat they were held in. <b>Minor rallies and roadshows are secret</b>: nobody hears about them.</p>,
    },
    {
      id: 'chat', phase: 'campaign', title: 'Chat', anchor: ['[data-tour="chat"]'], dim: true, block: true,
      enabled: ({ cfg, playerCount }) => cfg.chat.campaigning !== 'OFF' && playerCount >= 3,
      body: c => (
        <>
          {c.cfg.chat.campaigning === 'GROUP'
            ? <p>With three or more players there is a <b>group chat</b> that everybody reads. It opens when the campaign starts, so you can bargain (or bluff) early. Type <b>@</b> to tag a party: they get a red badge for it.</p>
            : <p>With three or more players you can chat <b>one-to-one</b> with every party from the start of the campaign: pick a party on the left. A red badge shows unread messages.</p>}
          {c.cfg.chat.campaigning === 'GROUP' && <p>Once counting starts, the chat becomes <b>one-to-one</b>: a private chat with each party.</p>}
          <p>In a 2-player game there is no chat and no coalition-building.</p>
        </>
      ),
    },
    {
      id: 'global-reports', phase: 'campaign', title: 'News agencies', anchor: ['[data-tour="global-reports"]'], dim: true, block: true,
      enabled: ({ cfg }) => cfg.news.enabled,
      body: c => (
        <>
          <p>The <b>News agencies</b> button is <b>free</b>. It opens one graph from each of {c.cfg.news.agencies.length} news agencies: {c.cfg.news.agencies.map(a => a.name).join(', ')}. Each draws how many seats it thinks every party will win, with the party avatars on the lines, and a new point every <b>{Math.round(c.cfg.news.sampleIntervalMs / 1000)} seconds</b>.</p>
          <p>All the agencies start from the same even split, but they guess differently: each one's seat range for a party is its own. They get closer to the truth as the campaign goes on, and the graphs stop when the campaign ends. Compare them, but do not trust any one of them.</p>
        </>
      ),
    },
    {
      id: 'analyst', phase: 'campaign', title: 'Analyst reports', anchor: ['[data-tour="side"]'], dim: true, block: true,
      enabled: ({ cfg }) => reportsOn(cfg),
      body: c => (
        <p>For a fee you can buy a noisy estimate of one seat or of the whole map ({c.money(c.cfg.analyst.seatReport.start)} to {c.money(c.cfg.analyst.globalReport.end)}, rising as the campaign goes on). Reports describe the position {Math.round(c.cfg.analyst.delayMs / 1000)} seconds ago.</p>
      ),
    },
    {
      id: 'committed', phase: 'campaign', title: 'Your committed voters', anchor: ['[data-tour="map"]'],
      body: c => (
        <p>The seats shaded in your party colour are where you already have <b>loyal voters</b>, before the campaign even starts. The darker the shade, the bigger the share: HIGH ({bandText(c.cfg, 'HIGH')}), MEDIUM ({bandText(c.cfg, 'MEDIUM')}), LOW ({bandText(c.cfg, 'LOW')}) of the seat. Only you can see your own.</p>
      ),
      task: {
        id: 'committed',
        hint: () => <>Click one of your shaded seats.</>,
        done: c => {
          const cs = c.priv?.committed?.find(x => x.seat === c.selectedSeat);
          return <>The seat panel says <b>Committed voters: ~{cs?.percent}% &middot; {cs?.level}</b>. Those voters are yours.</>;
        },
        helper: { label: 'Show me one', run: c => c.selectSeat(c.priv?.committed?.[0]?.seat ?? null) },
      },
    },
    {
      id: 'reputation', phase: 'campaign', title: 'Reputation among swing voters', anchor: ['[data-tour="map"]'],
      body: () => (
        <>
          <p>Besides committed voters, every seat has <b>swing voters</b> who can be won over. The number on each seat (zoom in to see it) is <b>your reputation</b> among them. The seat panel shows the same number: &ldquo;Reputation N among swing voters&rdquo;.</p>
          <p>It starts at 0 and <b>never goes down</b>. Nobody else can see yours, and you cannot see theirs.</p>
        </>
      ),
    },
    {
      id: 'rally', phase: 'campaign', title: 'Hold a major rally', anchor: ['[data-tour="map"]'],
      body: c => (
        <>
          <p>A major rally is a big public event and costs <b>{c.money(c.cfg.costs.rally)}</b>. Click any seat and press <b>Major rally</b>.</p>
          <p className="tour-small">You can only campaign in a seat where your party has a candidate (the tour fielded one for you everywhere).</p>
        </>
      ),
      task: {
        id: 'rally',
        hint: () => <>Click a seat, then press Major rally.</>,
        done: c => {
          const { local, global, decay } = c.cfg.effects.rally;
          const scale = c.cfg.display.reputationScale;
          const gain = c.repGain && c.repGain.type === 'rally' ? c.repGain.seats[c.repGain.seat] : undefined;
          return (
            <>
              {gain !== undefined && <p>Your reputation there jumped by <b>+{gain}</b>. The green smoke on the map shows where it grew.</p>}
              <p>A major rally adds <b>+{Math.round(global * scale)}</b> to your reputation in <b>every seat</b> in the world, because it is broadcast (rivals see it in the ticker), and an additional <b>+{Math.round(local * scale)}</b> in the seat where you hold it. Nearby seats get a smaller boost that fades with distance, down to nothing at {decay.maxKm} km.</p>
              <p>Two small bonuses: the <b>first</b> rally or roadshow in a seat earns a slightly bigger gain there, and gains grow slightly as the campaign goes on. Do not wait for the end to do everything: the increase is tiny, and your budget is only worth what you spend.</p>
            </>
          );
        },
      },
    },
    {
      id: 'cooldown', phase: 'campaign', title: 'The major rally cooldown', anchor: ['[data-tour="map"]'],
      enabled: ({ cfg }) => cfg.cooldowns.rallyMs > 0,
      body: () => <p>Now try to hold <b>another major rally right away</b>.</p>,
      task: {
        id: 'cooldown',
        hint: () => <>Click a seat and look at the Major rally button.</>,
        done: c => (
          <p>Refused: you can hold a major rally only once every <b>{Math.round(c.cfg.cooldowns.rallyMs / 1000)} seconds</b>, because the party leader has to get there. The button counts down. <b>Minor rallies and roadshows have no cooldown.</b></p>
        ),
      },
    },
    {
      id: 'minor-rally', phase: 'campaign', title: 'Hold a minor rally', anchor: ['[data-tour="map"]'],
      body: c => <p>A minor rally is a smaller event for <b>{c.money(c.cfg.costs.minorRally)}</b>. It has <b>no cooldown</b> and, like a roadshow, it is <b>secret</b>: it never reaches the news. Click a seat and press <b>Minor rally</b>.</p>,
      task: {
        id: 'minorRally',
        hint: () => <>Click a seat, then press Minor rally.</>,
        done: c => {
          const { local, decay } = c.cfg.effects.minorRally;
          const scale = c.cfg.display.reputationScale;
          const gain = c.repGain && (c.repGain.type as string) === 'minorRally' ? c.repGain.seats[c.repGain.seat] : undefined;
          return (
            <>
              {gain !== undefined && <p>Your reputation there jumped by <b>+{gain}</b>.</p>}
              <p>A minor rally adds <b>+{Math.round(local * scale)}</b> in the seat where you hold it. Nearby seats get a smaller boost that fades with distance, down to nothing at {decay.maxKm} km, and nothing is added anywhere else. It costs {c.money(c.cfg.costs.minorRally)} against {c.money(c.cfg.costs.rally)} for a major rally, can be repeated at once, and rivals never find out.</p>
            </>
          );
        },
      },
    },
    {
      id: 'roadshow', phase: 'campaign', title: 'Hold a roadshow', anchor: ['[data-tour="map"]'],
      body: c => (
        <>
          <p>A roadshow is cheap (<b>{c.money(c.cfg.costs.roadshow)}</b>) and secret. Click a seat and press <b>Roadshow</b>.</p>
          <p className="tour-small">Like every campaign action, it works only in a seat where your party has a candidate.</p>
        </>
      ),
      task: {
        id: 'roadshow',
        hint: () => <>Click a seat, then press Roadshow.</>,
        done: c => (
          <p>A roadshow adds <b>+{Math.round(c.cfg.effects.roadshow.local * c.cfg.display.reputationScale)}</b> in that seat only: purely local, nothing spills over, and rivals never find out. The same bonuses apply: a slightly bigger gain for the first campaigner in a seat, and a slightly bigger gain later in the campaign.</p>
        ),
      },
    },
    {
      id: 'base', phase: 'campaign', title: 'Do not neglect your base', anchor: ['[data-tour="map"]'], dim: true, block: true,
      body: () => <p>Committed seats are your base, but the voters there who are <b>not</b> committed still vote by reputation. Campaign in your own seats too: that is how a base turns into wins.</p>,
    },
    {
      id: 'votes', phase: 'campaign', title: 'How a seat votes', dim: true, block: true,
      body: c => (
        <>
          <ol className="tour-list">
            <li><b>Committed voters</b> vote for their party.</li>
            <li><b>Influence</b>: committed voters bring along 0 to {c.cfg.voting.influenceMaxPercent}% extra voters, at random.</li>
            <li><b>Randomness</b>: a random 0 to {c.cfg.voting.randomMaxPercent * c.playerCount}% of the uncommitted voters vote at random ({c.cfg.voting.randomMaxPercent}% for each of the {c.playerCount} parties).</li>
            <li><b>Reputation</b>: everyone else splits between the parties in proportion to their reputation.</li>
          </ol>
          <p>Only the parties that have a candidate in a seat take part in its vote. The party with the most votes wins the seat (first past the post). That ends the campaign: time to count.</p>
        </>
      ),
      action: { label: 'Start counting', run: startCounting },
    },
    {
      id: 'counting', phase: 'counting', title: 'The count', anchor: ['[data-tour="tally"]'],
      body: c => (
        <>
          <p>Seats are declared as the count goes on. A seat first shows a <b>leading</b> party: early leads are noisy and can flip. From {pct(c.cfg.counting.winStartFraction)} of the counting time seats become <b>won</b>, the safest first.</p>
          <p>The bar shows seats won (solid) and leading (striped) against the <b>majority mark, {c.maj}</b>. Click a declared seat to see its vote-share pie. A real count lasts {minutes(c.cfg.durations.countingMs)} minutes ({minutes(c.cfg.durations.countingMsTwoPlayers)} with only 2 players).</p>
        </>
      ),
    },
    {
      id: 'hung', phase: 'counting', title: 'A hung parliament', anchor: ['[data-tour="side"]'], dim: true, block: true,
      body: () => (
        <p>With three or more players it is common that <b>nobody has a majority</b>. Then the parties bargain: the government may need a <b>coalition</b>, and the largest party does not automatically govern. (With exactly 2 players there is no bargaining: the majority wins.)</p>
      ),
    },
    {
      id: 'paused', phase: 'counting', title: 'No one has a majority', anchor: ['[data-tour="tally"]'], gate: 'paused',
      body: c => (
        <p>
          <b>{c.largest?.name}</b> leads with <b>{c.largest?.seats}</b> seats but is {Math.max(0, c.maj - (c.largest?.seats ?? 0))} short of the majority ({c.maj}). You have <b>{c.mine?.seats}</b>. Add all {SMALL_PARTIES} smaller parties ({c.smallSum} seats) and you reach exactly <b>{(c.mine?.seats ?? 0) + c.smallSum}</b>: the majority. Lose any one of them and you fall short.
        </p>
      ),
    },
    {
      id: 'watch-chat', phase: 'counting', title: 'Keep monitoring the chat', anchor: ['[data-tour="chat"]'], dim: true, block: true,
      body: () => (
        <>
          <p>From now on every chat is <b>one-to-one</b>: a private conversation with each party, listed on the left.</p>
          <p><b>Government offers arrive in the chat</b> with the party that made them, with Accept and Decline buttons. When a party accepts your offer, <b>&ldquo;Accepted&rdquo;</b> appears in your chat with them (and when you accept, in yours). A red badge counts what is unread, on each chat and on the chat section, so <b>keep monitoring the chat for offers</b>.</p>
        </>
      ),
    },
    {
      id: 'govern', phase: 'counting', title: 'Form a government', anchor: ['.tour-offer-builder'],
      body: c => (
        <>
          <p>You are the <b>Prime Minister</b>. Give each of the {SMALL_PARTIES} smaller parties a post in the boxes: {c.cfg.points.portfolios.filter(p => p.id !== 'PM').map(p => (p.max > 1 ? `${p.label} (up to ${p.max})` : p.label)).join(', ')}. Watch <b>Combined seats</b> reach {c.maj}, then press <b>Send offer</b>.</p>
          <p className="tour-small">Points: each post is worth points ({c.cfg.points.portfolios.map(p => `${p.label} ${p.points}`).join(', ')}), plus {c.cfg.points.seatMultiplier} &times; your share of the seats and a {c.cfg.points.governmentFloor}-point government floor. Parties left in opposition get {c.cfg.points.opposition}.</p>
        </>
      ),
      task: {
        id: 'govern',
        hint: c => {
          const o = lastOffer(c);
          if (!o) return <>Fill the posts, then Send offer. In this practice game the rivals only say yes when all {SMALL_PARTIES} smaller parties are in.</>;
          if (o.status === 'declined') return <><b>{nameOf(c, o.declinedBy)}</b> declined: they only join if all {SMALL_PARTIES} smaller parties are in. Change the offer and send it again.</>;
          if (o.status === 'open') return <>Offer sent: {o.accepted.length} of {o.partners.length} have accepted&hellip; Watch the chats: each acceptance says <b>Accepted</b>.</>;
          return <>Fill the posts, then Send offer.</>;
        },
        done: c => <>All {SMALL_PARTIES} accepted: you hold {c.maj} seats. Each chat with them now says <b>Accepted</b>.</>,
      },
    },
    {
      id: 'resume', phase: 'counting', title: 'The government is confirmed', anchor: ['[data-tour="tally"]'], gate: 'finished',
      body: () => (
        <p>With the offer accepted, the last seats are declared. A government is confirmed only once <b>every seat has been declared</b>; then the game ends at once.</p>
      ),
    },
    {
      id: 'result', phase: 'result', title: 'Your coalition governs', anchor: ['.page.result .banner'], final: true, corner: true,
      body: c => {
        const r = c.snap?.result;
        const pts = r?.points.find(p => p.playerId === c.me);
        return (
          <>
            <p>You kept the single largest party (<b>{c.largest?.name}</b>, {c.largest?.seats} seats) out of power by forming a coalition.</p>
            <p>Points = portfolio points + seat points ({c.cfg.points.seatMultiplier} &times; your seat share) + the {c.cfg.points.governmentFloor}-point government floor; opposition parties get {c.cfg.points.opposition}.{pts ? <> You scored <b>{pts.total}</b>.</> : null} The party with the most points wins.</p>
          </>
        );
      },
    },
  ];
}

/** The steps that apply to this map / config / number of parties (reports off, no chat or pre-campaign in a 2-player game, ...). */
export function visibleSteps(startCounting: () => void, cfg: MapConfig, playerCount: number, startCampaign?: () => void): TourStep[] {
  return buildSteps(startCounting, startCampaign).filter(s => !s.enabled || s.enabled({ cfg, playerCount }));
}

export function makeCtx(p: {
  cfg: MapConfig; snap: GameSnapshot | null; priv: PrivateState | null; me: PlayerId | null; selectedSeat: SeatId | null;
  repGain: RepGainState | null; selectSeat: (s: SeatId | null) => void;
}): TourCtx {
  const { cfg, snap, me } = p;
  const n = snap?.tally?.total ?? cfg.seatCount;
  // the majority is live during the pre-campaign (it follows the contested seats) and fixed from the campaign start
  const maj = snap && snap.status !== 'preCampaign' && snap.majority ? snap.majority : majorityOf(n);
  const live = (snap?.players ?? []).filter(x => x.status === 'active' || x.status === 'disconnected');
  const seatsOf = (id: PlayerId) => (snap?.result ? snap.result.tally[id] ?? 0 : (snap?.tally?.wins[id] ?? 0) + (snap?.tally?.leads[id] ?? 0));
  const rows = live.map(x => ({ id: x.playerId, name: x.party?.name ?? x.nickname, seats: seatsOf(x.playerId) })).sort((a, b) => b.seats - a.seats);
  const mine = rows.find(r => r.id === me);
  const largest = rows.find(r => r.id !== me);
  const smallSum = rows.filter(r => r.id !== me && r !== largest).reduce((s, r) => s + r.seats, 0);
  return {
    cfg, n, maj, money: v => formatMoney(v, cfg.currency.symbol), snap, priv: p.priv, me, selectedSeat: p.selectedSeat,
    repGain: p.repGain, playerCount: live.length || 9, rows, mine, largest, smallSum, selectSeat: p.selectSeat,
  };
}
