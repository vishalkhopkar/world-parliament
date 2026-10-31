// /config.json: published next to index.html so tools that only know the site URL (the AI agent: HP_SERVER=<site url>) can find
// the REST API and the WebSocket. Only URLs, never secrets. Emitted only when the build knows the real API (VITE_API_URL).
import type { Plugin } from 'vite';

export interface SiteConfig { apiUrl: string; wsUrl: string }

const toWs = (httpUrl: string) => httpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';

export function siteConfigFromEnv(env: Record<string, string | undefined>): SiteConfig | null {
  const api = (env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
  if (!api) return null;
  const ws = (env.VITE_WS_URL ?? '').trim().replace(/\/+$/, '');
  return { apiUrl: api, wsUrl: ws || toWs(api) };
}

export function apiConfig(): Plugin {
  return {
    name: 'hp-api-config',
    apply: 'build',
    generateBundle() {
      const cfg = siteConfigFromEnv(process.env);
      if (cfg) this.emitFile({ type: 'asset', fileName: 'config.json', source: JSON.stringify(cfg, null, 2) + '\n' });
    },
  };
}
