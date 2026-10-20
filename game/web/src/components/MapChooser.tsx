import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import type { MapManifest } from '@hp/shared';
import { siteUrlOf, thumbnailUrlOf } from '../map/mapData';
import './mapChooser.css';

interface Props {
  /** Every map folder known to the build (MAP_MANIFESTS). */
  maps: readonly MapManifest[];
  value: string;
  onChange(mapId: string): void;
}

/** "Choose a map": one selectable card per map (radio group) with a "View map" link to the map's static study site. */
export function MapChooser({ maps, value, onChange }: Props) {
  const group = useId();
  return (
    <fieldset className="map-chooser">
      <legend className="map-chooser-title">Choose a map</legend>
      <div className="map-cards">
        {maps.map(m => {
          const id = `${group}-${m.id}`;
          const selected = m.id === value;
          return (
            <div key={m.id} className={'map-card' + (selected ? ' selected' : '')} data-testid="map-card">
              <input
                className="map-card-radio" type="radio" name={group} id={id} value={m.id} checked={selected}
                aria-labelledby={`${id}-name`} aria-describedby={`${id}-desc`} onChange={() => onChange(m.id)}
              />
              <label className="map-card-body" htmlFor={id}>
                <img className="map-card-thumb" src={thumbnailUrlOf(m)} alt="" loading="lazy" />
                <span className="map-card-text">
                  <span className="map-card-name" id={`${id}-name`}>{m.name}</span>
                  <span className="map-card-seats">{m.seatCount.toLocaleString('en-IN')} seats</span>
                  <span className="map-card-desc" id={`${id}-desc`}>{m.description}</span>
                </span>
              </label>
              <a className="btn ghost sm map-card-view" href={siteUrlOf(m)} target="_blank" rel="noopener" aria-label={`View map: ${m.name}`}>
                View map <ExternalLink size={13} aria-hidden />
              </a>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
