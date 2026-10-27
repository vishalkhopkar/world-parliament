// Pure helpers for the guided tour's scripted election: the final seat counts, who owns which seat, and the order in
// which the count is revealed. No React, no store, no clock: everything is a function of its arguments (and a seeded rng),
// so the properties the tour teaches can be unit-tested.
import { majorityOf } from '@hp/shared';
import type { Rng } from '@hp/shared';

/** Number of smaller parties whose support (together with the player) makes up the exact majority. */
export const SMALL_PARTIES = 7;

/** Reference result for 500 seats: largest party, the player, then the seven smaller parties. */
const BASE_YOU_AND_SMALL = [110, 30, 28, 25, 20, 17, 12, 9];
const BASE_YOU_AND_SMALL_SUM = BASE_YOU_AND_SMALL.reduce((a, b) => a + b, 0); // 251

export interface TourCounts {
  /** The single largest party (not the player). Always short of the majority. */
  largest: number;
  /** The player: runner-up. */
  you: number;
  /** The seven smaller parties, descending. */
  small: number[];
}

/**
 * Seat counts of the scripted result for a map of `n` seats (n >= 17).
 * For n = 500: 249 / 110 / 30 28 25 20 17 12 9. The properties hold for every n:
 *   sum = n; largest + you + smalls; largest < majority; you > every small party;
 *   you + ALL seven smaller parties = majority exactly, so dropping any one of them falls short.
 */
export function tourSeatCounts(n: number): TourCounts {
  if (!Number.isInteger(n) || n < 17) throw new Error(`the tour needs a map of at least 17 seats (got ${n})`);
  const maj = majorityOf(n);
  const largest = n - maj; // the rest of the house; always < maj
  const rest = maj; // you + the seven smaller parties
  const weights = BASE_YOU_AND_SMALL.slice(1);
  const small = weights.map(w => Math.max(1, Math.floor((rest * w) / BASE_YOU_AND_SMALL_SUM)));
  let you = rest - small.reduce((a, b) => a + b, 0);
  // the player must stay the runner-up (only matters for tiny maps where the floors round up)
  while (you <= small[0] && small[0] > 1) { small[0]--; you++; small.sort((a, b) => b - a); }
  return { largest, you, small };
}

/** [largest, you, ...small] as one array in party order 0..8 mapped to (A, you, s1..s7): index 0 = you, 1 = largest. */
export function quotasInPartyOrder(c: TourCounts): number[] {
  return [c.you, c.largest, ...c.small];
}

// ------------------------------------------------------------------------------------------------ seat assignment
export interface SeatNode { id: number; x: number; y: number; neighbours: number[] }

const d2 = (a: SeatNode, b: SeatNode) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * Pick `count` cores for the other parties: well spread out, away from the player's committed seats, and never an
 * island with fewer than two neighbours (it could not grow). Farthest-point sampling in map coordinates.
 */
export function pickCores(seats: SeatNode[], mineSeats: ReadonlySet<number>, count: number): number[] {
  const mine = seats.filter(s => mineSeats.has(s.id));
  const cand = seats.filter(s => !mineSeats.has(s.id) && s.neighbours.length >= 2);
  const pool = cand.length >= count ? cand : seats.filter(s => !mineSeats.has(s.id));
  const picked: SeatNode[] = [];
  const dist = (s: SeatNode) => {
    let best = Infinity;
    for (const o of mine) best = Math.min(best, d2(s, o));
    for (const o of picked) best = Math.min(best, d2(s, o));
    return best;
  };
  while (picked.length < count && pool.length > picked.length) {
    let best: SeatNode | undefined;
    let bestD = -1;
    for (const s of pool) {
      if (picked.includes(s)) continue;
      const d = dist(s);
      if (d > bestD || (d === bestD && best && s.id < best.id)) { best = s; bestD = d; }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked.map(s => s.id);
}

/**
 * Quota-limited multi-source region growing. `quotas[p]` seats for party p (they must add up to the number of seats),
 * `cores[p]` = its first seat, `pre` = seats already given to a party (the player's committed seats).
 * Parties grow together, each step going to the party that is furthest behind its quota (so big parties grow faster),
 * taking the unclaimed neighbouring seat nearest its core. Seats left over (islands, enclosed parties) go to the nearest
 * party that still has quota left. Returns seat id -> party index and hits every quota exactly.
 */
export function assignSeats(
  seats: SeatNode[], quotas: number[], cores: number[], pre: ReadonlyMap<number, number> = new Map(),
): Map<number, number> {
  const total = quotas.reduce((a, b) => a + b, 0);
  if (total !== seats.length) throw new Error(`quotas (${total}) must add up to the seat count (${seats.length})`);
  if (cores.length !== quotas.length) throw new Error('one core per party');
  const byId = new Map(seats.map(s => [s.id, s] as const));
  const owner = new Map<number, number>();
  const got = quotas.map(() => 0);
  const mine: number[][] = quotas.map(() => []);
  const frontier: Set<number>[] = quotas.map(() => new Set<number>());

  const addFrontier = (p: number, id: number) => {
    for (const nb of byId.get(id)?.neighbours ?? []) if (byId.has(nb) && !owner.has(nb)) frontier[p].add(nb);
  };
  const claim = (p: number, id: number) => {
    owner.set(id, p); got[p]++; mine[p].push(id);
    for (const f of frontier) f.delete(id);
    addFrontier(p, id);
  };

  for (const [id, p] of pre) if (byId.has(id) && !owner.has(id) && got[p] < quotas[p]) claim(p, id);
  quotas.forEach((q, p) => { if (q > 0 && got[p] < q && !owner.has(cores[p]) && byId.has(cores[p])) claim(p, cores[p]); });

  for (;;) {
    let pick = -1;
    let ratio = Infinity;
    for (let p = 0; p < quotas.length; p++) {
      if (got[p] >= quotas[p] || frontier[p].size === 0) continue;
      const r = got[p] / quotas[p];
      if (r < ratio) { ratio = r; pick = p; }
    }
    if (pick < 0) break;
    const core = byId.get(cores[pick]) ?? byId.get(mine[pick][0])!;
    let best = -1;
    let bestD = Infinity;
    for (const id of frontier[pick]) {
      const d = d2(byId.get(id)!, core);
      if (d < bestD || (d === bestD && id < best)) { best = id; bestD = d; }
    }
    claim(pick, best);
  }

  // leftovers: nearest party that still has quota (distance to any seat it already owns)
  const left = seats.filter(s => !owner.has(s.id)).sort((a, b) => a.id - b.id);
  for (const s of left) {
    let pick = -1;
    let bestD = Infinity;
    for (let p = 0; p < quotas.length; p++) {
      if (got[p] >= quotas[p]) continue;
      let d = Infinity;
      for (const id of mine[p]) d = Math.min(d, d2(s, byId.get(id)!));
      if (mine[p].length === 0) d = 1e18;
      if (d < bestD) { bestD = d; pick = p; }
    }
    claim(pick, s.id);
  }
  return owner;
}

// ------------------------------------------------------------------------------------------------ the count
export interface RevealEvent {
  /** Virtual counting time in ms (0 = counting starts). */
  t: number;
  seat: number;
  status: 'leading' | 'won';
  /** Party index (the order of `truth`'s values). */
  party: number;
}

export interface RevealPlan {
  events: RevealEvent[];
  /** The count stops here until the government is agreed. At this moment every seat leads (or has won) its true winner. */
  pauseMs: number;
  /** Everything is declared at this time. */
  endMs: number;
}

export interface RevealOptions {
  pauseMs: number;
  resumeMs: number;
  /** Share of the seats confirmed (won) by the pause. */
  confirmedFraction?: number;
  /** Strongest first: seat -> margin of the winner over the runner-up (decides which seats are confirmed first). */
  margin?: (seat: number) => number;
}

/**
 * Reveal schedule. Before the pause: every seat gets a first lead (often a wrong one) at a random time, may flip once or
 * twice, and from `finalLeadBy` it leads its true winner; `confirmedFraction` of the seats (the safest ones) are confirmed
 * too. After the pause the rest are confirmed, safest first, the last one exactly at `endMs`.
 */
export function buildReveal(truth: ReadonlyMap<number, number>, parties: number, rng: Rng, o: RevealOptions): RevealPlan {
  const { pauseMs, resumeMs } = o;
  const frac = o.confirmedFraction ?? 0.6;
  const seats = [...truth.keys()].sort((a, b) => a - b);
  const keyed = seats.map(s => ({ s, key: (o.margin?.(s) ?? 0) + 0.35 * rng() })).sort((a, b) => b.key - a.key);
  const nConfirmed = Math.round(seats.length * frac);
  const events: RevealEvent[] = [];
  const wrongParty = (not: number[]) => {
    let p = Math.floor(rng() * parties);
    for (let i = 0; i < parties && not.includes(p); i++) p = (p + 1) % parties;
    return p;
  };
  keyed.forEach(({ s }, rank) => {
    const win = truth.get(s)!;
    const confirmed = rank < nConfirmed;
    const wonAt = confirmed ? pauseMs * (0.4 + 0.58 * (nConfirmed > 1 ? rank / (nConfirmed - 1) : 1)) : Infinity;
    const lastLead = Math.min(confirmed ? wonAt - 150 : pauseMs * (0.55 + 0.4 * rng()), pauseMs * 0.95);
    const first = Math.max(30, pauseMs * (0.03 + 0.4 * rng()));
    // a noisy history ending in the truth
    const flips = rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 2);
    let t = Math.min(first, lastLead - 100 * (flips + 1));
    t = Math.max(30, t);
    const seq: { t: number; party: number }[] = [];
    let prev = -1;
    for (let i = 0; i < flips; i++) {
      const p = wrongParty([win, prev]);
      seq.push({ t, party: p }); prev = p;
      t += Math.max(60, (lastLead - t) * (0.25 + 0.4 * rng()));
    }
    seq.push({ t: Math.min(Math.max(t, 30), lastLead), party: win });
    for (let i = 1; i < seq.length; i++) if (seq[i].t <= seq[i - 1].t) seq[i].t = seq[i - 1].t + 20;
    for (const e of seq) events.push({ t: Math.round(e.t), seat: s, status: 'leading', party: e.party });
    if (confirmed) events.push({ t: Math.round(wonAt), seat: s, status: 'won', party: win });
  });
  const rest = keyed.slice(nConfirmed);
  rest.forEach(({ s }, i) => {
    const t = pauseMs + (rest.length > 1 ? resumeMs * ((i + 1) / rest.length) : resumeMs);
    events.push({ t: Math.round(i === rest.length - 1 ? pauseMs + resumeMs : t), seat: s, status: 'won', party: truth.get(s)! });
  });
  events.sort((a, b) => a.t - b.t || (a.status === 'leading' ? -1 : 1));
  return { events, pauseMs, endMs: pauseMs + resumeMs };
}

/** What a count looks like after replaying the events up to `upTo` (virtual ms): seat -> latest declaration. */
export function replayReveal(plan: RevealPlan, upTo: number): Map<number, { status: 'leading' | 'won'; party: number }> {
  const out = new Map<number, { status: 'leading' | 'won'; party: number }>();
  for (const e of plan.events) {
    if (e.t > upTo) break;
    if (out.get(e.seat)?.status === 'won') continue;
    out.set(e.seat, { status: e.status, party: e.party });
  }
  return out;
}
