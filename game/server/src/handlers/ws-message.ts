// WebSocket routes ping/campaign/buyReport/chat/proposeGovernment/respondOffer/withdrawOffer/$default.
import type { ClientMessage } from '@hp/shared';
import { getService } from '../aws/factory';

export const handler = async (event: { requestContext: { connectionId: string }; body?: string | null; isBase64Encoded?: boolean }) => {
  const svc = getService();
  const connectionId = event.requestContext.connectionId;
  let msg: ClientMessage | undefined;
  try {
    const text = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    msg = JSON.parse(text ?? '') as ClientMessage;
  } catch {
    msg = undefined;
  }
  // handleMessage reports every error to the client as an 'error' message, so the Lambda itself always succeeds.
  await svc.handleMessage(connectionId, msg as ClientMessage);
  return { statusCode: 200 };
};
