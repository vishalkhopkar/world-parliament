import type { MapConfig } from '../src/mapConfig';
import { WORLD_CONFIG } from '../src/mapConfig';
import type { Action, GameMapPackage, GameMapSeat } from '../src/types';

export const T0 = 1_000_000;

/** Test config: simple round numbers, 8 seats. */
export const TEST_CFG: MapConfig = {
  ...WORLD_CONFIG,
  seatCount: 8,
  effects: {
    rally: { local: 1.0, global: 0.01, decay: { halfDistanceKm: 100, maxKm: 500, capRatio: 0.5 } },
    roadshow: { local: 1.5, decay: { halfDistanceKm: 30, maxKm: 150, capRatio: 0.4 } },
    firstMover: { rally: 0, roadshow: 0 }, // off in the base test config; firstMover.test.ts turns it on
  },
  timeMultiplier: { start: 1.0, end: 1.2 },
  randomSwing: 0.02,
};

function seat(id: number, lon: number, lat: number, neighbours: number[] = []): GameMapSeat {
  return { id, lon, lat, x: lon, y: lat, neighbours };
}

/**
 * 8 seats near the equator (1 deg lon ~ 111.2 km):
 * 1 @0, 2 @0.01 (~1 km from 1), 3 @1 (~111 km), 4 @3 (~334 km), 5 @6 (~667 km, beyond rally maxKm), 6 @20 (far),
 * 7 @0.2,lat 0 (~22 km from 1), 8 @ 120 lon (very far).
 */
export function testMap(): GameMapPackage {
  return {
    mapId: 'test',
    version: 1,
    seatCount: 8,
    seats: [
      seat(1, 0, 0), seat(2, 0.01, 0), seat(3, 1, 0), seat(4, 3, 0),
      seat(5, 6, 0), seat(6, 20, 0), seat(7, 0.2, 0), seat(8, 120, 0),
    ],
    phaseGroups: {
      '1': [[1, 2, 3, 4, 5, 6, 7, 8]],
      '2': [[1, 2, 3, 4], [5, 6, 7, 8]],
      '3': [[1, 2, 3], [4, 5, 6], [7, 8]],
    },
    topo: { coarse: 'x.json' },
  };
}

let counter = 0;
export function act(playerId: string, type: 'rally' | 'roadshow', seatId: number, ts: number): Action {
  return { id: `a${counter++}`, playerId, type, seat: seatId, ts };
}
