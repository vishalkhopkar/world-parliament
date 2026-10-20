import type { MapConfig } from '../mapConfig';
import type { GameMapPackage, GameTimeline, SeatId } from '../types';

/** Phase close times for k phases, campaign split equally. Last close = campaignEnd. */
export function buildTimeline(cfg: MapConfig, phases: number, campaignStart: number): GameTimeline {
  if (!Number.isInteger(phases) || phases < 1) throw new Error(`invalid phase count: ${phases}`);
  const { campaignMs, countingMs, postCountingMs } = cfg.durations;
  const phaseCloses: number[] = [];
  for (let i = 0; i < phases; i++) phaseCloses.push(Math.round(campaignStart + ((i + 1) * campaignMs) / phases));
  const campaignEnd = phaseCloses[phases - 1];
  const countingEnd = campaignEnd + countingMs;
  return { campaignStart, phaseCloses, campaignEnd, countingEnd, postCountingEnd: countingEnd + postCountingMs };
}

/** Index of the polling phase a seat belongs to for k phases. Throws if the seat/phase grouping is unknown. */
export function phaseOfSeat(map: GameMapPackage, phases: number, seat: SeatId): number {
  const groups = map.phaseGroups[String(phases)];
  if (!groups) throw new Error(`map ${map.mapId} has no phase grouping for ${phases} phases`);
  for (let p = 0; p < groups.length; p++) if (groups[p].includes(seat)) return p;
  throw new Error(`seat ${seat} is not in any polling phase for ${phases} phases`);
}
