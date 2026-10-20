// WebSocket $disconnect: mark the player disconnected and schedule the grace check.
import { getService } from '../aws/factory';

export const handler = async (event: { requestContext: { connectionId: string } }) => {
  try {
    await getService().disconnect(event.requestContext.connectionId);
  } catch (e) {
    console.error('ws-disconnect failed', e);
  }
  return { statusCode: 200 };
};
