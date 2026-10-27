// Every action of the table, offline against a fake session: guards (not joined / not admitted), argument validation,
// name resolution, cursor handling, error texts. The real server is exercised by integration.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG } from '@hp/shared';
import type { ChatMessage, CoalitionOffer, GameSnapshot, PlayerPublic, ServerMessage } from '@hp/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIONS, ACTION_BY_NAME, executeAction, formatResultText } from '../src/actions';
import { AgentError, toErrorInfo } from '../src/errors';
import { loadGamePackage, loadSeatNames } from '../src/gamePackage';
import { SeatDirectory } from '../src/resolve';
import { renderRules } from '../src/rules';
import { AgentSession } from '../src/session';
import { applyMessage } from '../src/state';

import { enableReportsForFile, setReportFlags } from './reportsFlag';

const cfg = WORLD_CONFIG;
enableReportsForFile();
let dir: SeatDirectory;
beforeAll(async () => { dir = new SeatDirectory((await loadGamePackage('world-500'))!, loadSeatNames('world-500')); });

const P = (id: string, nick: string, i: number, over: Partial<PlayerPublic> = {}): PlayerPublic => ({
  playerId: id, nickname: nick, isAdmin: id === 'h', kind: id === 'h' ? 'human' : 'agent', status: 'active',
  party: { name: `Party ${nick}`, colour: PARTY_COLOURS[i].hex, symbol: PARTY_SYMBOLS[i].id, avatar: AVATARS[i].id }, ...over,
});
const players = (): PlayerPublic[] => [P('h', 'Asha', 0), P('me', 'Claude', 1), P('c', 'Codex', 2), P('d', 'Dev', 3)];

interface Opts {
  status?: GameSnapshot['status'];
  admission?: 'pending' | 'rejected' | 'active';
  players?: PlayerPublic[];
  offers?: CoalitionOffer[];
  budget?: number;
  news?: GameSnapshot['news'];
}
function session(opts: Opts = {}) {
  const s = new AgentSession({ seats: dir });
  const c = s.client;
  const now = Date.now();
  const list = (opts.players ?? players()).map((p) => (p.playerId === 'me' && opts.admission ? { ...p, status: opts.admission === 'rejected' ? 'rejected' : opts.admission } as PlayerPublic : p));
  const closes = [now + 100_000, now + 200_000, now + 300_000];
  c.session = { server: 'http://x', gameId: 'g', playerId: 'me', token: 't', nickname: 'Claude' };
  c.state.gameId = 'g'; c.state.me = 'me'; c.state.joinCode = 'ABC123';
  c.state.snapshot = {
    gameId: 'g', mapId: 'world-500', status: opts.status ?? 'campaign', phases: 3, players: list, news: opts.news ?? [], polledPhases: [], seats: {}, tally: null,
    offers: opts.offers ?? [], government: null, result: null,
    timeline: { campaignStart: now - 1000, phaseCloses: closes, campaignEnd: closes[2], countingEnd: closes[2] + 1000, postCountingEnd: closes[2] + 2000 },
  };
  c.state.priv = { you: 'me', budget: opts.budget ?? cfg.budget, myActions: [], myReports: [] };
  const calls: Record<string, unknown[][]> = {};
  const rec = <T>(name: string, ret: T) => vi.fn(async (...a: unknown[]) => { (calls[name] ??= []).push(a); return ret; });
  c.campaignBatch = rec('campaignBatch', []) as never;
  c.chat = vi.fn(async (to: string[], text: string) => { (calls.chat ??= []).push([to, text]); return { id: 'm1', from: 'me', to, text, ts: Date.now() } as ChatMessage; }) as never;
  c.proposeGovernment = vi.fn(async (pf, partners) => {
    (calls.propose ??= []).push([pf, partners]);
    return { offerId: 'offer-new', proposer: 'me', portfolios: pf, partners: partners ?? [], accepted: [], status: 'open', createdAt: Date.now() } as CoalitionOffer;
  }) as never;
  c.respondOffer = rec('respondOffer', null) as never;
  c.withdrawOffer = vi.fn(async (id: string) => { (calls.withdraw ??= []).push([id]); return { ...(opts.offers ?? []).find((o) => o.offerId === id)!, status: 'withdrawn' } as CoalitionOffer; }) as never;
  c.waitForAdmission = rec('waitForAdmission', 'admitted') as never;
  c.setParty = rec('setParty', undefined) as never;
  c.refreshLobby = vi.fn(async () => ({ gameId: 'g', joinCode: 'ABC123', mapId: 'world-500', phases: 3, status: 'lobby', admissionOpen: true, you: 'me', players: list })) as never;
  return { s, c, calls };
}

const offer = (id: string, over: Partial<CoalitionOffer> = {}): CoalitionOffer => ({
  offerId: id, proposer: 'h', portfolios: { PM: ['h'], HOME: ['me'] }, partners: ['me'], accepted: [], status: 'open', createdAt: 1, ...over,
});
const ok = async (s: AgentSession, name: string, args: unknown = {}) => {
  const r = await executeAction(s, name, args);
  if (!r.ok) throw new Error(formatResultText(r));
  return r.data as any;
};
const err = async (s: AgentSession, name: string, args: unknown = {}) => {
  const r = await executeAction(s, name, args);
  if (r.ok) throw new Error(`${name} should have failed, returned ${JSON.stringify(r.data).slice(0, 150)}`);
  return r.error;
};

// ------------------------------------------------------------------ guards
const ARGS: Record<string, unknown> = {
  wait_for_admission: { timeout_s: 1 }, get_lobby: {}, list_party_options: {},
  set_party: { name: 'Blue Wave', colour: 'blue', symbol: 'sun', avatar: 'xi' }, list_seats: {}, get_seat: { seat: 1 },
  campaign: { type: 'rally', seat: 1 }, campaign_batch: { actions: [{ type: 'rally', seat: 1 }] }, buy_report: { scope: 'global' },
  get_news: {}, wait_for_events: { timeout_s: 0 }, chat: { to: ['all'], text: 'hi' }, get_chat: {},
  propose_government: { portfolios: { HOME: 'Party Codex' } }, respond_offer: { offer_id: 'x', accept: true }, withdraw_offer: { offer_id: 'x' }, list_offers: {},
};

describe('guards: every action that needs a game refuses cleanly before joining', () => {
  it.each(Object.keys(ARGS))('%s -> NOT_JOINED with a hint, and nothing is sent', async (name) => {
    const s = new AgentSession({ seats: dir });
    const e = await err(s, name, ARGS[name]);
    expect(e.code).toBe('NOT_JOINED');
    expect(e.hint).toMatch(/join_game/);
  });

  it('actions that work without a game: get_rules, get_state (tells you to join), leave_game (nothing to leave)', async () => {
    const s = new AgentSession({ seats: dir });
    expect(typeof (await ok(s, 'get_rules'))).toBe('string');
    const st = await ok(s, 'get_state');
    expect(st.joined).toBe(false);
    expect(st.advice.join(' ')).toMatch(/join_game/);
    expect(st.advice.join(' ')).toMatch(/cannot create/i);
    expect((await ok(s, 'leave_game')).left).toBe(false);
  });
});

describe('guards: pending / declined players cannot act (NOT_ADMITTED) but can look', () => {
  const NEEDS_ADMISSION = ['set_party', 'campaign', 'campaign_batch', 'buy_report', 'chat', 'propose_government', 'respond_offer', 'withdraw_offer'];
  for (const admission of ['pending', 'rejected'] as const) {
    it.each(NEEDS_ADMISSION)(`${admission}: %s -> NOT_ADMITTED`, async (name) => {
      const { s, calls } = session({ admission, status: 'lobby' });
      const e = await err(s, name, ARGS[name]);
      expect(e.code).toBe('NOT_ADMITTED');
      expect(e.message).toMatch(admission === 'pending' ? /not admitted you yet/ : /declined/);
      expect(Object.keys(calls)).toEqual([]);
    });
  }
  it.each(['get_lobby', 'list_party_options', 'get_state', 'get_news', 'get_chat', 'list_offers', 'list_seats'])('%s works while pending', async (name) => {
    const { s } = session({ admission: 'pending', status: 'lobby' });
    await ok(s, name, ARGS[name] ?? {});
  });
});

// ------------------------------------------------------------------ individual actions
describe('wait_for_admission', () => {
  it.each([['admitted', /list_party_options/], ['declined', /declined/], ['pending', /Still pending/]] as const)('%s', async (status, hint) => {
    const { s, c } = session();
    (c.waitForAdmission as ReturnType<typeof vi.fn>).mockResolvedValueOnce(status);
    const r = await ok(s, 'wait_for_admission', { timeout_s: 5 });
    expect(r.status).toBe(status);
    expect(r.hint).toMatch(hint);
    expect(c.waitForAdmission).toHaveBeenCalledWith(5000);
  });
  it('timeout bounds 1..120, default 30', async () => {
    const { s, c } = session();
    for (const bad of [0, 121, -1, 'x']) expect((await err(s, 'wait_for_admission', { timeout_s: bad })).code).toBe('INVALID_INPUT');
    await ok(s, 'wait_for_admission', {});
    expect(c.waitForAdmission).toHaveBeenLastCalledWith(30_000);
    await ok(s, 'wait_for_admission', { timeout_s: 120 });
    expect(c.waitForAdmission).toHaveBeenLastCalledWith(120_000);
  });
});

describe('get_lobby / list_party_options / set_party', () => {
  it('get_lobby reports players with kind, your admission and the player range', async () => {
    const { s } = session({ status: 'campaign' });
    const r = await ok(s, 'get_lobby');
    expect(r.your_admission).toBe('admitted');
    expect(r.players.map((p: any) => p.party)).toEqual(['Party Asha', 'Party Claude', 'Party Codex', 'Party Dev']);
    expect(r.players.find((p: any) => p.party === 'Party Asha').kind).toBe('human');
    expect(JSON.stringify(r)).not.toMatch(/Asha'|"Asha|"Claude|"Codex|"Dev"/);
    expect(r.players.every((p: any) => p.nickname === undefined)).toBe(true);
    expect(r.players_needed_to_start).toBe(`${cfg.players.min}-${cfg.players.max}`);
    expect(r.polling_phases).toBe(3);
  });

  it('list_party_options marks options taken by OTHER players only and shows your own party', async () => {
    const { s } = session();
    const r = await ok(s, 'list_party_options');
    expect(r.colours).toHaveLength(PARTY_COLOURS.length);
    expect(r.symbols).toHaveLength(PARTY_SYMBOLS.length);
    expect(r.avatars).toHaveLength(AVATARS.length);
    expect(r.colours.find((x: any) => x.hex === PARTY_COLOURS[0].hex).taken_by).toBe('Party Asha');
    expect(r.colours.find((x: any) => x.hex === PARTY_COLOURS[1].hex).taken_by).toBeNull(); // mine
    expect(r.avatars.find((x: any) => x.id === AVATARS[2].id).taken_by).toBe('Party Codex');
    expect(r.symbols.find((x: any) => x.id === PARTY_SYMBOLS[3].id).taken_by).toBe('Party Dev');
    expect(r.your_party.name).toBe('Party Claude');
  });

  it('a rejected player\'s party does not count as taken', async () => {
    const ps = players();
    ps[2] = { ...ps[2], status: 'rejected' };
    const { s } = session({ players: ps });
    const r = await ok(s, 'list_party_options');
    expect(r.avatars.find((x: any) => x.id === AVATARS[2].id).taken_by).toBeNull();
  });

  it('set_party resolves colour / symbol / avatar by label, id or hex in any case and sends canonical values', async () => {
    const { s, calls } = session({ status: 'lobby' });
    const r = await ok(s, 'set_party', { name: '  Blue Wave ', colour: 'SaFFron', symbol: 'Scales', avatar: 'MODI' });
    expect(r.party).toEqual({ name: 'Blue Wave', colour: PARTY_COLOURS.find((c) => c.id === 'saffron')!.hex, symbol: 'scales', avatar: 'modi' });
    expect(calls.setParty[0][0]).toEqual(r.party);
    await ok(s, 'set_party', { name: 'Other', colour: '#1f5fbf', symbol: 'tree', avatar: 'Arvind' });
    expect((calls.setParty[1][0] as any).colour).toBe('#1F5FBF');
  });

  it.each([
    ['unknown colour', { colour: 'chartreuse' }, 'UNKNOWN_OPTION'], ['unknown symbol', { symbol: 'skull' }, 'UNKNOWN_OPTION'], ['unknown avatar', { avatar: 'nobody' }, 'UNKNOWN_OPTION'],
    ['name too short', { name: 'A' }, 'INVALID_INPUT'], ['name too long', { name: 'x'.repeat(31) }, 'INVALID_INPUT'],
    ['missing avatar', { avatar: undefined }, 'INVALID_INPUT'], ['empty colour', { colour: '' }, 'INVALID_INPUT'],
  ])('%s -> %s and nothing is sent', async (_label, over, code) => {
    const { s, calls } = session({ status: 'lobby' });
    const e = await err(s, 'set_party', { name: 'Blue Wave', colour: 'blue', symbol: 'sun', avatar: 'xi', ...over });
    expect(e.code).toBe(code);
    expect(calls.setParty).toBeUndefined();
  });
});

describe('get_news', () => {
  const news = Array.from({ length: 7 }, (_, i) => ({ playerId: i % 2 ? 'c' : 'me', seat: 10 + i, ts: Date.now() - (7 - i) * 1000 }));
  it('paginates with since_cursor / limit and only ever contains rallies (public news)', async () => {
    const { s } = session({ news });
    const a = await ok(s, 'get_news', { limit: 3 });
    expect(a.total).toBe(7);
    expect(a.items).toHaveLength(3);
    expect(a.next_cursor).toBe(3);
    expect(a.items.every((i: any) => i.what === 'rally')).toBe(true);
    const b = await ok(s, 'get_news', { since_cursor: a.next_cursor, limit: 100 });
    expect(b.items).toHaveLength(4);
    expect(b.next_cursor).toBe(7);
    const c = await ok(s, 'get_news', { since_cursor: 7 });
    expect(c.items).toEqual([]);
    expect(c.next_cursor).toBe(7);
  });
  it('seat names come from the map, "seconds_ago" is non-negative, parties are named', async () => {
    const { s } = session({ news });
    const r = await ok(s, 'get_news', {});
    for (const i of r.items) { expect(i.seat_name).toBe(dir.name(i.seat)); expect(i.seconds_ago).toBeGreaterThanOrEqual(0); expect(i.party).toBeTruthy(); }
  });
  it('rejects silly cursors / limits', async () => {
    const { s } = session({ news });
    for (const bad of [{ since_cursor: -1 }, { limit: 0 }, { limit: 201 }, { since_cursor: 1.5 }]) expect((await err(s, 'get_news', bad)).code).toBe('INVALID_INPUT');
  });
});

describe('wait_for_events', () => {
  const push = (s: AgentSession, m: ServerMessage) => {
    for (const e of applyMessage(s.client.state, m, Date.now())) s.client.events.push(e.type, e.data, Date.now());
  };
  it('returns new events once, advances the cursor by itself and says when it timed out', async () => {
    const { s } = session();
    expect(await ok(s, 'wait_for_events', { timeout_s: 0 })).toMatchObject({ events: [], timed_out: true, next_cursor: 0 });
    push(s, { type: 'news', item: { playerId: 'c', seat: 5, ts: Date.now() } });
    push(s, { type: 'phaseClosed', phase: 0, seats: [1, 2] });
    const a = await ok(s, 'wait_for_events', { timeout_s: 0 });
    expect(a.events.map((e: any) => e.type)).toEqual(['news', 'phaseClosed']);
    expect(a.timed_out).toBe(false);
    const again = await ok(s, 'wait_for_events', { timeout_s: 0 });
    expect(again.events).toEqual([]);
    expect(again.next_cursor).toBe(a.next_cursor);
  });
  it('seatUpdate events are excluded unless asked for; the type filter and limit work; an explicit cursor re-reads', async () => {
    const { s } = session();
    push(s, { type: 'seatUpdate', declaration: { seat: 1, status: 'leading', playerId: 'c' }, tally: { leads: { c: 1 }, wins: {}, declared: 0, total: 500 } });
    push(s, { type: 'chat', message: { id: 'm', from: 'c', to: ['me'], text: 'hello', ts: 1 } });
    push(s, { type: 'chat', message: { id: 'm2', from: 'c', to: ['me'], text: 'again', ts: 2 } });
    const dflt = await ok(s, 'wait_for_events', { timeout_s: 0 });
    expect(dflt.events.map((e: any) => e.type)).toEqual(['chat', 'chat']);
    const su = await ok(s, 'wait_for_events', { since_cursor: 0, types: ['seatUpdate'], timeout_s: 0 });
    expect(su.events).toHaveLength(1);
    const lim = await ok(s, 'wait_for_events', { since_cursor: 0, limit: 1, types: ['chat'], timeout_s: 0 });
    expect(lim.events).toHaveLength(1);
    expect(lim.next_cursor).toBeLessThan(3);
  });
  it('wakes up as soon as an event arrives (long poll)', async () => {
    const { s } = session();
    const t0 = Date.now();
    const p = ok(s, 'wait_for_events', { timeout_s: 20 });
    setTimeout(() => push(s, { type: 'status', status: 'counting', timeline: s.client.state.snapshot!.timeline }), 80);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.events[0].type).toBe('status');
    expect(r.hint_state.status).toBe('counting');
  });
  it('validates timeout / types', async () => {
    const { s } = session();
    expect((await err(s, 'wait_for_events', { timeout_s: 61 })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'wait_for_events', { types: ['bogus'] })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'wait_for_events', { limit: 0 })).code).toBe('INVALID_INPUT');
  });
});

describe('chat / get_chat', () => {
  const counting = { status: 'counting' as const };
  it('needs 3+ players and an open chat window (not the lobby); the order of the checks is stable', async () => {
    const two = session({ ...counting, players: players().slice(0, 2).map((p, i) => (i === 1 ? { ...p, playerId: 'me' } : p)) });
    expect((await err(two.s, 'chat', { to: ['Party Asha'], text: 'hi' })).code).toBe('NEGOTIATION_DISABLED');
    const early = session({ status: 'lobby' });
    expect((await err(early.s, 'chat', { to: ['Party Asha'], text: 'hi' })).code).toBe('WRONG_PHASE');
    expect(early.calls.chat).toBeUndefined();
  });
  it('resolves party name and id (never nicknames); de-duplicates; "all" means every other living player', async () => {
    const ps = players();
    ps[3] = { ...ps[3], status: 'eliminated' };
    const { s, calls } = session({ ...counting, players: ps });
    await ok(s, 'chat', { to: ['party asha', 'Party Asha', 'h'], text: 'hello' });
    expect(calls.chat[0][0]).toEqual(['h']);
    await ok(s, 'chat', { to: ['all'], text: 'everyone' });
    expect((calls.chat[1][0] as string[]).sort()).toEqual(['c', 'h']); // not me, not the eliminated Dev
    await ok(s, 'chat', { to: ['Everybody'], text: 'x' });
    expect((calls.chat[2][0] as string[]).sort()).toEqual(['c', 'h']);
    await ok(s, 'chat', { to: ['Party Dev'], text: 'to the eliminated is allowed by name' });
    expect(calls.chat[3][0]).toEqual(['d']);
  });
  it.each([
    [{ to: ['Party Claude'], text: 'me' }, 'INVALID_INPUT'], [{ to: ['me'], text: 'me' }, 'INVALID_INPUT'], [{ to: ['Nobody'], text: 'x' }, 'UNKNOWN_PLAYER'],
    [{ to: [], text: 'x' }, 'INVALID_INPUT'], [{ to: ['Party Asha'], text: '' }, 'INVALID_INPUT'], [{ to: ['Party Asha'], text: 'x'.repeat(501) }, 'INVALID_INPUT'],
    [{ to: 5, text: 'x' }, 'INVALID_INPUT'],
  ])('%j -> %s', async (args, code) => {
    const { s, calls } = session(counting);
    expect((await err(s, 'chat', args)).code).toBe(code);
    expect(calls.chat).toBeUndefined();
  });
  it('`to` is optional: without it the message goes to every other living player (group chat)', async () => {
    const ps = players();
    ps[3] = { ...ps[3], status: 'eliminated' };
    const { s, calls } = session({ ...counting, players: ps });
    await ok(s, 'chat', { text: 'to the whole table' });
    expect((calls.chat[0][0] as string[]).sort()).toEqual(['c', 'h']);
    expect(calls.chat[0][1]).toBe('to the whole table');
  });
  it('get_chat returns everything from the cursor and the next cursor', async () => {
    const { s } = session(counting);
    s.client.state.chat = [1, 2, 3].map((i) => ({ id: `m${i}`, from: 'c', to: ['me'], text: `t${i}`, ts: i }));
    const a = await ok(s, 'get_chat', {});
    expect(a.messages.map((m: any) => m.text)).toEqual(['t1', 't2', 't3']);
    expect(a.next_cursor).toBe(3);
    const b = await ok(s, 'get_chat', { since_cursor: 2 });
    expect(b.messages.map((m: any) => m.text)).toEqual(['t3']);
    expect((await ok(s, 'get_chat', { since_cursor: 3 })).messages).toEqual([]);
  });
});

describe('propose_government', () => {
  const counting = { status: 'counting' as const };
  it('checks: 3+ players, counting phase', async () => {
    const two = session({ ...counting, players: [P('h', 'Asha', 0), P('me', 'Claude', 1)] });
    expect((await err(two.s, 'propose_government', { portfolios: { HOME: 'Party Asha' } })).code).toBe('NEGOTIATION_DISABLED');
    expect((await err(session({ status: 'campaign' }).s, 'propose_government', { portfolios: { HOME: 'Party Asha' } })).code).toBe('WRONG_PHASE');
  });
  it('resolves portfolio names/aliases and player references; PM defaults to me; lists may repeat players', async () => {
    const { s, calls } = session(counting);
    const r = await ok(s, 'propose_government', { portfolios: { 'Deputy Prime Minister': ['party asha', 'Party Codex', 'h'], home: 'Party Dev', 'external affairs': 'Party Codex' }, partners: ['Party Dev', 'Party Codex'] });
    const [pf, partners] = calls.propose[0] as [Record<string, string[]>, string[]];
    expect(pf.PM).toEqual(['me']);
    expect(pf.DPM.sort()).toEqual(['c', 'h']);
    expect(pf.HOME).toEqual(['d']);
    expect(pf.EXTERNAL).toEqual(['c']);
    expect(partners.sort()).toEqual(['c', 'd']);
    expect(r.proposed).toBe(true);
  });
  it('the PM must be me; unknown portfolio / player are clear errors; nothing sent', async () => {
    const { s, calls } = session(counting);
    expect((await err(s, 'propose_government', { portfolios: { PM: 'Party Asha' } })).code).toBe('INVALID_GOVERNMENT');
    expect((await err(s, 'propose_government', { portfolios: { PM: ['Party Claude', 'Party Asha'] } })).code).toBe('INVALID_GOVERNMENT');
    expect((await err(s, 'propose_government', { portfolios: { MINISTER_OF_FUN: 'Party Asha' } })).code).not.toBe('INTERNAL');
    expect((await err(s, 'propose_government', { portfolios: { HOME: 'Nobody' } })).code).toBe('UNKNOWN_PLAYER');
    expect((await err(s, 'propose_government', { portfolios: { HOME: 'Party Asha' }, partners: ['Nobody'] })).code).toBe('UNKNOWN_PLAYER');
    expect((await err(s, 'propose_government', {})).code).toBe('INVALID_INPUT');
    expect(calls.propose).toBeUndefined();
  });
  it('proposing with myself as PM explicitly is fine', async () => {
    const { s, calls } = session(counting);
    await ok(s, 'propose_government', { portfolios: { PM: 'me', HOME: 'Party Codex' } });
    expect((calls.propose[0][0] as any).PM).toEqual(['me']);
  });
});

describe('respond_offer / withdraw_offer / list_offers', () => {
  const offers = [offer('abcdef123'), offer('abcxyz999', { proposer: 'c', partners: ['me'] }), offer('mine0001', { proposer: 'me', partners: ['h'], portfolios: { PM: ['me'], HOME: ['h'] } }), offer('old', { status: 'declined' })];
  it('accept / decline by exact id; returns the refreshed offer', async () => {
    const { s, calls } = session({ status: 'counting', offers });
    const r = await ok(s, 'respond_offer', { offer_id: 'abcdef123', accept: true });
    expect(calls.respondOffer[0]).toEqual(['abcdef123', true]);
    expect(r.you).toBe('accepted');
    const d = await ok(s, 'respond_offer', { offer_id: 'abcxyz999', accept: false });
    expect(d.you).toBe('declined');
  });
  it('a unique prefix works, an ambiguous or unknown one is OFFER_NOT_FOUND listing the known ids', async () => {
    const { s, calls } = session({ status: 'counting', offers });
    await ok(s, 'respond_offer', { offer_id: 'abcd', accept: true });
    expect(calls.respondOffer[0][0]).toBe('abcdef123');
    const amb = await err(s, 'respond_offer', { offer_id: 'abc', accept: true });
    expect(amb.code).toBe('OFFER_NOT_FOUND');
    expect(amb.message).toContain('abcdef123');
    expect((await err(s, 'respond_offer', { offer_id: 'zzz', accept: true })).code).toBe('OFFER_NOT_FOUND');
    expect(calls.respondOffer).toHaveLength(1);
  });
  it('cannot respond to your own offer; accepting twice is a no-op with a note; invalid input is rejected', async () => {
    const mineAccepted = [offer('abc1', { accepted: ['me'] }), offer('mine0001', { proposer: 'me', partners: ['h'] })];
    const { s, calls } = session({ status: 'counting', offers: mineAccepted });
    expect((await err(s, 'respond_offer', { offer_id: 'mine0001', accept: true })).code).toBe('INVALID_INPUT');
    const r = await ok(s, 'respond_offer', { offer_id: 'abc1', accept: true });
    expect(r.note).toMatch(/already accepted/);
    expect(calls.respondOffer).toBeUndefined();
    for (const bad of [{ offer_id: '', accept: true }, { offer_id: 'abc1' }, { offer_id: 'abc1', accept: 'yes' }, { accept: true }]) expect((await err(s, 'respond_offer', bad)).code).toBe('INVALID_INPUT');
  });
  it('withdraw_offer: known offer -> sent; unknown -> OFFER_NOT_FOUND', async () => {
    const { s, calls } = session({ status: 'counting', offers });
    const r = await ok(s, 'withdraw_offer', { offer_id: 'mine0001' });
    expect(calls.withdraw[0]).toEqual(['mine0001']);
    expect(r.offer.status).toBe('withdrawn');
    expect((await err(s, 'withdraw_offer', { offer_id: 'nope' })).code).toBe('OFFER_NOT_FOUND');
    expect(calls.withdraw).toHaveLength(1);
  });
  it('list_offers: all or only active ones; includes tally and government when known', async () => {
    const { s } = session({ status: 'counting', offers });
    const all = await ok(s, 'list_offers', {});
    expect(all.offers).toHaveLength(4);
    const active = await ok(s, 'list_offers', { only_active: true });
    expect(active.offers.map((o: any) => o.offer_id ?? o.id ?? o.offerId)).not.toContain('old');
    expect(active.offers).toHaveLength(3);
    expect(all.government).toBeNull();
    expect(all.tally).toBeNull();
    s.client.state.snapshot!.tally = { leads: {}, wins: { c: 3 }, declared: 3, total: 500 };
    expect((await ok(s, 'list_offers', {})).tally).toMatchObject({ declared_won: 3, of: 500, majority: 251 });
  });
});

describe('leave_game', () => {
  it('forgets the game: state reset, session file cleared, later actions say NOT_JOINED', async () => {
    const { s } = session();
    const r = await ok(s, 'leave_game');
    expect(r).toMatchObject({ left: true, game_id: 'g' });
    expect(r.warning).toMatch(/eliminated/);
    expect(s.joined).toBe(false);
    expect((await err(s, 'get_lobby')).code).toBe('NOT_JOINED');
    expect((await ok(s, 'leave_game')).left).toBe(false);
  });
});

describe('campaign / campaign_batch / buy_report validation', () => {
  it.each([[{ type: 'dance', seat: 1 }], [{ type: 'rally' }], [{ seat: 1 }], [{ type: 'rally', seat: 1.5 }], [{ type: 'rally', seat: '' }], [{ type: 'rally', seat: null }]])('campaign %j -> INVALID_INPUT', async (args) => {
    const { s, c } = session();
    expect((await err(s, 'campaign', args)).code).toBe('INVALID_INPUT');
    expect(c.campaignBatch).not.toHaveBeenCalled();
  });
  it('unknown seat id or name -> UNKNOWN_SEAT, no money spent', async () => {
    const { s, c } = session();
    for (const seat of [0, 501, -3, 99999, 'Atlantis Nowhere']) expect((await err(s, 'campaign', { type: 'rally', seat })).code, String(seat)).toBe('UNKNOWN_SEAT');
    expect(c.campaignBatch).not.toHaveBeenCalled();
  });
  it('batch: empty and over 50 are invalid, 50 is accepted; rows keep their order and index', async () => {
    const { s, c } = session();
    expect((await err(s, 'campaign_batch', { actions: [] })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'campaign_batch', { actions: Array.from({ length: 51 }, () => ({ type: 'roadshow', seat: 1 })) })).code).toBe('INVALID_INPUT');
    (c.campaignBatch as ReturnType<typeof vi.fn>).mockImplementation(async (l: unknown[]) => l.map(() => ({ ok: true, budget: 1 })));
    const r = await ok(s, 'campaign_batch', { actions: Array.from({ length: 50 }, (_, i) => ({ type: 'roadshow', seat: 1 + i })) });
    expect(r.sent).toBe(50);
    expect(r.results.map((x: any) => x.index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
  it('batch: budget is checked cumulatively and exactly (the last affordable action passes, the next one fails)', async () => {
    const { s, c } = session({ budget: cfg.costs.rally + cfg.costs.roadshow * 2 });
    (c.campaignBatch as ReturnType<typeof vi.fn>).mockImplementation(async (l: unknown[]) => l.map(() => ({ ok: true, budget: 0 })));
    const r = await ok(s, 'campaign_batch', { actions: [{ type: 'rally', seat: 1 }, { type: 'roadshow', seat: 2 }, { type: 'roadshow', seat: 3 }, { type: 'roadshow', seat: 4 }] });
    expect(r.sent).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.results[3].error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', local: true });
  });
  it('batch: only one rally per cooldown goes through; later rallies fail locally with RATE_LIMITED, are not charged or sent, roadshows still go', async () => {
    const { s, c } = session();
    (c.campaignBatch as ReturnType<typeof vi.fn>).mockImplementation(async (l: unknown[]) => l.map(() => ({ ok: true, budget: 0 })));
    const r = await ok(s, 'campaign_batch', { actions: [{ type: 'rally', seat: 1 }, { type: 'rally', seat: 2 }, { type: 'roadshow', seat: 3 }, { type: 'rally', seat: 4 }] });
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.results[1].error).toMatchObject({ code: 'RATE_LIMITED', local: true });
    expect(r.results[1].error.message).toMatch(/cooldown/i);
    expect(r.results[3].error.code).toBe('RATE_LIMITED');
    expect((c.campaignBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([{ type: 'rally', seat: 1 }, { type: 'roadshow', seat: 3 }]);
  });
  it('a rally inside the cooldown (server nextRallyAt, or the last rally in myActions) is refused locally, roadshows are not', async () => {
    const { s, c } = session();
    const now = s.client.serverNow();
    (c.state.priv as any).nextRallyAt = now + 20_000;
    const e = await err(s, 'campaign', { type: 'rally', seat: 1 });
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.message).toMatch(/(19|20|21) s/);
    expect((c.campaignBatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    (c.campaignBatch as ReturnType<typeof vi.fn>).mockImplementation(async (l: unknown[]) => l.map(() => ({ ok: true, budget: 0 })));
    expect((await ok(s, 'campaign', { type: 'roadshow', seat: 1 })).ok).toBe(true);
    // fallback without nextRallyAt: computed from the last rally in myActions and the configured cooldown
    (c.state.priv as any).nextRallyAt = undefined;
    (c.state.priv as any).myActions = [{ type: 'rally', seat: 5, ts: now - 1000 }];
    expect((await err(s, 'campaign', { type: 'rally', seat: 1 })).code).toBe('RATE_LIMITED');
    (c.state.priv as any).myActions = [{ type: 'rally', seat: 5, ts: now - cfg.cooldowns.rallyMs - 1000 }];
    expect((await ok(s, 'campaign', { type: 'rally', seat: 1 })).ok).toBe(true);
  });
  it('get_state budget shows rally_ready / next_rally_in_s', async () => {
    const { s, c } = session();
    let d = await ok(s, 'get_state');
    expect(d.budget).toMatchObject({ rally_ready: true, next_rally_in_s: 0, rally_cooldown_s: Math.round(cfg.cooldowns.rallyMs / 1000) });
    (c.state.priv as any).myActions = [{ type: 'rally', seat: 5, ts: s.client.serverNow() - 5000 }];
    d = await ok(s, 'get_state');
    expect(d.budget.rally_ready).toBe(false);
    expect(d.budget.next_rally_in_s).toBeGreaterThan(0);
    expect(d.budget.next_rally_in_s).toBeLessThanOrEqual(Math.round(cfg.cooldowns.rallyMs / 1000));
  });
  it('a single campaign error is thrown as that error (not wrapped)', async () => {
    const { s } = session({ budget: 1 });
    expect((await err(s, 'campaign', { type: 'rally', seat: 1 })).code).toBe('INSUFFICIENT_FUNDS');
  });
  it('buy_report validation: scope enum, seat required for seat scope, unknown seat, funds', async () => {
    const { s, c } = session();
    c.buyReport = vi.fn(async () => ({ report: { scope: 'global', asOf: 1, purchasedAt: 2, price: 3, entries: [] }, budget: 5 })) as never;
    expect((await err(s, 'buy_report', { scope: 'regional' })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'buy_report', { scope: 'seat' })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'buy_report', { scope: 'seat', seat: 'Atlantis Nowhere' })).code).toBe('UNKNOWN_SEAT');
    const poor = session({ budget: 1 });
    expect((await err(poor.s, 'buy_report', { scope: 'global' })).code).toBe('INSUFFICIENT_FUNDS');
    expect(c.buyReport).not.toHaveBeenCalled();
    await ok(s, 'buy_report', { scope: 'global' });
    expect(c.buyReport).toHaveBeenCalledWith('global', undefined);
  });
  it.each([['lobby', 'WRONG_PHASE'], ['counting', 'TOO_LATE'], ['postCounting', 'TOO_LATE'], ['finished', 'TOO_LATE']] as const)('%s game: campaign and reports -> %s', async (status, code) => {
    const { s, c } = session({ status });
    expect((await err(s, 'campaign', { type: 'rally', seat: 1 })).code).toBe(code);
    expect((await err(s, 'buy_report', { scope: 'global' })).code).toBe(code);
    expect(c.campaignBatch).not.toHaveBeenCalled();
  });
});

describe('analyst reports switched off in the config', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it.each([['seat', false, true], ['global', true, false]] as const)('buy_report scope %s is refused locally (FORBIDDEN, nothing sent) when that report is off', async (scope, seatOn, globalOn) => {
    restore = setReportFlags(seatOn, globalOn);
    const { s, c } = session();
    c.buyReport = vi.fn(async () => { throw new Error('must not be called'); }) as never;
    const e = await err(s, 'buy_report', scope === 'seat' ? { scope, seat: 1 } : { scope });
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toMatch(new RegExp(`${scope} reports are switched off`, 'i'));
    expect(c.buyReport).not.toHaveBeenCalled();
  });
  it('the other scope still works when only one report is off', async () => {
    restore = setReportFlags(false, true);
    const { s, c } = session();
    c.buyReport = vi.fn(async () => ({ report: { scope: 'global', asOf: 1, purchasedAt: 2, price: 3, entries: [] }, budget: 5 })) as never;
    await ok(s, 'buy_report', { scope: 'global' });
    expect(c.buyReport).toHaveBeenCalledWith('global', undefined);
  });
  it('the tool description warns that reports may be switched off', () => {
    expect(ACTION_BY_NAME.get('buy_report')!.description).toMatch(/switched off/i);
  });
  it('get_state quotes no price for a switched-off report and says so', async () => {
    restore = setReportFlags(false, true);
    const { s } = session();
    const b = (await ok(s, 'get_state')).budget;
    expect(b.seat_report_price_now_wr).toBeUndefined();
    expect(b.seat_report).toMatch(/switched off/i);
    expect(b.global_report_price_now_wr).toBeGreaterThan(0);
    expect(b.global_report).toBeUndefined();
  });
  it('RULES say "currently switched off in this game" in the prices table and section 5, and render prices when on', () => {
    const off = renderRules({ ...cfg, analyst: { ...cfg.analyst, seatReport: { ...cfg.analyst.seatReport, enabled: false }, globalReport: { ...cfg.analyst.globalReport, enabled: false } } });
    expect(off).toMatch(/\*\*Seat analyst report\*\* \(one seat\) \| currently switched off in this game/);
    expect(off).toMatch(/\*\*Global analyst report\*\* \| currently switched off in this game/);
    expect(off).toMatch(/analyst reports are currently switched off in this game/i);
    expect(off).not.toContain('{{');
    const on = renderRules({ ...cfg, analyst: { ...cfg.analyst, seatReport: { ...cfg.analyst.seatReport, enabled: true }, globalReport: { ...cfg.analyst.globalReport, enabled: true } } });
    expect(on).not.toMatch(/switched off in this game/i);
    expect(on).toContain(`${cfg.currency.symbol}${cfg.analyst.globalReport.start.toLocaleString('en-US')}`);
  });
});

describe('list_seats / get_seat edge cases', () => {
  it('limit and offset bounds, unknown near seat, unknown phase', async () => {
    const { s } = session();
    for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { phase: 0 }, { phase: 6 }]) expect((await err(s, 'list_seats', bad)).code).toBe('INVALID_INPUT');
    expect((await err(s, 'list_seats', { near_seat_id: 'Atlantis Nowhere' })).code).toBe('UNKNOWN_SEAT');
    const page = await ok(s, 'list_seats', { limit: 100, offset: 450 });
    expect(page.returned).toBe(50);
    expect(page.next_offset).toBeUndefined();
    const first = await ok(s, 'list_seats', { limit: 10 });
    expect(first.next_offset).toBe(10);
  });
  it('get_seat: unknown seat error; neighbours listed with distances', async () => {
    const { s } = session();
    expect((await err(s, 'get_seat', { seat: 9999 })).code).toBe('UNKNOWN_SEAT');
    const r = await ok(s, 'get_seat', { seat: 1 });
    expect(r.neighbours.length).toBeGreaterThan(0);
    expect(r.neighbours.every((n: any) => typeof n.km === 'number')).toBe(true);
  });
});

// ------------------------------------------------------------------ wrapper and errors
describe('executeAction wrapper', () => {
  it('never throws: unknown action, invalid input, handler crash (INTERNAL, logged), AgentError passthrough', async () => {
    const { s } = session();
    expect((await err(s, 'self_destruct')).code).toBe('UNKNOWN_ACTION');
    const invalid = await err(s, 'campaign', { type: 'rally' });
    expect(invalid.code).toBe('INVALID_INPUT');
    expect(invalid.message).toContain('seat');
    expect(invalid.hint).toMatch(/type, seat/);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = ACTION_BY_NAME.get('get_lobby')!;
    const orig = a.run;
    a.run = async () => { throw new TypeError('kaboom'); };
    try {
      const e = await err(s, 'get_lobby');
      expect(e.code).toBe('INTERNAL');
      expect(e.message).toBe('kaboom');
      expect(spy).toHaveBeenCalled();
    } finally { a.run = orig; spy.mockRestore(); }
    a.run = async () => { throw new AgentError('NO_CONNECTION', 'down'); };
    try { expect((await err(s, 'get_lobby')).code).toBe('NO_CONNECTION'); } finally { a.run = orig; }
  });
  it('null / undefined input is treated as {} for actions without arguments', async () => {
    const { s } = session();
    expect((await executeAction(s, 'get_lobby', null)).ok).toBe(true);
    expect((await executeAction(s, 'get_lobby', undefined)).ok).toBe(true);
  });
  it('formatResultText: strings as is, JSON for data, ERROR + Hint for errors', () => {
    expect(formatResultText({ ok: true, data: 'plain' })).toBe('plain');
    expect(formatResultText({ ok: true, data: { a: 1 } })).toBe('{"a":1}');
    expect(formatResultText({ ok: false, error: { code: 'X', message: 'm', hint: 'h' } })).toBe('ERROR X: m\nHint: h');
    expect(formatResultText({ ok: false, error: { code: 'X', message: 'm' } })).toBe('ERROR X: m');
  });
  it('every action has a unique name, a description, a zod object schema and a readOnly flag only where it changes nothing', () => {
    expect(new Set(ACTIONS.map((a) => a.name)).size).toBe(ACTIONS.length);
    const mutating = ['join_game', 'set_party', 'campaign', 'campaign_batch', 'buy_report', 'chat', 'propose_government', 'respond_offer', 'withdraw_offer', 'leave_game'];
    for (const a of ACTIONS) {
      expect(typeof a.run).toBe('function');
      expect(a.schema.shape).toBeDefined();
      expect(!!a.readOnly, a.name).toBe(!mutating.includes(a.name));
    }
  });
});

describe('error texts', () => {
  it('every error code of the server contract has a hint for the agent (so the LLM always gets "what to do next")', () => {
    const proto = readFileSync(fileURLToPath(new URL('../../shared/src/protocol.ts', import.meta.url)), 'utf8');
    const block = /export type ErrorCode =([\s\S]*?);/.exec(proto)![1];
    const codes = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(15);
    const missing = codes.filter((c) => !new AgentError(c as never, 'x').hint);
    expect(missing).toEqual([]);
  });
  it('toErrorInfo: AgentError keeps code and hint, anything else becomes INTERNAL', () => {
    expect(toErrorInfo(new AgentError('SEAT_POLLED', 'closed'))).toMatchObject({ code: 'SEAT_POLLED', message: 'closed' });
    expect(toErrorInfo(new AgentError('SEAT_POLLED', 'closed', 'custom hint')).hint).toBe('custom hint');
    expect(toErrorInfo(new Error('plain'))).toMatchObject({ code: 'INTERNAL', message: 'plain' });
    expect(toErrorInfo('a string')).toMatchObject({ code: 'INTERNAL', message: 'a string' });
  });
});

// ------------------------------------------------------------------ playtest fixes
describe('playtest fixes', () => {
  const push = (s: AgentSession, m: ServerMessage) => { for (const e of applyMessage(s.client.state, m, Date.now())) s.client.events.push(e.type, e.data, Date.now()); };

  it('wait_for_events hint_state and get_state show the campaign budget even before the server private message arrives', async () => {
    const { s } = session({ status: 'lobby', budget: 0 }); // lobby-time hello carried budget 0
    push(s, { type: 'status', status: 'campaign', timeline: s.client.state.snapshot!.timeline! } as never); // status arrives BEFORE private
    const w = await ok(s, 'wait_for_events', { timeout_s: 0 });
    expect(w.hint_state.budget).toBe(cfg.budget);
    expect((await ok(s, 'get_state')).budget.wr).toBe(cfg.budget);
    // once the server tells us, the real number wins
    push(s, { type: 'private', private: { you: 'me', budget: 1234, myActions: [], myReports: [] } } as never);
    expect((await ok(s, 'wait_for_events', { timeout_s: 0 })).hint_state.budget).toBe(1234);
  });
  it('a genuinely empty budget stays 0', async () => {
    const { s } = session({ status: 'campaign', budget: 0 });
    expect((await ok(s, 'wait_for_events', { timeout_s: 0 })).hint_state.budget).toBe(0);
  });

  it('set_party with only auto_pick picks a free unique name, colour, symbol and avatar; explicit fields win', async () => {
    const { s, calls } = session({ status: 'lobby' });
    const r = await ok(s, 'set_party', { auto_pick: true });
    const sent = calls.setParty[0][0] as any;
    expect(sent.name.length).toBeGreaterThanOrEqual(2);
    expect(['Party Asha', 'Party Codex', 'Party Dev']).not.toContain(sent.name);
    for (const i of [0, 2, 3]) {
      expect(sent.colour).not.toBe(PARTY_COLOURS[i].hex);
      expect(sent.symbol).not.toBe(PARTY_SYMBOLS[i].id);
      expect(sent.avatar).not.toBe(AVATARS[i].id);
    }
    expect(r.auto_picked).toMatchObject({ name: sent.name });
    await ok(s, 'set_party', { auto_pick: true, name: 'Mine', colour: 'blue' });
    const second = calls.setParty[1][0] as any;
    expect(second.name).toBe('Mine');
    expect(second.colour).toBe('#1F5FBF');
  });
  it('set_party without auto_pick still requires all four fields', async () => {
    const { s, calls } = session({ status: 'lobby' });
    const e = await err(s, 'set_party', { name: 'Blue', colour: 'blue', symbol: 'sun' });
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/avatar/);
    expect(calls.setParty).toBeUndefined();
  });

  it('join_game accepts code as an alias of join_code and defaults the nickname', async () => {
    const { s, c } = session();
    c.session = null as never;
    (s as any).persist = () => undefined;
    c.join = vi.fn(async () => ({ server: 'http://x', gameId: 'g', playerId: 'me', token: 't', nickname: 'Claude' })) as never;
    await ok(s, 'join_game', { code: 'abc123', nickname: 'Bot' });
    expect(c.join).toHaveBeenLastCalledWith('abc123', 'Bot');
    await ok(s, 'join_game', { code: 'ABC123' });
    expect(c.join).toHaveBeenLastCalledWith('ABC123', 'Claude');
    expect((await err(s, 'join_game', { nickname: 'x' })).code).toBe('INVALID_INPUT');
  });

  it('a majority government is rendered as an outright majority with no shared portfolios', async () => {
    const { s } = session({ status: 'finished' });
    const gov = { pm: 'me', members: ['me'], portfolios: { PM: ['me'], DPM: ['me', 'me'], HOME: ['me'] }, viaNegotiation: false };
    s.client.state.snapshot = { ...s.client.state.snapshot!, government: gov as never };
    const st = await ok(s, 'get_state');
    expect(st.government.outright_majority).toBe(true);
    expect(st.government.note).toMatch(/outright majority/i);
    expect(st.government.note).toMatch(/no portfolios (were )?shared/i);
    const co = { ...gov, members: ['me', 'c'], portfolios: { PM: ['me'], DPM: ['me', 'c'] }, viaNegotiation: true };
    s.client.state.snapshot = { ...s.client.state.snapshot!, government: co as never };
    expect((await ok(s, 'get_state')).government.outright_majority).toBe(false);
  });

  it('buy_report says the quoted price may rise and shows the price paid; get_state shows the current price', async () => {
    const { s, c } = session();
    c.buyReport = vi.fn(async () => ({ report: { scope: 'global', asOf: 1, purchasedAt: 2, price: 777, entries: [] }, budget: 5 })) as never;
    const r = await ok(s, 'buy_report', { scope: 'global' });
    expect(r.price_paid_wr).toBe(777);
    expect(r.price_note).toMatch(/rise/i);
    expect(ACTION_BY_NAME.get('buy_report')!.description).toMatch(/quoted price may rise|may rise/i);
    expect((await ok(s, 'get_state')).budget.report_price_note).toMatch(/rise/i);
  });
});
