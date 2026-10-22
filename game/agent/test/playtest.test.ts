// Fixes from the AI-agent playtests: offer views, tally names, timers, argument coercion, chat window, set_party clashes, rules text.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS } from '@hp/shared';
import type { CoalitionOffer, ServerMessage } from '@hp/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ACTIONS, ACTION_BY_NAME } from '../src/actions';
import { AgentError } from '../src/errors';
import { nextHint, parseArgv } from '../src/cli';
import { createMcpServer, PLAY_PROMPT, SERVER_INSTRUCTIONS } from '../src/mcp';
import { renderRules, rulesTemplate } from '../src/rules';
import type { AgentSession } from '../src/session';
import { applyMessage } from '../src/state';
import { P, cfg, err, fakeSession, offerOf, ok, seatDir } from './fake';
import type { FakeOpts } from './fake';
import type { SeatDirectory } from '../src/resolve';

let dir: SeatDirectory;
beforeAll(async () => { dir = await seatDir(); });
const mk = (o: FakeOpts = {}) => fakeSession(dir, o);
const push = (s: AgentSession, m: ServerMessage) => {
  for (const e of applyMessage(s.client.state, m, Date.now())) s.client.events.push(e.type, e.data, Date.now());
};
const tally = (wins: Record<string, number>, leads: Record<string, number> = {}) => ({ leads, wins, declared: Object.values(wins).reduce((a, b) => a + b, 0), total: 500 });

// ------------------------------------------------------------------ A, C: offer views
describe('offer view', () => {
  it('declined: declined_by (party name), nothing awaited, note says declining kills the offer; no seat counts', async () => {
    const { s } = mk({ status: 'counting', offers: [offerOf('o1', { status: 'declined', declinedBy: 'me', partners: ['me', 'c'] })] });
    const o = (await ok(s, 'list_offers')).offers[0];
    expect(o.declined_by).toBe('Party Claude');
    expect(o.waiting_for).toEqual([]);
    expect(o.note).toMatch(/declined by Party Claude: declining kills the whole offer, propose again/);
    expect(o.members_won_seats_so_far).toBeUndefined();
    expect(o.members_leading_seats).toBeUndefined();
  });
  it('superseded: superseded_by is the new offer id; note says accept the new offer instead', async () => {
    const { s } = mk({ status: 'counting', offers: [offerOf('o1', { status: 'superseded', supersededBy: 'o2', partners: ['me', 'c'] }), offerOf('o2')] });
    const o = (await ok(s, 'list_offers')).offers.find((x: any) => x.offer_id === 'o1');
    expect(o.superseded_by).toBe('o2');
    expect(o.waiting_for).toEqual([]);
    expect(o.note).toMatch(/superseded/);
    expect(o.note).toMatch(/o2/);
    expect(o.note).toMatch(/accept the new offer instead/);
  });
  it('withdrawn and formed have notes and no waiting_for', async () => {
    const { s } = mk({ status: 'counting', offers: [offerOf('w', { status: 'withdrawn', partners: ['me', 'c'] }), offerOf('f', { status: 'formed', partners: ['me'], accepted: ['me'] })] });
    const r = await ok(s, 'list_offers');
    const w = r.offers.find((x: any) => x.offer_id === 'w');
    const f = r.offers.find((x: any) => x.offer_id === 'f');
    expect(w.note).toMatch(/withdrawn/i);
    expect(w.waiting_for).toEqual([]);
    expect(f.note).toMatch(/formed|confirmed/i);
    expect(f.waiting_for).toEqual([]);
  });
  it('open / accepted: waiting_for lists the partners who have not accepted; seat counts present (won AND leading)', async () => {
    const { s } = mk({ status: 'counting', tally: tally({ h: 10, me: 5 }, { h: 30, me: 7, c: 2 }), offers: [offerOf('o', { partners: ['me', 'c'], accepted: ['me'] }), offerOf('a', { status: 'accepted', partners: ['me'], accepted: ['me'] })] });
    const r = await ok(s, 'list_offers');
    const o = r.offers[0];
    expect(o.waiting_for).toEqual(['Party Codex']);
    expect(o.members_won_seats_so_far).toBe(15 + 0);
    expect(o.members_leading_seats).toBe(30 + 7 + 2);
    expect(o.note).toMatch(/Waiting/);
    const a = r.offers[1];
    expect(a.waiting_for).toEqual([]);
    expect(a.note).toMatch(/every seat is declared|all seats are declared/i);
    expect(a.note).toMatch(/game then ends/i);
    expect(a.members_won_seats_so_far).toBe(15);
  });
});

// ------------------------------------------------------------------ I: largest party left out
describe('largest party hint', () => {
  it('offer note and get_state advice say that leaving the largest party out is allowed (wins first, then leads)', async () => {
    const t = tally({ c: 120, h: 60, me: 50 }, { c: 200 });
    const { s } = mk({ status: 'counting', tally: t, offers: [offerOf('o', { partners: ['me'], portfolios: { PM: ['h'], HOME: ['me'] } })] });
    const o = (await ok(s, 'list_offers')).offers[0];
    expect(o.note).toContain('Party Codex is the largest party but is left out; that is allowed');
    const st = await ok(s, 'get_state');
    expect(st.advice.join(' ')).toContain('Party Codex is the largest party but is left out; that is allowed');
  });
  it('falls back to leads when nothing is won yet; no hint when the largest party is a member or when tied', async () => {
    const lead = mk({ status: 'counting', tally: tally({}, { c: 9, h: 4 }), offers: [offerOf('o')] });
    expect((await ok(lead.s, 'list_offers')).offers[0].note).toContain('Party Codex is the largest party but is left out');
    const member = mk({ status: 'counting', tally: tally({ h: 9, c: 4 }), offers: [offerOf('o')] });
    expect((await ok(member.s, 'list_offers')).offers[0].note).not.toMatch(/largest party/);
    const tie = mk({ status: 'counting', tally: tally({ c: 5, d: 5 }), offers: [offerOf('o')] });
    expect((await ok(tie.s, 'list_offers')).offers[0].note).not.toMatch(/largest party/);
  });
  it('advice also covers a formed government without the largest party', async () => {
    const gov = { pm: 'h', members: ['h', 'me'], portfolios: { PM: ['h'] }, viaNegotiation: true } as never;
    const { s } = mk({ status: 'postCounting', tally: tally({ c: 100, h: 50, me: 40 }), government: gov });
    expect((await ok(s, 'get_state')).advice.join(' ')).toContain('Party Codex is the largest party but is left out; that is allowed');
  });
});

// ------------------------------------------------------------------ G: timers
describe('timers: stage and stage_left_s', () => {
  const tl = (now: number) => ({ campaignStart: now - 10_000, phaseCloses: [now + 40_000, now + 100_000, now + 160_000], campaignEnd: now + 160_000, countingEnd: now + 220_000, postCountingEnd: now + 280_000 });
  it('campaign: seconds to the NEXT phase close; counting: to countingEnd; postCounting: to postCountingEnd', async () => {
    const now = Date.now();
    const a = mk({ status: 'campaign', timeline: tl(now) });
    const ta = (await ok(a.s, 'get_state')).timers;
    expect(ta.stage).toBe('campaign');
    expect(ta.stage_left_s).toBeGreaterThanOrEqual(39);
    expect(ta.stage_left_s).toBeLessThanOrEqual(40);
    const b = mk({ status: 'counting', timeline: tl(now) });
    const tb = (await ok(b.s, 'get_state')).timers;
    expect(tb.stage).toBe('counting');
    expect(tb.stage_left_s).toBeGreaterThanOrEqual(219);
    expect(tb.stage_left_s).toBeLessThanOrEqual(220);
    const c = mk({ status: 'postCounting', timeline: tl(now) });
    const tc = (await ok(c.s, 'get_state')).timers;
    expect(tc.stage).toBe('postCounting');
    expect(tc.stage_left_s).toBeGreaterThanOrEqual(279);
    const f = mk({ status: 'finished', timeline: tl(now) });
    expect((await ok(f.s, 'get_state')).timers.stage).toBe('finished');
    const l = mk({ status: 'lobby', timeline: tl(now) });
    expect((await ok(l.s, 'get_state')).timers.stage).toBe('lobby');
  });
  it('after the last phase close the campaign stage counts down to campaign end; milestone names are *_ends_in_s', async () => {
    const now = Date.now();
    const t = { ...tl(now), phaseCloses: [now - 90_000, now - 30_000, now + 20_000] };
    const { s } = mk({ status: 'campaign', timeline: { ...t, campaignEnd: now + 20_000 } });
    const timers = (await ok(s, 'get_state')).timers;
    expect(timers.stage_left_s).toBeGreaterThanOrEqual(19);
    expect(timers.counting_ends_in_s).toBeGreaterThanOrEqual(219);
    expect(timers.post_counting_ends_in_s).toBeGreaterThanOrEqual(279);
    expect(timers.counting_left_s).toBeUndefined();
    expect(timers.post_counting_left_s).toBeUndefined();
  });
  it('wait_for_events hint_state: stage + stage_left_s, and phase_left_s is not null during counting', async () => {
    const now = Date.now();
    const { s } = mk({ status: 'counting', timeline: tl(now) });
    const r = await ok(s, 'wait_for_events', { timeout_s: 0 });
    expect(r.hint_state.stage).toBe('counting');
    expect(r.hint_state.stage_left_s).toBeGreaterThanOrEqual(219);
    expect(r.hint_state.phase_left_s).toBe(r.hint_state.stage_left_s);
  });
});

// ------------------------------------------------------------------ E: coercion
describe('bare strings for array fields are coerced before validation', () => {
  it.each([
    ['status', ['status']], ['chat,offer', ['chat', 'offer']], ['[status]', ['status']], ['["chat", "offer"]', ['chat', 'offer']], ["'chat', 'offer'", ['chat', 'offer']], [' chat , offer ', ['chat', 'offer']],
  ])('wait_for_events types=%j', async (raw, expected) => {
    const { s } = mk({ status: 'counting' });
    push(s, { type: 'status', status: 'counting', timeline: s.client.state.snapshot!.timeline });
    push(s, { type: 'chat', message: { id: 'm', from: 'c', to: ['me'], text: 'hello', ts: 1 } });
    push(s, { type: 'offer', offer: offerOf('o1') });
    const r = await ok(s, 'wait_for_events', { since_cursor: 0, types: raw, timeout_s: 0 });
    expect(new Set(r.events.map((e: any) => e.type))).toEqual(new Set(expected));
  });
  it('chat to=all and propose_government partners=a,b', async () => {
    const { s, calls } = mk({ status: 'counting' });
    await ok(s, 'chat', { to: 'all', text: 'hi' });
    expect((calls.chat[0][0] as string[]).sort()).toEqual(['c', 'd', 'h']);
    await ok(s, 'chat', { to: 'Party Asha,Party Dev', text: 'hi' });
    expect((calls.chat[1][0] as string[]).sort()).toEqual(['d', 'h']);
    s.client.proposeGovernment = vi.fn(async (pf, partners) => ({ offerId: 'n', proposer: 'me', portfolios: pf, partners: partners ?? [], accepted: [], status: 'open', createdAt: 1 })) as never;
    await ok(s, 'propose_government', { portfolios: { HOME: 'Party Asha' }, partners: 'Party Codex,Party Dev' });
    expect((s.client.proposeGovernment as any).mock.calls[0][1].sort()).toEqual(['c', 'd']);
  });
  it('unwraps optional/default wrappers only for array-typed fields; other fields are untouched', async () => {
    const { s } = mk({ status: 'counting' });
    expect((await err(s, 'wait_for_events', { types: 'bogus' })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'wait_for_events', { timeout_s: 'x' })).code).toBe('INVALID_INPUT');
    expect((await err(s, 'chat', { to: 'Party Asha', text: '' })).code).toBe('INVALID_INPUT');
  });
  it('no ZodEffects in the action schemas (the catalog printer cannot render them)', () => {
    for (const a of ACTIONS) for (const v of Object.values(a.schema.shape)) {
      let t: any = v;
      while (t?._def?.innerType) t = t._def.innerType;
      expect(t._def.typeName).not.toBe('ZodEffects');
    }
  });
});

describe('wait_for_events types filter (playtest: chat events leaked into a status-only wait)', () => {
  it('action level: types=["status"] never returns chat events, and the cursor skips them', async () => {
    const { s } = mk({ status: 'counting' });
    push(s, { type: 'chat', message: { id: 'm1', from: 'c', to: ['me'], text: 'a', ts: 1 } });
    push(s, { type: 'chat', message: { id: 'm2', from: 'c', to: ['me'], text: 'b', ts: 2 } });
    const r = await ok(s, 'wait_for_events', { types: ['status'], timeout_s: 0 });
    expect(r.events).toEqual([]);
    expect(r.timed_out).toBe(true);
    push(s, { type: 'status', status: 'postCounting', timeline: s.client.state.snapshot!.timeline });
    push(s, { type: 'chat', message: { id: 'm3', from: 'c', to: ['me'], text: 'c', ts: 3 } });
    const r2 = await ok(s, 'wait_for_events', { types: ['status'], timeout_s: 0 });
    expect(r2.events.map((e: any) => e.type)).toEqual(['status']);
  });
  it('MCP level (in-memory transport, real zod->JSON-schema path): types:["status"] returns no chat', async () => {
    const { s } = mk({ status: 'counting' });
    const server = createMcpServer(s);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    try {
      push(s, { type: 'chat', message: { id: 'm1', from: 'c', to: ['me'], text: 'secret chatter', ts: 1 } });
      push(s, { type: 'status', status: 'postCounting', timeline: s.client.state.snapshot!.timeline });
      const res: any = await client.callTool({ name: 'wait_for_events', arguments: { types: ['status'], timeout_s: 0, since_cursor: 0 } });
      const body = JSON.parse(res.content[0].text);
      expect(res.isError).toBeFalsy();
      expect(body.events.map((e: any) => e.type)).toEqual(['status']);
      expect(res.content[0].text).not.toContain('secret chatter');
      const tools = (await client.listTools()).tools;
      const wfe: any = tools.find((t) => t.name === 'wait_for_events');
      expect(wfe.inputSchema.properties.types.type).toBe('array');
    } finally { await client.close(); await server.close(); }
  });
  it('CLI level: types=status / types=chat,offer / types=["status"] parse and filter correctly', async () => {
    const { s } = mk({ status: 'counting' });
    push(s, { type: 'chat', message: { id: 'm1', from: 'c', to: ['me'], text: 'chatter', ts: 1 } });
    push(s, { type: 'status', status: 'postCounting', timeline: s.client.state.snapshot!.timeline });
    for (const arg of ['types=status', 'types=["status"]', 'types=[status]']) {
      const p = parseArgv(['wait_for_events', '--name', 'x', arg, 'timeout_s=0', 'since_cursor=0']);
      const r = await ok(s, p.command, p.args);
      expect(r.events.map((e: any) => e.type)).toEqual(['status']);
    }
    const p2 = parseArgv(['wait_for_events', '--name', 'x', 'types=chat,status', 'timeout_s=0', 'since_cursor=0']);
    expect((await ok(s, p2.command, p2.args)).events.map((e: any) => e.type)).toEqual(['chat', 'status']);
  });
});

describe('documented caps', () => {
  const caps: [string, RegExp][] = [
    ['wait_for_events', /timeout_s[^.]*max 60|max 60/], ['wait_for_admission', /max 120/], ['list_seats', /limit max 100|max 100/], ['campaign_batch', /up to 50|max 50/],
  ];
  it.each(caps)('%s description states its cap', (name, re) => {
    expect(ACTION_BY_NAME.get(name)!.description).toMatch(re);
  });
  it('RULES.md and README.md mention every cap', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    for (const text of [rulesTemplate(), readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8')]) {
      expect(text).toMatch(/timeout_s[^\n]*60/);
      expect(text).toMatch(/wait_for_admission[^\n]*120/);
      expect(text).toMatch(/list_seats[^\n]*100/);
      expect(text).toMatch(/campaign_batch[^\n]*50/);
    }
  });
});

// ------------------------------------------------------------------ F: withdraw_offer
describe('withdraw_offer', () => {
  const mine = (id: string, over: Partial<CoalitionOffer> = {}) => offerOf(id, { proposer: 'me', partners: ['h'], portfolios: { PM: ['me'], HOME: ['h'] }, ...over });
  it('offer_id is optional: defaults to the newest of MY open/accepted offers', async () => {
    const offers = [mine('m-old', { createdAt: 10 }), mine('m-new', { createdAt: 30, status: 'accepted', accepted: ['h'] }), mine('m-dead', { createdAt: 50, status: 'superseded' }), offerOf('theirs', { createdAt: 99 })];
    const { s, calls } = mk({ status: 'counting', offers });
    const r = await ok(s, 'withdraw_offer', {});
    expect(calls.withdraw[0]).toEqual(['m-new']);
    expect(r.ok).toBe(true);
  });
  it('OFFER_NOT_FOUND when I have no open/accepted offer; prefix works like respond_offer', async () => {
    const none = mk({ status: 'counting', offers: [mine('x', { status: 'withdrawn' }), offerOf('theirs')] });
    expect((await err(none.s, 'withdraw_offer', {})).code).toBe('OFFER_NOT_FOUND');
    expect(none.calls.withdraw).toBeUndefined();
    const pre = mk({ status: 'counting', offers: [mine('abcdef123'), mine('zzz1', { createdAt: 5 })] });
    await ok(pre.s, 'withdraw_offer', { offer_id: 'abcd' });
    expect(pre.calls.withdraw[0]).toEqual(['abcdef123']);
    const amb = mk({ status: 'counting', offers: [mine('abc1'), mine('abc2')] });
    expect((await err(amb.s, 'withdraw_offer', { offer_id: 'abc' })).code).toBe('OFFER_NOT_FOUND');
  });
  it('refuses somebody else\'s offer locally', async () => {
    const { s, calls } = mk({ status: 'counting', offers: [offerOf('theirs')] });
    expect((await err(s, 'withdraw_offer', { offer_id: 'theirs' })).code).toBe('INVALID_INPUT');
    expect(calls.withdraw).toBeUndefined();
  });
});

// ------------------------------------------------------------------ H: chat window
describe('chat window follows messaging.opensAt', () => {
  it('default (campaign): allowed during the campaign with 3+ players, not in the lobby; propose/respond stay counting-only', async () => {
    expect(cfg.messaging.opensAt).toBe('campaign');
    const camp = mk({ status: 'campaign' });
    await ok(camp.s, 'chat', { text: 'early talk' });
    expect(camp.calls.chat).toHaveLength(1);
    const lobby = mk({ status: 'lobby' });
    expect((await err(lobby.s, 'chat', { text: 'x' })).code).toBe('WRONG_PHASE');
    expect((await err(camp.s, 'propose_government', { portfolios: { HOME: 'Party Asha' } })).code).toBe('WRONG_PHASE');
    const two = mk({ status: 'campaign', players: [P('h', 'Asha', 0), P('me', 'Claude', 1)] });
    expect((await err(two.s, 'chat', { text: 'x' })).code).toBe('NEGOTIATION_DISABLED');
  });
  it('opensAt=counting: campaign chat is WRONG_PHASE and says when it opens', async () => {
    const { s } = mk({ status: 'campaign' });
    s.cfg = () => ({ ...cfg, messaging: { mode: 'group', opensAt: 'counting' } });
    const e = await err(s, 'chat', { text: 'x' });
    expect(e.code).toBe('WRONG_PHASE');
    expect(e.message).toMatch(/counting/);
  });
  it('descriptions say chat opens at campaign start (configurable)', () => {
    expect(ACTION_BY_NAME.get('chat')!.description).toMatch(/campaign start \(configurable\)/);
  });
});

// ------------------------------------------------------------------ J: chat view
describe('chat view: to is "everyone" in group mode, names in individual mode', () => {
  const msg = { id: 'm1', from: 'c', to: ['me', 'h', 'd'], text: 'hi', ts: 1 };
  it('group (default)', async () => {
    const { s } = mk({ status: 'counting' });
    s.client.state.chat = [msg];
    const r = await ok(s, 'get_chat');
    expect(r.messages[0].to).toBe('everyone');
    push(s, { type: 'chat', message: { ...msg, id: 'm2' } });
    const ev = await ok(s, 'wait_for_events', { types: ['chat'], since_cursor: 0, timeout_s: 0 });
    expect(ev.events[0].to).toBe('everyone');
    const sent = await ok(s, 'chat', { text: 'yo' });
    expect(sent.message.to).toBe('everyone');
  });
  it('individual', async () => {
    const { s } = mk({ status: 'counting' });
    s.cfg = () => ({ ...cfg, messaging: { mode: 'individual', opensAt: 'campaign' } });
    s.client.state.chat = [msg];
    expect((await ok(s, 'get_chat')).messages[0].to).toEqual(['Party Claude', 'Party Asha', 'Party Dev']);
  });
});

// ------------------------------------------------------------------ K: set_party clashes
describe('set_party clashes', () => {
  const args = { name: 'Blue Wave', colour: PARTY_COLOURS[0].hex, symbol: PARTY_SYMBOLS[3].id, avatar: AVATARS[2].id };
  const clash = (code: string) => new AgentError(code as never, `${code} from server`);
  it.each(['NAME_TAKEN', 'COLOUR_TAKEN', 'SYMBOL_TAKEN', 'AVATAR_TAKEN'])('%s: refreshes the lobby and rethrows the same code listing the FREE options', async (code) => {
    const { s, c } = mk({ status: 'lobby' });
    (c.setParty as any).mockRejectedValueOnce(clash(code));
    const e = await err(s, 'set_party', args);
    expect(e.code).toBe(code);
    expect(c.refreshLobby).toHaveBeenCalled();
    // taken by others in players4: colours 0,2,3 ; symbols 0,2,3 ; avatars 0,2,3 -> index 1 is mine, index 4 is free
    expect(e.message).toContain(PARTY_COLOURS[4].label);
    expect(e.message).toContain(PARTY_SYMBOLS[4].id);
    expect(e.message).toContain(AVATARS[4].id);
    expect(e.message).not.toContain(PARTY_COLOURS[2].hex);
    expect(e.message).toMatch(/free colours/i);
  });
  it('auto_pick retries with the first free option for colour / symbol / avatar and returns the final party', async () => {
    const { s, c } = mk({ status: 'lobby' });
    (c.setParty as any).mockRejectedValueOnce(clash('COLOUR_TAKEN')).mockRejectedValueOnce(clash('AVATAR_TAKEN'));
    const r = await ok(s, 'set_party', { ...args, auto_pick: true });
    expect(r.ok).toBe(true);
    expect((c.setParty as any).mock.calls).toHaveLength(3);
    expect(r.party.colour).toBe(PARTY_COLOURS.find((_c, i) => ![0, 2, 3].includes(i))!.hex);
    expect(r.party.avatar).toBe(AVATARS.find((_a, i) => ![0, 2, 3].includes(i))!.id);
    expect(r.party.name).toBe('Blue Wave');
    expect(r.party.symbol).toBe(PARTY_SYMBOLS[3].id);
  });
  it('auto_pick never changes the name, and gives up after 3 retries', async () => {
    const a = mk({ status: 'lobby' });
    (a.c.setParty as any).mockRejectedValueOnce(clash('NAME_TAKEN'));
    expect((await err(a.s, 'set_party', { ...args, auto_pick: true })).code).toBe('NAME_TAKEN');
    expect((a.c.setParty as any).mock.calls).toHaveLength(1);
    const b = mk({ status: 'lobby' });
    (b.c.setParty as any).mockRejectedValue(clash('COLOUR_TAKEN'));
    expect((await err(b.s, 'set_party', { ...args, auto_pick: true })).code).toBe('COLOUR_TAKEN');
    expect((b.c.setParty as any).mock.calls).toHaveLength(4); // first try + 3 retries
  });
  it('auto_pick defaults to false (a clash is reported, not retried)', async () => {
    const { s, c } = mk({ status: 'lobby' });
    (c.setParty as any).mockRejectedValueOnce(clash('COLOUR_TAKEN'));
    await err(s, 'set_party', args);
    expect((c.setParty as any).mock.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ rules text
describe('rules text', () => {
  const text = renderRules(cfg);
  it('RULES: confirmation only at the end of counting, never every party, private offers, chat start, strategy tip', () => {
    expect(text).toMatch(/only once every seat is declared/i);
    expect(text).toMatch(/at least one party must stay out/i);
    expect(text).toMatch(/offers are private/i);
    expect(text).toMatch(/chat opens at the start of the campaign/i);
    expect(text).toMatch(/agree one government early in the group chat/i);
    expect(text).not.toContain('{{');
  });
  it('CHAT_RULE renders the chat start from messaging.opensAt', () => {
    const c = renderRules({ ...cfg, messaging: { mode: 'group', opensAt: 'counting' } });
    expect(c).toMatch(/chat opens when counting starts/i);
    expect(c).not.toMatch(/chat opens at the start of the campaign/i);
  });
  it('tool descriptions, MCP blurb and advice state the same rules', () => {
    for (const n of ['propose_government', 'respond_offer']) {
      expect(ACTION_BY_NAME.get(n)!.description).toMatch(/every seat is declared/i);
    }
    expect(ACTION_BY_NAME.get('propose_government')!.description).toMatch(/at least one party must stay out/i);
    expect(ACTION_BY_NAME.get('list_offers')!.description).toMatch(/private/i);
    expect(SERVER_INSTRUCTIONS + PLAY_PROMPT()).toMatch(/every seat is declared/i);
  });
  it('counting advice mentions the rules', async () => {
    const { s } = mk({ status: 'counting' });
    const adv = (await ok(s, 'get_state')).advice.join(' ');
    expect(adv).toMatch(/every seat is declared/i);
    expect(adv).toMatch(/at least one party/i);
  });
  it('result meaning for a coalition mentions the end-of-counting confirmation', async () => {
    const { s } = mk({ status: 'finished' });
    s.client.state.snapshot!.result = { outcome: 'coalition', tally: { h: 3 }, government: null, points: [], winners: ['h'] } as never;
    expect((await ok(s, 'get_state')).result.meaning).toMatch(/every seat was declared|end of counting/i);
  });
});

// ------------------------------------------------------------------ leftovers
describe('playtest leftovers', () => {
  it('CLI next-hint and DAEMON hint use the node bin path, not npx tsx', () => {
    expect(nextHint('Bot')).toContain('node game/agent/bin/cli.mjs get_rules --name Bot');
    expect(nextHint('Bot')).not.toMatch(/npx tsx/);
  });
  it('phaseClosed events with 3 phases show 1-based phases and update polled_phases', async () => {
    const { s } = mk({ status: 'campaign' });
    push(s, { type: 'phaseClosed', phase: 0, seats: [1, 2, 3] });
    push(s, { type: 'phaseClosed', phase: 1, seats: [4, 5] });
    push(s, { type: 'phaseClosed', phase: 2, seats: [6] });
    const r = await ok(s, 'wait_for_events', { types: ['phaseClosed'], since_cursor: 0, timeout_s: 0 });
    expect(r.events.map((e: any) => [e.type, e.phase, e.seats_polled])).toEqual([['phaseClosed', 1, 3], ['phaseClosed', 2, 2], ['phaseClosed', 3, 1]]);
    expect((await ok(s, 'get_state')).polled_phases).toEqual([1, 2, 3]);
  });
  it('tally and results are keyed by party name, never by nickname, even when two players share a nickname', async () => {
    const ps = [P('h', 'Sam', 0, { party: { name: 'Blue', colour: PARTY_COLOURS[0].hex, symbol: PARTY_SYMBOLS[0].id, avatar: AVATARS[0].id } }),
      P('me', 'Sam', 1, { party: { name: 'Green', colour: PARTY_COLOURS[1].hex, symbol: PARTY_SYMBOLS[1].id, avatar: AVATARS[1].id } }),
      P('c', 'Sam', 2, { party: { name: 'Red', colour: PARTY_COLOURS[2].hex, symbol: PARTY_SYMBOLS[2].id, avatar: AVATARS[2].id } })];
    const { s } = mk({ status: 'counting', players: ps, tally: tally({ h: 5, me: 3, c: 2 }, { h: 6, me: 4, c: 3 }) });
    const st = await ok(s, 'get_state');
    const names = ps.map((p) => p.party!.name);
    expect(new Set(names).size).toBe(3);
    expect(Object.keys(st.tally.by_party).sort()).toEqual([...names].sort());
    expect(JSON.stringify(st.tally)).not.toContain('"Sam"');
    s.client.state.snapshot!.result = { outcome: 'coalition', tally: { h: 5, me: 3, c: 2 }, government: null, points: [], winners: ['h'] } as never;
    const res = (await ok(s, 'get_state')).result;
    expect(Object.keys(res.seats).sort()).toEqual([...names].sort());
    expect(JSON.stringify(res)).not.toContain('"Sam"');
  });
  it('get_state uses `tally`, never `live_tally`', async () => {
    const { s } = mk({ status: 'counting', tally: tally({ h: 1 }) });
    const st = await ok(s, 'get_state');
    expect(st.tally).toBeDefined();
    expect(JSON.stringify(st)).not.toContain('live_tally');
  });
});
