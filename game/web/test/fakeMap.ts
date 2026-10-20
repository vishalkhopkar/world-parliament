// A second, fake map with its own tuning, to prove the UI reads the CURRENT game's MapConfig (not WORLD_CONFIG).
import { MAP_CONFIGS, WORLD_CONFIG } from '@hp/shared';
import type { MapConfig } from '@hp/shared';

export const FAKE_MAP_ID = 'fake-100';

export const FAKE_CONFIG: MapConfig = {
  ...WORLD_CONFIG,
  mapId: FAKE_MAP_ID,
  seatCount: 100,
  currency: { name: 'Fake Dollar', symbol: 'F$' },
  budget: 90_000_000,
  costs: { rally: 50_000_000, roadshow: 30_000_000 },
  analyst: { ...WORLD_CONFIG.analyst, seatReport: { start: 70_000_000, end: 70_000_000 }, globalReport: { start: 110_000_000, end: 110_000_000 }, delayMs: 45_000 },
  phases: { min: 1, max: 2, default: 2 },
  players: { min: 3, max: 4 },
  points: {
    ...WORLD_CONFIG.points,
    portfolios: [
      { id: 'PM', label: 'Chancellor', points: 100, max: 1 },
      { id: 'MAGIC', label: 'Minister of Magic', points: 40, max: 1 },
      { id: 'DEPUTIES', label: 'Deputy Wizard', points: 25, max: 3 },
    ],
  },
};

/** Registers the fake map (idempotent). Call at module level of a test. */
export function registerFakeMap() { MAP_CONFIGS[FAKE_MAP_ID] = FAKE_CONFIG; }
