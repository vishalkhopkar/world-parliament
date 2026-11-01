// Compact, name-based views of game data for LLMs (ids replaced by party names / seat names, times by seconds).
import { analystPrice, chatModeFor, fullyFieldedBudget, majorityOf, rallyAvailableAt } from '@hp/shared';
import type {
  AnalystReport, FieldedCandidate, SeatId, ChatMessage, GlobalReports, CommittedView, CoalitionOffer, FinalResult, GameTimeline, Government, PlayerPublic, PortfolioAssignment, SeatDeclaration,
} from '@hp/shared';
import { admissionOf } from './state';
import type { AgentEvent } from './state';
import type { AgentSession } from './session';
import type { SeatDirectory } from './resolve';

export const round1 = (n: number): number => Math.round(n * 10) / 10;
const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * The player's budget. The server grants it when the game leaves the lobby (the pre-campaign with 3+ players, else the campaign)
 * and sends the status event BEFORE the private update, so for a moment the lobby-time 0 is still in the state
 * (state.budgetPending): that is a gap, not an empty purse, so report the number it will be until the real one arrives:
 * the full budget in a pre-campaign, what is left after a candidate on every seat in a 2-player campaign.
 */
export function currentBudget(s: AgentSession): number | null {
  const priv = s.client.state.priv;
  if (!priv) return null;
  const snap = s.client.state.snapshot;
  if (priv.budget === 0 && s.client.state.budgetPending && (snap?.status === 'campaign' || snap?.status === 'preCampaign')) {
    return snap.timeline?.preCampaignEnd !== undefined ? s.cfg().budget : fullyFieldedBudget(s.cfg());
  }
  return priv.budget;
}

/** Seats needed for a majority right now: the server's figure (it drops with vacant seats), else the whole map's. */
export const majorityNow = (s: AgentSession): number => s.client.state.snapshot?.majority ?? majorityOf(s.cfg().seatCount);

// ------------------------------------------------------------------ fielding (pre-campaign)
/** True when this game has a pre-campaign (3+ players): fielding is then explicit. A 2-player game fields every seat automatically. */
export const gameHasFielding = (s: AgentSession): boolean => {
  const snap = s.client.state.snapshot;
  return snap?.timeline?.preCampaignEnd !== undefined && !!snap.fielding;
};

/** Candidates standing in a seat (empty = vacant, or the game has no pre-campaign). */
export const candidatesIn = (s: AgentSession, seat: SeatId): FieldedCandidate[] => s.client.state.snapshot?.fielding?.[seat] ?? [];

/** Does this player have a candidate in the seat? null = not applicable (no pre-campaign: every seat is fielded) or unknown. */
export function iHaveCandidate(s: AgentSession, seat: SeatId): boolean | null {
  const snap = s.client.state.snapshot;
  if (!gameHasFielding(s) || !snap?.fielding || !s.client.me) return null;
  return candidatesIn(s, seat).some((c) => c.playerId === s.client.me);
}

/** How many seats have a candidate of this player, per player id. */
export function fieldedCounts(s: AgentSession): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of Object.values(s.client.state.snapshot?.fielding ?? {})) for (const c of list) out.set(c.playerId, (out.get(c.playerId) ?? 0) + 1);
  return out;
}

/** "Done fielding" progress: who is done, how many of how many (the connected active players decide the early start). */
export function doneProgress(s: AgentSession) {
  const st = s.client.state;
  const doneIds = st.snapshot?.fieldingDone ?? [];
  const needed = st.fieldingProgress?.needed ?? s.players().filter((p) => p.status === 'active').length;
  const done_count = st.fieldingProgress?.doneCount ?? doneIds.length;
  return { doneIds, done_count, needed, you_are_done: doneIds.includes(st.me ?? '') };
}

/** The pre-campaign numbers shared by get_state, the field tools and wait_for_events. */
export function fieldingSummary(s: AgentSession) {
  const snap = s.client.state.snapshot;
  const cfg = s.cfg();
  const counts = fieldedCounts(s);
  const by_party: Record<string, number> = {};
  for (const p of s.players().filter((x) => ['active', 'disconnected', 'eliminated'].includes(x.status))) by_party[who(s, p.playerId)] = counts.get(p.playerId) ?? 0;
  const dp = doneProgress(s);
  const done: Record<string, boolean> = {};
  for (const name of Object.keys(by_party)) done[name] = false;
  for (const id of dp.doneIds) done[who(s, id)] = true;
  return {
    your_candidates: counts.get(s.client.me ?? '') ?? 0,
    candidate_cost_wr: cfg.costs.candidate,
    by_party,
    done,
    you_are_done: dp.you_are_done,
    done_count: dp.done_count,
    needed: dp.needed,
    contested_seats: snap?.contestedSeats ?? 0,
    majority: majorityNow(s),
    seats_total: cfg.seatCount,
  };
}

/**
 * Server-clock ms at which this player's next rally is allowed. The server's own answer (PrivateState.nextRallyAt) wins when
 * present; otherwise it is computed from the player's last rally (myActions) and the configured cooldown. 0 = ready now.
 */
export function rallyReadyAt(s: AgentSession): number {
  const priv = s.client.state.priv;
  if (!priv) return 0;
  const cfg = s.cfg();
  let last: number | undefined;
  for (const a of priv.myActions) if (a.type === 'rally' && (last === undefined || a.ts > last)) last = a.ts;
  const computed = rallyAvailableAt(last, cfg);
  const at = Math.max(Number.isFinite(computed) ? computed : 0, priv.nextRallyAt ?? 0);
  return at;
}

/** rally_ready / next_rally_in_s for budget views (server-clock corrected). */
export function rallyCooldownView(s: AgentSession): { rally_ready: boolean; next_rally_in_s: number; rally_cooldown_s: number } {
  const cfg = s.cfg();
  const left = Math.max(0, rallyReadyAt(s) - s.client.serverNow());
  return { rally_ready: left <= 0, next_rally_in_s: Math.ceil(left / 1000), rally_cooldown_s: Math.round(cfg.cooldowns.rallyMs / 1000) };
}

export type Stage = 'lobby' | 'preCampaign' | 'campaign' | 'counting' | 'postCounting' | 'finished';

/** Which stage the game is in and the seconds until the NEXT milestone of that stage (the pre-campaign deadline, the next phase close, ...; null in the lobby, 0 when finished). */
export function stageInfo(status: string | undefined, tl: GameTimeline | null | undefined, now: number): { stage: Stage; stage_left_s: number | null } {
  const stage = (['lobby', 'preCampaign', 'campaign', 'counting', 'postCounting', 'finished'].includes(status ?? '') ? status : 'lobby') as Stage;
  if (!tl) return { stage, stage_left_s: stage === 'finished' ? 0 : null };
  switch (stage) {
    case 'preCampaign': return { stage, stage_left_s: tl.preCampaignEnd !== undefined ? secs(tl.preCampaignEnd - now) : secs(tl.campaignStart - now) };
    case 'campaign': {
      const next = tl.phaseCloses.find((x) => x > now);
      return { stage, stage_left_s: secs((next ?? tl.campaignEnd) - now) };
    }
    case 'counting': return { stage, stage_left_s: secs(tl.countingEnd - now) };
    case 'postCounting': return { stage, stage_left_s: secs(tl.postCountingEnd - now) };
    case 'finished': return { stage, stage_left_s: 0 };
    default: return { stage, stage_left_s: null };
  }
}

export function playerView(s: AgentSession, p: PlayerPublic) {
  return {
    id: p.playerId,
    // the nickname is only a stand-in identifier until the player has a party
    ...(p.party ? {} : { nickname: p.nickname }),
    party: p.party?.name ?? null,
    colour: p.party?.colour ?? null,
    symbol: p.party?.symbol ?? null,
    avatar: p.party?.avatar ?? null,
    kind: p.kind ?? 'human',
    status: p.status,
    is_admin: p.isAdmin,
    you: p.playerId === s.client.me,
  };
}

/** The party name (the nickname is shown only for a player who has no party yet). `_withParty` is kept for call sites. */
export function who(s: AgentSession, id: string, _withParty = false): string {
  const p = s.player(id);
  if (!p) return id;
  return p.party?.name ?? p.nickname;
}

export const namesOf = (s: AgentSession, ids: string[]): string[] => ids.map((i) => who(s, i));

export function portfoliosView(s: AgentSession, pf: PortfolioAssignment): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(pf)) out[k] = namesOf(s, v);
  return out;
}

export function winsByName(s: AgentSession): Record<string, { leads: number; wins: number }> {
  const t = s.client.state.snapshot?.tally;
  const out: Record<string, { leads: number; wins: number }> = {};
  const ids = new Set([...(t ? [...Object.keys(t.leads), ...Object.keys(t.wins)] : []), ...s.players().filter((p) => ['active', 'disconnected'].includes(p.status)).map((p) => p.playerId)]);
  for (const id of ids) {
    const name = who(s, id);
    // party names are unique; only party-less players (nickname fallback) could collide
    out[name in out ? `${name} [${id}]` : name] = { leads: t?.leads[id] ?? 0, wins: t?.wins[id] ?? 0 };
  }
  return out;
}

/** The unique party id with the most seats (wins; leads when nobody has won one yet), or null (nothing yet / a tie). */
export function largestParty(s: AgentSession): string | null {
  const t = s.client.state.snapshot?.tally;
  if (!t) return null;
  for (const m of [t.wins, t.leads]) {
    const rows = Object.entries(m).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (!rows.length) continue;
    return rows.length > 1 && rows[1][1] === rows[0][1] ? null : rows[0][0];
  }
  return null;
}

export const leftOutHint = (s: AgentSession, id: string): string => `${who(s, id)} is the largest party but is left out; that is allowed (only points and a majority of won seats matter).`;

export function offerView(s: AgentSession, o: CoalitionOffer) {
  const tally = s.client.state.snapshot?.tally;
  const wins = tally?.wins ?? {};
  const leads = tally?.leads ?? {};
  const members = [...new Set([o.proposer, ...o.partners, ...Object.values(o.portfolios).flat()])];
  const live = o.status === 'open' || o.status === 'accepted';
  const memberSeats = members.reduce((a, m) => a + (wins[m] ?? 0), 0);
  const memberLeads = members.reduce((a, m) => a + (leads[m] ?? 0), 0);
  const need = majorityNow(s);
  const me = s.client.me;
  const big = live ? largestParty(s) : null;
  const leftOut = big !== null && !members.includes(big) ? ` ${leftOutHint(s, big)}` : '';
  let note: string | undefined;
  switch (o.status) {
    case 'accepted':
      note = `Everyone accepted. The government is confirmed only once every seat is declared (end of counting) and the members' WON seats then reach ${need} (now ${memberSeats}); the game then ends immediately with the result. Until then the offer just waits.${leftOut}`;
      break;
    case 'open':
      note = `Waiting for the partners to accept. Even when all accept, it is confirmed only once every seat is declared (end of counting).${leftOut}`;
      break;
    case 'declined':
      note = `declined by ${o.declinedBy ? who(s, o.declinedBy) : 'a partner'}: declining kills the whole offer, propose again.`;
      break;
    case 'withdrawn':
      note = 'Withdrawn by the proposer. It is dead; propose or accept another offer.';
      break;
    case 'superseded':
      note = `Superseded by a newer offer from the same proposer${o.supersededBy ? ` (superseded_by ${o.supersededBy})` : ''}: accept the new offer instead.`;
      break;
    case 'formed':
      note = 'This offer became the government (confirmed at the end of counting).';
      break;
  }
  return {
    offer_id: o.offerId,
    status: o.status,
    proposer: who(s, o.proposer),
    portfolios: portfoliosView(s, o.portfolios),
    partners: namesOf(s, o.partners),
    accepted: namesOf(s, o.accepted),
    waiting_for: live ? namesOf(s, o.partners.filter((p) => !o.accepted.includes(p))) : [],
    ...(o.declinedBy ? { declined_by: who(s, o.declinedBy) } : {}),
    ...(o.supersededBy ? { superseded_by: o.supersededBy } : {}),
    you_are_proposer: o.proposer === me,
    you_accepted: me !== null && o.accepted.includes(me),
    ...(live ? { members_won_seats_so_far: memberSeats, members_leading_seats: memberLeads } : {}),
    majority_needed: need,
    note,
  };
}

export function governmentView(s: AgentSession, g: Government) {
  return {
    pm: who(s, g.pm, true),
    members: g.members.map((m) => who(s, m, true)),
    portfolios: portfoliosView(s, g.portfolios),
    via_negotiation: g.viaNegotiation,
    outright_majority: !g.viaNegotiation,
    ...(g.viaNegotiation ? {} : {
      note: 'Outright majority: this party won a majority of seats on its own and did not negotiate, so no portfolios were shared. It holds every portfolio itself (both Deputy Prime Minister slots included); the repeated names are not a coalition.',
    }),
  };
}

export function resultView(s: AgentSession, r: FinalResult) {
  const me = s.client.me;
  return {
    outcome: r.outcome,
    meaning: ({
      majority: 'Outright majority: one party won a majority of seats on its own and did not negotiate, so no portfolios were shared: clear winner.',
      coalition: 'A coalition government was confirmed once every seat was declared (end of counting); the member with the most points wins. At least one party always stays out of a government.',
      draw: 'Exact tie between two players: draw.',
      noGovernment: 'Nobody had a confirmed government when the time ran out: everyone loses.',
    } as Record<string, string>)[r.outcome],
    winners: r.winners.map((w) => who(s, w, true)),
    you_won: me !== null && r.winners.includes(me),
    seats: Object.fromEntries(Object.entries(r.tally).map(([p, n]) => [who(s, p), n])),
    points: r.points.map((p) => ({
      player: who(s, p.playerId, true), total: p.total, portfolio: p.portfolioPoints, seats: p.seatPoints, government_bonus: p.governmentFloor,
    })).sort((a, b) => b.total - a.total),
    government: r.government ? governmentView(s, r.government) : null,
  };
}

export function reportView(s: AgentSession, r: AnalystReport, dir: SeatDirectory | null) {
  const ageS = secs(r.purchasedAt - r.asOf);
  return {
    scope: r.scope,
    seat: r.seat ?? null,
    seat_name: r.seat !== undefined ? (dir?.name(r.seat) ?? `Seat ${r.seat}`) : null,
    describes_position_seconds_before_purchase: ageS,
    as_of: new Date(r.asOf).toISOString(),
    price_wr: r.price,
    entries: r.entries.map((e) => (r.scope === 'seat'
      ? { rank: e.rank, party: who(s, e.playerId, true), est_vote_share_pct: round1(e.estimate * 100), margin_pct_points: round1(e.margin * 100) }
      : { rank: e.rank, party: who(s, e.playerId, true), est_seats: Math.round(e.estimate), margin_seats: Math.round(e.margin) })),
    note: 'Noisy opinion poll about the recent past. Treat as +- margin.',
  };
}

export function declarationView(s: AgentSession, d: SeatDeclaration, dir: SeatDirectory | null) {
  return { seat: d.seat, seat_name: dir?.name(d.seat) ?? `Seat ${d.seat}`, status: d.status, party: who(s, d.playerId, true) };
}

/** A chat message: `to` is 'everyone' in the group chat, else the one recipient; tags ("@Party") are listed, with a flag when you are tagged. */
export function chatView(s: AgentSession, m: ChatMessage) {
  const group = (m.channel ?? 'group') === 'group';
  const me = s.client.me;
  return {
    id: m.id, chat: group ? 'group' : 'one-to-one', from: who(s, m.from), to: group ? 'everyone' : namesOf(s, m.to), text: m.text,
    time: new Date(m.ts).toISOString().slice(11, 19) + 'Z', you_sent: m.from === me,
    ...(m.mentions?.length ? { tagged: namesOf(s, m.mentions), tags_you: !!me && m.mentions.includes(me) } : {}),
  };
}

/** Human-friendly rendering of one logged event. */
export function eventView(s: AgentSession, e: AgentEvent, dir: SeatDirectory | null): Record<string, unknown> {
  const base = { cursor: e.cursor, type: e.type };
  const d = e.data as any;
  switch (e.type) {
    case 'news': return { ...base, party: who(s, d.item.playerId, true), seat: d.item.seat, seat_name: dir?.name(d.item.seat) ?? `Seat ${d.item.seat}`, what: 'rally' };
    case 'phaseClosed': return { ...base, phase: d.phase + 1, seats_polled: (d.seats as number[]).length, note: 'Seats of this phase are polled and frozen.' };
    case 'seatUpdate': return { ...base, ...declarationView(s, d.declaration, dir) };
    case 'chat': return { ...base, ...chatView(s, d.message) };
    case 'offer': return { ...base, ...offerView(s, d.offer) };
    case 'government': return { ...base, ...governmentView(s, d.government) };
    case 'result': return { ...base, ...resultView(s, d.result) };
    case 'status': {
      const note = ({
        preCampaign: 'The pre-campaign has started: field candidates now (field_candidates). With no candidate by the deadline you are eliminated. Campaign actions open when it ends.',
        campaign: 'The campaign is on: rallies, minor rallies and roadshows, only in seats where you have a candidate.',
      } as Record<string, string>)[d.status];
      return { ...base, status: d.status, ...(note ? { note } : {}) };
    }
    case 'fielding': return {
      ...base, party: who(s, d.playerId, true), fielded: (d.added as unknown[]).length, withdrawn: (d.removed as unknown[]).length,
      contested_seats: d.contestedSeats, majority: d.majority,
    };
    case 'fieldingDone': return { ...base, party: who(s, d.playerId, true), done: d.done, done_count: d.doneCount, needed: d.needed };
    case 'players': return { ...base, players: (d.players as PlayerPublic[]).map((p) => ({ ...(p.party ? {} : { nickname: p.nickname }), party: p.party?.name ?? null, kind: p.kind ?? 'human', status: p.status, admin: p.isAdmin })) };
    case 'report': return { ...base, report: reportView(s, d.report, dir), budget: d.budget };
    case 'rematch': {
      const snap = s.client.state.snapshot;
      const phases = snap?.timeline?.phaseCloses.length ?? snap?.phases;
      const mine = s.client.state.me ? s.player(s.client.state.me)?.party?.name : undefined;
      return {
        ...base, previous_game_id: d.previousGameId ?? null, game_id: d.gameId, join_code: d.joinCode || null,
        ...(phases !== undefined ? { polling_phases: phases } : {}),
        ...(mine ? { your_party: mine } : {}),
        note: 'The host played again. You are already in the new game with the same party; it has started (no set_party, no join_game needed): with 3+ players it begins in the pre-campaign (field candidates now with field_candidates), with 2 players in the campaign. Call get_state. Do not call leave_game.',
      };
    }
    case 'error': return { ...base, code: d.error, message: d.message };
  }
}

// ------------------------------------------------------------------ committed voters (own only)
/** "~30% (HIGH)": the band figure, never the value after influence. */
export const committedLabel = (c: CommittedView): string => `~${c.percent}% (${c.level})`;

/** Summary of the player's own committed seats: counts per level plus the list (seat, name, band label). */
export function committedSummary(s: AgentSession, dir: SeatDirectory | null) {
  const list = s.client.state.priv?.committed ?? [];
  const by_level: Record<string, number> = {};
  for (const c of list) by_level[c.level] = (by_level[c.level] ?? 0) + 1;
  return {
    total: list.length,
    by_level,
    seats: list.map((c) => ({ seat: c.seat, name: dir?.name(c.seat) ?? `Seat ${c.seat}`, committed: committedLabel(c), band: c.band })),
    note: 'Your committed voters (private). They are a base to defend and extend; the % is the band figure, the votes you finally get there can differ (influence and chance).',
  };
}

// ------------------------------------------------------------------ get_state
export function stateView(s: AgentSession, dir: SeatDirectory | null) {
  const c = s.client;
  const st = c.state;
  if (!c.session) {
    return { joined: false, advice: ['You have not joined a game. Call get_rules, then join_game with the join code a human host gives you. AI players cannot create games.'] };
  }
  const snap = st.snapshot;
  const cfg = s.cfg();
  const tl = snap?.timeline ?? null;
  const now = c.serverNow();
  const status = snap?.status ?? st.lobby?.status ?? 'lobby';
  const admission = admissionOf(st);
  const mine = s.players().find((p) => p.playerId === c.me);
  const priv = st.priv;
  const budget = currentBudget(s) ?? 0;
  const out: Record<string, unknown> = {
    joined: true,
    game_id: c.session.gameId,
    join_code: st.joinCode,
    map: s.mapId(),
    seats_total: cfg.seatCount,
    // contested seats = seats with at least one candidate: a vacant seat is never declared and the majority drops with it
    contested_seats: snap?.contestedSeats ?? cfg.seatCount,
    majority: majorityNow(s),
    status,
    admission,
    connection: st.link,
    you: { id: c.me, ...(mine?.party ? {} : { nickname: mine?.nickname ?? st.nickname }), party: mine?.party?.name ?? null, kind: 'agent', status: mine?.status ?? null },
    server_time_offset_ms: Math.round(st.serverOffsetMs),
  };
  const advice: string[] = [];
  let phaseIdx: number | null = null;
  let inCampaign = false;

  if (tl) {
    const phases = tl.phaseCloses.length;
    const cur = tl.phaseCloses.findIndex((t) => t > now);
    inCampaign = status === 'campaign' && now >= tl.campaignStart && now < tl.campaignEnd;
    phaseIdx = status === 'campaign' && cur >= 0 ? cur : null;
    out.timers = {
      ...(tl.preCampaignEnd !== undefined ? { pre_campaign_left_s: secs(tl.preCampaignEnd - now) } : {}),
      campaign_starts_in_s: now < tl.campaignStart ? secs(tl.campaignStart - now) : 0,
      campaign_left_s: secs(tl.campaignEnd - now),
      current_polling_phase: phaseIdx !== null ? phaseIdx + 1 : null,
      polling_phases_total: phases,
      current_phase_left_s: phaseIdx !== null ? secs(tl.phaseCloses[phaseIdx] - now) : 0,
      phase_deadlines_in_s: tl.phaseCloses.map((t) => secs(t - now)),
      ...stageInfo(status, tl, now),
      counting_ends_in_s: secs(tl.countingEnd - now),
      post_counting_ends_in_s: secs(tl.postCountingEnd - now),
    };
    out.polled_phases = [...st.polledPhases].sort((a, b) => a - b).map((p) => p + 1);
    // which chat this stage has (Chat.Campaigning; always INDV from counting): GROUP, INDV (one-to-one) or null = none now
    out.chat_mode = (snap?.players.filter((p) => p.status !== 'pending' && p.status !== 'rejected').length ?? 0) >= 3 ? chatModeFor(s.cfg(), status) : null;
    if (dir && snap) {
      const pm = s.phaseMap(dir);
      let open = 0;
      for (const [, p] of pm) if (!s.phaseClosed(p)) open++;
      out.seats_still_open = open;
    }
  }

  if (priv) {
    const cost = cfg.costs;
    const prices = tl ? { seat: analystPrice(cfg, 'seat', tl, now), global: analystPrice(cfg, 'global', tl, now) } : null;
    out.budget = {
      wr: budget,
      rally_cost_wr: cost.rally,
      minor_rally_cost_wr: cost.minorRally,
      roadshow_cost_wr: cost.roadshow,
      candidate_cost_wr: cost.candidate,
      costs_wr: { ...cost },
      rallies_affordable: Math.floor(budget / cost.rally),
      minor_rallies_affordable: Math.floor(budget / cost.minorRally),
      roadshows_affordable: Math.floor(budget / cost.roadshow),
      candidates_affordable: cost.candidate > 0 ? Math.floor(budget / cost.candidate) : null,
      ...rallyCooldownView(s),
      ...(prices && cfg.analyst.seatReport.enabled ? { seat_report_price_now_wr: prices.seat } : {}),
      ...(prices && cfg.analyst.globalReport.enabled ? { global_report_price_now_wr: prices.global } : {}),
      ...(cfg.analyst.seatReport.enabled ? {} : { seat_report: 'currently switched off in this game (buy_report refuses it)' }),
      ...(cfg.analyst.globalReport.enabled ? {} : { global_report: 'currently switched off in this game (buy_report refuses it)' }),
      report_price_note: 'Report prices rise as the campaign goes on, by the second: the price you pay is the one at the moment the server handles your purchase, so it can be slightly higher than the price shown here.',
      currency: cfg.currency.symbol,
    };
    const done = (t: string) => priv.myActions.filter((a) => a.type === t).length;
    out.committed = committedSummary(s, dir);
    out.my_actions = { rallies: done('rally'), minor_rallies: done('minorRally'), roadshows: done('roadshow'), reports_bought: priv.myReports.length };
  }
  if (snap && gameHasFielding(s)) out.fielding = { ...fieldingSummary(s), note: 'Public and live: every party can see who has a candidate where. Only seats where you have a candidate can be campaigned in.' };

  out.players = s.players().filter((p) => p.status !== 'rejected').map((p) => playerView(s, p));
  if (snap) {
    const byParty: Record<string, number> = {};
    for (const n of snap.news) { const k = who(s, n.playerId); byParty[k] = (byParty[k] ?? 0) + 1; }
    out.public_rally_news = { total: snap.news.length, by_party: byParty, note: 'Major rallies only; minor rallies and roadshows are hidden.' };
    if (snap.tally) out.tally = { declared_won: snap.tally.declared, of: snap.tally.total, by_party: winsByName(s) };
    const involved = snap.offers.filter((o) => (o.status === 'open' || o.status === 'accepted'));
    out.open_offers = involved.map((o) => offerView(s, o));
    out.government = snap.government ? governmentView(s, snap.government) : null;
    out.result = snap.result ? resultView(s, snap.result) : null;
  }

  // ---- advice for the next step
  const nPlayers = s.players().filter((p) => ['active', 'disconnected', 'eliminated'].includes(p.status)).length;
  if (admission === 'pending') advice.push('Waiting for the host to admit you: call wait_for_admission.');
  else if (admission === 'declined') advice.push('The host declined your request. Ask the human for a new code or to admit you, then leave_game and join again.');
  else if (status === 'lobby') {
    if (!mine?.party) advice.push('Pick your party: list_party_options, then set_party {name, colour, symbol, avatar}.');
    else advice.push('Party set. Waiting for the host to start the game: wait_for_events {types:["status"]}. You can change your party until then.');
  } else if (status === 'preCampaign') {
    const left = tl?.preCampaignEnd !== undefined ? secs(tl.preCampaignEnd - now) : null;
    const fielded = fieldedCounts(s).get(c.me ?? '') ?? 0;
    advice.push(`PRE-CAMPAIGN${left !== null ? ` (${left} s left)` : ''}: field candidates before the deadline with field_candidates {seats:[...]} (or {all:true}). With no candidates you are out of the game. Each candidate costs ${cfg.currency.symbol}${cfg.costs.candidate.toLocaleString('en-US')} (refunded in full if you withdraw_candidates before the deadline), and you can only campaign in seats where you have one; what you do not spend on candidates is your campaign budget. You have ${fielded} candidate${fielded === 1 ? '' : 's'} now. Negotiate one-to-one with the other parties about who stands where (chat {to, text}); rallies, roadshows and reports open only when the campaign starts.`);
    advice.push('When you have fielded what you want, call done_fielding: the campaign then starts as soon as every connected active party is done (fielding or withdrawing afterwards clears your done; done_fielding {done:false} takes it back). If you do nothing the countdown ends the phase.');
    if (fielded === 0) advice.push('URGENT: you have no candidates yet. Field at least one before the deadline or you are eliminated.');
  } else if (mine?.status === 'eliminated' && (status === 'campaign' || status === 'counting' || status === 'postCounting')) {
    advice.push('You are eliminated (typically: no candidate was fielded before the campaign started). You can still read the chat but cannot act. Keep calling wait_for_events: the game may be played again.');
  } else if (status === 'campaign') {
    if (tl && now < tl.campaignStart) advice.push(`The campaign starts in ${secs(tl.campaignStart - now)} s. Plan now with list_seats; campaign actions wait for the start automatically.`);
    else if (inCampaign) {
      const minCost = Math.min(cfg.costs.rally, cfg.costs.minorRally, cfg.costs.roadshow);
      const fieldedArg = gameHasFielding(s) ? ', fielded_only:true' : ''; // you can only campaign where you have a candidate
      if (budget >= minCost) advice.push(`You have ${cfg.currency.symbol}${Math.round(budget).toLocaleString('en-US')} left (${Math.floor(budget / cfg.costs.roadshow)} roadshows, ${Math.floor(budget / cfg.costs.minorRally)} minor rallies or ${Math.floor(budget / cfg.costs.rally)} rallies). Unspent money is wasted: use list_seats {open_only:true${fieldedArg}} and campaign_batch before phase ${(phaseIdx ?? 0) + 1} closes.`);
      else advice.push('Your budget is spent. Use get_news / wait_for_events to follow the game; negotiation starts at counting.');
    }
  } else if (status === 'counting' || status === 'postCounting') {
    if (snap?.government) {
      advice.push('A government has been formed. Wait for the result.');
      const big = largestParty(s);
      if (big && !snap.government.members.includes(big)) advice.push(leftOutHint(s, big));
    } else if (nPlayers < 3) advice.push('2-player game: no chat or coalitions. Wait for the result.');
    else {
      advice.push('Negotiate: chat with others, propose_government (you are the PM) or respond_offer. A government is confirmed only once every seat is declared (the end of counting) and its members\' WON seats then reach the majority; the game then ends immediately with the result. Accepted offers just wait until then. A government can never include every party: at least one party must stay out. Offers are private: you only see offers you proposed or were named in. No confirmed government at the end = everyone loses.');
      const big = largestParty(s);
      const inLive = (snap?.offers ?? []).some((o) => (o.status === 'open' || o.status === 'accepted') && [o.proposer, ...o.partners, ...Object.values(o.portfolios).flat()].includes(big ?? ''));
      if (big && !inLive) advice.push(leftOutHint(s, big));
    }
  } else if (status === 'finished') advice.push(snap?.result ? 'The game is over. Report the result to the human, then keep calling wait_for_events (types ["rematch"]): the host may play again. If a rematch event arrives you are already in the new game with your party (3+ players: in the pre-campaign, field candidates at once; 2 players: in the campaign): call get_state. Do not call leave_game or join_game.' : 'The game is finished.');
  out.advice = advice;
  return out;
}

/** The news agencies' graphs as compact JSON: per agency the latest projected seats and seat range per party (biggest first) and the history. */
export function globalReportsView(s: AgentSession, r: GlobalReports) {
  const ids = Object.keys(r.agencies[0]?.ranges ?? {});
  const t0 = r.agencies[0]?.points[0]?.t ?? r.asOf;
  return {
    as_of: new Date(r.asOf).toISOString(),
    seconds_since_campaign_start: secs(r.asOf - t0),
    point_every_s: secs(r.sampleIntervalMs),
    agencies: r.agencies.map((a) => {
      const latest = a.points[a.points.length - 1]?.seats ?? {};
      return {
        name: a.name,
        parties: ids.map((id) => ({ party: who(s, id, true), projected_seats: round1(latest[id] ?? 0), range_seats: a.ranges[id] }))
          .sort((x, y) => y.projected_seats - x.projected_seats),
        history: a.points.map((p) => ({ seconds_since_start: secs(p.t - t0), seats: Object.fromEntries(ids.map((id) => [who(s, id, true), round1(p.seats[id] ?? 0)])) })),
      };
    }),
    note: 'Free, noisy opinion projections. Each agency errs differently; the error shrinks on average as the campaign goes on. Compare agencies; do not trust one.',
  };
}
