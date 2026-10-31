import { describe, expect, it } from 'vitest';
import { siteConfigFromEnv } from '../vite.apiConfig';

describe('published /config.json', () => {
  it('carries the API and WebSocket URLs the bundle was built with (trailing slashes removed)', () => {
    expect(siteConfigFromEnv({ VITE_API_URL: 'https://a.execute-api.ap-south-1.amazonaws.com/', VITE_WS_URL: 'wss://b.execute-api.ap-south-1.amazonaws.com/live' }))
      .toEqual({ apiUrl: 'https://a.execute-api.ap-south-1.amazonaws.com', wsUrl: 'wss://b.execute-api.ap-south-1.amazonaws.com/live' });
  });
  it('derives the ws URL from the API URL when only that is set, and is absent for a build without an API (mock mode)', () => {
    expect(siteConfigFromEnv({ VITE_API_URL: 'https://api.example.com' })).toEqual({ apiUrl: 'https://api.example.com', wsUrl: 'wss://api.example.com/ws' });
    expect(siteConfigFromEnv({})).toBeNull();
    expect(siteConfigFromEnv({ VITE_API_URL: '  ' })).toBeNull();
  });
});
