import type { Action, ActionType, GameTimeline } from '@hp/shared';
import type { World } from './world';

/**
 * Incremental mirror of the engine's computeEffects (same arithmetic), plus per-component tracking the bots and
 * metrics need. Verified against the engine at the end of each game when `verify` is on.
 */
export class State {
  readonly P: number;
  readonly n: number;
  readonly close: Float64Array;      // absolute close time (ms) of each seat's phase
  readonly eff: Float64Array[];      // true total effect, per player
  readonly road: Float64Array[];     // roadshow-only effect
  readonly cEff: Float64Array[];     // global-constant-only effect
  readonly pub: Float64Array[];      // publicly visible effect = every rally (incl. c), per player
  readonly pubTotal: Float64Array;   // sum of pub over players
  readonly visitedRoad: Uint8Array[];
  readonly rallied: Uint8Array[];
  readonly actions: Action[] = [];
  private seq = 0;

  constructor(readonly w: World, readonly timeline: GameTimeline, readonly k: number, P: number) {
    this.P = P;
    this.n = w.n;
    const n = w.n;
    this.close = new Float64Array(n).fill(Infinity);
    const ps = w.phaseSeats.get(k) as number[][];
    ps.forEach((g, p) => { for (const i of g) this.close[i] = timeline.phaseCloses[p]; });
    const mk = () => Array.from({ length: P }, () => new Float64Array(n));
    this.eff = mk(); this.road = mk(); this.cEff = mk(); this.pub = mk();
    this.pubTotal = new Float64Array(n);
    this.visitedRoad = Array.from({ length: P }, () => new Uint8Array(n));
    this.rallied = Array.from({ length: P }, () => new Uint8Array(n));
  }

  isOpen(i: number, ts: number): boolean { return this.close[i] > ts; }

  mult(ts: number): number {
    const { start, end } = this.w.cfg.timeMultiplier;
    const span = this.timeline.campaignEnd - this.timeline.campaignStart;
    let t = span <= 0 ? 1 : (ts - this.timeline.campaignStart) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return start + (end - start) * t;
  }

  /** Apply an action by player p at seat index i at time ts. Returns false (no change) if the seat is frozen. */
  apply(p: number, type: ActionType, i: number, ts: number): boolean {
    if (!(this.close[i] > ts)) return false;
    const n = this.n;
    const m = this.mult(ts);
    const c = this.w.cfg.effects.rally.global;
    const eff = this.eff[p];
    const close = this.close;
    if (type === 'rally') {
      const row = this.w.rallyRows[i];
      const cE = this.cEff[p];
      const pb = this.pub[p];
      const pt = this.pubTotal;
      for (let j = 0; j < n; j++) {
        if (close[j] > ts) {
          const v = c * m;
          eff[j] += v; cE[j] += v; pb[j] += v; pt[j] += v;
        }
      }
      for (let q = 0; q < row.idx.length; q++) {
        const j = row.idx[q];
        if (close[j] > ts) {
          const v = row.w[q] * m;
          eff[j] += v; pb[j] += v; pt[j] += v;
        }
      }
      this.rallied[p][i] = 1;
    } else {
      const row = this.w.roadRows[i];
      const rd = this.road[p];
      for (let q = 0; q < row.idx.length; q++) {
        const j = row.idx[q];
        if (close[j] > ts) {
          const v = row.w[q] * m;
          eff[j] += v; rd[j] += v;
        }
      }
      this.visitedRoad[p][i] = 1;
    }
    this.actions.push({ id: `a${this.seq++}`, playerId: `P${p}`, type, seat: this.w.kernels.seatIds[i], ts });
    return true;
  }

  /** Rival public effect at seat i as seen by player p (all other players' rallies). */
  rivalPub(p: number, i: number): number { return this.pubTotal[i] - this.pub[p][i]; }
}
