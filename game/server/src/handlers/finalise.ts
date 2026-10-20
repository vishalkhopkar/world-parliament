// Step Functions end of game ({ gameId } or { gameId, error: true } on failure). Idempotent.
import { getService } from '../aws/factory';

export const handler = async (event: { gameId: string; error?: boolean }) => {
  if (!event.gameId) throw new Error('gameId required');
  await getService().finalise(event.gameId, { error: event.error === true });
  return { ok: true };
};
