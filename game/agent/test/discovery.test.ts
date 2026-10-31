// Pointing HP_SERVER at the CloudFront site URL: the agent reads /config.json (published by the deploy) to find the REST and WebSocket endpoints.
import { describe, expect, it } from 'vitest';
import { GameClient } from '../src/client';

const API = 'https://abc123.execute-api.ap-south-1.amazonaws.com';
const WS = 'wss://def456.execute-api.ap-south-1.amazonaws.com/live';

function mk(server: string, reply: (url: string) => { status?: number; text: string } | Error, ws?: string) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(`${init.method ?? 'GET'} ${url}`);
    const r = reply(String(url));
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => r.text } as Response;
  }) as typeof fetch;
  const c = new GameClient({ server, ws, fetchImpl });
  c.connect = async () => undefined;
  return { c, urls };
}
const config = (url: string) => (url.endsWith('/config.json') ? { text: JSON.stringify({ apiUrl: API, wsUrl: WS }) } : { text: JSON.stringify({ gameId: 'g', playerId: 'p', token: 't', status: 'pending' }) });

describe('endpoint discovery from /config.json', () => {
  it('join against a CloudFront URL reads /config.json first, then uses the API and WebSocket URLs from it', async () => {
    const { c, urls } = mk('https://d111.cloudfront.net/', config);
    const s = await c.join('abc123', 'Bot');
    expect(urls[0]).toBe('GET https://d111.cloudfront.net/config.json');
    expect(urls[1]).toBe(`POST ${API}/games/join`);
    expect(c.server).toBe(API);
    expect(c.wsUrl).toBe(WS);
    expect(s.server).toBe(API);
  });

  it('is skipped for localhost (the local dev server serves no config) and when a ws URL was given explicitly', async () => {
    const a = mk('http://localhost:8787', config);
    await a.c.join('abc123', 'Bot');
    expect(a.urls).toEqual(['POST http://localhost:8787/games/join']);
    const b = mk('https://d111.cloudfront.net', config, 'wss://explicit/live');
    await b.c.join('abc123', 'Bot');
    expect(b.urls[0]).toBe('POST https://d111.cloudfront.net/games/join');
    expect(b.c.wsUrl).toBe('wss://explicit/live');
  });

  it('falls back to the given URL when /config.json is missing, is the SPA index.html, is malformed, or the fetch fails', async () => {
    for (const bad of [{ status: 404, text: 'nope' }, { text: '<!doctype html><html></html>' }, { text: '{"apiUrl": 5}' }, { text: JSON.stringify({ apiUrl: 'javascript:alert(1)', wsUrl: WS }) }, new Error('offline')]) {
      const { c, urls } = mk('https://api.example.com', (u) => (u.endsWith('/config.json') ? bad : config(u)));
      await c.join('abc123', 'Bot');
      expect(urls).toContain('POST https://api.example.com/games/join');
      expect(c.server).toBe('https://api.example.com');
    }
  });

  it('only looks once per client', async () => {
    const { c, urls } = mk('https://d111.cloudfront.net', config);
    await c.discover();
    await c.discover();
    expect(urls.filter((u) => u.endsWith('config.json'))).toHaveLength(1);
  });
});
