// Real dev server (in-process), a scripted human host, and two AI players driven ONLY through the shared action table.
// Rules: 3+ players start in a timed pre-campaign (field_candidates / withdraw_candidates, no candidate = eliminated, campaigning only where fielded);
// a 2-player game has no pre-campaign and starts its campaign on budget - seats x candidate price; a rematch of a 3+ player game starts in the pre-campaign.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORLD_CONFIG, fullyFieldedBudget } from '@hp/shared';
import type { DevServer } from '../../server/src/local/devServer';
import { AgentSession } from '../src/session';
import { Human, call, callErr, sleep, startServer, until } from './helpers';

import { enableReportsForFile } from './reportsFlag';

enableReportsForFile();
let srv: DevServer;
let base: string;
const sessions: AgentSession[] = [];
const agent = (): AgentSession => {
  const s = new AgentSession({ server: base, reconnectBaseMs: 100, pingMs: 5000 });
  sessions.push(s);
  return s;
};

beforeAll(async () => { ({ srv, base } = await startServer()); });
const humans: Human[] = [];
afterAll(async () => { for (const s of sessions) s.client.close(); for (const h of humans) h.close(); await srv.close(); });

describe('AI agents join and play through the action table', () => {
  it('full game: join, admission, parties, campaign_batch, reports, chat, coalition, result', async () => {
    const human = await new Human(base).create('Asha', 2);
    humans.push(human);

    // an agent can never host: the server refuses a create request that claims kind:'agent'
    const forbidden = await human.api('POST', '/games', { nickname: 'Bot', mapId: 'world-500', phases: 2, kind: 'agent' }, '');
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.error).toBe('FORBIDDEN');

    const A = agent();
    const B = agent();
    // not joined yet: clear error text
    expect((await callErr(A, 'campaign', { type: 'rally', seat: 1 })).code).toBe('NOT_JOINED');

    // ---- join (pending) + wait_for_admission while the human admits
    const joinA = await call(A, 'join_game', { join_code: human.joinCode.toLowerCase(), nickname: 'Claude' });
    expect(joinA.status).toBe('pending');
    expect(joinA.hint).toMatch(/wait_for_admission/);
    const joinB = await call(B, 'join_game', { join_code: human.joinCode, nickname: 'Codex' });
    expect(joinB.status).toBe('pending');
    expect((await callErr(A, 'join_game', { join_code: human.joinCode, nickname: 'Again' })).code).toBe('ALREADY_JOINED');
    expect((await callErr(A, 'set_party', { name: 'Blue Wave', colour: 'Blue', symbol: 'globe', avatar: 'xi' })).code).toBe('NOT_ADMITTED');

    const waitA = call(A, 'wait_for_admission', { timeout_s: 20 });
    const waitB = call(B, 'wait_for_admission', { timeout_s: 20 });
    await until(async () => (await human.pending()).length === 2, 5000, 'two pending agents');
    const pending = await human.pending();
    expect(pending.every((p) => p.kind === 'agent')).toBe(true); // the host sees the robot badge data
    for (const p of pending) expect((await human.admit(p.playerId)).status).toBe(200);
    expect((await waitA).status).toBe('admitted');
    expect((await waitB).status).toBe('admitted');

    // ---- parties (same REST call as the UI)
    const opts = await call(A, 'list_party_options');
    expect(opts.colours.length).toBeGreaterThanOrEqual(10);
    expect(opts.symbols.length).toBeGreaterThanOrEqual(10);
    expect(Array.isArray(opts.avatars)).toBe(true);
    const pa = await call(A, 'set_party', { name: 'Blue Wave', colour: '#1F5FBF', symbol: 'Globe', avatar: 'Modi' });
    expect(pa.ok).toBe(true);
    // uniqueness is enforced like for humans, with a readable hint
    const dup = await callErr(B, 'set_party', { name: 'Blue Wave', colour: 'Green', symbol: 'leaf', avatar: 'kim' });
    expect(dup.code).toBe('NAME_TAKEN');
    expect(dup.hint).toBeTruthy();
    expect((await callErr(B, 'set_party', { name: 'Green Deal', colour: 'blue', symbol: 'leaf', avatar: 'kim' })).code).toBe('COLOUR_TAKEN');
    expect((await callErr(B, 'set_party', { name: 'Green Deal', colour: 'Green', symbol: 'leaf', avatar: 'modi' })).code).toBe('AVATAR_TAKEN');
    expect((await callErr(B, 'set_party', { name: 'Green Deal', colour: 'Green', symbol: 'leaf' })).code).toBe('INVALID_INPUT'); // avatar is required
    expect((await callErr(B, 'set_party', { name: 'Green Deal', colour: 'Green', symbol: 'leaf', avatar: 'nobody' })).code).toBe('UNKNOWN_OPTION');
    await call(B, 'set_party', { name: 'Green Deal', colour: 'Green', symbol: 'leaf', avatar: 'kim' });
    expect((await human.setParty('Saffron Front', 'saffron', 'sun')).status).toBe(200);

    const lobby = await call(A, 'get_lobby');
    expect(lobby.players.map((p: any) => [p.party, p.kind])).toEqual(expect.arrayContaining([['Saffron Front', 'human'], ['Blue Wave', 'agent'], ['Green Deal', 'agent']]));
    // once parties are set no nickname is exposed anywhere in agent output
    expect(JSON.stringify(lobby)).not.toMatch(/Asha|Claude|Codex/);
    expect(lobby.players.every((p: any) => p.nickname === undefined)).toBe(true);
    expect(lobby.your_admission).toBe('admitted');
    expect(lobby.polling_phases).toBe(2);
    const opts2 = await call(B, 'list_party_options');
    expect(opts2.colours.find((c: any) => c.label === 'Blue').taken_by).toBe('Blue Wave');
    expect(opts2.avatars.find((a: any) => a.id === 'modi').taken_by).toBe('Blue Wave');
    expect(opts2.avatars.find((a: any) => a.id === 'kim').taken_by).toBeNull(); // B's own avatar is not 'taken' for B

    // ---- the human starts the game; agents learn it through events
    const sinceA = A.client.events.cursor;
    const started = await human.start();
    expect(started.status).toBe(200);
    const ev = await call(A, 'wait_for_events', { since_cursor: sinceA, timeout_s: 10, types: ['status'] });
    expect(ev.events.some((e: any) => e.status === 'preCampaign')).toBe(true); // 3 players: the pre-campaign comes first

    // ---- pre-campaign: campaigning is not open yet, candidates are fielded (and are public), chat is one-to-one
    const pre = await call(A, 'get_state');
    expect(pre.status).toBe('preCampaign');
    expect(pre.timers.stage).toBe('preCampaign');
    expect(pre.timers.pre_campaign_left_s).toBeGreaterThan(0);
    expect(pre.budget.wr).toBe(WORLD_CONFIG.budget);
    expect(pre.chat_mode).toBe('INDV');
    expect(pre.advice.join(' ')).toMatch(/URGENT/);
    const tooSoon = await callErr(A, 'campaign', { type: 'roadshow', seat: 1 });
    expect(tooSoon.code).toBe('WRONG_PHASE');
    expect(tooSoon.hint).toMatch(/field_candidates/);
    const fA = await call(A, 'field_candidates', { all: true });
    expect(fA).toMatchObject({ fielded: WORLD_CONFIG.seatCount, skipped: 0, your_candidates: WORLD_CONFIG.seatCount });
    expect(fA.budget_wr).toBe(fullyFieldedBudget(WORLD_CONFIG));
    expect((await call(A, 'field_candidates', { seats: [1, 2] })).fielded).toBe(0); // already fielded: skipped, nothing charged
    await call(B, 'field_candidates', { all: true });
    const heldBack = [50, 51]; // B gives these two up again (refunded in full)
    const wB = await call(B, 'withdraw_candidates', { seats: heldBack });
    expect(wB).toMatchObject({ withdrawn: 2, refunded_wr: 2 * WORLD_CONFIG.costs.candidate, your_candidates: WORLD_CONFIG.seatCount - 2 });
    expect(wB.budget_wr).toBe(fullyFieldedBudget(WORLD_CONFIG) + 2 * WORLD_CONFIG.costs.candidate);
    // fielding is public and live: A sees B's count and who stands in a seat
    await until(async () => (await call(A, 'get_state')).fielding.by_party['Green Deal'] === WORLD_CONFIG.seatCount - 2, 5000, 'A sees the candidates of B');
    const seat50 = await call(A, 'get_seat', { seat: 50 });
    expect(seat50.candidates_here.map((c: any) => c.party)).toEqual(['Blue Wave']);
    expect(seat50.candidates_here[0].you).toBe(true);
    const seat7 = await call(A, 'get_seat', { seat: 7 });
    expect(seat7.candidates_here.map((c: any) => c.party).sort()).toEqual(['Blue Wave', 'Green Deal']);
    const notYet = await call(B, 'list_seats', { not_fielded_only: true, limit: 5 });
    expect(notYet.rows.map((r: any) => r.id)).toEqual(heldBack);
    const preChat = await call(A, 'chat', { to: ['Green Deal'], text: 'You keep the east, I take the west?' });
    expect(preChat.chat_mode).toBe('INDV');
    expect((await callErr(A, 'chat', { text: 'no recipient' })).code).toBe('INVALID_INPUT');
    // done_fielding: refused with no candidate (the host has none yet), then A and B are done: 2 of 3, the host still blocks an early start
    const hostDone0 = await human.done().then(() => 'ok', (e: Error) => e.message);
    expect(hostDone0).toMatch(/BAD_REQUEST/); // the host has no candidate yet
    const dA = await call(A, 'done_fielding');
    expect(dA).toMatchObject({ done: true, done_count: 1, needed: 3 });
    const dB = await call(B, 'done_fielding');
    expect(dB).toMatchObject({ done: true, done_count: 2, needed: 3, progress: '2 of 3 done' });
    expect(dB.waiting_for).toEqual(['Saffron Front']);
    await until(async () => (await call(A, 'get_state')).fielding.done_count === 2, 5000, 'A sees B done');
    expect((await call(A, 'get_state')).fielding).toMatchObject({ you_are_done: true, needed: 3 });
    // the human host fields one seat (a party needs a candidate to stay in the game); a lone seat is enough to stay out of a coalition.
    // The host never presses Done here, so the countdown (not an early start) ends this pre-campaign.
    expect((await human.field([1])).added).toHaveLength(1);

    await until(() => A.client.state.snapshot?.status === 'campaign' && B.client.state.snapshot?.status === 'campaign', 15_000, 'campaign started');
    expect((await callErr(A, 'field_candidates', { seats: [3] })).code).toBe('WRONG_PHASE'); // the line-up is fixed now
    expect((await call(A, 'get_lobby')).players.find((p: any) => p.party === 'Saffron Front').status).toBe('active'); // it had a candidate
    expect((await call(A, 'get_state')).contested_seats).toBe(WORLD_CONFIG.seatCount); // every seat has a Blue Wave candidate

    // ---- campaign fast: batches of rallies and roadshows (names and ids mixed)
    const st0 = await call(A, 'get_state');
    expect(st0.status).toBe('campaign');
    expect(st0.budget.wr).toBe(fullyFieldedBudget(WORLD_CONFIG));
    expect(st0.you.party).toBe('Blue Wave');
    expect(st0.you.nickname).toBeUndefined();
    const open = await call(A, 'list_seats', { open_only: true, fielded_only: true, limit: 100, phase: 2 });
    expect(open.rows.length).toBe(100);
    const phase2 = open.rows.map((r: any) => r.id as number);

    const t0 = Date.now();
    const batchA = await call(A, 'campaign_batch', {
      actions: [{ type: 'rally', seat: phase2[0] }, ...phase2.slice(1, 21).map((id: number) => ({ type: 'roadshow', seat: id }))],
    });
    expect(batchA.sent).toBe(21);
    expect(batchA.failed).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(batchA.budget_wr).toBe(fullyFieldedBudget(WORLD_CONFIG) - WORLD_CONFIG.costs.rally - 20 * WORLD_CONFIG.costs.roadshow);

    const named = await call(B, 'get_seat', { seat: phase2[30] });
    const batchB = await call(B, 'campaign_batch', {
      actions: [{ type: 'roadshow', seat: named.name }, { type: 'rally', seat: phase2[40] }, { type: 'roadshow', seat: phase2[41] }, { type: 'minorRally', seat: phase2[42] }],
    });
    expect(batchB.sent).toBe(4);
    expect(batchB.results[0].seat_name).toBe(named.name);

    // single campaign + local overspend rejection + unknown seat
    const one = await call(B, 'campaign', { type: 'roadshow', seat: phase2[50] });
    expect(one.ok).toBe(true);
    // B rallied a moment ago: more rallies fail locally with RATE_LIMITED (nothing sent or charged)
    const tooMany = await call(B, 'campaign_batch', { actions: Array.from({ length: 50 }, (_, i) => ({ type: 'rally', seat: phase2[i % 40] })) });
    expect(tooMany.failed).toBe(50);
    expect(tooMany.results.find((r: any) => !r.ok).error.code).toBe('RATE_LIMITED');
    expect((await callErr(B, 'campaign', { type: 'rally', seat: 'Atlantis' })).code).toBe('UNKNOWN_SEAT');
    // a minor rally is hidden: mine shows up in my own counts, in nobody's news
    const minor = await call(B, 'get_seat', { seat: phase2[42] });
    expect(minor.my_actions_here.minor_rallies).toBe(1);
    expect(batchB.budget_wr).toBe(fullyFieldedBudget(WORLD_CONFIG) + 2 * WORLD_CONFIG.costs.candidate - WORLD_CONFIG.costs.rally - 2 * WORLD_CONFIG.costs.roadshow - WORLD_CONFIG.costs.minorRally);

    // no candidate, no campaigning: refused locally (nothing sent) ...
    const noCand = await callErr(B, 'campaign', { type: 'roadshow', seat: heldBack[0] });
    expect(noCand.code).toBe('NOT_FIELDED');
    expect(noCand.hint).toMatch(/fielded_only/);
    // ... and by the server itself when the local check is bypassed
    await expect(B.client.campaign('minorRally', heldBack[1])).rejects.toMatchObject({ code: 'NOT_FIELDED' });

    // my own actions and public news (rallies only)
    const stB = await call(B, 'get_state');
    expect(stB.my_actions.roadshows).toBe(3);
    expect(stB.my_actions.minor_rallies).toBe(1);
    expect(stB.my_actions.rallies).toBeGreaterThanOrEqual(1);
    const news = await call(A, 'get_news', {});
    expect(news.total).toBe(2); // the two major rallies only: minor rallies and roadshows are hidden
    expect(news.items.every((n: any) => n.seat !== phase2[42])).toBe(true);
    expect(news.items.every((n: any) => n.what === 'rally')).toBe(true);
    expect(news.items.some((n: any) => n.party.includes('Green Deal'))).toBe(true);

    // ---- analyst reports (seat + global)
    const seatReport = await call(A, 'buy_report', { scope: 'seat', seat: phase2[1] });
    expect(seatReport.report.scope).toBe('seat');
    expect(seatReport.report.entries.length).toBeGreaterThanOrEqual(2);
    expect(seatReport.budget_wr).toBeLessThan(batchA.budget_wr);
    const globalReport = await call(A, 'buy_report', { scope: 'global' });
    expect(globalReport.report.entries[0].est_seats).toBeGreaterThanOrEqual(0);
    expect(globalReport.report.describes_position_seconds_before_purchase).toBeGreaterThanOrEqual(25);

    // ---- reconnect with the same token (drop the socket under A's feet)
    (A.client as any).ws.close();
    await until(() => A.client.state.link === 'reconnecting' || A.client.state.link === 'open', 3000, 'reconnect started');
    await until(() => A.client.state.link === 'open' && (A.client as any).ws?.readyState === 1, 8000, 'reconnected');
    const afterReconnect = await call(A, 'get_state');
    expect(afterReconnect.my_actions.roadshows).toBe(20);
    expect(afterReconnect.budget.wr).toBeLessThan(batchA.budget_wr);

    // ---- wait for the first phase to be polled (event) and the counting phase
    await call(A, 'wait_for_events', { timeout_s: 20, types: ['phaseClosed'] });
    await until(() => A.client.state.snapshot?.status === 'counting', 25_000, 'counting');

    // ---- negotiation: chat + coalition (3 players, humans host does not campaign so A+B hold every seat)
    const cursorB = B.client.events.cursor; // B already holds the pre-campaign message
    const chat = await call(A, 'chat', { to: ['Green Deal'], text: 'Shall we form a government? I will be PM.' });
    expect(chat.sent).toBe(true);
    const gotChat = await call(B, 'wait_for_events', { since_cursor: cursorB, timeout_s: 5, types: ['chat'] });
    expect(gotChat.events[0].text).toMatch(/government/);
    expect(gotChat.events[0].from).toBe('Blue Wave');
    // counting is always: one-to-one, so `to` is the one recipient
    expect(gotChat.events[0].to).toEqual(['Green Deal']);
    expect(gotChat.events[0].chat).toBe('one-to-one');
    const chats = await call(B, 'get_chat', {});
    expect(chats.messages.length).toBe(2); // the pre-campaign message and this one
    expect((await callErr(A, 'chat', { to: ['nobody'], text: 'hi' })).code).toBe('UNKNOWN_PLAYER');

    const prop = await call(A, 'propose_government', { portfolios: { dpm: ['Green Deal'], finance: ['green deal'] } });
    expect(prop.offer.status).toBe('open');
    expect(prop.offer.proposer).toBe('Blue Wave');
    expect(prop.offer.portfolios.PM).toEqual(['Blue Wave']);
    expect((await callErr(A, 'propose_government', { portfolios: { home: ['Codex'] } })).code).toBe('UNKNOWN_PLAYER'); // nicknames are not accepted
    const offerId = prop.offer.offer_id as string;
    const offerEv = await call(B, 'wait_for_events', { timeout_s: 5, types: ['offer'] });
    expect(offerEv.events[0].offer_id).toBe(offerId);
    expect(offerEv.events[0].waiting_for).toEqual(['Green Deal']);
    const offersB = await call(B, 'list_offers', {});
    expect(offersB.offers.map((o: any) => o.offer_id)).toContain(offerId);
    const acc = await call(B, 'respond_offer', { offer_id: offerId, accept: true });
    expect(acc.offer.status).toBe('accepted');
    expect(acc.offer.you_accepted).toBe(true);
    const again = await call(B, 'respond_offer', { offer_id: offerId, accept: true });
    expect(again.note).toMatch(/already/);
    expect((await callErr(A, 'respond_offer', { offer_id: offerId, accept: true })).code).toBe('INVALID_INPUT');
    expect((await callErr(B, 'respond_offer', { offer_id: 'nope', accept: true })).code).toBe('OFFER_NOT_FOUND');

    // ---- result
    const res = await call(A, 'wait_for_events', { timeout_s: 30, types: ['result'] });
    expect(res.events[0].outcome).toBe('coalition');
    expect(res.events[0].winners.length).toBeGreaterThan(0);
    expect(res.events[0].government.pm).toContain('Blue Wave');
    await until(() => B.client.state.snapshot?.status === 'finished', 5000, 'B sees the result');
    const fin = await call(B, 'get_state');
    expect(fin.status).toBe('finished');
    expect(fin.result.points.length).toBe(3);
    expect(fin.government.pm).toContain('Blue Wave');
    expect(fin.advice.join(' ')).toMatch(/wait_for_events/);

    // ---- play again (needs the server's rematch endpoint): agents roll over with party and token, straight into the PRE-campaign (3 players)
    const oldGame = human.gameId;
    const cursorA = A.client.events.cursor;
    const replay = await human.playAgain(2);
    expect(replay.status).toBe(200);
    expect(human.gameId).not.toBe(oldGame);
    const rm = await call(A, 'wait_for_events', { since_cursor: cursorA, timeout_s: 15, types: ['rematch'] });
    expect(rm.events[0]).toMatchObject({ type: 'rematch', game_id: human.gameId, previous_game_id: oldGame });
    await until(() => B.client.session?.gameId === human.gameId && B.client.state.snapshot?.gameId === human.gameId, 10_000, 'B in the new game');
    for (const X of [A, B]) {
      expect(X.client.session?.playerId).toBe(X.client.state.me);
      const st = await call(X, 'get_state');
      expect(st.status).toBe('preCampaign');
      expect(st.you.party).toBeTruthy(); // party kept, no set_party
      expect(st.fielding.your_candidates).toBe(0); // fielding belongs to each game: field again
      expect(st.budget.wr).toBe(WORLD_CONFIG.budget);
    }
    expect(rm.events[0].note).toMatch(/pre-campaign/);
    const plannedStart = A.client.state.snapshot!.timeline!.campaignStart;
    await call(A, 'field_candidates', { seats: [1, 2, 3, 4] });
    await call(A, 'done_fielding');
    await call(A, 'withdraw_candidates', { seats: [4] }); // withdrawing clears my done
    expect((await call(A, 'get_state')).fielding.you_are_done).toBe(false);
    await call(B, 'field_candidates', { seats: [1] });
    await human.field([2]);
    await call(A, 'done_fielding');
    await call(B, 'done_fielding');
    expect((await call(A, 'get_state')).fielding.done_count).toBe(2); // the host is still to press Done
    expect((await human.done()).doneCount).toBe(3); // everybody is done: the campaign starts at once
    await until(() => A.client.state.snapshot?.status === 'campaign', 15_000, 'rematch campaign started');
    expect(A.client.state.snapshot!.timeline!.campaignStart).toBeLessThan(plannedStart); // early start: earlier than the countdown would have allowed
    expect((await callErr(A, 'done_fielding')).code).toBe('WRONG_PHASE');
    const batch = await call(A, 'campaign_batch', { actions: [{ type: 'roadshow', seat: 1 }] });
    expect(batch.results[0].ok).toBe(true);
    expect((await call(A, 'get_state')).contested_seats).toBe(3); // seats 1, 2 and 3 have a candidate; the rest is vacant
    // the session file would now point at the new game
    expect(A.client.session?.gameId).toBe(human.gameId);
  });

  it('2-player game: no pre-campaign, every seat is fielded for you, the campaign starts on budget minus the candidates, minor rallies work', async () => {
    const human = await new Human(base).create('Duo', 1);
    const X = agent();
    await call(X, 'join_game', { join_code: human.joinCode, nickname: 'Solo' });
    await until(async () => (await human.pending()).length === 1, 5000, 'pending agent');
    await human.admit((await human.pending())[0].playerId);
    await call(X, 'wait_for_admission', { timeout_s: 10 });
    await call(X, 'set_party', { name: 'Solo Party', colour: 'Green', symbol: 'leaf', avatar: 'kim' });
    expect((await human.setParty('Duo Party', 'saffron', 'sun')).status).toBe(200);
    const since = X.client.events.cursor;
    expect((await human.start()).status).toBe(200);
    const ev = await call(X, 'wait_for_events', { since_cursor: since, timeout_s: 10, types: ['status'] });
    expect(ev.events.map((e: any) => e.status)).not.toContain('preCampaign');
    await until(() => X.client.state.snapshot?.status === 'campaign', 10_000, 'campaign');
    await until(() => X.client.state.priv?.budget === fullyFieldedBudget(WORLD_CONFIG), 5000, 'budget after the automatic candidates');
    const st = await call(X, 'get_state');
    expect(st.budget.wr).toBe(fullyFieldedBudget(WORLD_CONFIG));
    expect(st.contested_seats).toBe(WORLD_CONFIG.seatCount);
    expect(st.fielding).toBeUndefined();
    const e = await callErr(X, 'field_candidates', { seats: [1] });
    expect(e.code).toBe('WRONG_PHASE');
    expect(e.message).toMatch(/no pre-campaign/);
    const r = await call(X, 'campaign_batch', { actions: [{ type: 'minorRally', seat: 1 }, { type: 'roadshow', seat: 2 }] });
    expect(r.sent).toBe(2);
    expect(r.budget_wr).toBe(fullyFieldedBudget(WORLD_CONFIG) - WORLD_CONFIG.costs.minorRally - WORLD_CONFIG.costs.roadshow);
  });

  it('declined agents are told so; 2-player games have no chat/offers; leave_game forgets the session', async () => {
    const human = await new Human(base).create('Host', 1);
    const X = agent();
    await call(X, 'join_game', { join_code: human.joinCode, nickname: 'Bot' });
    const w = call(X, 'wait_for_admission', { timeout_s: 10 });
    await until(async () => (await human.pending()).length === 1, 5000);
    await human.admit((await human.pending())[0].playerId, false);
    expect((await w).status).toBe('declined');
    await until(() => X.client.state.link === 'closed', 8000, 'link closed after decline');
    expect((await call(X, 'get_state')).admission).toBe('declined');
    expect((await callErr(X, 'set_party', { name: 'Nope', colour: 'blue', symbol: 'sun', avatar: 'xi' })).code).toBe('NOT_ADMITTED');
    const left = await call(X, 'leave_game');
    expect(left.left).toBe(true);
    expect((await call(X, 'get_state')).joined).toBe(false);
    await sleep(10);
    expect((await callErr(X, 'get_lobby')).code).toBe('NOT_JOINED');

    // wrong join code is a clear error
    const Y = agent();
    expect((await callErr(Y, 'join_game', { join_code: 'ZZZZZZ', nickname: 'Bot' })).code).toBe('NOT_FOUND');
  });
});
