// A small fake map package (a rows x cols grid of seats) for tests that need real seat geometry without fetching game.json.
import type { GameMapPackage, GameMapSeat } from '@hp/shared';

/** Grid of `rows` x `cols` seats, ids 1.., 4-neighbour links, ~330 km between neighbours, 1 polling-phase grouping. */
export function gridPackage(rows = 7, cols = 8, mapId = 'world-500'): GameMapPackage {
  const seats: GameMapSeat[] = [];
  const id = (r: number, c: number) => r * cols + c + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const neighbours: number[] = [];
      if (r > 0) neighbours.push(id(r - 1, c));
      if (r < rows - 1) neighbours.push(id(r + 1, c));
      if (c > 0) neighbours.push(id(r, c - 1));
      if (c < cols - 1) neighbours.push(id(r, c + 1));
      seats.push({ id: id(r, c), lon: c * 3, lat: r * 3, x: c * 10, y: r * 10, neighbours: neighbours.sort((a, b) => a - b) });
    }
  }
  const ids = seats.map(s => s.id);
  return { mapId, version: 1, seatCount: seats.length, seats, phaseGroups: { '1': [ids] }, topo: { coarse: 'x' } };
}
