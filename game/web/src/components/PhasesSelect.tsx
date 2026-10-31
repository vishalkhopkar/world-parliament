import type { MapConfig } from '@hp/shared';

/** Clamp a phase count into the map's allowed range. */
export function clampPhases(phases: number, range: MapConfig['phases']): number {
  return Math.min(range.max, Math.max(range.min, phases));
}

/** "Polling phases" dropdown: min..max of the map's `cfg.phases`, labelled "N phase(s)"; a stale value is clamped. */
export function PhasesSelect({ range, value, onChange, disabled }: {
  range: MapConfig['phases']; value: number; onChange: (n: number) => void; disabled?: boolean;
}) {
  const v = clampPhases(value, range);
  return (
    <label className="field">Polling phases
      <select className="input" value={v} disabled={disabled} onChange={e => onChange(Number(e.target.value))}>
        {Array.from({ length: range.max - range.min + 1 }, (_, i) => i + range.min).map(n => (
          <option key={n} value={n}>{n} phase{n > 1 ? 's' : ''}</option>
        ))}
      </select>
    </label>
  );
}
