import { buildKernels, configForMap } from '@hp/shared';
import type { GameMapPackage, Kernels, MapConfig } from '@hp/shared';
import type { LoadedMap, MapProvider } from './types';
import { GAME_PACKAGES } from '../maps.generated';

/** Map provider that builds kernels lazily and caches them (call at module scope so Lambda containers reuse them). */
export function makeMapProvider(entries: Record<string, { map: GameMapPackage; cfg: MapConfig }>): MapProvider {
  const cache = new Map<string, Kernels>();
  return (mapId: string): LoadedMap | undefined => {
    const e = Object.prototype.hasOwnProperty.call(entries, mapId) ? entries[mapId] : undefined;
    if (!e) return undefined;
    let kernels = cache.get(mapId);
    if (!kernels) {
      kernels = buildKernels(e.map, e.cfg);
      cache.set(mapId, kernels);
    }
    return { map: e.map, cfg: e.cfg, kernels };
  };
}

/** One entry per maps/<id>/ game package (generated registry); `tune` may adjust each map's MapConfig (e.g. env overrides). */
export function registryEntries(tune: (cfg: MapConfig) => MapConfig = c => c): Record<string, { map: GameMapPackage; cfg: MapConfig }> {
  return Object.fromEntries(Object.entries(GAME_PACKAGES).map(([id, map]) => [id, { map, cfg: tune(configForMap(id, map.seatCount)) }]));
}

/** Provider over every map in the generated registry. Unknown ids return undefined (createGame rejects them with BAD_REQUEST). */
export function makeRegistryMapProvider(tune?: (cfg: MapConfig) => MapConfig): MapProvider {
  return makeMapProvider(registryEntries(tune));
}
