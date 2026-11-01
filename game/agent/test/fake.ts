// Offline fake session (no network): a joined, admitted player "me" in a 4-party game, with mockable client calls.
import { vi } from 'vitest';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG, majorityOf } from '@hp/shared';
import type { ChatMessage, CoalitionOffer, FieldedCandidate, GameSnapshot, GameTimeline, PlayerPublic } from '@hp/shared';
import { executeAction, formatResultText } from '../src/actions';
import { loadGamePackage, loadSeatNames } from '../src/gamePackage';
import { SeatDirectory } from '../src/resolve';
import { AgentSession } from '../src/session';
import { applyMessage } from '../src/state';

export const cfg = WORLD_CONFIG;
let dirCache: SeatDirectory | null = null;
export async function seatDir(): Promise<SeatDirectory> {
  return (dirCache ??= new SeatDirectory((await loadGamePackage('world-500'))!, loadSeatNames('world-500')));
}

export const P = (id: string, nick: string, i: number, over: Partial<PlayerPublic> = {}): PlayerPublic => ({
  playerId: id, nickname: nick, isAdmin: id === 'h', kind: id === 'h' ? 'human' : 'agent', status: 'active',
  party: { name: `Party ${nick}`, colour: PARTY_COLOURS[i].hex, symbol: PARTY_SYMBOLS[i].id, avatar: AVATARS[i].id }, ...over,
});
export const players4 = (): PlayerPublic[] => [P('h', 'Asha', 0), P('me', 'Claude', 1), P('c', 'Codex', 2), P('d', 'Dev', 3)];

export interface FakeOpts {
  status?: GameSnapshot['status'];
  players?: PlayerPublic[];
  offers?: CoalitionOffer[];
  tally?: GameSnapshot['tally'];
  government?: GameSnapshot['government'];
  budget?: number;
  /** offsets (ms from now) of the three phase closes, campaign end, counting end, post-counting end */
  timeline?: GameTimeline;
  phases?: number;
  /** A 3+ player game: status 'preCampaign' (unless `status` says otherwise) and a timeline with preCampaignEnd 90 s ahead. */
  preCampaign?: boolean;
  /** seat -> candidates (public). Only meaningful with preCampaign. */
  fielding?: Record<number, FieldedCandidate[]>;
  /** players who pressed Done fielding (only meaningful with preCampaign) */
  fieldingDone?: string[];
}

export function fakeSession(dir: SeatDirectory, opts: FakeOpts = {}) {
  const s = new AgentSession({ seats: dir });
  const c = s.client;
  const now = Date.now();
  const closes = [now + 100_000, now + 200_000, now + 300_000];
  const pre = !!opts.preCampaign;
  const list = opts.players ?? players4();
  c.session = { server: 'http://x', gameId: 'g', playerId: 'me', token: 't', nickname: 'Claude' };
  c.state.gameId = 'g'; c.state.me = 'me'; c.state.joinCode = 'ABC123';
  c.state.snapshot = {
    gameId: 'g', mapId: 'world-500', status: opts.status ?? (opts.preCampaign ? 'preCampaign' : 'campaign'), phases: opts.phases ?? 3, players: list, news: [], polledPhases: [], seats: {},
    fielding: opts.fielding ?? {}, fieldingDone: opts.fieldingDone ?? [], contestedSeats: opts.fielding ? Object.keys(opts.fielding).length : cfg.seatCount,
    majority: majorityOf(opts.fielding ? Object.keys(opts.fielding).length : cfg.seatCount),
    tally: opts.tally ?? null, offers: opts.offers ?? [], government: opts.government ?? null, result: null,
    timeline: opts.timeline ?? { ...(pre && opts.status !== 'campaign' ? { preCampaignEnd: now + 90_000 } : pre ? { preCampaignEnd: now - 5000 } : {}), campaignStart: pre && opts.status !== 'campaign' ? now + 95_000 : now - 1000, phaseCloses: closes, campaignEnd: closes[2], countingEnd: closes[2] + 60_000, postCountingEnd: closes[2] + 120_000 },
  };
  c.state.priv = { you: 'me', budget: opts.budget ?? cfg.budget, myActions: [], myReports: [] };
  const calls: Record<string, unknown[][]> = {};
  c.chat = vi.fn(async (to: string[], text: string) => { (calls.chat ??= []).push([to, text]); return { id: 'm1', from: 'me', to, text, ts: Date.now() } as ChatMessage; }) as never;
  c.withdrawOffer = vi.fn(async (id: string) => { (calls.withdraw ??= []).push([id]); return { ...(opts.offers ?? []).find((o) => o.offerId === id)!, status: 'withdrawn' } as CoalitionOffer; }) as never;
  // the server's behaviour for a field / withdraw message: skip what does not apply, charge or refund, answer fieldAck + fieldingUpdate
  const fieldLike = (kind: 'field' | 'withdraw') => vi.fn(async (seats: number[]) => {
    (calls[kind] ??= []).push([seats]);
    const f = c.state.snapshot!.fielding;
    const has = (seat: number) => (f[seat] ?? []).some((x) => x.playerId === 'me');
    const todo = seats.filter((seat) => (kind === 'field' ? !has(seat) : has(seat)));
    const added = kind === 'field' ? todo.map((seat) => ({ seat, name: `Candidate ${seat}` })) : [];
    const removed = kind === 'withdraw' ? todo : [];
    const budget = c.state.priv!.budget + (removed.length - added.length) * cfg.costs.candidate;
    applyMessage(c.state, { type: 'fieldAck', ok: true, budget, added, removed }, Date.now());
    const contested = Object.keys(c.state.snapshot!.fielding).length;
    applyMessage(c.state, { type: 'fieldingUpdate', playerId: 'me', added, removed, contestedSeats: contested, majority: majorityOf(contested) }, Date.now());
    return { budget, added, removed };
  });
  c.fieldCandidates = fieldLike('field') as never;
  c.withdrawCandidates = fieldLike('withdraw') as never;
  // the server's behaviour for doneFielding: answer everybody with fieldingDone (needed = the active players, as the server counts connected ones)
  c.doneFielding = vi.fn(async (done = true) => {
    (calls.done ??= []).push([done]);
    const needed = c.state.snapshot!.players.filter((p) => p.status === 'active').length;
    const ids = (c.state.snapshot!.fieldingDone ?? []).filter((x) => x !== 'me');
    const doneCount = ids.length + (done ? 1 : 0);
    applyMessage(c.state, { type: 'fieldingDone', playerId: 'me', done, doneCount, needed }, Date.now());
    return { done, doneCount, needed };
  }) as never;
  c.respondOffer = vi.fn(async (id: string, accept: boolean) => { (calls.respondOffer ??= []).push([id, accept]); return null; }) as never;
  c.setParty = vi.fn(async (party: unknown) => { (calls.setParty ??= []).push([party]); }) as never;
  c.refreshLobby = vi.fn(async () => ({ gameId: 'g', joinCode: 'ABC123', mapId: 'world-500', phases: 3, status: 'lobby', admissionOpen: true, you: 'me', players: list })) as never;
  return { s, c, calls, now };
}

export const offerOf = (id: string, over: Partial<CoalitionOffer> = {}): CoalitionOffer => ({
  offerId: id, proposer: 'h', portfolios: { PM: ['h'], HOME: ['me'] }, partners: ['me'], accepted: [], status: 'open', createdAt: 1, ...over,
});

export const ok = async (s: AgentSession, name: string, args: unknown = {}) => {
  const r = await executeAction(s, name, args);
  if (!r.ok) throw new Error(formatResultText(r));
  return r.data as any;
};
export const err = async (s: AgentSession, name: string, args: unknown = {}) => {
  const r = await executeAction(s, name, args);
  if (r.ok) throw new Error(`${name} should have failed, returned ${JSON.stringify(r.data).slice(0, 150)}`);
  return r.error;
};
