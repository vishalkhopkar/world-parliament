// Step Functions: { gameId } at the pre-campaign deadline (only executions with a pre-campaign get here). Idempotent.
import { getService } from '../aws/factory';

export const handler = async (event: { gameId: string }) => {
  if (!event.gameId) throw new Error('gameId required');
  await getService().openCampaign(event.gameId);
  return { ok: true };
};
