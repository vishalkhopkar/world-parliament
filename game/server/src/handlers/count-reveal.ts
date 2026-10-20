// Step Functions counting loop: reveal due seat declarations, return { done, nextAtIso }.
import { getService } from '../aws/factory';

export const handler = async (event: { gameId: string }): Promise<{ done: boolean; nextAtIso: string }> => {
  if (!event.gameId) throw new Error('gameId required');
  const r = await getService().countReveal(event.gameId);
  return { done: r.done, nextAtIso: new Date(r.nextAtMs).toISOString() };
};
