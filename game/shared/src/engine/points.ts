import { majorityOf } from '../mapConfig';
import type { MapConfig } from '../mapConfig';
import type {
  CoalitionOffer, FinalResult, Government, PlayerId, PointsBreakdown, PortfolioAssignment, SeatTally,
} from '../types';

/**
 * A government must leave at least one party out: true when some contender (a non-eliminated party) is NOT a member.
 * Members that are not contenders (eliminated players) cover nobody. With no contenders there is nobody to leave out.
 */
export function leavesPartyOut(memberIds: readonly PlayerId[], contenderIds: readonly PlayerId[]): boolean {
  const members = new Set(memberIds);
  return contenderIds.some((c) => !members.has(c));
}

/** Checks: exactly one PM, portfolio limits from cfg, no unknown ids, members' seats >= majority. Error text or null. */
export function validateGovernment(
  portfolios: PortfolioAssignment, tally: SeatTally, cfg: MapConfig, seatCount: number,
): string | null {
  const defs = new Map(cfg.points.portfolios.map((d) => [d.id, d]));
  for (const id of Object.keys(portfolios)) {
    if (!defs.has(id)) return `Unknown portfolio: ${id}`;
  }
  const pm = portfolios['PM'] ?? [];
  if (pm.length !== 1) return pm.length === 0 ? 'A Prime Minister is required' : 'There can be only one Prime Minister';
  const members = new Set<PlayerId>();
  for (const [id, holders] of Object.entries(portfolios)) {
    const def = defs.get(id)!;
    if (holders.length > def.max) return `${def.label} can be held by at most ${def.max} player${def.max === 1 ? '' : 's'}`;
    for (const h of holders) members.add(h);
  }
  let seats = 0;
  for (const m of members) seats += tally[m] ?? 0;
  const need = majorityOf(seatCount);
  if (seats < need) return `The government has ${seats} seats but needs ${need} for a majority`;
  return null;
}

/** Build the Government object from an accepted offer (proposer is always PM). */
export function governmentFromOffer(offer: CoalitionOffer, formedAt: number): Government {
  const portfolios: PortfolioAssignment = {};
  for (const [id, holders] of Object.entries(offer.portfolios)) portfolios[id] = [...holders];
  if (!portfolios['PM'] || portfolios['PM'].length !== 1 || portfolios['PM'][0] !== offer.proposer) {
    portfolios['PM'] = [offer.proposer];
  }
  const members: PlayerId[] = [offer.proposer];
  const add = (p: PlayerId) => { if (!members.includes(p)) members.push(p); };
  offer.partners.forEach(add);
  for (const holders of Object.values(portfolios)) holders.forEach(add);
  return { pm: offer.proposer, members, portfolios, formedAt, viaNegotiation: true };
}

/** Single-party majority government that did not negotiate: holds every portfolio (up to its max). */
export function majorityGovernment(playerId: PlayerId, cfg: MapConfig, formedAt: number): Government {
  const portfolios: PortfolioAssignment = {};
  for (const def of cfg.points.portfolios) portfolios[def.id] = Array.from({ length: def.max }, () => playerId);
  return { pm: playerId, members: [playerId], portfolios, formedAt, viaNegotiation: false };
}

/**
 * Final outcome and whole-number points.
 * Design choices where the contract is open:
 * - 'draw' (no government, exactly 2 non-eliminated players, equal seats): both win; each gets seat points + governmentFloor
 *   as if a government member, 0 portfolio points, so totals are equal.
 * - 'majority' requires government.viaNegotiation === false and the PM holding >= majorityOf(seatCount); a non-negotiated
 *   government whose PM lacks a majority (inconsistent input) is treated as 'coalition'.
 * - coalition winners = non-eliminated player(s) with the highest total (ties share the win).
 */
export function finalResult(
  tally: SeatTally, government: Government | null, players: PlayerId[], eliminated: Set<PlayerId>,
  cfg: MapConfig, seatCount: number,
): FinalResult {
  const defs = new Map(cfg.points.portfolios.map((d) => [d.id, d]));
  const seatsOf = (p: PlayerId) => tally[p] ?? 0;
  const seatPts = (p: PlayerId) => Math.round((cfg.points.seatMultiplier * seatsOf(p)) / seatCount);
  const active = players.filter((p) => !eliminated.has(p));

  const portfolioPts = new Map<PlayerId, number>();
  const members = new Set<PlayerId>();
  if (government) {
    for (const m of government.members) members.add(m);
    for (const [id, holders] of Object.entries(government.portfolios)) {
      const def = defs.get(id);
      if (!def) continue;
      for (const h of holders) {
        members.add(h);
        portfolioPts.set(h, (portfolioPts.get(h) ?? 0) + def.points);
      }
    }
  }

  const breakdown = (p: PlayerId, asMember: boolean): PointsBreakdown => {
    if (eliminated.has(p)) return { playerId: p, portfolioPoints: 0, seatPoints: 0, governmentFloor: 0, total: 0 };
    if (!asMember) {
      const o = cfg.points.opposition;
      return { playerId: p, portfolioPoints: 0, seatPoints: 0, governmentFloor: 0, total: o };
    }
    const portfolioPoints = portfolioPts.get(p) ?? 0;
    const seatPoints = seatPts(p);
    const governmentFloor = cfg.points.governmentFloor;
    return { playerId: p, portfolioPoints, seatPoints, governmentFloor, total: portfolioPoints + seatPoints + governmentFloor };
  };

  if (!government) {
    const isDraw = active.length === 2 && seatsOf(active[0]) === seatsOf(active[1]);
    if (isDraw) {
      return {
        outcome: 'draw', tally, government: null,
        points: players.map((p) => breakdown(p, true)),
        winners: [...active],
      };
    }
    return {
      outcome: 'noGovernment', tally, government: null,
      points: players.map((p) => breakdown(p, false)),
      winners: [],
    };
  }

  const points = players.map((p) => breakdown(p, members.has(p)));
  if (!government.viaNegotiation && seatsOf(government.pm) >= majorityOf(seatCount) && !eliminated.has(government.pm)) {
    return { outcome: 'majority', tally, government, points, winners: [government.pm] };
  }
  let top = -Infinity;
  for (const b of points) if (!eliminated.has(b.playerId) && b.total > top) top = b.total;
  const winners = points.filter((b) => !eliminated.has(b.playerId) && b.total === top).map((b) => b.playerId);
  return { outcome: 'coalition', tally, government, points, winners };
}
