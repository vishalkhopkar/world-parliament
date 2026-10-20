// WebSocket $connect: authenticate with ?gameId=&token= and register the connection.
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getService } from '../aws/factory';
import { GameError, HTTP_STATUS } from '../core/types';

interface ConnectEvent {
  requestContext: { connectionId: string };
  queryStringParameters?: Record<string, string | undefined> | null;
}

export const handler = async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
  const q = event.queryStringParameters ?? {};
  try {
    await getService().connect(q.gameId ?? '', q.token, event.requestContext.connectionId);
    return { statusCode: 200 };
  } catch (e) {
    if (e instanceof GameError) return { statusCode: HTTP_STATUS[e.code], body: JSON.stringify({ error: e.code, message: e.message }) };
    console.error('ws-connect failed', e);
    return { statusCode: 500 };
  }
};
