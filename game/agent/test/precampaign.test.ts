// Pre-campaign and minor rally, as the agent sees them (offline, against a fake session; the real server is in integration.test.ts).
// Rules under test: with 3+ players a timed pre-campaign comes first; a party fields candidates (field_candidates / withdraw_candidates,
// public and live, refunded on withdrawal); no candidate at the deadline = eliminated; campaign actions are only possible in seats where
// the party has a candidate (NOT_FIELDED); the minor rally is a hidden, cooldown-free campaign action; a 2-player game has no pre-campaign.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORLD_CONFIG, fullyFieldedBudget, majorityOf } from '@hp/shared';
import type { PlayerPublic, ServerMessage } from '@hp/shared';
import { ACTIONS, ACTION_BY_NAME } from '../src/actions';
import { GameClient } from '../src/client';
import { AgentError } from '../src/errors';
import { createMcpServer, PLAY_PROMPT, SERVER_INSTRUCTIONS } from '../src/mcp';
import { renderRules, rulesTemplate, rulesValues } from '../src/rules';
import type { AgentSession } from '../src/session';
import { EVENT_TYPES, applyMessage, changeFielding, newState } from '../src/state';
import { currentBudget, stageInfo } from '../src/views';
import { P, err, fakeSession, ok, players4, seatDir } from './fake';
import type { FakeOpts } from './fake';
import type { SeatDirectory } from '../src/resolve';
import { enableReportsForFile } from './reportsFlag';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = WORLD_CONFIG;
const price = cfg.costs.candidate;
enableReportsForFile();
let dir: SeatDirectory;
const newsWas = cfg.news.enabled;
beforeAll(async () => { dir = await seatDir(); cfg.news.enabled = true; });
afterAll(() => { cfg.news.enabled = newsWas; });
const mk = (o: FakeOpts = {}) => fakeSession(dir, o);
const pre = (o: FakeOpts = {}) => mk({ preCampaign: true, ...o });
const push = (s: AgentSession, m: ServerMessage) => { for (const e of applyMessage(s.client.state, m, Date.now())) s.client.events.push(e.type, e.data, Date.now()); };
const cand = (playerId: string, seat: number) => ({ playerId, name: `Candidate ${seat}` });

// ------------------------------------------------------------------ state: messages
describe('state: fielding messages', () => {
  it('a fieldingUpdate adds and removes a player\'s candidates, carries the new contested seats and majority, and is logged as a fielding event', () => {
    const { s } = pre();
    push(s, { type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 7, name: 'Asha K' }, { seat: 8 }], removed: [], contestedSeats: 2, majority: 2 });
    const snap = s.client.state.snapshot!;
    expect(snap.fielding[7]).toEqual([{ playerId: 'c', name: 'Asha K' }]);
    expect(snap.fielding[8]).toEqual([{ playerId: 'c' }]);
    expect([snap.contestedSeats, snap.majority]).toEqual([2, 2]);
    push(s, { type: 'fieldingUpdate', playerId: 'c', added: [], removed: [8], contestedSeats: 1, majority: 1 });
    expect(s.client.state.snapshot!.fielding[8]).toBeUndefined();
    expect(s.client.state.snapshot!.contestedSeats).toBe(1);
    expect(s.client.events.since(0, { types: ['fielding'] }).events.map((e) => e.data.contestedSeats)).toEqual([2, 1]);
  });

  it('applying the same change twice does not duplicate a candidate (fieldAck and fieldingUpdate carry the same news)', () => {
    const f = changeFielding({}, 'me', [{ seat: 3, name: 'X' }], []);
    expect(changeFielding(f, 'me', [{ seat: 3, name: 'X' }], [])[3]).toHaveLength(1);
    expect(changeFielding(f, 'c', [{ seat: 3 }], [])[3]).toHaveLength(2);
    expect(changeFielding(f, 'me', [], [3])[3]).toBeUndefined();
  });

  it('a fieldAck sets the budget and my candidates; it is not an event of its own', () => {
    const { s } = pre();
    push(s, { type: 'fieldAck', ok: true, budget: 1234, added: [{ seat: 5, name: 'N' }], removed: [] });
    expect(s.client.state.priv!.budget).toBe(1234);
    expect(s.client.state.snapshot!.fielding[5]).toEqual([{ playerId: 'me', name: 'N' }]);
    expect(s.client.events.cursor).toBe(0);
  });

  it('the fielding event type exists and the status flip to preCampaign from the lobby waits for the budget update', () => {
    expect(EVENT_TYPES).toContain('fielding');
    const { s } = mk({ status: 'lobby', budget: 0 });
    push(s, { type: 'status', status: 'preCampaign', timeline: { preCampaignEnd: Date.now() + 90_000, campaignStart: Date.now() + 95_000, phaseCloses: [Date.now() + 200_000], campaignEnd: Date.now() + 200_000, countingEnd: Date.now() + 260_000, postCountingEnd: Date.now() + 300_000 } });
    expect(s.client.state.budgetPending).toBe(true);
    expect(currentBudget(s)).toBe(cfg.budget); // the whole budget: candidates are paid out of it
    push(s, { type: 'private', private: { you: 'me', budget: cfg.budget, myActions: [], myReports: [] } });
    expect(s.client.state.budgetPending).toBe(false);
  });

  it('the flip from preCampaign to campaign never makes a spent (or eliminated) budget of 0 look like a gap', () => {
    const { s } = pre({ budget: 0 });
    push(s, { type: 'status', status: 'campaign', timeline: s.client.state.snapshot!.timeline! });
    expect(s.client.state.budgetPending).toBe(false);
    expect(currentBudget(s)).toBe(0);
  });

  it('a 2-player game has no pre-campaign: the lobby-to-campaign gap shows what is left after a candidate in every seat', () => {
    const { s } = mk({ status: 'lobby', budget: 0 });
    push(s, { type: 'status', status: 'campaign', timeline: s.client.state.snapshot!.timeline! });
    expect(currentBudget(s)).toBe(fullyFieldedBudget(cfg));
  });
});

// ------------------------------------------------------------------ client: field / withdraw over the socket
describe('client: fieldCandidates / withdrawCandidates', () => {
  function client() {
    const c = new GameClient({ server: 'http://x' });
    c.session = { server: 'http://x', gameId: 'g', playerId: 'me', token: 't' };
    c.state.me = 'me';
    const sent: any[] = [];
    (c as any).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
    const deliver = (m: ServerMessage) => (c as any).handle(m);
    return { c, sent, deliver };
  }

  it('sends one field message with a clientRef and resolves with the server\'s fieldAck (budget, what was added)', async () => {
    const { c, sent, deliver } = client();
    const p = c.fieldCandidates([1, 2]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'field', seats: [1, 2] });
    expect(typeof sent[0].clientRef).toBe('string');
    deliver({ type: 'fieldAck', clientRef: sent[0].clientRef, ok: true, budget: 900, added: [{ seat: 1, name: 'A' }], removed: [] });
    expect(await p).toEqual({ budget: 900, added: [{ seat: 1, name: 'A' }], removed: [] });
  });

  it('withdraw sends the withdraw action; a duplicate ack is flagged', async () => {
    const { c, sent, deliver } = client();
    const p = c.withdrawCandidates([4]);
    expect(sent[0]).toMatchObject({ action: 'withdraw', seats: [4] });
    deliver({ type: 'fieldAck', clientRef: sent[0].clientRef, duplicate: true, ok: true, budget: 5, added: [], removed: [4] });
    expect(await p).toMatchObject({ removed: [4], duplicate: true });
  });

  it('a server error with the same clientRef rejects with that code (INSUFFICIENT_FUNDS, WRONG_PHASE ...)', async () => {
    const { c, sent, deliver } = client();
    const p = c.fieldCandidates([1]);
    deliver({ type: 'error', error: 'INSUFFICIENT_FUNDS', message: 'too dear', clientRef: sent[0].clientRef });
    await expect(p).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('a timeout says the server may have applied it and that repeating is safe', async () => {
    const { c } = client();
    const e = (await c.fieldCandidates([1], 20).catch((x: unknown) => x)) as AgentError;
    expect(e.code).toBe('TIMEOUT');
    expect(e.hint).toMatch(/safe to repeat/);
  });

  it('without a connection it fails fast', async () => {
    const c = new GameClient({ server: 'http://x' });
    c.session = { server: 'http://x', gameId: 'g', playerId: 'me', token: 't' };
    await expect(c.fieldCandidates([1])).rejects.toMatchObject({ code: 'NO_CONNECTION' });
  });
});

// ------------------------------------------------------------------ field_candidates / withdraw_candidates
describe('field_candidates', () => {
  it('fields the seats (ids or names), reports fielded / skipped, the budget after paying, the time left and the majority', async () => {
    const { s, c, calls } = pre();
    const name = dir.name(2);
    const r = await ok(s, 'field_candidates', { seats: [1, name, 3] });
    expect(calls.field[0][0]).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ ok: true, fielded: 3, skipped: 0, your_candidates: 3, candidate_cost_wr: price, contested_seats: 3, majority: majorityOf(3) });
    expect(r.budget_wr).toBe(cfg.budget - 3 * price);
    expect(r.pre_campaign_left_s).toBeGreaterThan(80);
    expect(c.state.priv!.budget).toBe(cfg.budget - 3 * price);
  });

  it('skips seats already fielded without sending them (and sends nothing when nothing is left to do)', async () => {
    const { s, calls } = pre({ fielding: { 1: [cand('me', 1)] } });
    const r = await ok(s, 'field_candidates', { seats: [1, 2, 2] });
    expect(calls.field[0][0]).toEqual([2]);
    expect(r).toMatchObject({ fielded: 1, skipped: 1 });
    const again = await ok(s, 'field_candidates', { seats: [1, 2] });
    expect(calls.field).toHaveLength(1);
    expect(again).toMatchObject({ fielded: 0, skipped: 2, budget_wr: cfg.budget - price }); // only seat 2 was ever charged here
    expect(again.skipped_note).toMatch(/already have a candidate/);
  });

  it('all:true fields every seat of the map; seats and all together, or neither, are INVALID_INPUT; more seats than the map has is refused', async () => {
    const { s, calls } = pre();
    const r = await ok(s, 'field_candidates', { all: true });
    expect(calls.field[0][0]).toHaveLength(cfg.seatCount);
    expect(r.fielded).toBe(cfg.seatCount);
    expect(r.budget_wr).toBe(fullyFieldedBudget(cfg));
    const t = pre();
    expect((await err(t.s, 'field_candidates', { all: true, seats: [1] })).code).toBe('INVALID_INPUT');
    expect((await err(t.s, 'field_candidates', {})).code).toBe('INVALID_INPUT');
    expect((await err(t.s, 'field_candidates', { seats: [] })).code).toBe('INVALID_INPUT');
    expect((await err(t.s, 'field_candidates', { seats: Array.from({ length: cfg.seatCount + 1 }, (_, k) => k + 1) })).message).toMatch(new RegExp(`At most ${cfg.seatCount} seats`));
    expect((await err(t.s, 'field_candidates', { seats: [cfg.seatCount + 1] })).code).toBe('UNKNOWN_SEAT');
    expect((await err(t.s, 'field_candidates', { seats: ['Atlantis'] })).code).toBe('UNKNOWN_SEAT');
    expect(t.calls.field).toBeUndefined();
  });

  it('refuses a batch the budget cannot pay for as a whole (INSUFFICIENT_FUNDS, nothing sent) and says how many fit', async () => {
    const { s, calls } = pre({ budget: price * 2 + 1 });
    const e = await err(s, 'field_candidates', { seats: [1, 2, 3] });
    expect(e.code).toBe('INSUFFICIENT_FUNDS');
    expect(e.message).toMatch(/at most 2 more/);
    expect(e.hint).toMatch(/withdraw_candidates/);
    expect(calls.field).toBeUndefined();
  });

  it('is refused outside the pre-campaign: lobby, campaign, a 2-player game (no pre-campaign at all), an eliminated player, after the deadline', async () => {
    const lobby = mk({ status: 'lobby' });
    expect((await err(lobby.s, 'field_candidates', { seats: [1] })).code).toBe('WRONG_PHASE');
    const camp = pre({ status: 'campaign' });
    camp.c.state.snapshot!.timeline = { ...camp.c.state.snapshot!.timeline!, preCampaignEnd: Date.now() - 5000 };
    const e1 = await err(camp.s, 'field_candidates', { seats: [1] });
    expect(e1.code).toBe('WRONG_PHASE');
    expect(e1.message).toMatch(/pre-campaign, which is over/);
    const two = mk(); // campaign without preCampaignEnd = a 2-player game
    const e2 = await err(two.s, 'withdraw_candidates', { seats: [1] });
    expect(e2.code).toBe('WRONG_PHASE');
    expect(e2.message).toMatch(/2-player game has no pre-campaign/);
    expect(e2.hint).toMatch(/campaign_batch/);
    const out = pre({ players: players4().map((p) => (p.playerId === 'me' ? { ...p, status: 'eliminated' } as PlayerPublic : p)) });
    expect((await err(out.s, 'field_candidates', { seats: [1] })).code).toBe('FORBIDDEN');
    const late = pre();
    late.c.state.snapshot!.timeline = { ...late.c.state.snapshot!.timeline!, preCampaignEnd: Date.now() - 1 };
    expect((await err(late.s, 'field_candidates', { seats: [1] })).code).toBe('TOO_LATE');
    for (const x of [lobby, camp, two, out, late]) expect(x.calls.field ?? x.calls.withdraw).toBeUndefined();
  });

  it('warns loudly while the party still has no candidate', async () => {
    const { s } = pre();
    const r = await ok(s, 'field_candidates', { seats: [1] });
    expect(r.hint).not.toMatch(/NO candidates/);
    const w = await ok(s, 'withdraw_candidates', { seats: [1] });
    expect(w.hint).toMatch(/NO candidates/);
  });
});

describe('withdraw_candidates', () => {
  it('withdraws and refunds in full; seats without a candidate are skipped; reports withdrawn / skipped / refunded and the time left', async () => {
    const { s, calls } = pre({ fielding: { 1: [cand('me', 1)], 2: [cand('me', 2), cand('c', 2)], 3: [cand('c', 3)] }, budget: cfg.budget - 2 * price });
    const r = await ok(s, 'withdraw_candidates', { seats: [1, 2, 3, 4] });
    expect(calls.withdraw[0][0]).toEqual([1, 2]);
    expect(r).toMatchObject({ ok: true, withdrawn: 2, skipped: 2, refunded_wr: 2 * price, your_candidates: 0, budget_wr: cfg.budget });
    expect(r.pre_campaign_left_s).toBeGreaterThan(80);
    const f = s.client.state.snapshot!.fielding;
    expect(f[1]).toBeUndefined();
    expect(f[2]).toEqual([cand('c', 2)]); // the rival\'s candidate stays
    expect(r.contested_seats).toBe(2);
  });

  it('all:true withdraws every candidate I hold', async () => {
    const { s, calls } = pre({ fielding: { 1: [cand('me', 1)], 9: [cand('me', 9)], 5: [cand('c', 5)] } });
    const r = await ok(s, 'withdraw_candidates', { all: true });
    expect([...calls.withdraw[0][0] as number[]].sort((a, b) => a - b)).toEqual([1, 9]);
    expect(r.withdrawn).toBe(2);
  });

  it('is refused in the campaign (the line-up is fixed)', async () => {
    const { s } = pre({ status: 'campaign' });
    s.client.state.snapshot!.timeline = { ...s.client.state.snapshot!.timeline!, preCampaignEnd: Date.now() - 5000 };
    expect((await err(s, 'withdraw_candidates', { seats: [1] })).code).toBe('WRONG_PHASE');
  });
});

// ------------------------------------------------------------------ campaign actions around the pre-campaign
describe('campaign actions during the pre-campaign and without a candidate', () => {
  it('campaign, campaign_batch, buy_report and the news agencies answer WRONG_PHASE (not TOO_LATE) and tell you to field now', async () => {
    const { s, c } = pre();
    c.campaignBatch = (async () => { throw new Error('must not be sent'); }) as never;
    for (const [name, args] of [['campaign', { type: 'roadshow', seat: 1 }], ['campaign_batch', { actions: [{ type: 'minorRally', seat: 1 }] }], ['buy_report', { scope: 'global' }]] as const) {
      const e = await err(s, name, args);
      expect(e.code, name).toBe('WRONG_PHASE');
      expect(e.message, name).toMatch(/campaign has not started/i);
      expect(e.hint, name).toMatch(/field_candidates/);
    }
    const g = await err(s, 'get_global_reports');
    expect(g.code).toBe('WRONG_PHASE');
  });

  it('NOT_FIELDED: a rally, minor rally or roadshow in a seat where I have no candidate is refused locally with a hint and not sent; the other rows still go', async () => {
    const { s, c } = mk({ preCampaign: true, status: 'campaign', fielding: { 3: [cand('me', 3), cand('c', 3)], 4: [cand('c', 4)] } });
    const sent: { type: string; seat: number }[] = [];
    c.campaignBatch = (async (list: any[]) => list.map((a) => { sent.push(a); return { ok: true as const, budget: 1 }; })) as never;
    const r = await ok(s, 'campaign_batch', { actions: [{ type: 'roadshow', seat: 3 }, { type: 'minorRally', seat: 4 }, { type: 'roadshow', seat: 5 }, { type: 'rally', seat: 4 }] });
    expect(sent).toEqual([{ type: 'roadshow', seat: 3 }]);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(3);
    for (const row of r.results.filter((x: any) => !x.ok)) {
      expect(row.error).toMatchObject({ code: 'NOT_FIELDED', local: true });
      expect(row.error.hint).toMatch(/fielded_only/);
    }
    expect(r.results[1].error.message).toMatch(/minor rally/);
    expect((await err(s, 'campaign', { type: 'roadshow', seat: 4 })).code).toBe('NOT_FIELDED');
  });

  it('a game without a pre-campaign (2 players) never precheck-refuses a seat: every seat is fielded for you', async () => {
    const { s, c } = mk(); // snapshot.fielding is empty here
    c.campaignBatch = (async (list: any[]) => list.map(() => ({ ok: true as const, budget: 1 }))) as never;
    expect((await ok(s, 'campaign', { type: 'roadshow', seat: 4 })).ok).toBe(true);
  });

  it('an eliminated player is told so instead of being sent to the server', async () => {
    const { s } = pre({ status: 'campaign', players: players4().map((p) => (p.playerId === 'me' ? { ...p, status: 'eliminated' } as PlayerPublic : p)) });
    s.client.state.snapshot!.timeline = { ...s.client.state.snapshot!.timeline!, preCampaignEnd: Date.now() - 5000 };
    const e = await err(s, 'campaign', { type: 'roadshow', seat: 1 });
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toMatch(/eliminated/);
    expect((await ok(s, 'get_state')).advice.join(' ')).toMatch(/You are eliminated/);
  });
});

describe('minor rally', () => {
  it('is accepted by campaign and campaign_batch (and not by a typo), is charged its own price and has no cooldown', async () => {
    const { s, c } = mk({ preCampaign: true, status: 'campaign', fielding: Object.fromEntries([1, 2, 3].map((k) => [k, [cand('me', k)]])) });
    const sent: { type: string; seat: number }[] = [];
    let budget = c.state.priv!.budget;
    c.campaignBatch = (async (list: any[]) => list.map((a) => { sent.push(a); budget -= cfg.costs[a.type as 'rally']; c.state.priv!.budget = budget; return { ok: true as const, budget }; })) as never;
    expect(ACTION_BY_NAME.get('campaign')!.schema.safeParse({ type: 'minorRally', seat: 1 }).success).toBe(true);
    expect(ACTION_BY_NAME.get('campaign_batch')!.schema.safeParse({ actions: [{ type: 'minorRally', seat: 1 }] }).success).toBe(true);
    expect(ACTION_BY_NAME.get('campaign')!.schema.safeParse({ type: 'minor_rally', seat: 1 }).success).toBe(false);
    const r = await ok(s, 'campaign_batch', { actions: [{ type: 'minorRally', seat: 1 }, { type: 'minorRally', seat: 2 }, { type: 'minorRally', seat: 3 }] });
    expect(r.sent).toBe(3); // a major rally would have stopped the 2nd and 3rd on the cooldown
    expect(sent).toHaveLength(3);
    expect(r.budget_wr).toBe(cfg.budget - 3 * cfg.costs.minorRally);
    expect(r.minor_rallies_affordable).toBe(Math.floor(r.budget_wr / cfg.costs.minorRally));
    expect(r.rally_ready).toBe(true); // the cooldown is for the major rally only
  });

  it('is refused locally when the budget cannot pay its price', async () => {
    const { s } = mk({ preCampaign: true, status: 'campaign', fielding: { 1: [cand('me', 1)] }, budget: cfg.costs.minorRally - 1 });
    const e = await err(s, 'campaign', { type: 'minorRally', seat: 1 });
    expect(e.code).toBe('INSUFFICIENT_FUNDS');
    expect(e.message).toMatch(/minorRally/);
  });

  it('is private: my own counts show it (get_state, get_seat), the public news and the rally news counts do not', async () => {
    const { s, c } = mk({ preCampaign: true, status: 'campaign', fielding: { 1: [cand('me', 1)] } });
    c.state.pendingActions.set('r1', { type: 'minorRally', seat: 1 });
    push(s, { type: 'actionAck', clientRef: 'r1', ok: true, budget: 5 });
    const st = await ok(s, 'get_state');
    expect(st.my_actions).toEqual({ rallies: 0, minor_rallies: 1, roadshows: 0, reports_bought: 0 });
    expect((await ok(s, 'get_seat', { seat: 1 })).my_actions_here).toEqual({ rallies: 0, minor_rallies: 1, roadshows: 0 });
    expect(st.public_rally_news.total).toBe(0);
    expect(st.public_rally_news.note).toMatch(/minor rallies and roadshows are hidden/);
    const news = await ok(s, 'get_news');
    expect(news.total).toBe(0);
    expect(ACTION_BY_NAME.get('get_news')!.description).toMatch(/Minor rallies and roadshows never appear/);
  });
});

// ------------------------------------------------------------------ views
describe('stage and timers', () => {
  it('stageInfo knows the pre-campaign: its own stage and the seconds to the deadline (never treated as the lobby)', () => {
    const now = 1_000_000;
    const tl = { preCampaignEnd: now + 60_000, campaignStart: now + 65_000, phaseCloses: [now + 300_000], campaignEnd: now + 300_000, countingEnd: now + 400_000, postCountingEnd: now + 500_000 };
    expect(stageInfo('preCampaign', tl, now)).toEqual({ stage: 'preCampaign', stage_left_s: 60 });
    expect(stageInfo('preCampaign', null, now)).toEqual({ stage: 'preCampaign', stage_left_s: null });
    expect(stageInfo('lobby', tl, now).stage).toBe('lobby');
    expect(stageInfo('abandoned', tl, now).stage).toBe('lobby'); // unknown statuses still fall back to the lobby
  });

  it('get_state in the pre-campaign: stage, timers, contested seats and majority from the snapshot, everyone\'s candidate counts, chat mode, costs', async () => {
    const { s } = pre({ fielding: { 1: [cand('me', 1), cand('c', 1)], 2: [cand('c', 2)], 3: [cand('d', 3)] } });
    s.client.state.snapshot = { ...s.client.state.snapshot!, contestedSeats: 3, majority: 2 };
    const st = await ok(s, 'get_state');
    expect(st.status).toBe('preCampaign');
    expect(st.timers.stage).toBe('preCampaign');
    expect(st.timers.stage_left_s).toBeGreaterThan(80);
    expect(st.timers.pre_campaign_left_s).toBeGreaterThan(80);
    expect(st.timers.campaign_starts_in_s).toBeGreaterThan(80);
    expect(st.contested_seats).toBe(3);
    expect(st.majority).toBe(2);
    expect(st.chat_mode).toBe('INDV');
    expect(st.fielding).toMatchObject({
      your_candidates: 1, candidate_cost_wr: price, contested_seats: 3, majority: 2, seats_total: cfg.seatCount,
      by_party: { 'Party Asha': 0, 'Party Claude': 1, 'Party Codex': 2, 'Party Dev': 1 },
    });
    expect(st.budget).toMatchObject({
      candidate_cost_wr: price, minor_rally_cost_wr: cfg.costs.minorRally, candidates_affordable: Math.floor(cfg.budget / price),
      costs_wr: { rally: cfg.costs.rally, minorRally: cfg.costs.minorRally, roadshow: cfg.costs.roadshow, candidate: price },
    });
  });

  it('advice in the pre-campaign: field before the deadline, no candidates = out, each costs N and is refunded on withdrawal, negotiate one-to-one; louder with no candidate', async () => {
    const none = pre();
    const a = (await ok(none.s, 'get_state')).advice.join(' ');
    expect(a).toMatch(/PRE-CAMPAIGN/);
    expect(a).toMatch(/field_candidates/);
    expect(a).toMatch(/no candidates you are out/);
    expect(a).toContain(`${cfg.currency.symbol}${price.toLocaleString('en-US')}`);
    expect(a).toMatch(/refunded in full/);
    expect(a).toMatch(/one-to-one/);
    expect(a).toMatch(/URGENT/);
    const some = pre({ fielding: { 1: [cand('me', 1)] } });
    expect((await ok(some.s, 'get_state')).advice.join(' ')).not.toMatch(/URGENT/);
  });

  it('after the campaign starts get_state keeps showing fielding (who contests) and advises fielded_only; a 2-player game has no fielding block', async () => {
    const { s } = mk({ preCampaign: true, status: 'campaign', fielding: { 1: [cand('me', 1)] } });
    const st = await ok(s, 'get_state');
    expect(st.fielding.your_candidates).toBe(1);
    expect(st.advice.join(' ')).toMatch(/fielded_only:true/);
    expect(st.advice.join(' ')).toMatch(/minor rallies/);
    const two = mk();
    const st2 = await ok(two.s, 'get_state');
    expect(st2.fielding).toBeUndefined();
    expect(st2.contested_seats).toBe(cfg.seatCount);
    expect(st2.majority).toBe(majorityOf(cfg.seatCount));
    expect(st2.advice.join(' ')).not.toMatch(/fielded_only/);
  });

  it('chat works in the pre-campaign one-to-one (to is required), and says when it opens before the game', async () => {
    const { s, calls } = pre();
    expect((await err(s, 'chat', { text: 'hi' })).code).toBe('INVALID_INPUT');
    const r = await ok(s, 'chat', { to: ['Party Codex'], text: 'I will stand in Asia, you take Europe?' });
    expect(r.chat_mode).toBe('INDV');
    expect(calls.chat[0][1]).toMatch(/Asia/);
    const lobby = mk({ status: 'lobby' });
    expect((await err(lobby.s, 'chat', { to: ['all'], text: 'x' })).message).toMatch(/pre-campaign/);
  });
});

describe('list_seats and get_seat show the line-up', () => {
  const lineup = { 1: [cand('me', 1), cand('c', 1)], 2: [cand('c', 2)], 3: [cand('me', 3)] };

  it('list_seats rows say whether I have a candidate and how many parties stand; fielded_only / not_fielded_only filter on it', async () => {
    const { s } = pre({ fielding: lineup });
    const rows = (await ok(s, 'list_seats', { limit: 5 })).rows;
    expect(rows.map((r: any) => [r.id, r.you_have_candidate, r.candidates])).toEqual([[1, true, 2], [2, false, 1], [3, true, 1], [4, false, 0], [5, false, 0]]);
    const mine = await ok(s, 'list_seats', { fielded_only: true, limit: 100 });
    expect(mine.rows.map((r: any) => r.id)).toEqual([1, 3]);
    const free = await ok(s, 'list_seats', { not_fielded_only: true, limit: 3 });
    expect(free.total).toBe(cfg.seatCount - 2);
    expect(free.rows.map((r: any) => r.id)).toEqual([2, 4, 5]);
    expect((await ok(s, 'list_seats', { fielded_only: true, open_only: true, limit: 100 })).rows.map((r: any) => r.id)).toEqual([1, 3]);
  });

  it('in a game without a pre-campaign every seat is mine and the rows carry no fielding fields', async () => {
    const { s } = mk();
    const r = await ok(s, 'list_seats', { fielded_only: true, limit: 2 });
    expect(r.total).toBe(cfg.seatCount);
    expect(r.rows[0].you_have_candidate).toBeUndefined();
    expect((await ok(s, 'list_seats', { not_fielded_only: true })).total).toBe(0);
  });

  it('get_seat lists who stands there with the candidates\' names, whether I do, and whether the seat is vacant', async () => {
    const { s } = pre({ fielding: lineup });
    const g = await ok(s, 'get_seat', { seat: 1 });
    expect(g.you_have_candidate).toBe(true);
    expect(g.vacant).toBe(false);
    expect(g.candidates_here).toEqual([
      { party: 'Party Claude', candidate: 'Candidate 1', you: true }, { party: 'Party Codex', candidate: 'Candidate 1', you: false },
    ]);
    const other = await ok(s, 'get_seat', { seat: 2 });
    expect(other.you_have_candidate).toBe(false);
    const empty = await ok(s, 'get_seat', { seat: 4 });
    expect(empty).toMatchObject({ vacant: true, candidates_here: [], you_have_candidate: false });
    expect((await ok(mk().s, 'get_seat', { seat: 4 })).you_have_candidate).toBe(true);
  });
});

describe('events', () => {
  it('wait_for_events leaves fielding events out by default (humans paint many seats) but returns them when asked, with the new majority', async () => {
    const { s } = pre();
    push(s, { type: 'fieldingUpdate', playerId: 'c', added: [{ seat: 7 }], removed: [], contestedSeats: 1, majority: 1 });
    expect((await ok(s, 'wait_for_events', { since_cursor: 0, timeout_s: 0 })).events).toEqual([]);
    const w = await ok(s, 'wait_for_events', { since_cursor: 0, timeout_s: 0, types: ['fielding'] });
    expect(w.events[0]).toMatchObject({ type: 'fielding', party: 'Party Codex', fielded: 1, withdrawn: 0, contested_seats: 1, majority: 1 });
    expect(w.hint_state.stage).toBe('preCampaign');
  });

  it('the status event for the pre-campaign tells you to field candidates', async () => {
    const { s } = mk({ status: 'lobby' });
    push(s, { type: 'status', status: 'preCampaign', timeline: { preCampaignEnd: Date.now() + 90_000, campaignStart: Date.now() + 95_000, phaseCloses: [Date.now() + 200_000], campaignEnd: Date.now() + 200_000, countingEnd: Date.now() + 300_000, postCountingEnd: Date.now() + 400_000 } });
    const w = await ok(s, 'wait_for_events', { since_cursor: 0, timeout_s: 0, types: ['status'] });
    expect(w.events[0].status).toBe('preCampaign');
    expect(w.events[0].note).toMatch(/field candidates now/);
    expect(w.hint_state.stage).toBe('preCampaign');
  });
});

describe('majority follows the game (vacant seats lower it)', () => {
  it('list_offers and offers use the snapshot\'s majority, not the whole map\'s', async () => {
    const { s } = pre({ status: 'counting', tally: { leads: {}, wins: {}, declared: 0, total: 300 } });
    s.client.state.snapshot = { ...s.client.state.snapshot!, majority: 151, contestedSeats: 300 };
    expect((await ok(s, 'list_offers')).tally.majority).toBe(151);
    expect((await ok(s, 'get_state')).majority).toBe(151);
  });
});

// ------------------------------------------------------------------ docs, prompts and the rules text
describe('rules, README, prompts and the tool list', () => {
  it('the new tools and the action type are in the table, with descriptions that name the pre-campaign', () => {
    const names = ACTIONS.map((a) => a.name);
    expect(names).toContain('field_candidates');
    expect(names).toContain('withdraw_candidates');
    expect(ACTION_BY_NAME.get('field_candidates')!.description).toMatch(/PRE-CAMPAIGN ONLY/);
    expect(ACTION_BY_NAME.get('campaign')!.description).toMatch(/minorRally/);
    expect(ACTION_BY_NAME.get('campaign_batch')!.description).toMatch(/minorRally/);
  });

  it('RULES.md renders with the live numbers: candidate and minor rally prices, the pre-campaign section, the budget left after fielding every seat', () => {
    const text = renderRules(cfg);
    const v = rulesValues(cfg);
    expect(text).not.toContain('{{');
    expect(text).toContain('## 2a. Pre-campaign');
    expect(text).toContain(`${cfg.currency.symbol}${price}`);
    expect(v.CANDIDATE_COST_TEXT).toBe(`${cfg.currency.symbol}${price}`);
    expect(v.MINOR_RALLY_COST_TEXT).toBe(`${cfg.currency.symbol}${cfg.costs.minorRally.toLocaleString('en-US')}`);
    expect(v.CAMPAIGN_BUDGET_TEXT).toBe(`${cfg.currency.symbol}${fullyFieldedBudget(cfg).toLocaleString('en-US')}`);
    expect(v.MAX_ROADSHOWS).toBe(String(Math.floor(fullyFieldedBudget(cfg) / cfg.costs.roadshow)));
    expect(v.MINOR_LOCAL).toBe(String(cfg.effects.minorRally.local));
    expect(v.MINOR_REACH_KM).toBe(String(cfg.effects.minorRally.decay.maxKm));
    expect(v.FIRST_MOVER_MINOR).toBe(String(cfg.effects.firstMover.minorRally));
    expect(text).toMatch(/No candidate at the deadline = eliminated/);
    expect(text).toMatch(/NOT_FIELDED/);
    expect(text).toMatch(/Minor rallies and roadshows are never shown/);
    expect(text).toMatch(/parties contesting the seat/);
    expect(text).not.toMatch(/Every seat always has a winner/);
    const changed = renderRules({ ...cfg, costs: { ...cfg.costs, candidate: 100, minorRally: 3_000 } });
    expect(changed).toContain(`${cfg.currency.symbol}3,000`);
    expect(changed).toContain(`${cfg.currency.symbol}${(cfg.seatCount * 100).toLocaleString('en-US')}`);
  });

  it('RULES.md, the README, AGENTS.md, the MCP instructions and the play prompt all name field_candidates and withdraw_candidates, and say a rematch starts in the pre-campaign', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    const agents = readFileSync(fileURLToPath(new URL('../../../AGENTS.md', import.meta.url)), 'utf8');
    for (const [what, text] of [['RULES', rulesTemplate()], ['README', readme]] as const) {
      expect(text, what).toContain('field_candidates');
      expect(text, what).toContain('withdraw_candidates');
      expect(text, what).toContain('minorRally');
    }
    expect(agents).toContain('field_candidates');
    expect(SERVER_INSTRUCTIONS).toContain('field_candidates');
    expect(PLAY_PROMPT('ABC123')).toContain('field_candidates');
    expect(PLAY_PROMPT('ABC123')).toMatch(/PRE-CAMPAIGN/);
    for (const [what, text] of [['RULES', rulesTemplate()], ['README', readme], ['AGENTS', agents], ['instructions', SERVER_INSTRUCTIONS], ['prompt', PLAY_PROMPT()]] as const) {
      expect(text, what).not.toMatch(/already in the (new )?campaign/);
      expect(text, what).not.toMatch(/new campaign/);
      expect(text, what).toMatch(/pre-campaign/);
    }
  });

  it('the MCP server lists the new tools with schemas, and field_candidates is not read-only', async () => {
    const { s } = pre();
    const server = createMcpServer(s) as any;
    const tools = Object.keys(server._registeredTools ?? {});
    expect(tools).toEqual(expect.arrayContaining(['field_candidates', 'withdraw_candidates']));
    expect(ACTION_BY_NAME.get('field_candidates')!.readOnly).toBeFalsy();
  });

  it('every new view uses only fields the snapshot guarantees (a hello without fielding must not crash get_state)', async () => {
    const { s } = pre();
    delete (s.client.state.snapshot as any).fielding;
    delete (s.client.state.snapshot as any).majority;
    delete (s.client.state.snapshot as any).contestedSeats;
    const st = await ok(s, 'get_state');
    expect(st.majority).toBe(majorityOf(cfg.seatCount));
    expect((await ok(s, 'list_seats', { limit: 2 })).rows[0].you_have_candidate).toBeUndefined();
    expect(newState().snapshot).toBeNull();
    void P;
  });
});
