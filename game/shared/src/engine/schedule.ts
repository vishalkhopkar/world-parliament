import type { MapConfig } from '../mapConfig';
import type { GameMapPackage, GameTimeline, SeatId } from '../types';

/** Counting duration for a game with `activePlayers` players: the 2-player length for exactly 2, else the normal one. */
export function countingMsFor(cfg: MapConfig, activePlayers: number): number {
  return activePlayers === 2 ? cfg.durations.countingMsTwoPlayers : cfg.durations.countingMs;
}

/** Post-counting (negotiation) duration: the 2-player value (normally 0, nothing to negotiate) for exactly 2 players. */
export function postCountingMsFor(cfg: MapConfig, activePlayers: number): number {
  return activePlayers === 2 ? cfg.durations.postCountingMsTwoPlayers : cfg.durations.postCountingMs;
}

/**
 * Phase close times for k phases, campaign split equally. Last close = campaignEnd.
 * `countingMs` / `postCountingMs` override the cfg durations (e.g. countingMsFor / postCountingMsFor with the player count).
 */
export function buildTimeline(
  cfg: MapConfig, phases: number, campaignStart: number, countingMsOverride?: number, postCountingMsOverride?: number,
): GameTimeline {
  if (!Number.isInteger(phases) || phases < 1) throw new Error(`invalid phase count: ${phases}`);
  const { campaignMs } = cfg.durations;
  const countingMs = countingMsOverride ?? cfg.durations.countingMs;
  const postCountingMs = postCountingMsOverride ?? cfg.durations.postCountingMs;
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
