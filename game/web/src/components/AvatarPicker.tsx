import { AVATARS } from '@hp/shared';
import { avatarById, avatarUrl } from '../avatars';
import './avatarPicker.css';

/** The full image is 512 px; showing it at 240 css px keeps it sharp on 2x screens (limit: 256). */
const PREVIEW_PX = 240;

interface Props {
  /** selected avatar id ('' = none) */
  value: string;
  /** avatar ids used by other players: shown disabled */
  taken: readonly string[];
  onChange(id: string): void;
}

/** Grid of avatar thumbnails (radio group) + a large preview of the selected one (full image). */
export function AvatarPicker({ value, taken, onChange }: Props) {
  const chosen = avatarById(value);
  return (
    <div className="avatar-picker">
      <div className="avatar-grid" role="radiogroup" aria-label="Avatar">
        {AVATARS.map(a => {
          const isTaken = taken.includes(a.id);
          const on = a.id === value;
          return (
            <button
              key={a.id} type="button" role="radio" aria-checked={on} aria-label={a.label} disabled={isTaken}
              className={'avatar-opt' + (on ? ' on' : '')} title={isTaken ? `${a.label} (taken)` : a.label} onClick={() => onChange(a.id)}
            >
              <img src={avatarUrl(a.id, 'thumb')} alt={a.label} loading="lazy" decoding="async" width={80} height={80} />
              {isTaken && <span className="avatar-taken" aria-hidden>taken</span>}
            </button>
          );
        })}
      </div>
      <div className="avatar-preview-box">
        {chosen ? (
          <>
            <img className="avatar-preview" src={avatarUrl(chosen.id, 'full')} alt={`Selected avatar: ${chosen.label}`} width={PREVIEW_PX} height={PREVIEW_PX} decoding="async" />
            <strong className="avatar-preview-name">{chosen.label}</strong>
          </>
        ) : <p className="hint avatar-preview-empty">Pick an avatar: it is your face in lists, the ticker and results.</p>}
      </div>
    </div>
  );
}
