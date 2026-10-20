// Compact, name-based views of game data for LLMs (ids replaced by nicknames / seat names, times by seconds).
import { analystPrice, majorityOf } from '@hp/shared';
import type {
  AnalystReport, ChatMessage, CoalitionOffer, FinalResult, Government, PlayerPublic, PortfolioAssignment, SeatDeclaration,
} from '@hp/shared';
import { admissionOf } from './state';
import type { AgentEvent } from './state';
import type { AgentSession } from './session';
import type { SeatDirectory } from './resolve';

export const round1 = (n: number): number => Math.round(n * 10) / 10;
const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000));

export function playerView(s: AgentSession, p: PlayerPublic) {
  return {
    id: p.playerId,
    nickname: p.nickname,
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

/** "Asha" ; with party: "Asha (Saffron Front)". */
export function who(s: AgentSession, id: string, withParty = false): string {
  const p = s.player(id);
  if (!p) return id;
  return withParty && p.party ? `${p.nickname} (${p.party.name})` : p.nickname;
}

const namesOf = (s: AgentSession, ids: string[]): string[] => ids.map((i) => who(s, i));

export function portfoliosView(s: AgentSession, pf: PortfolioAssignment): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(pf)) out[k] = namesOf(s, v);
  return out;
}

export function winsByName(s: AgentSession): Record<string, { leads: number; wins: number }> {
  const t = s.client.state.snapshot?.tally;
  const out: Record<string, { leads: number; wins: number }> = {};
  const ids = new Set([...(t ? [...Object.keys(t.leads), ...Object.keys(t.wins)] : []), ...s.players().filter((p) => ['active', 'disconnected'].includes(p.status)).map((p) => p.playerId)]);
  for (const id of ids) out[who(s, id)] = { leads: t?.leads[id] ?? 0, wins: t?.wins[id] ?? 0 };
  return out;
}

export function offerView(s: AgentSession, o: CoalitionOffer) {
  const wins = s.client.state.snapshot?.tally?.wins ?? {};
  const members = [...new Set([o.proposer, ...o.partners, ...Object.values(o.portfolios).flat()])];
  const memberSeats = members.reduce((a, m) => a + (wins[m] ?? 0), 0);
  const need = majorityOf(s.cfg().seatCount);
  const me = s.client.me;
  return {
    offer_id: o.offerId,
    status: o.status,
    proposer: who(s, o.proposer),
    portfolios: portfoliosView(s, o.portfolios),
    partners: namesOf(s, o.partners),
    accepted: namesOf(s, o.accepted),
    waiting_for: namesOf(s, o.partners.filter((p) => !o.accepted.includes(p))),
    you_are_proposer: o.proposer === me,
    you_accepted: me !== null && o.accepted.includes(me),
    members_won_seats_so_far: memberSeats,
    majority_needed: need,
    note: o.status === 'accepted'
      ? (memberSeats >= need ? 'Everyone accepted and the members hold a majority of WON seats: the government is confirmed automatically.' : `Everyone accepted. It will be confirmed automatically once the members' WON seats reach ${need} (now ${memberSeats}).`)
      : o.status === 'open' ? 'Waiting for the partners to accept.' : undefined,
  };
}

export function governmentView(s: AgentSession, g: Government) {
  return {
    pm: who(s, g.pm, true),
    members: g.members.map((m) => who(s, m, true)),
    portfolios: portfoliosView(s, g.portfolios),
    via_negotiation: g.viaNegotiation,
  };
}

export function resultView(s: AgentSession, r: FinalResult) {
  const me = s.client.me;
  return {
    outcome: r.outcome,
    meaning: ({
      majority: 'One party had a majority and did not negotiate: clear winner.',
      coalition: 'A coalition government formed; the member with the most points wins.',
      draw: 'Exact tie between two players: draw.',
      noGovernment: 'Nobody formed a government in time: everyone loses.',
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

export function chatView(s: AgentSession, m: ChatMessage) {
  return { id: m.id, from: who(s, m.from), to: namesOf(s, m.to), text: m.text, time: new Date(m.ts).toISOString().slice(11, 19) + 'Z', you_sent: m.from === s.client.me };
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
    case 'status': return { ...base, status: d.status };
    case 'players': return { ...base, players: (d.players as PlayerPublic[]).map((p) => ({ nickname: p.nickname, party: p.party?.name ?? null, kind: p.kind ?? 'human', status: p.status, admin: p.isAdmin })) };
    case 'report': return { ...base, report: reportView(s, d.report, dir), budget_crore: round1(d.budget / 1e7) };
    case 'error': return { ...base, code: d.error, message: d.message };
  }
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
  const budget = priv?.budget ?? 0;
  const out: Record<string, unknown> = {
    joined: true,
    game_id: c.session.gameId,
    join_code: st.joinCode,
    map: s.mapId(),
    seats_total: cfg.seatCount,
    majority: majorityOf(cfg.seatCount),
    status,
    admission,
    connection: st.link,
    you: { id: c.me, nickname: mine?.nickname ?? st.nickname, party: mine?.party?.name ?? null, kind: 'agent' },
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
      campaign_starts_in_s: now < tl.campaignStart ? secs(tl.campaignStart - now) : 0,
      campaign_left_s: secs(tl.campaignEnd - now),
      current_polling_phase: phaseIdx !== null ? phaseIdx + 1 : null,
      polling_phases_total: phases,
      current_phase_left_s: phaseIdx !== null ? secs(tl.phaseCloses[phaseIdx] - now) : 0,
      phase_deadlines_in_s: tl.phaseCloses.map((t) => secs(t - now)),
      counting_left_s: secs(tl.countingEnd - now),
      post_counting_left_s: secs(tl.postCountingEnd - now),
    };
    out.polled_phases = [...st.polledPhases].sort((a, b) => a - b).map((p) => p + 1);
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
      crore: round1(budget / 1e7),
      rally_cost_wr: cost.rally,
      roadshow_cost_wr: cost.roadshow,
      rallies_affordable: Math.floor(budget / cost.rally),
      roadshows_affordable: Math.floor(budget / cost.roadshow),
      ...(prices ? { seat_report_price_now_wr: prices.seat, global_report_price_now_wr: prices.global } : {}),
      currency: cfg.currency.symbol,
    };
    const rallies = priv.myActions.filter((a) => a.type === 'rally').length;
    out.my_actions = { rallies, roadshows: priv.myActions.length - rallies, reports_bought: priv.myReports.length };
  }

  out.players = s.players().filter((p) => p.status !== 'rejected').map((p) => playerView(s, p));
  if (snap) {
    const byParty: Record<string, number> = {};
    for (const n of snap.news) { const k = who(s, n.playerId); byParty[k] = (byParty[k] ?? 0) + 1; }
    out.public_rally_news = { total: snap.news.length, by_party: byParty };
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
  } else if (status === 'campaign') {
    if (tl && now < tl.campaignStart) advice.push(`The campaign starts in ${secs(tl.campaignStart - now)} s. Plan now with list_seats; campaign actions wait for the start automatically.`);
    else if (inCampaign) {
      const minCost = Math.min(cfg.costs.rally, cfg.costs.roadshow);
      if (budget >= minCost) advice.push(`You have ${round1(budget / 1e7)} crore left (${Math.floor(budget / cfg.costs.roadshow)} roadshows or ${Math.floor(budget / cfg.costs.rally)} rallies). Unspent money is wasted: use list_seats {open_only:true} and campaign_batch before phase ${(phaseIdx ?? 0) + 1} closes.`);
      else advice.push('Your budget is spent. Use get_news / wait_for_events to follow the game; negotiation starts at counting.');
    }
  } else if (status === 'counting' || status === 'postCounting') {
    if (snap?.government) advice.push('A government has been formed. Wait for the result.');
    else if (nPlayers < 3) advice.push('2-player game: no chat or coalitions. Wait for the result.');
    else advice.push('Negotiate: chat with others, propose_government (you are the PM) or respond_offer. A government is confirmed once its members\' WON seats reach the majority. No government by the deadline = everyone loses.');
  } else if (status === 'finished') advice.push(snap?.result ? 'The game is over. Report the result to the human.' : 'The game is finished.');
  out.advice = advice;
  return out;
}
