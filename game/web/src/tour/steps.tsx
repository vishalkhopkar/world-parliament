// The guided tour's script. Every number comes from the map's config (game.properties) or from the live practice game,
// never hard-coded, so the tour stays true when the rules are retuned.
import type { ReactNode } from 'react';
import { majorityOf } from '@hp/shared';
import type { GameSnapshot, MapConfig, PlayerId, PrivateState, SeatId } from '@hp/shared';
import { formatMoney } from '../lib';
import type { RepGainState } from '../state/store';
import { SMALL_PARTIES } from './tourScript';

export type TaskId = 'committed' | 'rally' | 'cooldown' | 'roadshow' | 'govern';
export type TourPhase = 'campaign' | 'counting' | 'result';

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

export function buildSteps(startCounting: () => void): TourStep[] {
  return [
    {
      id: 'welcome', phase: 'campaign', title: 'Welcome to HUNG PARLIAMENT', dim: true, block: true,
      body: c => (
        <>
          <p>The map is divided into <b>{c.n} parliament seats</b> of roughly equal population. To govern alone a party needs a majority: <b>{c.maj} seats</b> (half of {c.n}, plus one).</p>
          <p>This is a practice election with <b>{c.playerCount} parties</b>: you and {c.playerCount - 1} rivals. In a real game you choose your own party's name, colour, symbol and avatar. Nothing here is saved.</p>
        </>
      ),
    },
    {
      id: 'party', phase: 'campaign', title: 'This is your party', anchor: ['[data-tour="hud-party"]'], dim: true, block: true,
      body: c => <p>You lead <b>{c.mine?.name ?? 'your party'}</b>. Everything shown in your colour on the map belongs to it.</p>,
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
        <p>You start with <b>{c.money(c.cfg.budget)}</b>. A rally costs <b>{c.money(c.cfg.costs.rally)}</b> and a roadshow <b>{c.money(c.cfg.costs.roadshow)}</b>. Spending is final, so make every rupee count.</p>
      ),
    },
    {
      id: 'ticker', phase: 'campaign', title: 'The news ticker', anchor: ['[data-tour="ticker"]'], dim: true, block: true,
      body: () => <p>Every rally is public news: rivals' rallies scroll past here with the seat they were held in. <b>Roadshows are secret</b>: nobody hears about them.</p>,
    },
    {
      id: 'my-actions', phase: 'campaign', title: 'My actions', anchor: ['[data-tour="my-actions"]'], dim: true, block: true,
      body: () => <p>Everything you have done, including your secret roadshows. Only you can see this list.</p>,
    },
    {
      id: 'chat', phase: 'campaign', title: 'Group chat', anchor: ['[data-tour="chat"]'], dim: true, block: true,
      enabled: ({ cfg, playerCount }) => cfg.messaging.opensAt === 'campaign' && playerCount >= 3,
      body: () => (
        <p>With three or more players there is a <b>group chat</b> that everybody reads. It opens when the campaign starts, so you can bargain (or bluff) early. In a 2-player game there is no chat and no coalition-building.</p>
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
      id: 'rally', phase: 'campaign', title: 'Hold a rally', anchor: ['[data-tour="map"]'],
      body: c => <p>A rally is a big public event and costs <b>{c.money(c.cfg.costs.rally)}</b>. Click any seat and press <b>Rally</b>.</p>,
      task: {
        id: 'rally',
        hint: () => <>Click a seat, then press Rally.</>,
        done: c => {
          const { local, global, decay } = c.cfg.effects.rally;
          const scale = c.cfg.display.reputationScale;
          const gain = c.repGain && c.repGain.type === 'rally' ? c.repGain.seats[c.repGain.seat] : undefined;
          return (
            <>
              {gain !== undefined && <p>Your reputation there jumped by <b>+{gain}</b>. The green smoke on the map shows where it grew.</p>}
              <p>A rally adds <b>+{Math.round(global * scale)}</b> to your reputation in <b>every seat</b> in the world, because it is broadcast (rivals see it in the ticker), and an additional <b>+{Math.round(local * scale)}</b> in the seat where you hold it. Nearby seats get a smaller boost that fades with distance, down to nothing at {decay.maxKm} km.</p>
              <p>Two small bonuses: the <b>first</b> rally or roadshow in a seat earns a slightly bigger gain there, and gains grow slightly as the campaign goes on. Do not wait for the end to do everything: the increase is tiny, and your budget is only worth what you spend.</p>
            </>
          );
        },
      },
    },
    {
      id: 'cooldown', phase: 'campaign', title: 'The rally cooldown', anchor: ['[data-tour="map"]'],
      enabled: ({ cfg }) => cfg.cooldowns.rallyMs > 0,
      body: () => <p>Now try to hold <b>another rally right away</b>.</p>,
      task: {
        id: 'cooldown',
        hint: () => <>Click a seat and look at the Rally button.</>,
        done: c => (
          <p>Refused: you can rally only once every <b>{Math.round(c.cfg.cooldowns.rallyMs / 1000)} seconds</b>, because the party leader has to get there. The button counts down. <b>Roadshows have no cooldown.</b></p>
        ),
      },
    },
    {
      id: 'roadshow', phase: 'campaign', title: 'Hold a roadshow', anchor: ['[data-tour="map"]'],
      body: c => <p>A roadshow is cheap (<b>{c.money(c.cfg.costs.roadshow)}</b>) and secret. Click a seat and press <b>Roadshow</b>.</p>,
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
          <p>The party with the most votes wins the seat (first past the post). That ends the campaign: time to count.</p>
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
          if (o.status === 'open') return <>Offer sent: {o.accepted.length} of {o.partners.length} have accepted&hellip;</>;
          return <>Fill the posts, then Send offer.</>;
        },
        done: c => <>All {SMALL_PARTIES} accepted: you hold {c.maj} seats.</>,
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

/** The steps that apply to this map / config / number of parties (reports off, no chat in a 2-player game, ...). */
export function visibleSteps(startCounting: () => void, cfg: MapConfig, playerCount: number): TourStep[] {
  return buildSteps(startCounting).filter(s => !s.enabled || s.enabled({ cfg, playerCount }));
}

export function makeCtx(p: {
  cfg: MapConfig; snap: GameSnapshot | null; priv: PrivateState | null; me: PlayerId | null; selectedSeat: SeatId | null;
  repGain: RepGainState | null; selectSeat: (s: SeatId | null) => void;
}): TourCtx {
  const { cfg, snap, me } = p;
  const n = snap?.tally?.total ?? cfg.seatCount;
  const live = (snap?.players ?? []).filter(x => x.status === 'active' || x.status === 'disconnected');
  const seatsOf = (id: PlayerId) => (snap?.result ? snap.result.tally[id] ?? 0 : (snap?.tally?.wins[id] ?? 0) + (snap?.tally?.leads[id] ?? 0));
  const rows = live.map(x => ({ id: x.playerId, name: x.party?.name ?? x.nickname, seats: seatsOf(x.playerId) })).sort((a, b) => b.seats - a.seats);
  const mine = rows.find(r => r.id === me);
  const largest = rows.find(r => r.id !== me);
  const smallSum = rows.filter(r => r.id !== me && r !== largest).reduce((s, r) => s + r.seats, 0);
  return {
    cfg, n, maj: majorityOf(n), money: v => formatMoney(v, cfg.currency.symbol), snap, priv: p.priv, me, selectedSeat: p.selectedSeat,
    repGain: p.repGain, playerCount: live.length || 9, rows, mine, largest, smallSum, selectSeat: p.selectSeat,
  };
}
