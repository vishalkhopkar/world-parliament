// Game engine public API (pure functions, no I/O). CONTRACT: server, sim and web import only these.
// Implemented in rng.ts / effects.ts / schedule.ts / committed.ts / votes.ts / analyst.ts / points.ts; types in types.ts.
// Signatures may only change with the coordinator's agreement. See each file for behaviour docs.

export type { Rng, Kernels, Effects, Committed, EffectOptions } from './types';
export { createRng, gaussian } from './rng';
export { buildKernels, timeMultiplier, computeEffects, reputationView, seatShares, haversineKm } from './effects';
export { buildTimeline, countingMsFor, phaseOfSeat, postCountingMsFor } from './schedule';
export { pollSeats, expectedSeatShares, removePlayerFromResults, tallySeats } from './votes';
export { dealCommitted, committedMatrix, committedView, committedTotals } from './committed';
export { analystPrice, analystReport } from './analyst';
export { validateGovernment, leavesPartyOut, governmentFromOffer, majorityGovernment, finalResult } from './points';
