import { pieSlices } from '../lib/pie';
import './pieChart.css';

export interface PieChartItem {
  id: string;
  value: number;
  colour: string;
  /** party name */
  label: string;
  /** candidate name for this seat, if known */
  candidate?: string;
}

interface Props {
  items: PieChartItem[];
  /** accessible name of the chart, e.g. "Vote share in Mumbai" */
  ariaLabel: string;
  size?: number;
}

const VIEW = 200;

/** SVG pie of the items (zero values are skipped) plus a legend sorted biggest first, percentages with one decimal. */
export function PieChart({ items, ariaLabel, size = 180 }: Props) {
  const slices = pieSlices(items.map(i => ({ id: i.id, value: i.value, colour: i.colour, label: i.label })), { radius: VIEW / 2 - 2, cx: VIEW / 2, cy: VIEW / 2 });
  const byId = new Map(items.map(i => [i.id, i]));
  const legend = [...slices].sort((a, b) => b.fraction - a.fraction);
  return (
    <div className="pie">
      <svg className="pie-svg" viewBox={`0 0 ${VIEW} ${VIEW}`} width={size} height={size} role="img" aria-label={ariaLabel}>
        {slices.map(s => <path key={s.id} className="pie-slice" d={s.path} fill={s.colour} stroke="var(--ivory)" strokeWidth={1.5} strokeLinejoin="round" />)}
      </svg>
      <ul className="pie-legend">
        {legend.map(s => {
          const candidate = byId.get(s.id)?.candidate;
          return (
            <li key={s.id}>
              <span className="pie-swatch" style={{ background: s.colour }} />
              <span className="pie-name">{s.label}{candidate && <small> · {candidate}</small>}</span>
              <b className="pie-pct">{(s.fraction * 100).toFixed(1)}%</b>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
