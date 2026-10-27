// Pure helpers for the news-agency line charts (components/GlobalReportsModal.tsx): scales, paths, ticks, label spreading.

export interface ChartBox { width: number; height: number; left: number; right: number; top: number; bottom: number }
export interface ChartScales {
  /** time (ms) -> x pixel */
  x(t: number): number;
  /** value (seats) -> y pixel (0 at the bottom of the plot) */
  y(v: number): number;
  plot: { x0: number; x1: number; y0: number; y1: number };
}

/** Linear scales for t in [t0, t1] and v in [0, vMax]. A zero-length time span maps to the left edge. */
export function chartScales(t0: number, t1: number, vMax: number, box: ChartBox): ChartScales {
  const x0 = box.left, x1 = box.width - box.right, yTop = box.top, yBottom = box.height - box.bottom;
  const dt = t1 - t0;
  const vm = vMax > 0 ? vMax : 1;
  return {
    x: t => (dt > 0 ? x0 + ((t - t0) / dt) * (x1 - x0) : x0),
    y: v => yBottom - (v / vm) * (yBottom - yTop),
    plot: { x0, x1, y0: yTop, y1: yBottom },
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** SVG path "M x y L x y …" through the points; empty string for no points. */
export function linePath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.y)}`).join(' ');
}

/** "Nice" round tick values from 0 up to (at least) max, about `count` of them. The last tick is the axis maximum. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) { out.push(Math.round(v * 1e6) / 1e6); if (v >= max) break; }
  return out;
}

/** Ticks along the time axis: elapsed milliseconds as { t, label } ("0:30", "1:00" …), `count` or fewer of them, starting at 0. */
export function timeTicks(spanMs: number, count = 4): { t: number; label: string }[] {
  if (!(spanMs > 0)) return [{ t: 0, label: formatElapsed(0) }];
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(s => s * 1000);
  const step = steps.find(s => spanMs / s <= count) ?? steps[steps.length - 1];
  const out: { t: number; label: string }[] = [];
  for (let t = 0; t <= spanMs + 1; t += step) out.push({ t, label: formatElapsed(t) });
  return out;
}

/** Elapsed time as m:ss (or h:mm:ss from one hour). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/**
 * Spread label centres vertically so neighbours are at least `minGap` apart, staying inside [lo, hi] and keeping the order of
 * the inputs' values. Returns the new positions in the input order. (If the room is too small the gap shrinks evenly.)
 */
export function spreadLabels(ys: number[], minGap: number, lo: number, hi: number): number[] {
  const n = ys.length;
  if (!n) return [];
  const gap = n > 1 ? Math.min(minGap, (hi - lo) / (n - 1)) : 0;
  const order = ys.map((y, i) => i).sort((a, b) => ys[a] - ys[b] || a - b);
  const pos = order.map(i => Math.min(hi, Math.max(lo, ys[i])));
  for (let k = 1; k < n; k++) if (pos[k] < pos[k - 1] + gap) pos[k] = pos[k - 1] + gap;
  if (pos[n - 1] > hi) {
    pos[n - 1] = hi;
    for (let k = n - 2; k >= 0; k--) if (pos[k] > pos[k + 1] - gap) pos[k] = pos[k + 1] - gap;
  }
  const out = new Array<number>(n);
  order.forEach((i, k) => { out[i] = pos[k]; });
  return out;
}
