// HTTP API (payload v2) -> lobby REST. Thin adapter over core/http.ts.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getService } from '../aws/factory';
import { CORS_HEADERS, handleRest } from '../core/http';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const raw = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const res = await handleRest(getService(), {
    method: event.requestContext.http.method, path: event.rawPath, headers, body: raw,
  });
  return {
    statusCode: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
    body: res.body === undefined ? '' : JSON.stringify(res.body),
  };
};
