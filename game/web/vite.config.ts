import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.resolve(here, '../../maps');
const avatarsDir = path.resolve(here, '../assets/avatars');

const TYPES: Record<string, string> = {
  '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/**
 * Any map folder maps/<id>/ (map.json + thumbnail + site/) is a library the game uses generically:
 *  - dev: serves ../../maps/** at /maps/** (e.g. /maps/world-500/site/data/world.topo.json, /maps/world-500/thumbnail.jpg)
 *  - build: copies every maps/<id>/{map.json, thumbnail.*, site/**} into dist/maps/<id>/
 * The source/ toolkit inside a map folder is never served or copied.
 */
function maps(): Plugin {
  return {
    name: 'hp-maps',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/maps/')) return next();
        const rel = decodeURIComponent(url.slice('/maps/'.length));
        let file = path.resolve(mapsDir, rel);
        const inside = file.startsWith(mapsDir + path.sep);
        const parts = rel.split('/');
        const isSource = parts[1] === 'source';
        if (inside && !isSource && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!inside || isSource || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404; // real 404 (no SPA fallback) so the app can detect a missing map package
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!fs.existsSync(mapsDir)) return;
      for (const ent of fs.readdirSync(mapsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const src = path.join(mapsDir, ent.name);
        if (!fs.existsSync(path.join(src, 'map.json'))) continue;
        const out = path.resolve(here, 'dist/maps', ent.name);
        fs.mkdirSync(out, { recursive: true });
        fs.copyFileSync(path.join(src, 'map.json'), path.join(out, 'map.json'));
        for (const f of fs.readdirSync(src)) {
          if (/^thumbnail\./i.test(f)) fs.copyFileSync(path.join(src, f), path.join(out, f));
        }
        if (fs.existsSync(path.join(src, 'site'))) fs.cpSync(path.join(src, 'site'), path.join(out, 'site'), { recursive: true });
      }
    },
  };
}

/**
 * Avatar images (game/assets/avatars: avatars.json, full/<id>.jpg 512 px, thumb/<id>.jpg 160 px):
 *  - dev: served at /avatars/**
 *  - build: copied to dist/avatars/
 */
function avatars(): Plugin {
  return {
    name: 'hp-avatars',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/avatars/')) return next();
        const file = path.resolve(avatarsDir, decodeURIComponent(url.slice('/avatars/'.length)));
        if (!file.startsWith(avatarsDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (fs.existsSync(avatarsDir)) fs.cpSync(avatarsDir, path.resolve(here, 'dist/avatars'), { recursive: true });
    },
  };
}

/**
 * Link-preview tags need an absolute og:image URL. VITE_SITE_URL (set by game-deploy.yml from the CloudFront URL)
 * is prefixed to the root-relative path; without it the path stays relative (fine for local use).
 */
function siteUrl(): Plugin {
  return {
    name: 'hp-site-url',
    transformIndexHtml(html) {
      const base = (process.env.VITE_SITE_URL ?? '').replace(/\/+$/, '');
      return base ? html.replace(/content="\/og-image\.jpg"/g, `content="${base}/og-image.jpg"`) : html;
    },
  };
}

export default defineConfig({
  plugins: [react(), maps(), avatars(), siteUrl()],
  server: { port: 5173, fs: { allow: [path.resolve(here, '../..')] } },
  build: { chunkSizeWarningLimit: 1200 },
});
