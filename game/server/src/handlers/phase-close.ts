// Step Functions: { gameId, phase } with phase 1-based (Map index + 1). Engine/SeatResult phases are 0-based.
import { getService } from '../aws/factory';

export const handler = async (event: { gameId: string; phase: number }) => {
  const phase = Number(event.phase);
  if (!event.gameId || !Number.isInteger(phase) || phase < 1) throw new Error(`bad phase-close input: ${JSON.stringify(event)}`);
  await getService().phaseClose(event.gameId, phase - 1);
  return { ok: true };
};
