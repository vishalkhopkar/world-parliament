// EventBridge Scheduler one-time target: { gameId, playerId }. Eliminates the player if still disconnected.
import { getService } from '../aws/factory';

export const handler = async (event: { gameId: string; playerId: string }) => {
  if (!event.gameId || !event.playerId) throw new Error('gameId and playerId required');
  await getService().graceCheck(event.gameId, event.playerId);
  return { ok: true };
};
