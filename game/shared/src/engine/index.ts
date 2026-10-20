// Game engine public API (pure functions, no I/O). CONTRACT: server, sim and web import only these.
// Implemented in rng.ts / effects.ts / schedule.ts / votes.ts / analyst.ts / points.ts; types in types.ts.
// Signatures may only change with the coordinator's agreement. See each file for behaviour docs.

export type { Rng, Kernels, Effects, EffectOptions } from './types';
export { createRng } from './rng';
export { buildKernels, timeMultiplier, computeEffects, seatShares, haversineKm } from './effects';
export { buildTimeline, phaseOfSeat } from './schedule';
export { pollSeats, removePlayerFromResults, tallySeats } from './votes';
export { analystPrice, analystReport } from './analyst';
export { validateGovernment, governmentFromOffer, majorityGovernment, finalResult } from './points';
