export interface PieValue { id: string; value: number; colour: string; label?: string }
export interface PieSlice {
  id: string;
  value: number;
  /** share of the total, 0..1 (the fractions of all slices sum to 1) */
  fraction: number;
  /** radians, 0 = 12 o'clock, growing clockwise */
  startAngle: number;
  endAngle: number;
  /** SVG path `d` of the wedge (or of the full disc for a single 100% slice) */
  path: string;
  colour: string;
  label: string;
}
export interface PieOptions { radius?: number; cx?: number; cy?: number }

const TAU = Math.PI * 2;
const r2 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Pure pie-chart geometry: turns values into SVG wedges, starting at 12 o'clock and going clockwise, in input order.
 * Zero, negative and non-finite values are dropped; the rest are normalised to fractions. Empty input gives [].
 */
export function pieSlices(values: PieValue[], opts: PieOptions = {}): PieSlice[] {
  const radius = opts.radius ?? 100;
  const cx = opts.cx ?? radius;
  const cy = opts.cy ?? radius;
  const kept = values.filter(v => Number.isFinite(v.value) && v.value > 0);
  const total = kept.reduce((a, v) => a + v.value, 0);
  if (!kept.length || !(total > 0)) return [];
  const pt = (a: number) => `${r2(cx + radius * Math.sin(a))} ${r2(cy - radius * Math.cos(a))}`;
  let acc = 0;
  return kept.map(v => {
    const fraction = v.value / total;
    const startAngle = acc * TAU;
    acc += fraction;
    const endAngle = acc * TAU;
    let path: string;
    if (fraction >= 1 - 1e-9) {
      // one arc cannot draw a full circle: use two half circles
      path = `M ${cx} ${r2(cy - radius)} A ${radius} ${radius} 0 1 1 ${cx} ${r2(cy + radius)} A ${radius} ${radius} 0 1 1 ${cx} ${r2(cy - radius)} Z`;
    } else {
      const large = fraction > 0.5 ? 1 : 0;
      path = `M ${cx} ${cy} L ${pt(startAngle)} A ${radius} ${radius} 0 ${large} 1 ${pt(endAngle)} Z`;
    }
    return { id: v.id, value: v.value, fraction, startAngle, endAngle, path, colour: v.colour, label: v.label ?? v.id };
  });
}
