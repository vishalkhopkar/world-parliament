import { useMemo } from 'react';
import { DEFAULT_MAP_ID, WORLD_CONFIG, configForMap } from '@hp/shared';
import type { MapConfig } from '@hp/shared';
import { manifestFor } from '../map/mapData';
import { selectMapId, useStore } from './store';

/** MapConfig of a map id; the seat count comes from the argument, else the map manifest. */
export function mapConfigFor(mapId: string, seatCount?: number): MapConfig {
  return configForMap(mapId, seatCount ?? manifestFor(mapId)?.seatCount ?? WORLD_CONFIG.seatCount);
}

/**
 * MapConfig of the CURRENT game's map (costs, prices, portfolios, currency, phases, player limits...).
 * Outside a game: the default map. Seat count: the loaded map package of that map, else the manifest.
 */
export function useMapConfig(): MapConfig {
  const mapId = useStore(selectMapId) ?? DEFAULT_MAP_ID;
  const pkgSeats = useStore(s => (s.gamePkg && s.gamePkg.mapId === mapId ? s.gamePkg.seatCount : undefined));
  return useMemo(() => mapConfigFor(mapId, pkgSeats), [mapId, pkgSeats]);
}
