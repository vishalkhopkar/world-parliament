// THE action table. The MCP server (mcp.ts) and the CLI/daemon (cli.ts, daemon.ts) both execute actions only through this
// table, so they can never diverge. Each action: name, LLM-facing description, zod input schema, handler on an AgentSession.
import { analystPrice, AVATARS, chatModeFor, haversineKm, PARTY_COLOURS, PARTY_SYMBOLS } from '@hp/shared';
import type { ActionType, CoalitionOffer, CommittedView, MapConfig, PartyIdentity, PortfolioAssignment, SeatId } from '@hp/shared';
import { z } from 'zod';
import { AgentError, toErrorInfo } from './errors';
import type { ErrorInfo } from './errors';
import { resolveColour, resolveOption, resolvePlayer, resolvePortfolio, type NamedSeat } from './resolve';
import { configForMap, renderRules } from './rules';
import type { AgentSession } from './session';
import { EVENT_TYPES, admissionOf } from './state';
import type { EventType } from './state';
import {
  candidatesIn, chatView, doneProgress, fieldedCounts, namesOf, committedLabel, currentBudget, eventView, fieldingSummary, gameHasFielding, iHaveCandidate, majorityNow, rallyCooldownView, rallyReadyAt,
  governmentView, offerView, playerView, reportView, globalReportsView, round1, stageInfo, stateView, who, winsByName,
} from './views';

export interface ActionDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  /** true = does not change anything in the game (MCP readOnlyHint) */
  readOnly?: boolean;
  run(ctx: AgentSession, input: z.infer<S>): Promise<unknown>;
}

const def = <S extends z.ZodObject<z.ZodRawShape>>(a: ActionDef<S>): ActionDef => a as unknown as ActionDef;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000));
const WR = (cfg: { currency: { symbol: string } }, n: number) => `${cfg.currency.symbol}${Math.round(n).toLocaleString('en-US')}`;

// ------------------------------------------------------------------ shared helpers
function needJoined(s: AgentSession): void {
  if (!s.joined) throw new AgentError('NOT_JOINED', 'You have not joined a game yet.');
}

function needAdmitted(s: AgentSession): void {
  needJoined(s);
  const a = admissionOf(s.client.state);
  if (a === 'pending' || a === 'declined') throw new AgentError('NOT_ADMITTED', a === 'pending' ? 'The host has not admitted you yet.' : 'The host declined your request to join.');
}

/** Seat ref -> seat (with names when the package is available, otherwise numeric ids only). */
async function seatOf(s: AgentSession, ref: unknown): Promise<{ id: SeatId; name: string; seat: NamedSeat | null }> {
  const dir = await s.seatsOrNull();
  if (dir) { const seat = dir.resolve(ref); return { id: seat.id, name: seat.name, seat }; }
  const n = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref.trim()) ? Number(ref) : NaN;
  if (!Number.isInteger(n)) throw new AgentError('NO_MAP', 'Seat names are unavailable (map package not found); use numeric seat ids.');
  return { id: n, name: `Seat ${n}`, seat: null };
}

const MAX_LEAD_IN_WAIT_MS = 15_000;

/** Wait out the short lead-in between /start and the campaign start; reject if it is far away or already over. */
async function campaignWindow(s: AgentSession): Promise<void> {
  needAdmitted(s);
  const c = s.client;
  const snap = c.state.snapshot;
  const status = snap?.status ?? 'lobby';
  if (status === 'lobby' || !snap?.timeline) throw new AgentError('WRONG_PHASE', 'The game has not started yet (only the human host can start it).', 'Call wait_for_events with types ["status"], or get_state.');
  if (status === 'preCampaign') {
    const left = snap.timeline.preCampaignEnd !== undefined ? secs(snap.timeline.preCampaignEnd - c.serverNow()) : null;
    throw new AgentError('WRONG_PHASE', `The campaign has not started yet: the pre-campaign is running${left !== null ? ` (${left} s left)` : ''}. Rallies, roadshows and reports open when the campaign starts.`,
      'Field your candidates now with field_candidates {seats:[...]} (you can only campaign in seats where you have one; no candidates = eliminated), chat one-to-one, then call wait_for_events {types:["status"]} for the campaign start.');
  }
  if (status !== 'campaign') throw new AgentError('TOO_LATE', 'The campaign is over.');
  if (c.state.snapshot?.players.find((p) => p.playerId === c.me)?.status === 'eliminated') {
    throw new AgentError('FORBIDDEN', 'You are eliminated (no candidate was fielded before the campaign started), so you cannot act any more.', 'You can still read the chat. Keep calling wait_for_events: the host may play again.');
  }
  const tl = snap.timeline;
  let now = c.serverNow();
  if (now < tl.campaignStart) {
    const wait = tl.campaignStart - now;
    if (wait > MAX_LEAD_IN_WAIT_MS) throw new AgentError('WRONG_PHASE', `The campaign starts in ${secs(wait)} s.`, 'Call get_state for the countdown, then retry.');
    await sleep(wait + 60);
    now = c.serverNow();
  }
  if (now >= tl.campaignEnd) throw new AgentError('TOO_LATE', 'The campaign is over.');
}

/** Local pre-validation (the server stays the authority). Returns an error or null. */
function precheckSeat(s: AgentSession, seatId: SeatId, phaseOf: Map<SeatId, number> | null): AgentError | null {
  if (!phaseOf) return null;
  const p = phaseOf.get(seatId);
  if (p === undefined) return new AgentError('UNKNOWN_SEAT', `Seat ${seatId} does not exist in this game.`);
  if (s.phaseClosed(p)) return new AgentError('SEAT_POLLED', `Polling in that seat (phase ${p + 1}) has already closed.`);
  return null;
}

function budgetView(s: AgentSession) {
  const cfg = s.cfg();
  const b = currentBudget(s) ?? 0;
  return {
    budget_wr: b,
    rallies_affordable: Math.floor(b / cfg.costs.rally),
    minor_rallies_affordable: Math.floor(b / cfg.costs.minorRally),
    roadshows_affordable: Math.floor(b / cfg.costs.roadshow),
    ...rallyCooldownView(s),
  };
}

/** Offer by exact id, or by a unique id prefix (shared by respond_offer and withdraw_offer). */
function resolveOffer(s: AgentSession, ref: string): CoalitionOffer {
  const offers = s.client.state.snapshot?.offers ?? [];
  const exact = offers.find((o) => o.offerId === ref);
  if (exact) return exact;
  const pre = offers.filter((o) => o.offerId.startsWith(ref));
  if (pre.length === 1) return pre[0];
  throw new AgentError('OFFER_NOT_FOUND', `No offer "${ref}" is known to you. Known: ${offers.map((o) => o.offerId).join(', ') || 'none'}. (You only see offers you proposed or were named in.)`);
}


/** Preset party options with the party (of another player) that holds each one, or null when free. */
function partyOptions(s: AgentSession) {
  const others = s.players().filter((p) => p.playerId !== s.client.me && p.party && p.status !== 'rejected');
  const takenBy = (pred: (p: PartyIdentity) => boolean) => others.find((p) => pred(p.party as PartyIdentity))?.party?.name ?? null;
  return {
    colours: PARTY_COLOURS.map((c) => ({ hex: c.hex, label: c.label, taken_by: takenBy((p) => p.colour.toLowerCase() === c.hex.toLowerCase()) })),
    symbols: PARTY_SYMBOLS.map((c) => ({ id: c.id, label: c.label, taken_by: takenBy((p) => p.symbol === c.id) })),
    avatars: AVATARS.map((a) => ({ id: a.id, label: a.label, taken_by: takenBy((p) => p.avatar === a.id) })),
  };
}

const CLASH_FIELD = { NAME_TAKEN: 'name', COLOUR_TAKEN: 'colour', SYMBOL_TAKEN: 'symbol', AVATAR_TAKEN: 'avatar' } as const;
type ClashCode = keyof typeof CLASH_FIELD;

function clashError(s: AgentSession, e: AgentError): AgentError {
  const o = partyOptions(s);
  const list = (rows: { label: string; taken_by: string | null; hex?: string; id?: string }[], key: 'hex' | 'id') => rows.filter((r) => !r.taken_by).map((r) => `${r.label} (${r[key]})`).join(', ') || 'none';
  return new AgentError(e.code, `${e.message} Free colours: ${list(o.colours, 'hex')}. Free symbols: ${list(o.symbols, 'id')}. Free avatars: ${list(o.avatars, 'id')}.`,
    'Call set_party again with free options from this list (or pass auto_pick:true to let the tool choose free colour/symbol/avatar; give your own name or it is chosen too).');
}

// ------------------------------------------------------------------ schemas
const seatRef = z.union([z.number().int(), z.string().min(1)]).describe('Seat id (1..N) or seat name, e.g. 17 or "Delhi West"');
const actionType = z.enum(['rally', 'minorRally', 'roadshow']);

// ------------------------------------------------------------------ the table
export const ACTIONS: ActionDef[] = [
  def({
    name: 'get_rules',
    description: 'Return the complete rulebook and strategy guide for HUNG PARLIAMENT (Markdown), with the live numbers of this game (budget, prices, effects, points). Call this FIRST if you do not know the game. No arguments.',
    schema: z.object({}),
    readOnly: true,
    async run(s) {
      const snap = s.client.state.snapshot;
      const cfg = s.joined ? s.cfg() : configForMap(null);
      let mapName: string | undefined;
      const dir = await s.seatsOrNull().catch(() => null);
      if (dir) mapName = `${dir.pkg.seatCount} seats, map ${dir.pkg.mapId}`;
      let text = renderRules(cfg, { mapName, timeline: snap?.timeline ?? null });
      if (snap) text += `\n\n---\n## This game right now\nYou are in game ${snap.gameId} (map ${snap.mapId}, ${snap.phases} polling phase${snap.phases === 1 ? '' : 's'}, status ${snap.status}). Call get_state for live timers, budget and what to do next.\n`;
      return text;
    },
  }),

  def({
    name: 'join_game',
    description: 'Ask to join a game created by a human, using the join code the human gave you (6 letters/digits). You join as an AI player. The host must admit you (status "pending" until then). You can NOT create or start games. Next: wait_for_admission.',
    schema: z.object({
      join_code: z.string().min(3).optional().describe("The join code shown in the host's lobby (alias: code)"),
      code: z.string().min(3).optional().describe('Alias of join_code'),
      nickname: z.string().min(1).max(24).default('Claude').describe('Your join name (max 24 characters, default "Claude"); shown only to the host until you set a party'),
    }),
    async run(s, i) {
      const joinCode = i.join_code ?? i.code;
      if (!joinCode) throw new AgentError('INVALID_INPUT', 'join_code is required (the code the human host gives you; "code" works too).');
      const sess = await s.client.join(joinCode, i.nickname);
      s.persist();
      return {
        status: 'pending',
        game_id: sess.gameId,
        player_id: sess.playerId,
        hint: 'Join request sent. The human host has to admit you. Call wait_for_admission next (the host sees you in the lobby with a robot badge).',
      };
    },
  }),

  def({
    name: 'wait_for_admission',
    description: 'Wait until the host admits or declines your join request. Returns status "admitted", "declined" or "pending" (timeout_s max 120, default 30; on pending call again).',
    schema: z.object({ timeout_s: z.number().min(1).max(120).default(30).describe('Seconds to wait (max 120, default 30; call again on pending)') }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const r = await s.client.waitForAdmission(i.timeout_s * 1000);
      const hint = r === 'admitted' ? 'You are in. Call list_party_options, then set_party. Then wait for the host to start (wait_for_events types ["status"]).'
        : r === 'declined' ? 'The host declined you. Ask the human to admit you; then leave_game and join_game again.'
          : 'Still pending. Ask the human host to click Admit, then call wait_for_admission again.';
      return { status: r, hint };
    },
  }),

  def({
    name: 'get_lobby',
    description: 'Lobby / game overview from the server: players (party name, kind human|agent, admin flag, status; a nickname appears only for players who have no party yet), number of polling phases, game status, whether the host is admitting players, your own admission status.',
    schema: z.object({}),
    readOnly: true,
    async run(s) {
      needJoined(s);
      const lobby = await s.client.refreshLobby();
      return {
        game_id: lobby.gameId,
        join_code: lobby.joinCode,
        map: lobby.mapId,
        polling_phases: lobby.phases,
        status: lobby.status,
        admission_open: lobby.admissionOpen,
        your_admission: admissionOf(s.client.state),
        players: lobby.players.map((p) => playerView(s, p)),
        players_needed_to_start: `${s.cfg().players.min}-${s.cfg().players.max}`,
      };
    },
  }),

  def({
    name: 'list_party_options',
    description: 'List the preset party colours (hex + label), symbols (id + label) and avatars (id + label) with a "taken" flag for those already chosen by other players. Pick free ones for set_party.',
    schema: z.object({}),
    readOnly: true,
    async run(s) {
      needJoined(s);
      await s.client.refreshLobby().catch(() => undefined);
      const mine = s.players().find((p) => p.playerId === s.client.me)?.party ?? null;
      return {
        your_party: mine,
        ...partyOptions(s),
        note: 'Party name, colour, symbol and avatar must each be unique in the game, and all four are required to start.',
      };
    },
  }),

  def({
    name: 'set_party',
    description: 'Choose (or change, until the game starts) your party identity: name (2-30 chars), colour (hex like "#1F5FBF" or label like "Blue"), symbol (id or label) and avatar (id or label). ALL FOUR are required unless auto_pick:true (the host cannot start the game until every player has an avatar) and each must be unique among players. Use list_party_options first to see what is free. If another player grabbed your colour/symbol/avatar/name first you get NAME_TAKEN / COLOUR_TAKEN / SYMBOL_TAKEN / AVATAR_TAKEN with the list of FREE options; pass auto_pick:true to fill in anything you leave out (even all four: set_party {auto_pick:true}) and to retry automatically (up to 3 times) with the next free option (a name you gave is never changed; with auto_pick:true and no name, a free name like "Blue Alliance" is chosen).',
    schema: z.object({
      name: z.string().min(2).max(30).optional().describe('Party name, unique in the game (required unless auto_pick:true)'),
      colour: z.string().min(1).optional().describe('Colour hex or label, from list_party_options (required unless auto_pick:true)'),
      symbol: z.string().min(1).optional().describe('Symbol id or label, from list_party_options (required unless auto_pick:true)'),
      avatar: z.string().min(1).optional().describe('Avatar id or label, from list_party_options (required unless auto_pick:true; unique)'),
      auto_pick: z.boolean().default(false).describe('Fill in whatever you leave out with a free unique name / colour / symbol / avatar (fields you give always win), and on a clash retry up to 3 times with the next free option'),
    }),
    async run(s, i) {
      needAdmitted(s);
      if (!i.auto_pick) {
        const missing = (['name', 'colour', 'symbol', 'avatar'] as const).filter((k) => !i[k]);
        if (missing.length) throw new AgentError('INVALID_INPUT', `set_party needs ${missing.join(', ')} (all four of name, colour, symbol, avatar are required).`, 'Pass them, or pass auto_pick:true to let the tool choose free ones.');
      }
      const autoPicked: Record<string, string> = {};
      const o0 = partyOptions(s);
      const mine = s.players().find((p) => p.playerId === s.client.me)?.party ?? null;
      const free = <T extends { taken_by: string | null }>(rows: T[]) => rows.filter((x) => !x.taken_by);
      const takenNames = new Set(s.players().filter((p) => p.playerId !== s.client.me && p.party && p.status !== 'rejected').map((p) => p.party!.name.trim().toLowerCase()));
      const nameFor = (colourHex: string, skip: Set<string>): string => {
        const label = PARTY_COLOURS.find((c) => c.hex.toLowerCase() === colourHex.toLowerCase())?.label ?? 'Independent';
        for (let n = 1; ; n++) {
          const cand = n === 1 ? `${label} Alliance` : `${label} Alliance ${n}`;
          if (!takenNames.has(cand.toLowerCase()) && !skip.has(cand)) return cand;
        }
      };
      const colourHex = i.colour ? resolveColour(PARTY_COLOURS, i.colour).hex : (mine?.colour ?? free(o0.colours)[0]?.hex ?? PARTY_COLOURS[0].hex);
      const symbolId = i.symbol ? resolveOption(PARTY_SYMBOLS, i.symbol, 'symbol').id : (mine?.symbol ?? free(o0.symbols)[0]?.id ?? PARTY_SYMBOLS[0].id);
      const avatarId = i.avatar ? resolveOption(AVATARS, i.avatar, 'avatar').id : (mine?.avatar ?? free(o0.avatars)[0]?.id ?? AVATARS[0].id);
      if (!i.colour) autoPicked.colour = colourHex;
      if (!i.symbol) autoPicked.symbol = symbolId;
      if (!i.avatar) autoPicked.avatar = avatarId;
      const nameAuto = !i.name;
      const triedNames = new Set<string>();
      let name = i.name ? i.name.trim() : (mine?.name ?? nameFor(colourHex, triedNames));
      if (nameAuto) autoPicked.name = name;
      let party: PartyIdentity = { name, colour: colourHex, symbol: symbolId, avatar: avatarId };
      for (let attempt = 0; ; attempt++) {
        try {
          await s.client.setParty(party);
          break;
        } catch (e) {
          if (!(e instanceof AgentError) || !(e.code in CLASH_FIELD)) throw e;
          await s.client.refreshLobby().catch(() => undefined);
          const field = CLASH_FIELD[e.code as ClashCode];
          if (!i.auto_pick || (field === 'name' && !nameAuto) || attempt >= 3) throw clashError(s, e);
          if (field === 'name') {
            triedNames.add(party.name);
            name = nameFor(party.colour, triedNames);
            party = { ...party, name };
            autoPicked.name = name;
            continue;
          }
          const o = partyOptions(s);
          const frees = (field === 'colour' ? o.colours.filter((x) => !x.taken_by).map((x) => x.hex) : field === 'symbol' ? o.symbols.filter((x) => !x.taken_by).map((x) => x.id) : o.avatars.filter((x) => !x.taken_by).map((x) => x.id));
          const pick = frees.find((x) => x !== party[field]);
          if (pick === undefined) throw clashError(s, e);
          party = { ...party, [field]: pick };
          autoPicked[field] = pick;
        }
      }
      return { ok: true, party, ...(Object.keys(autoPicked).length ? { auto_picked: autoPicked } : {}), hint: 'Party saved. Wait for the host to start the game (wait_for_events types ["status"]), then get_state.' };
    },
  }),

  def({
    name: 'get_state',
    description: 'Compact summary for decision making: game status, stage (lobby|preCampaign|campaign|counting|postCounting|finished) with stage_left_s (seconds to the pre-campaign deadline / next phase close / campaign end / counting end / post-counting end), plus timers.pre_campaign_left_s (3+ players), seconds left for the whole campaign, current polling phase, counting_ends_in_s and post_counting_ends_in_s (server-clock corrected), phase number, contested_seats and majority (live in the pre-campaign: vacant seats lower the majority), `fielding` (3+ players: your candidate count, each party\'s count, candidate price), YOUR budget and the current prices (rally, minor rally, roadshow, candidate, reports), how many actions you took, which polling phases are closed, all players (party, kind, status), public rally-news counts, your committed seats (`committed`: counts per level and the list), the live `tally` during counting, open coalition offers involving you, the government and the result, plus "advice" with the suggested next step. After a rematch it describes the new game (game id, phases, timers, budget). Cheap: call it whenever unsure.',
    schema: z.object({}),
    readOnly: true,
    async run(s) {
      const dir = s.joined ? await s.seatsOrNull().catch(() => null) : null;
      return stateView(s, dir);
    },
  }),

  def({
    name: 'list_seats',
    description: 'List seats as compact rows {id, name, phase (1-based polling phase), polled (closed = frozen), lon, lat, neighbours (count), committed (your own committed voters there as "~30% (HIGH)", only on seats where you have some), and in games with a pre-campaign you_have_candidate + candidates (how many parties stand there)}. Filters: phase, committed_only (only seats where you have committed voters), open_only (only seats whose polling has not closed), fielded_only (only seats where you have a candidate, i.e. where you can campaign), not_fielded_only (only seats where you have none yet: candidates to field), query (name substring, accent-insensitive), near_seat_id (seat id or name; rows sorted by distance and include km). limit max 100.',
    schema: z.object({
      phase: z.number().int().min(1).max(5).optional().describe('Only seats polled in this polling phase (1-based)'),
      open_only: z.boolean().default(false).describe('Only seats whose polling has not closed yet'),
      committed_only: z.boolean().default(false).describe('Only seats where you have committed voters'),
      fielded_only: z.boolean().default(false).describe('Only seats where you have a candidate (the seats you can campaign in)'),
      not_fielded_only: z.boolean().default(false).describe('Only seats where you have no candidate yet (what field_candidates could still add)'),
      query: z.string().optional().describe('Name search, e.g. "delhi"'),
      near_seat_id: seatRef.optional().describe('Sort by distance from this seat (id or name) and show km'),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).default(0),
    }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const dir = await s.seats();
      const pm = s.phaseMap(dir);
      let seats = i.query ? dir.search(i.query) : dir.all();
      if (i.phase !== undefined) seats = seats.filter((x) => pm.get(x.id) === i.phase! - 1);
      if (i.open_only) seats = seats.filter((x) => { const p = pm.get(x.id); return p !== undefined && !s.phaseClosed(p); });
      const mineCommitted = new Map((s.client.state.priv?.committed ?? []).map((c) => [c.seat, c] as const));
      if (i.committed_only) seats = seats.filter((x) => mineCommitted.has(x.id));
      const have = (id: SeatId): boolean => iHaveCandidate(s, id) ?? true; // no pre-campaign: every seat is fielded for you
      if (i.fielded_only) seats = seats.filter((x) => have(x.id));
      if (i.not_fielded_only) seats = seats.filter((x) => !have(x.id));
      const fielding = gameHasFielding(s);
      let km = new Map<SeatId, number>();
      let anchorName: string | undefined;
      if (i.near_seat_id !== undefined) {
        const a = dir.resolve(i.near_seat_id);
        anchorName = a.name;
        seats = seats.filter((x) => x.id !== a.id);
        km = new Map(seats.map((x) => [x.id, Math.round(haversineKm(a.lon, a.lat, x.lon, x.lat))]));
        seats = [...seats].sort((x, y) => (km.get(x.id) as number) - (km.get(y.id) as number));
      }
      const total = seats.length;
      const rows = seats.slice(i.offset, i.offset + i.limit).map((x) => {
        const p = pm.get(x.id);
        return {
          id: x.id, name: x.name, phase: p === undefined ? null : p + 1, polled: p === undefined ? null : s.phaseClosed(p),
          lon: round1(x.lon * 10) / 10, lat: round1(x.lat * 10) / 10, neighbours: x.neighbours.length,
          ...(km.has(x.id) ? { km: km.get(x.id) } : {}),
          ...(mineCommitted.has(x.id) ? { committed: committedLabel(mineCommitted.get(x.id) as CommittedView) } : {}),
          ...(fielding ? { you_have_candidate: have(x.id), candidates: candidatesIn(s, x.id).length } : {}),
        };
      });
      return { total, offset: i.offset, returned: rows.length, ...(anchorName ? { near: anchorName } : {}), rows, ...(i.offset + rows.length < total ? { next_offset: i.offset + rows.length } : {}) };
    },
  }),

  def({
    name: 'get_seat',
    description: 'Details of one seat (id or name): polling phase and time until it closes, centre, neighbouring seats (with names and distance), how many rallies/minor rallies/roadshows YOU did there, public rally news held there (by party), your own committed voters there (e.g. "~30% (HIGH)"), your analyst reports for it and, in games with a pre-campaign, whether YOU have a candidate there and which parties stand there with their candidate names (a seat with none is vacant).',
    schema: z.object({ seat: seatRef }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const dir = await s.seats();
      const seat = dir.resolve(i.seat);
      const pm = s.phaseMap(dir);
      const p = pm.get(seat.id);
      const snap = s.client.state.snapshot;
      const priv = s.client.state.priv;
      const tl = snap?.timeline;
      const mine = priv?.myActions.filter((a) => a.seat === seat.id) ?? [];
      const ownCommitted = priv?.committed?.find((c) => c.seat === seat.id);
      const rallies: Record<string, number> = {};
      for (const n of snap?.news ?? []) if (n.seat === seat.id) rallies[who(s, n.playerId)] = (rallies[who(s, n.playerId)] ?? 0) + 1;
      return {
        id: seat.id, name: seat.name, phase: p === undefined ? null : p + 1,
        polled: p === undefined ? null : s.phaseClosed(p),
        closes_in_s: p !== undefined && tl && tl.phaseCloses[p] !== undefined ? secs(tl.phaseCloses[p] - s.client.serverNow()) : null,
        lon: seat.lon, lat: seat.lat,
        neighbours: seat.neighbours.map((n) => {
          const o = dir.get(n);
          const np = pm.get(n);
          return { id: n, name: dir.name(n), km: o ? Math.round(haversineKm(seat.lon, seat.lat, o.lon, o.lat)) : null, polled: np === undefined ? null : s.phaseClosed(np) };
        }),
        my_committed_voters: ownCommitted ? { committed: committedLabel(ownCommitted), band: ownCommitted.band, level: ownCommitted.level, note: 'Private band figure; the final votes can differ (influence and chance).' } : null,
        my_reputation: priv?.reputation?.[seat.id] ?? 0,
        my_actions_here: { rallies: mine.filter((a) => a.type === 'rally').length, minor_rallies: mine.filter((a) => a.type === 'minorRally').length, roadshows: mine.filter((a) => a.type === 'roadshow').length },
        you_have_candidate: iHaveCandidate(s, seat.id) ?? true,
        ...(gameHasFielding(s) ? {
          candidates_here: candidatesIn(s, seat.id).map((c) => ({ party: who(s, c.playerId, true), candidate: c.name ?? null, you: c.playerId === s.client.me })),
          vacant: candidatesIn(s, seat.id).length === 0,
        } : {}),
        public_rallies_here_by_party: rallies,
        my_seat_reports: (priv?.myReports ?? []).filter((r) => r.scope === 'seat' && r.seat === seat.id).map((r) => reportView(s, r, dir)),
        seat_won_by: snap?.seats[seat.id] ? { status: snap.seats[seat.id].status, party: who(s, snap.seats[seat.id].playerId, true) } : null,
      };
    },
  }),

  def({
    name: 'campaign',
    description: 'Hold ONE campaign action in a seat: type "rally" (the major rally: public, expensive, wide local spill-over fading over a few hundred km + a small effect everywhere; at most one per cooldown, otherwise RATE_LIMITED), "minorRally" (hidden, cheaper, a smaller local bell over a few seats, no global part, no cooldown) or "roadshow" (hidden, cheapest, strong effect in that seat only, no cooldown). Costs money immediately. The seat can be an id or a name. The server decides (seat must not be polled yet, you must have a candidate there or NOT_FIELDED, enough budget, rally cooldown over). Returns the remaining budget. To place many actions use campaign_batch.',
    schema: z.object({ type: actionType, seat: seatRef }),
    async run(s, i) {
      const r = await runCampaign(s, [{ type: i.type, seat: i.seat }]);
      const one = r.results[0];
      if (!one.ok) throw new AgentError((one.error?.code ?? 'INTERNAL') as never, one.error?.message ?? 'failed', one.error?.hint);
      return { ok: true, type: i.type, seat: one.seat, seat_name: one.seat_name, ...budgetView(s) };
    },
  }),

  def({
    name: 'campaign_batch',
    description: 'Place up to 50 campaign actions in ONE call, as fast as the server accepts them (pipelined). actions = [{type:"rally"|"minorRally"|"roadshow", seat:<id or name>}, ...]. Each action is pre-checked locally (budget in order, seat not polled, you have a candidate there, campaign window, rally cooldown) and then sent. Only ONE (major) rally per cooldown period can go through in a batch: if you are not ready, or after the first rally of the batch, later rallies are marked failed locally with RATE_LIMITED (nothing is charged, and they are not sent) while minor rallies and roadshows (no cooldown) are still sent. Put at most one major rally in a batch; the response lists per-action ok/error and your new budget. Failed actions cost nothing, EXCEPT a result with outcome_unknown:true (TIMEOUT): the server may still have applied it, so call get_state (budget, my_actions) before resending; never resend a rally blindly. The calls are sent a few at a time (HP_BATCH_CONCURRENCY, default 6), so a big batch against the AWS deployment takes a few seconds. Prefer this over many single calls.',
    schema: z.object({
      actions: z.array(z.object({ type: actionType, seat: seatRef })).min(1).max(50).describe('Up to 50 actions, executed in order'),
    }),
    async run(s, i) {
      const r = await runCampaign(s, i.actions);
      const okCount = r.results.filter((x) => x.ok).length;
      return { sent: okCount, failed: r.results.length - okCount, results: r.results, ...budgetView(s) };
    },
  }),

  def({
    name: 'field_candidates',
    description: 'PRE-CAMPAIGN ONLY (games with 3+ players): field a candidate of your party in each of the given seats (ids or names; {all:true} = every seat). A candidate costs money (get_state -> fielding.candidate_cost_wr) and is refunded in full if you withdraw_candidates before the deadline. You can only rally or roadshow in seats where you have a candidate, and a party with NO candidate when the pre-campaign ends is eliminated. Fielding is public and live (get_state fielding, get_seat candidates_here). Seats you already hold are skipped; if the batch costs more than your budget nothing is fielded (INSUFFICIENT_FUNDS). Money you do not spend here is your campaign budget. Fielding clears your done_fielding (call it again when finished). Refused outside the pre-campaign (WRONG_PHASE; a 2-player game has no pre-campaign, every seat is fielded for you). Returns how many were fielded/skipped, your budget and the time left.',
    schema: z.object({
      seats: z.array(seatRef).max(1000).optional().describe('Seats to field a candidate in (ids or names; at most the number of seats on the map)'),
      all: z.boolean().default(false).describe('Field a candidate in every seat you do not hold yet (instead of listing seats)'),
    }),
    async run(s, i) { return runFielding(s, 'field', i); },
  }),

  def({
    name: 'withdraw_candidates',
    description: 'PRE-CAMPAIGN ONLY (games with 3+ players): withdraw your candidate from each of the given seats (ids or names; {all:true} = every seat where you have one). The candidate price is refunded in full. Seats where you have no candidate are skipped. Remember: with no candidates at the end of the pre-campaign you are eliminated, and you cannot campaign in a seat you withdrew from. Withdrawing clears your done_fielding. Returns how many were withdrawn/skipped, your budget and the time left.',
    schema: z.object({
      seats: z.array(seatRef).max(1000).optional().describe('Seats to withdraw your candidate from (ids or names)'),
      all: z.boolean().default(false).describe('Withdraw from every seat where you have a candidate (you would be left with none)'),
    }),
    async run(s, i) { return runFielding(s, 'withdraw', i); },
  }),

  def({
    name: 'done_fielding',
    description: 'PRE-CAMPAIGN ONLY (games with 3+ players): tell everybody you have finished fielding (done defaults to true; {done:false} takes it back). When EVERY connected active party is done the campaign starts at once instead of waiting for the countdown, so call it as soon as you have fielded what you want. Fielding or withdrawing afterwards clears your done (call it again). If you do nothing the countdown still ends the phase. Refused with BAD_REQUEST while you have no candidate (field_candidates first), WRONG_PHASE outside the pre-campaign (a 2-player game has none), FORBIDDEN when eliminated. Returns who is still to finish ("n of m done") and the time left.',
    schema: z.object({
      done: z.boolean().default(true).describe('true = I am done fielding (default); false = take it back'),
    }),
    async run(s, i) { return runDoneFielding(s, i.done); },
  }),

  def({
    name: 'buy_report',
    description: 'Buy an analyst report. scope "seat" (needs seat id or name): ranks and estimated vote shares in that seat. scope "global": estimated seat counts per party (dearer). Reports show the position ~30 s ago and are noisy; prices rise during the campaign, by the second, so the quoted price may rise slightly before the server handles your purchase: the report shows the price actually paid (price_paid_wr) and get_state shows the current price. Returns the report (estimate +- margin, asOf) and your new budget. Reports can be switched off in a game (config): then this tool returns FORBIDDEN ("switched off") for that scope and charges nothing; get_state shows which are on.',
    schema: z.object({
      scope: z.enum(['seat', 'global']),
      seat: seatRef.optional().describe('Required for scope "seat"'),
    }),
    async run(s, i) {
      const reportCfg = i.scope === 'seat' ? s.cfg().analyst.seatReport : s.cfg().analyst.globalReport;
      if (!reportCfg.enabled) {
        throw new AgentError('FORBIDDEN', `Analyst ${i.scope} reports are switched off in this game.`, 'Nothing was charged. Do not try again: spend the budget on rallies and roadshows (get_state shows which reports are on sale).');
      }
      await campaignWindow(s);
      const cfg = s.cfg();
      const snap = s.client.state.snapshot!;
      let seatId: SeatId | undefined;
      let dir = await s.seatsOrNull();
      if (i.scope === 'seat') {
        if (i.seat === undefined) throw new AgentError('INVALID_INPUT', 'A seat report needs a seat (id or name).');
        seatId = (await seatOf(s, i.seat)).id;
        const e = precheckSeat(s, seatId, dir ? s.phaseMap(dir) : null);
        if (e) throw e;
      }
      const price = analystPrice(cfg, i.scope, snap.timeline!, s.client.serverNow());
      const have = currentBudget(s) ?? 0;
      if (have < price) throw new AgentError('INSUFFICIENT_FUNDS', `A ${i.scope} report costs about ${WR(cfg, price)} now but you have ${WR(cfg, have)}.`);
      const r = await s.client.buyReport(i.scope, seatId);
      dir = await s.seatsOrNull();
      return {
        report: reportView(s, r.report, dir),
        price_paid_wr: r.report.price,
        price_note: `Report prices rise by the second; you paid ${WR(cfg, r.report.price)} (about ${WR(cfg, price)} was quoted when you asked). The price now is slightly higher: see get_state budget.${i.scope}_report_price_now_wr.`,
        ...budgetView(s),
      };
    },
  }),

  def({
    name: 'get_global_reports',
    description: 'FREE (no budget cost, no limit): the news agencies global reports. Per agency (names from the config, e.g. Kal Tak, Toofan Express, Woof News, World Today): every party projected seats now (biggest first), the seat range [low, high] and the history of points since the campaign started. Noisy, and each agency errs differently; the error shrinks on average as the campaign goes on; the graphs freeze when the campaign ends. Not the paid analyst report. Needs the game to have started; returns FORBIDDEN when news agencies are switched off.',
    schema: z.object({}),
    readOnly: true,
    async run(s) {
      needAdmitted(s);
      if (!s.cfg().news.enabled) throw new AgentError('FORBIDDEN', 'News agency reports are switched off in this game.', 'Use get_state, get_news and the paid buy_report instead.');
      const snap = s.client.state.snapshot;
      if (!snap || snap.status === 'lobby' || !snap.timeline) throw new AgentError('WRONG_PHASE', 'The news agencies report from the campaign start.', 'Call wait_for_events with types ["status"], or get_state.');
      if (snap.status === 'preCampaign') throw new AgentError('WRONG_PHASE', 'The news agencies are not available in the pre-campaign: they report from the campaign start.', 'Field your candidates now (field_candidates), then wait_for_events with types ["status"].');
      return globalReportsView(s, await s.client.globalReports());
    },
  }),

  def({
    name: 'get_news',
    description: 'Public news: every major rally held so far by anyone (party, seat name, time). Major rallies are the only public campaign action (who has a candidate where is public too: see get_state / get_seat). Use since_cursor (the next_cursor of the previous call) to read only new items. Minor rallies and roadshows never appear here.',
    schema: z.object({
      since_cursor: z.number().int().min(0).default(0).describe('Number of news items already seen (use next_cursor from the last call)'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const dir = await s.seatsOrNull();
      const all = s.client.state.snapshot?.news ?? [];
      const slice = all.slice(i.since_cursor, i.since_cursor + i.limit);
      return {
        total: all.length,
        items: slice.map((n) => ({
          party: who(s, n.playerId, true), seat: n.seat, seat_name: dir?.name(n.seat) ?? `Seat ${n.seat}`, what: 'rally',
          seconds_ago: secs(s.client.serverNow() - n.ts),
        })),
        next_cursor: i.since_cursor + slice.length,
      };
    },
  }),

  def({
    name: 'wait_for_events',
    description: 'Long-poll for game events instead of polling get_state in a loop. Returns new events after since_cursor (default: after the events you already received from this tool) or an empty list after timeout_s (timeout_s max 60, default 25; call again on timeout). `types` filters (e.g. ["status"] or ["chat","offer"]; a bare comma-separated string also works). limit max 200. Event types: news (a major rally), phaseClosed, seatUpdate (counting declarations; excluded by default, ask for it via types), fielding (someone fielded / withdrew candidates in the pre-campaign, with the new contested_seats and majority; excluded by default, ask for it via types), fieldingDone (someone pressed or took back done_fielding, with done_count of needed; excluded by default, ask for it via types), chat, offer, government, result, status (preCampaign, campaign, counting ...), players, report, rematch (the host played again: you are already in the new game with your party, in the pre-campaign with 3+ players or the campaign with 2: call get_state), error. After the result keep calling this: the host may play again. Also returns next_cursor and a tiny state hint.',
    schema: z.object({
      since_cursor: z.number().int().min(0).optional().describe('Cursor from the previous call; omit to continue where this tool left off'),
      timeout_s: z.number().min(0).max(60).default(25),
      types: z.array(z.enum(EVENT_TYPES as unknown as [EventType, ...EventType[]])).optional().describe('Only these event types'),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const since = i.since_cursor ?? s.readCursor;
      const types = i.types ?? EVENT_TYPES.filter((t) => t !== 'seatUpdate' && t !== 'fielding' && t !== 'fieldingDone');
      const r = await s.client.waitForEvents(since, i.timeout_s * 1000, types, i.limit);
      s.readCursor = r.cursor;
      const dir = await s.seatsOrNull();
      const st = s.client.state;
      const tl = st.snapshot?.timeline;
      const now = s.client.serverNow();
      const cur = tl ? tl.phaseCloses.findIndex((t) => t > now) : -1;
      return {
        events: r.events.map((e) => eventView(s, e, dir)),
        next_cursor: r.cursor,
        timed_out: r.timedOut,
        hint_state: {
          status: st.snapshot?.status ?? null,
          connection: st.link,
          budget: currentBudget(s),
          ...stageInfo(st.snapshot?.status, tl, now),
          phase_left_s: tl && st.snapshot?.status === 'campaign' && cur >= 0 ? secs(tl.phaseCloses[cur] - now) : stageInfo(st.snapshot?.status, tl, now).stage_left_s,
        },
      };
    },
  }),

  def({
    name: 'chat',
    description: 'Send a chat message (only in games with 3+ players; chat opens with the pre-campaign and stays open through the campaign, counting and post-counting). Which chat depends on the stage (the pre-campaign, counting and post-counting are always one-to-one; config Chat.Campaigning decides the campaign: by default ONE group chat - see `chat_mode` in get_state). Use the pre-campaign chat to agree with other parties who stands where and to form informal alliances. GROUP: just give `text`, everyone in the game reads it (`to` is ignored); write "@Party name" to tag a party, which notifies them. INDV (one-to-one): `to` = recipient party names or ids (or ["all"]); each recipient gets a private copy that only you and they see. Government offers are separate (propose_government).',
    schema: z.object({
      to: z.array(z.string().min(1)).min(1).optional().describe('One-to-one chats: recipients (party names / ids, or ["all"]). Ignored in the group chat.'),
      text: z.string().min(1).max(500),
    }),
    async run(s, i) {
      needAdmitted(s);
      const st = s.client.state;
      const status = st.snapshot?.status;
      const contenders = s.players().filter((p) => ['active', 'disconnected', 'eliminated'].includes(p.status));
      if (contenders.length < 3) throw new AgentError('NEGOTIATION_DISABLED', 'With 2 players there is no chat.');
      const mode = chatModeFor(s.cfg(), status);
      if (!mode && (status === 'finished' || status === 'abandoned')) throw new AgentError('WRONG_PHASE', 'The game is over: the chat is closed.');
      if (!mode) throw new AgentError('WRONG_PHASE', status === 'campaign' || s.cfg().chat.campaigning === 'OFF' ? 'Chat opens when counting starts.' : 'Chat opens when the game starts (with the pre-campaign).');
      const others = contenders.filter((p) => p.playerId !== s.client.me && p.status !== 'eliminated');
      if (mode === 'INDV' && !i.to) throw new AgentError('INVALID_INPUT', 'Chats are one-to-one now: give `to` (party names, or ["all"] for a private copy to each party).');
      const ids = new Set<string>();
      for (const ref of i.to ?? ['all']) {
        if (/^(all|everyone|everybody)$/i.test(ref.trim())) others.forEach((p) => ids.add(p.playerId));
        else ids.add(resolvePlayer(contenders, ref, s.client.me).playerId);
      }
      ids.delete(s.client.me as string);
      if (!ids.size) throw new AgentError('INVALID_INPUT', 'Choose at least one other player.');
      const m = await s.client.chat([...ids], i.text);
      return { sent: true, chat_mode: mode, message: chatView(s, m), ...(mode === 'INDV' ? { sent_to: namesOf(s, [...ids]) } : {}) };
    },
  }),

  def({
    name: 'get_chat',
    description: 'Read the chat messages you can see (the whole group chat by default, or the private threads you are part of). Use since_cursor (next_cursor from the last call) to read only new ones.',
    schema: z.object({ since_cursor: z.number().int().min(0).default(0).describe('Number of messages already read') }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      const all = s.client.state.chat;
      return { messages: all.slice(i.since_cursor).map((m) => chatView(s, m)), next_cursor: all.length };
    },
  }),

  def({
    name: 'propose_government',
    description: 'Propose a coalition government (counting / post-counting, 3+ players). YOU are the Prime Minister. portfolios maps portfolio id -> list of party names (or player ids): e.g. {"DPM":["Blue Wave","Green Front"],"HOME":["Blue Wave"],"FINANCE":["Green Front"]}. PM defaults to you. Portfolio ids: PM, DPM (max 2), HOME, DEFENCE, FINANCE, EXTERNAL, SPEAKER (1 each). Every named player must accept (respond_offer). A government is confirmed ONLY once every seat is declared (the end of counting) and the members\' WON seats then reach the majority; the game then ends immediately with the result (during counting accepted offers just wait). A government can never include every party: at least one party must stay out (INVALID_GOVERNMENT otherwise). Offers are private (only the proposer and the named parties see them). `partners` optionally lists extra parties whose acceptance is required even without a portfolio. A new proposal supersedes your previous one.',
    schema: z.object({
      portfolios: z.record(z.union([z.string(), z.array(z.string())])).describe('Portfolio id -> party name or list of party names'),
      partners: z.array(z.string()).optional(),
    }),
    async run(s, i) {
      needAdmitted(s);
      const cfg = s.cfg();
      const status = s.client.state.snapshot?.status;
      const contenders = s.players().filter((p) => ['active', 'disconnected', 'eliminated'].includes(p.status));
      if (contenders.length < 3) throw new AgentError('NEGOTIATION_DISABLED', 'With 2 players there are no coalition offers.');
      if (status !== 'counting' && status !== 'postCounting') throw new AgentError('WRONG_PHASE', 'Coalition talks open when counting starts.');
      const pf: PortfolioAssignment = {};
      for (const [k, v] of Object.entries(i.portfolios)) {
        const id = resolvePortfolio(cfg.points.portfolios, k);
        const refs = Array.isArray(v) ? v : [v];
        pf[id] = [...new Set(refs.map((r) => resolvePlayer(contenders, r, s.client.me).playerId))];
      }
      const me = s.client.me as string;
      if (!pf.PM) pf.PM = [me];
      if (pf.PM.length !== 1 || pf.PM[0] !== me) throw new AgentError('INVALID_GOVERNMENT', 'The proposer (you) must be the Prime Minister.');
      const partners = i.partners ? [...new Set(i.partners.map((r) => resolvePlayer(contenders, r, me).playerId))] : undefined;
      const offer = await s.client.proposeGovernment(pf, partners);
      return { proposed: true, offer: offerView(s, offer) };
    },
  }),

  def({
    name: 'respond_offer',
    description: 'Accept or decline a coalition offer addressed to you (offer_id from list_offers / an "offer" event). Accepting commits you to that offer only (it withdraws any earlier acceptance); the government is confirmed only once every seat is declared (end of counting) and then the game ends immediately. Declining kills the whole offer (declined_by shows who). offer_id may be a unique prefix.',
    schema: z.object({ offer_id: z.string().min(1), accept: z.boolean() }),
    async run(s, i) {
      needAdmitted(s);
      const offer = resolveOffer(s, i.offer_id);
      const me = s.client.me as string;
      if (offer.proposer === me) throw new AgentError('INVALID_INPUT', 'You proposed this offer; use withdraw_offer to cancel it.');
      if (i.accept && offer.accepted.includes(me)) return { ok: true, note: 'You had already accepted this offer.', offer: offerView(s, offer) };
      const r = await s.client.respondOffer(offer.offerId, i.accept);
      const cur = (s.client.state.snapshot?.offers ?? []).find((o) => o.offerId === offer.offerId) ?? r ?? offer;
      return { ok: true, you: i.accept ? 'accepted' : 'declined', offer: offerView(s, cur) };
    },
  }),

  def({
    name: 'withdraw_offer',
    description: 'Withdraw a coalition offer that YOU proposed. offer_id is optional: without it your newest open/accepted offer is withdrawn (OFFER_NOT_FOUND when you have none); a unique id prefix works too.',
    schema: z.object({ offer_id: z.string().min(1).optional().describe('Offer id or unique prefix; default = your newest open/accepted offer') }),
    async run(s, i) {
      needAdmitted(s);
      const me = s.client.me as string;
      let offer: CoalitionOffer;
      if (i.offer_id) offer = resolveOffer(s, i.offer_id);
      else {
        const mine = (s.client.state.snapshot?.offers ?? []).filter((o) => o.proposer === me && (o.status === 'open' || o.status === 'accepted'));
        if (!mine.length) throw new AgentError('OFFER_NOT_FOUND', 'You have no open or accepted offer to withdraw.');
        offer = mine.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
      }
      if (offer.proposer !== me) throw new AgentError('INVALID_INPUT', 'You can only withdraw an offer you proposed (use respond_offer to decline one addressed to you).');
      const r = await s.client.withdrawOffer(offer.offerId);
      return { ok: true, offer: offerView(s, r) };
    },
  }),

  def({
    name: 'list_offers',
    description: 'List the coalition offers you proposed or were named in (offers are private: you never see other parties\' offers), with status (open, accepted, declined, withdrawn, superseded, formed), who accepted, who is still awaited (open/accepted only), declined_by / superseded_by, and a note. A government is confirmed only once every seat is declared (end of counting); the game then ends immediately.',
    schema: z.object({ only_active: z.boolean().default(false).describe('Hide declined / withdrawn / superseded offers') }),
    readOnly: true,
    async run(s, i) {
      needJoined(s);
      let offers = s.client.state.snapshot?.offers ?? [];
      if (i.only_active) offers = offers.filter((o) => o.status === 'open' || o.status === 'accepted');
      const snap = s.client.state.snapshot;
      return {
        offers: offers.map((o) => offerView(s, o)),
        government: snap?.government ? governmentView(s, snap.government) : null,
        tally: snap?.tally ? { declared_won: snap.tally.declared, of: snap.tally.total, majority: majorityNow(s), by_party: winsByName(s) } : null,
      };
    },
  }),

  def({
    name: 'leave_game',
    description: 'Disconnect from the game and forget the session. WARNING: if the game is running, you are eliminated after the grace period (about 90 s) and your progress is lost. Only call this when you really want to stop playing. Do NOT call it after the result or on a rematch event: the host may play again and you roll over automatically.',
    schema: z.object({}),
    async run(s) {
      const was = s.client.session?.gameId ?? null;
      s.client.reset();
      s.clearPersisted();
      s.readCursor = s.client.events.cursor;
      return { left: was !== null, game_id: was, warning: 'If the game was running, you will be eliminated after the grace period and cannot rejoin.' };
    },
  }),
];

export const ACTION_BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

// ------------------------------------------------------------------ pre-campaign: field / withdraw candidates
/** Checks shared by the pre-campaign tools: a started game, a pre-campaign at all (3+ players), still running, me not eliminated. */
function preCampaignGuard(s: AgentSession, tool: string, doing: string) {
  const c = s.client;
  const snap = c.state.snapshot;
  const status = snap?.status ?? 'lobby';
  const tl = snap?.timeline;
  if (status === 'lobby' || !tl) throw new AgentError('WRONG_PHASE', 'The game has not started yet (only the human host can start it).', 'Call wait_for_events with types ["status"], or get_state.');
  if (status !== 'preCampaign') {
    if (status === 'campaign' && tl.preCampaignEnd === undefined) {
      throw new AgentError('WRONG_PHASE', `${tool} is not available: a 2-player game has no pre-campaign. A candidate was fielded in every seat for you and charged at the start.`, 'Go straight to campaign_batch (get_state shows your budget).');
    }
    throw new AgentError('WRONG_PHASE', `${tool} is only possible during the pre-campaign, which is over: the line-up is fixed.`,
      status === 'campaign' ? 'Campaign in your fielded seats (list_seats {open_only:true, fielded_only:true}) with campaign_batch.' : 'Call get_state to see the current phase.');
  }
  if (c.state.snapshot?.players.find((p) => p.playerId === c.me)?.status === 'eliminated') {
    throw new AgentError('FORBIDDEN', `You are eliminated, so you cannot ${doing}.`, 'You can still read the chat. Keep calling wait_for_events: the host may play again.');
  }
  const left = tl.preCampaignEnd !== undefined ? tl.preCampaignEnd - c.serverNow() : null;
  if (left !== null && left <= 0) throw new AgentError('TOO_LATE', 'The pre-campaign deadline has passed.', 'Call get_state: the campaign is about to start (if you had no candidate you are eliminated).');
  return { tl, left };
}

async function runFielding(s: AgentSession, kind: 'field' | 'withdraw', input: { seats?: (number | string)[]; all: boolean }) {
  needAdmitted(s);
  const cfg = s.cfg();
  const c = s.client;
  const snap = c.state.snapshot;
  const tool = kind === 'field' ? 'field_candidates' : 'withdraw_candidates';
  const { tl } = preCampaignGuard(s, tool, 'field or withdraw candidates');

  // which seats
  let ids: SeatId[];
  if (input.all) {
    if (input.seats?.length) throw new AgentError('INVALID_INPUT', 'Give either seats or all:true, not both.');
    ids = Array.from({ length: cfg.seatCount }, (_, k) => k + 1);
  } else {
    if (!input.seats?.length) throw new AgentError('INVALID_INPUT', `${tool} needs seats (a list of seat ids or names) or all:true.`);
    if (input.seats.length > cfg.seatCount) throw new AgentError('INVALID_INPUT', `At most ${cfg.seatCount} seats (the number of seats on the map); got ${input.seats.length}.`);
    ids = [];
    for (const ref of input.seats) {
      const id = (await seatOf(s, ref)).id;
      if (!Number.isInteger(id) || id < 1 || id > cfg.seatCount) throw new AgentError('UNKNOWN_SEAT', `Seat ${id} does not exist in this game (1..${cfg.seatCount}).`);
      ids.push(id);
    }
  }
  ids = [...new Set(ids)];
  const mine = new Set<SeatId>(Object.entries(snap?.fielding ?? {}).filter(([, list]) => list.some((x) => x.playerId === c.me)).map(([k]) => Number(k)));
  const todo = ids.filter((id) => (kind === 'field' ? !mine.has(id) : mine.has(id)));
  const budget = currentBudget(s) ?? 0;
  const price = cfg.costs.candidate;

  let changed = 0;
  let serverSkipped = 0;
  if (todo.length) {
    if (kind === 'field' && price * todo.length > budget) {
      const fit = price > 0 ? Math.floor(budget / price) : todo.length;
      throw new AgentError('INSUFFICIENT_FUNDS', `${todo.length} candidates cost ${WR(cfg, price * todo.length)} (${WR(cfg, price)} each) but you have ${WR(cfg, budget)}: at most ${fit} more. Nothing was fielded.`,
        `Field at most ${fit} seats in one call (all or nothing), or withdraw_candidates from seats you do not need first. Remember what you do not spend here is your campaign budget.`);
    }
    const r = kind === 'field' ? await c.fieldCandidates(todo) : await c.withdrawCandidates(todo);
    changed = kind === 'field' ? r.added.length : r.removed.length;
    serverSkipped = todo.length - changed;
  }
  const sum = fieldingSummary(s);
  const skipped = ids.length - todo.length + serverSkipped;
  const leftS = tl.preCampaignEnd !== undefined ? secs(tl.preCampaignEnd - c.serverNow()) : null;
  const now = currentBudget(s) ?? 0;
  const hint = sum.your_candidates === 0
    ? 'You have NO candidates: field at least one before the deadline or you are eliminated.'
    : kind === 'field' ? 'Field more, or chat one-to-one to agree who stands where; what you do not spend is your campaign budget.' : 'Fielded seats can be re-added until the deadline.';
  return {
    ok: true,
    ...(kind === 'field' ? { fielded: changed } : { withdrawn: changed, refunded_wr: changed * price }),
    skipped,
    skipped_note: skipped ? (kind === 'field' ? 'Seats where you already have a candidate are skipped (nothing charged).' : 'Seats where you have no candidate are skipped.') : undefined,
    your_candidates: sum.your_candidates,
    budget_wr: now,
    candidate_cost_wr: price,
    pre_campaign_left_s: leftS,
    contested_seats: sum.contested_seats,
    majority: sum.majority,
    hint,
  };
}

async function runDoneFielding(s: AgentSession, done: boolean) {
  needAdmitted(s);
  const c = s.client;
  const { tl } = preCampaignGuard(s, 'done_fielding', 'say you are done fielding');
  const mine = fieldedCounts(s).get(c.me ?? '') ?? 0;
  if (done && mine === 0) {
    throw new AgentError('BAD_REQUEST', 'You have no candidate yet, so you cannot be done fielding.',
      'Field at least one candidate first (field_candidates {seats:[...]} or {all:true}), then call done_fielding. With no candidate when the pre-campaign ends you are eliminated.');
  }
  const r = await c.doneFielding(done);
  const dp = doneProgress(s);
  const waiting = s.players().filter((p) => p.status === 'active' && !dp.doneIds.includes(p.playerId)).map((p) => who(s, p.playerId));
  const leftS = tl.preCampaignEnd !== undefined ? secs(tl.preCampaignEnd - c.serverNow()) : null;
  return {
    ok: true,
    done: r.done,
    done_count: r.doneCount,
    needed: r.needed,
    progress: `${r.doneCount} of ${r.needed} done`,
    waiting_for: waiting,
    your_candidates: mine,
    pre_campaign_left_s: leftS,
    hint: r.done
      ? (r.doneCount >= r.needed ? 'Everybody is done: the campaign starts now (get_state, then campaign_batch).'
        : 'You are done. The campaign starts as soon as everybody is done, or when the countdown ends. Fielding or withdrawing again clears your done; done_fielding {done:false} takes it back.')
      : 'You are no longer done. Field or withdraw as you like, then call done_fielding again.',
  };
}

// ------------------------------------------------------------------ campaign implementation
interface CampaignRow {
  index: number; type: ActionType; seat: number | null; seat_name: string | null; ok: boolean; error?: ErrorInfo & { local?: boolean };
  /** true on a TIMEOUT: the server may or may not have applied (and charged) this action. Check get_state before resending. */
  outcome_unknown?: true;
}

async function runCampaign(s: AgentSession, list: { type: ActionType; seat: number | string }[]): Promise<{ results: CampaignRow[] }> {
  await campaignWindow(s);
  const cfg = s.cfg();
  const dir = await s.seatsOrNull();
  const phaseOf = dir ? s.phaseMap(dir) : null;
  let budget = currentBudget(s) ?? 0;
  let rallyAt = rallyReadyAt(s); // server-clock ms when the next rally may go through (updated as rallies are queued)
  const serverNow = s.client.serverNow();
  const results: CampaignRow[] = [];
  const toSend: { idx: number; type: ActionType; seat: number }[] = [];
  list.forEach((a, index) => {
    let row: CampaignRow = { index, type: a.type, seat: null, seat_name: null, ok: false };
    try {
      let id: number; let name: string;
      if (dir) { const seat = dir.resolve(a.seat); id = seat.id; name = seat.name; }
      else {
        id = typeof a.seat === 'number' ? a.seat : Number(a.seat);
        if (!Number.isInteger(id)) throw new AgentError('NO_MAP', 'Seat names are unavailable; use numeric seat ids.');
        name = `Seat ${id}`;
      }
      row = { ...row, seat: id, seat_name: name };
      const e = precheckSeat(s, id, phaseOf);
      if (e) throw e;
      if (iHaveCandidate(s, id) === false) {
        throw new AgentError('NOT_FIELDED', `You have no candidate in ${name} (seat ${id}), so you cannot ${a.type === 'minorRally' ? 'hold a minor rally' : a.type === 'rally' ? 'rally' : 'hold a roadshow'} there. Not sent, nothing charged.`,
          'Candidates were fielded in the pre-campaign and the line-up is now fixed. Use list_seats {open_only:true, fielded_only:true} to pick seats where you do have a candidate.');
      }
      const cost = cfg.costs[a.type];
      if (budget < cost) throw new AgentError('INSUFFICIENT_FUNDS', `Not enough budget for a ${a.type} (${WR(cfg, cost)}); ${WR(cfg, budget)} left after the earlier actions in this call.`);
      if (a.type === 'rally') {
        if (serverNow < rallyAt) {
          const wait = Math.ceil((rallyAt - serverNow) / 1000);
          throw new AgentError('RATE_LIMITED', `Rally cooldown: only one rally per ${Math.round(cfg.cooldowns.rallyMs / 1000)} s. Not sent, nothing charged. Next rally possible in ${wait} s (or in a later call); roadshows are not limited.`,
            `Wait ${wait} s, then rally again. You can still place roadshows now.`);
        }
        rallyAt = serverNow + cfg.cooldowns.rallyMs;
      }
      budget -= cost;
      toSend.push({ idx: index, type: a.type, seat: id });
      row.ok = true; // provisional
    } catch (e) {
      const info = toErrorInfo(e);
      row.ok = false;
      row.error = { ...info, local: true };
    }
    results.push(row);
  });
  if (toSend.length) {
    const out = await s.client.campaignBatch(toSend.map((t) => ({ type: t.type, seat: t.seat })));
    out.forEach((r, k) => {
      const row = results[toSend[k].idx];
      if (r.ok) row.ok = true;
      else {
        row.ok = false; row.error = toErrorInfo(r.error);
        if (r.unknown) {
          row.outcome_unknown = true;
          row.error = { ...row.error, hint: 'No answer in time: the server MAY have applied and charged this. Do NOT resend blindly (a rally costs a lot); call get_state and compare budget / my_actions first.' };
        }
      }
    });
  }
  return { results };
}

// ------------------------------------------------------------------ execution wrapper (never throws)
export type ActionResult = { ok: true; data: unknown } | { ok: false; error: ErrorInfo };

export async function executeAction(s: AgentSession, name: string, rawInput: unknown): Promise<ActionResult> {
  await s.maybeRestore().catch(() => undefined);
  const a = ACTION_BY_NAME.get(name);
  if (!a) {
    return { ok: false, error: toErrorInfo(new AgentError('UNKNOWN_ACTION', `Unknown action "${name}". Valid: ${ACTIONS.map((x) => x.name).join(', ')}.`)) };
  }
  const parsed = a.schema.safeParse(coerceArrays(a.schema, rawInput ?? {}));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return { ok: false, error: toErrorInfo(new AgentError('INVALID_INPUT', `Invalid input for ${name}: ${msg}`, `Expected fields: ${describeFields(a)}`)) };
  }
  try {
    return { ok: true, data: await a.run(s, parsed.data) };
  } catch (e) {
    if (!(e instanceof AgentError)) console.error(`[hung-parliament] action ${name} crashed:`, e);
    return { ok: false, error: toErrorInfo(e) };
  }
}

const unwrapZod = (t: any): any => {
  while (t?._def && ['ZodOptional', 'ZodDefault', 'ZodNullable'].includes(t._def.typeName)) t = t._def.innerType;
  return t;
};

/** "a,b" / "[a, b]" / '["a","b"]' -> ["a","b"] */
export function splitList(v: string): string[] {
  return v.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map((x) => x.trim().replace(/^["'`]+|["'`]+$/g, '').trim()).filter(Boolean);
}

/**
 * Shells and key=value arguments deliver arrays as bare strings (types=status, to=all, partners=a,b): turn a string for an
 * array-typed field into an array BEFORE validation. (Deliberately not z.preprocess: schema.ts has no ZodEffects support.)
 */
export function coerceArrays(schema: z.ZodObject<z.ZodRawShape>, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [k, t] of Object.entries(schema.shape)) {
    const v = out[k];
    if (typeof v !== 'string') continue;
    const arr = unwrapZod(t);
    if (arr?._def?.typeName !== 'ZodArray') continue;
    if (unwrapZod(arr._def.type)?._def?.typeName === 'ZodObject') {
      try { const j = JSON.parse(v); if (Array.isArray(j)) out[k] = j; } catch { /* leave it for the validator */ }
    } else out[k] = splitList(v);
  }
  return out;
}

function describeFields(a: ActionDef): string {
  const shape = a.schema.shape;
  const keys = Object.keys(shape);
  return keys.length ? keys.map((k) => `${k}${shape[k].isOptional() ? '?' : ''}`).join(', ') : '(none)';
}

/** Text for an LLM: strings as-is (get_rules), JSON otherwise, errors as "ERROR CODE: message + Hint". */
export function formatResultText(r: ActionResult): string {
  if (!r.ok) return `ERROR ${r.error.code}: ${r.error.message}${r.error.hint ? `\nHint: ${r.error.hint}` : ''}`;
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
}
