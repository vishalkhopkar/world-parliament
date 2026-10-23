import type { MapConfig } from '../mapConfig';
import type { CommittedView } from '../protocol';
import type { CommittedSet, GameMapPackage, PlayerId, SeatId } from '../types';
import type { Committed, Kernels, Rng } from './types';

/** Percent of each seat already committed by the given sets (sum over parties, seat id -> %). */
export function committedTotals(sets: Iterable<CommittedSet>, cfg: MapConfig): Map<SeatId, number> {
  const tot = new Map<SeatId, number>();
  for (const set of sets) {
    for (const cs of set.seats) {
      const b = cfg.committed.bands[cs.band - 1];
      if (b) tot.set(cs.seat, (tot.get(cs.seat) ?? 0) + b.percent);
    }
  }
  return tot;
}

/**
 * Deal one party's committed voters (dealing is sequential, one player at a time; `others` = sets dealt earlier in this game).
 * Core = uniformly random seat that is not the core of any `others` (throws if every seat is a core). Then a breadth-first walk
 * over seat neighbours from the core, level by level; inside a level seats are ordered by great-circle distance to the core,
 * ties broken at random. Bands are filled in order along that walk (band 1 takes the first bands[0].seats seats, core included,
 * band 2 the next ...). Each seat is tried once, for the current band: if it would take the seat's committed total (all parties)
 * above cfg.committed.seatMaxPercent it is skipped for good (the walk still passes through it). A small map just gets shorter
 * bands. RNG: one draw for the core, then one tiebreak draw per seat of each level when the level is reached (stops when full).
 */
export function dealCommitted(map: GameMapPackage, kernels: Kernels, cfg: MapConfig, others: CommittedSet[], rng: Rng): CommittedSet {
  const n = kernels.n;
  const taken = new Set(others.map((o) => o.core));
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!taken.has(kernels.seatIds[i])) free.push(i);
  if (!free.length) throw new Error('every seat is already the core of another party');
  const core = free[Math.min(free.length - 1, Math.floor(rng() * free.length))];

  const total = committedTotals(others, cfg);
  const adj: number[][] = new Array(n);
  for (const s of map.seats) {
    const i = kernels.index.get(s.id);
    if (i === undefined) continue;
    adj[i] = s.neighbours.map((id) => kernels.index.get(id)).filter((j): j is number => j !== undefined);
  }
  const { bands, seatMaxPercent } = cfg.committed;
  const out: CommittedSet = { core: kernels.seatIds[core], seats: [] };
  let b = 0;
  let inBand = 0;
  const skipEmpty = () => { while (b < bands.length && inBand >= bands[b].seats) { b++; inBand = 0; } };
  skipEmpty();

  const seen = new Uint8Array(n);
  seen[core] = 1;
  let level = [core];
  while (level.length && b < bands.length) {
    if (level.length > 1) {
      const tb = new Map(level.map((i) => [i, rng()] as const));
      level.sort((x, y) => kernels.distanceKm[core * n + x] - kernels.distanceKm[core * n + y] || (tb.get(x) as number) - (tb.get(y) as number));
    }
    for (const i of level) {
      if (b >= bands.length) break;
      const id = kernels.seatIds[i];
      if ((total.get(id) ?? 0) + bands[b].percent <= seatMaxPercent) {
        out.seats.push({ seat: id, band: b + 1 });
        inBand++;
        skipEmpty();
      }
    }
    const next: number[] = [];
    for (const i of level) for (const j of adj[i] ?? []) if (!seen[j]) { seen[j] = 1; next.push(j); }
    level = next;
  }
  return out;
}

/** Fractions (percent/100) per player and seat index; sets for seats outside the kernels are ignored. */
export function committedMatrix(sets: Iterable<[PlayerId, CommittedSet]>, kernels: Kernels, cfg: MapConfig): Committed {
  const m: Committed = new Map();
  for (const [p, set] of sets) {
    const v = new Float64Array(kernels.n);
    for (const cs of set.seats) {
      const i = kernels.index.get(cs.seat);
      const b = cfg.committed.bands[cs.band - 1];
      if (i !== undefined && b) v[i] += b.percent / 100;
    }
    m.set(p, v);
  }
  return m;
}

/** What the owner sees: one entry per committed seat (walk order), [] when nothing was dealt. */
export function committedView(set: CommittedSet | undefined, cfg: MapConfig): CommittedView[] {
  if (!set) return [];
  const out: CommittedView[] = [];
  for (const cs of set.seats) {
    const b = cfg.committed.bands[cs.band - 1];
    if (b) out.push({ seat: cs.seat, band: cs.band, percent: b.percent, level: b.level });
  }
  return out;
}
