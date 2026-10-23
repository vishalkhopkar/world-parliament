// Action table, schemas and local pre-validation, against a fake (offline) session.
import { beforeAll, describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';
import { ACTIONS, ACTION_BY_NAME, executeAction, formatResultText } from '../src/actions';
import { loadGamePackage, loadSeatNames } from '../src/gamePackage';
import { SeatDirectory } from '../src/resolve';
import { renderRules, rulesTemplate, rulesValues } from '../src/rules';
import { toJsonSchema } from '../src/schema';
import { AgentSession } from '../src/session';
import { parseArgsLenient, parseArgv } from '../src/cli';
import { GameClient } from '../src/client';

const cfg = WORLD_CONFIG;
let dir: SeatDirectory;
beforeAll(async () => { dir = new SeatDirectory((await loadGamePackage('world-500'))!, loadSeatNames('world-500')); });

const players: PlayerPublic[] = [
  { playerId: 'h', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Saffron', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'me', nickname: 'Claude', isAdmin: false, kind: 'agent', status: 'active', party: { name: 'Blue', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'c', nickname: 'Codex', isAdmin: false, kind: 'agent', status: 'active', party: { name: 'Green', colour: '#1E8C45', symbol: 'leaf' } },
];

interface Fake { s: AgentSession; sent: { type: string; seat: number }[] }
function fakeSession(opts: { status?: GameSnapshot['status']; budget?: number; startInMs?: number; phases?: number; closedPhase0?: boolean } = {}): Fake {
  const s = new AgentSession({ seats: dir });
  const c = s.client;
  const now = Date.now();
  const phases = opts.phases ?? 3;
  const start = now + (opts.startInMs ?? -1000);
  const span = 300_000;
  const closes = Array.from({ length: phases }, (_, i) => start + ((i + 1) * span) / phases);
  if (opts.closedPhase0) closes[0] = now - 5000;
  c.session = { server: 'http://x', gameId: 'g', playerId: 'me', token: 't', nickname: 'Claude' };
  c.state.gameId = 'g'; c.state.me = 'me';
  c.state.snapshot = {
    gameId: 'g', mapId: 'world-500', status: opts.status ?? 'campaign', phases, players, news: [], polledPhases: [], seats: {}, tally: null,
    offers: [], government: null, result: null,
    timeline: { campaignStart: start, phaseCloses: closes, campaignEnd: closes[phases - 1], countingEnd: closes[phases - 1] + 1000, postCountingEnd: closes[phases - 1] + 2000 },
  };
  c.state.priv = { you: 'me', budget: opts.budget ?? cfg.budget, myActions: [], myReports: [] };
  const sent: { type: string; seat: number }[] = [];
  let budget = c.state.priv.budget;
  c.campaignBatch = async (list) => list.map((a) => { sent.push(a); budget -= cfg.costs[a.type]; c.state.priv!.budget = budget; return { ok: true as const, budget }; });
  return { s, sent };
}

const phaseOfSeat = (s: AgentSession, id: number) => s.phaseMap(dir).get(id) as number;

describe('action table', () => {
  it('contains every required action exactly once and no way to create a game', () => {
    const names = ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['get_rules', 'join_game', 'wait_for_admission', 'get_lobby', 'list_party_options', 'set_party', 'get_state', 'list_seats', 'get_seat',
      'campaign', 'campaign_batch', 'buy_report', 'get_news', 'wait_for_events', 'chat', 'get_chat', 'propose_government', 'respond_offer', 'withdraw_offer',
      'list_offers', 'leave_game']) expect(names).toContain(n);
    expect(names.some((n) => /create|host|start_game/i.test(n))).toBe(false);
    expect('createGame' in GameClient.prototype).toBe(false);
    expect(Object.getOwnPropertyNames(GameClient.prototype).some((n) => /create/i.test(n))).toBe(false);
    for (const a of ACTIONS) expect(a.description.length).toBeGreaterThan(30);
  });

  it('zod schemas validate and reject sensibly', () => {
    const batch = ACTION_BY_NAME.get('campaign_batch')!.schema;
    expect(batch.safeParse({ actions: [{ type: 'rally', seat: 3 }, { type: 'roadshow', seat: 'Delhi East' }] }).success).toBe(true);
    expect(batch.safeParse({ actions: [] }).success).toBe(false);
    expect(batch.safeParse({ actions: Array.from({ length: 51 }, () => ({ type: 'rally', seat: 1 })) }).success).toBe(false);
    expect(batch.safeParse({ actions: Array.from({ length: 50 }, () => ({ type: 'rally', seat: 1 })) }).success).toBe(true);
    expect(batch.safeParse({ actions: [{ type: 'parade', seat: 1 }] }).success).toBe(false);
    const wait = ACTION_BY_NAME.get('wait_for_events')!.schema;
    expect(wait.parse({}).timeout_s).toBe(25);
    expect(wait.safeParse({ timeout_s: 61 }).success).toBe(false);
    expect(wait.safeParse({ types: ['news', 'chat'] }).success).toBe(true);
    expect(wait.safeParse({ types: ['bogus'] }).success).toBe(false);
    expect(ACTION_BY_NAME.get('wait_for_admission')!.schema.safeParse({ timeout_s: 121 }).success).toBe(false);
    expect(ACTION_BY_NAME.get('list_seats')!.schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ACTION_BY_NAME.get('join_game')!.schema.safeParse({ join_code: 'ABC123' }).success).toBe(true); // nickname defaults
    expect(ACTION_BY_NAME.get('join_game')!.schema.safeParse({ code: 'ABC123' }).success).toBe(true); // alias
    const party = ACTION_BY_NAME.get('set_party')!.schema;
    expect(party.safeParse({ auto_pick: true }).success).toBe(true); // everything else is picked; without auto_pick the run step requires all four
    expect(party.safeParse({ name: 'Blue', colour: 'blue', symbol: 'sun', avatar: 'xi' }).success).toBe(true);
    expect(ACTION_BY_NAME.get('propose_government')!.schema.safeParse({ portfolios: { DPM: ['Blue Wave', 'Green Front'], HOME: 'Blue Wave' } }).success).toBe(true);
  });

  it('every schema converts to a JSON schema with required fields', () => {
    for (const a of ACTIONS) {
      const js = toJsonSchema(a.schema) as any;
      expect(js.type).toBe('object');
    }
    const js = toJsonSchema(ACTION_BY_NAME.get('campaign_batch')!.schema) as any;
    expect(js.required).toEqual(['actions']);
    expect(js.properties.actions.maxItems).toBe(50);
    const ev = toJsonSchema(ACTION_BY_NAME.get('wait_for_events')!.schema) as any;
    expect(ev.required).toBeUndefined();
    expect(ev.properties.timeout_s.maximum).toBe(60);
    expect(ev.properties.types.items.enum).toContain('phaseClosed');
  });

  it('errors are returned as clear text (code + message + hint), never thrown', async () => {
    const s = new AgentSession({ seats: dir });
    const r = await executeAction(s, 'get_state', {});
    expect(r.ok).toBe(true); // not joined is a state, not an error
    const e = await executeAction(s, 'campaign', { type: 'rally', seat: 1 });
    expect(e.ok).toBe(false);
    const text = formatResultText(e);
    expect(text).toMatch(/^ERROR NOT_JOINED: /);
    expect(text).toContain('Hint:');
    const bad = formatResultText(await executeAction(s, 'campaign', { type: 'dance', seat: 1 }));
    expect(bad).toMatch(/^ERROR INVALID_INPUT/);
    expect(formatResultText(await executeAction(s, 'fly', {}))).toMatch(/^ERROR UNKNOWN_ACTION/);
  });
});

describe('local pre-validation (the server stays the authority)', () => {
  it('campaign resolves seat names and sends nothing when the seat is already polled', async () => {
    const { s, sent } = fakeSession({ closedPhase0: true });
    const inPhase0 = [...s.phaseMap(dir)].find(([, p]) => p === 0)![0];
    const r = await executeAction(s, 'campaign', { type: 'rally', seat: inPhase0 });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('SEAT_POLLED'); expect(r.error.hint).toBeTruthy(); }
    expect(sent).toHaveLength(0);
  });

  it('campaign by name sends one action and reports the new budget', async () => {
    const { s, sent } = fakeSession();
    const r = await executeAction(s, 'campaign', { type: 'roadshow', seat: 'delhi east' });
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ type: 'roadshow', seat: 2 }]);
    if (r.ok) expect((r.data as any).budget_wr).toBe(cfg.budget - cfg.costs.roadshow);
  });

  it('campaign_batch checks the budget cumulatively, skips invalid rows, sends the rest', async () => {
    const budget = cfg.costs.rally + cfg.costs.roadshow * 2; // 1 rally + 2 roadshows
    const { s, sent } = fakeSession({ budget });
    const r = await executeAction(s, 'campaign_batch', {
      actions: [
        { type: 'rally', seat: 2 }, { type: 'roadshow', seat: 3 }, { type: 'roadshow', seat: 'Nowhereville' },
        { type: 'roadshow', seat: 5 }, { type: 'roadshow', seat: 6 },
      ],
    });
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.sent).toBe(3);
    expect(d.failed).toBe(2);
    expect(d.results[2].error.code).toBe('UNKNOWN_SEAT');
    expect(d.results[2].error.local).toBe(true);
    expect(d.results[4].error.code).toBe('INSUFFICIENT_FUNDS');
    expect(sent.map((x) => x.seat)).toEqual([2, 3, 5]);
    expect(d.budget_wr).toBe(0);
  });

  it('refuses before the game starts / after the campaign, waits out a short lead-in', async () => {
    const lobby = fakeSession({ status: 'lobby' });
    lobby.s.client.state.snapshot!.timeline = null;
    const r1 = await executeAction(lobby.s, 'campaign', { type: 'rally', seat: 1 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('WRONG_PHASE');
    const over = fakeSession({ status: 'counting' });
    const r2 = await executeAction(over.s, 'campaign', { type: 'rally', seat: 1 });
    if (!r2.ok) expect(r2.error.code).toBe('TOO_LATE');
    const far = fakeSession({ startInMs: 60_000 });
    const r3 = await executeAction(far.s, 'campaign', { type: 'rally', seat: 1 });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.message).toMatch(/starts in/);
    const soon = fakeSession({ startInMs: 400 });
    const t0 = Date.now();
    const r4 = await executeAction(soon.s, 'campaign', { type: 'roadshow', seat: 1 });
    expect(r4.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it('buy_report refuses seat reports on polled seats and when the budget is short', async () => {
    const polled = fakeSession({ closedPhase0: true });
    const seat0 = [...polled.s.phaseMap(dir)].find(([, p]) => p === 0)![0];
    const r1 = await executeAction(polled.s, 'buy_report', { scope: 'seat', seat: seat0 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('SEAT_POLLED');
    const poor = fakeSession({ budget: 1000 });
    const r2 = await executeAction(poor.s, 'buy_report', { scope: 'global' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INSUFFICIENT_FUNDS');
    const r3 = await executeAction(poor.s, 'buy_report', { scope: 'seat' });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('INVALID_INPUT');
  });
});

describe('read-only views', () => {
  it('get_state summarises timers, budget, prices and advice', async () => {
    const { s } = fakeSession();
    const r = await executeAction(s, 'get_state', {});
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.status).toBe('campaign');
    expect(d.seats_total).toBe(500);
    expect(d.majority).toBe(251);
    expect(d.budget.wr).toBe(cfg.budget);
    expect(d.budget.rallies_affordable).toBe(Math.floor(cfg.budget / cfg.costs.rally));
    expect(d.budget.roadshows_affordable).toBe(Math.floor(cfg.budget / cfg.costs.roadshow));
    expect(d.budget.seat_report_price_now_wr).toBeGreaterThanOrEqual(cfg.analyst.seatReport.start);
    expect(d.timers.current_polling_phase).toBe(1);
    expect(d.timers.polling_phases_total).toBe(3);
    expect(d.timers.campaign_left_s).toBeGreaterThan(290);
    expect(d.players).toHaveLength(3);
    expect(d.players.find((p: any) => p.party === 'Blue').kind).toBe('agent');
    expect(d.advice[0]).toContain('campaign_batch');
    expect(d.seats_still_open).toBe(500);
  });

  it('list_seats filters by phase / open_only / query / near and paginates', async () => {
    const { s } = fakeSession({ closedPhase0: true });
    const all = (await executeAction(s, 'list_seats', { limit: 100 })) as any;
    expect(all.data.total).toBe(500);
    expect(all.data.returned).toBe(100);
    expect(all.data.next_offset).toBe(100);
    const p1 = (await executeAction(s, 'list_seats', { phase: 1, limit: 100 })) as any;
    expect(p1.data.rows.every((r: any) => r.phase === 1 && r.polled === true)).toBe(true);
    const open = (await executeAction(s, 'list_seats', { open_only: true, limit: 100 })) as any;
    expect(open.data.total).toBe(500 - p1.data.total);
    const q = (await executeAction(s, 'list_seats', { query: 'delhi' })) as any;
    expect(q.data.rows.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Delhi East', 'Delhi West']));
    const near = (await executeAction(s, 'list_seats', { near_seat_id: 'Delhi East', limit: 5 })) as any;
    expect(near.data.near).toBe('Delhi East');
    expect(near.data.rows[0].km).toBeLessThan(near.data.rows[4].km + 1);
    expect(near.data.rows.find((r: any) => r.id === 2)).toBeUndefined();
    const miss = formatResultText(await executeAction(s, 'list_seats', { near_seat_id: 'Atlantis' }));
    expect(miss).toMatch(/ERROR UNKNOWN_SEAT/);
  });

  it('exposes the own committed voters in get_state, list_seats and get_seat', async () => {
    const { s } = fakeSession();
    expect(((await executeAction(s, 'get_state', {})) as any).data.committed).toMatchObject({ total: 0, by_level: {}, seats: [] });
    expect(((await executeAction(s, 'get_seat', { seat: 2 })) as any).data.my_committed_voters).toBeNull();
    s.client.state.priv!.committed = [
      { seat: 2, band: 1, percent: 30, level: 'HIGH' },
      { seat: 3, band: 3, percent: 20, level: 'MEDIUM' },
      { seat: 4, band: 4, percent: 15, level: 'MEDIUM' },
    ];
    const st = ((await executeAction(s, 'get_state', {})) as any).data.committed;
    expect(st.total).toBe(3);
    expect(st.by_level).toEqual({ HIGH: 1, MEDIUM: 2 });
    expect(st.seats[0]).toMatchObject({ seat: 2, name: 'Delhi East', committed: '~30% (HIGH)' });
    const seat = ((await executeAction(s, 'get_seat', { seat: 2 })) as any).data.my_committed_voters;
    expect(seat).toMatchObject({ committed: '~30% (HIGH)', band: 1, level: 'HIGH' });
    const all = ((await executeAction(s, 'list_seats', { limit: 100 })) as any).data.rows;
    expect(all.find((r: any) => r.id === 2).committed).toBe('~30% (HIGH)');
    expect(all.find((r: any) => r.id === 5)?.committed).toBeUndefined();
    const only = ((await executeAction(s, 'list_seats', { committed_only: true })) as any).data;
    expect(only.rows.map((r: any) => r.id).sort()).toEqual([2, 3, 4]);
  });

  it('rules text describes the committed-voter vote model with live numbers', () => {
    const text = renderRules(WORLD_CONFIG);
    expect(text).toContain('Committed voters');
    expect(text).not.toContain('{{');
    const b = WORLD_CONFIG.committed.bands[0];
    expect(text).toContain(`${b.percent}%`);
    expect(text).toContain(String(WORLD_CONFIG.committed.seatMaxPercent));
    expect(text).toContain(String(WORLD_CONFIG.voting.influenceMaxPercent));
    expect(text).toContain(String(WORLD_CONFIG.voting.randomMaxPercent));
    expect(text).not.toMatch(/random swing/i);
  });

  it('get_seat returns neighbours with names and distances', async () => {
    const { s } = fakeSession();
    const r = (await executeAction(s, 'get_seat', { seat: 'Delhi East' })) as any;
    expect(r.ok).toBe(true);
    expect(r.data.id).toBe(2);
    expect(r.data.neighbours.length).toBeGreaterThan(0);
    expect(typeof r.data.neighbours[0].name).toBe('string');
    expect(r.data.my_actions_here).toEqual({ rallies: 0, roadshows: 0 });
    expect(phaseOfSeat(s, 2) + 1).toBe(r.data.phase);
  });
});

describe('rules rendering', () => {
  it('the template has no unrendered placeholders and numbers come from the config', () => {
    const text = renderRules(cfg);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain(`${WORLD_CONFIG.currency.symbol}50,000`);
    expect(text).toContain(`${WORLD_CONFIG.currency.symbol}2,000`);
    expect(text).toContain(`${WORLD_CONFIG.currency.symbol}400`);
    expect(text).toContain('251 seats');
    expect(text).toContain('500 parliament seats');
    expect(text).toContain('| `PM` | Prime Minister | 100 | 1 |');
    expect(text).toContain('| `DPM` | Deputy Prime Minister | 50 | 2 |');
  });

  it('explains the first mover bonus with the configured amounts', () => {
    const text = renderRules(cfg);
    expect(text).toContain("First mover's advantage");
    expect(text).toContain(`+${cfg.effects.firstMover.rally}`);
    expect(text).toContain(`+${cfg.effects.firstMover.roadshow}`);
    expect(renderRules({ ...cfg, effects: { ...cfg.effects, firstMover: { rally: 0.25, roadshow: 4 } } })).toContain('+0.25');
  });

  it('follows config changes (nothing hard-coded)', () => {
    const changed = { ...cfg, seatCount: 543, budget: 30_000, costs: { rally: 3_000, roadshow: 500 } };
    const text = renderRules(changed);
    expect(text).toContain(`${WORLD_CONFIG.currency.symbol}3,000`);
    expect(text).toContain('272 seats');
    expect(text).toContain('543 parliament seats');
    expect(text).not.toContain(`${WORLD_CONFIG.currency.symbol}50,000`);
    const v = rulesValues(changed);
    expect(v.MAX_RALLIES).toBe('10');
    expect(v.MAX_ROADSHOWS).toBe('60');
  });

  it('fails loudly on an unknown placeholder', () => {
    expect(() => renderRules(cfg, {}, 'x {{NOPE}}')).toThrow(/NOPE/);
  });

  it('the chat paragraph follows messaging.mode: one group chat everybody reads, or private threads', () => {
    const group = renderRules({ ...cfg, messaging: { mode: 'group', opensAt: 'counting' } });
    expect(group).toMatch(/group chat/i);
    expect(group).toMatch(/everyone in the game reads/i);
    expect(group).not.toMatch(/Only you and the recipients see it/);
    const threads = renderRules({ ...cfg, messaging: { mode: 'individual', opensAt: 'counting' } });
    expect(threads).toMatch(/Only you and the recipients see it/);
    expect(threads).not.toMatch(/everyone in the game reads/i);
    expect(group).not.toContain('{{');
    expect(rulesTemplate().length).toBeGreaterThan(3000);
  });

  it('get_rules works before joining', async () => {
    const r = await executeAction(new AgentSession({ seats: dir }), 'get_rules', {});
    expect(r.ok).toBe(true);
    expect(typeof (r as any).data).toBe('string');
    expect((r as any).data).toContain('HUNG PARLIAMENT');
  });
});

describe('cli argument parsing', () => {
  it('parses strict JSON, shell-mangled JSON and key=value pairs', () => {
    expect(parseArgsLenient('{"seat":17,"type":"rally"}')).toEqual({ seat: 17, type: 'rally' });
    expect(parseArgsLenient('{type:rally,seat:17}')).toEqual({ type: 'rally', seat: 17 });
    expect(parseArgsLenient('{seat:Delhi West,type:roadshow}')).toEqual({ seat: 'Delhi West', type: 'roadshow' });
    expect(parseArgsLenient('{actions:[{type:rally,seat:1},{type:roadshow,seat:2}]}')).toEqual({ actions: [{ type: 'rally', seat: 1 }, { type: 'roadshow', seat: 2 }] });
    expect(parseArgsLenient('{to:[Ben,Chitra],text:hello}')).toEqual({ to: ['Ben', 'Chitra'], text: 'hello' });
    const p = parseArgv(['campaign', '--name', 'C1', 'type=rally', 'seat=17', '--server=http://h:1']);
    expect(p).toMatchObject({ command: 'campaign', name: 'C1', server: 'http://h:1', args: { type: 'rally', seat: 17 } });
    const q = parseArgv(['join_game', '{"join_code":"AB12CD","nickname":"Claude"}', '--name', 'X']);
    expect(q.args).toEqual({ join_code: 'AB12CD', nickname: 'Claude' });
    expect(parseArgv(['get_state'], { HP_AGENT_NAME: 'FromEnv' }).name).toBe('FromEnv');
  });
});
