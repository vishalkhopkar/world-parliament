// Single-process local backend: REST lobby on http://localhost:8787 and WebSocket on ws://localhost:8787/ws?gameId=&token=
// Same GameService as the Lambdas, with in-memory persistence and timers instead of DynamoDB / Step Functions.
// Short games: HP_CAMPAIGN_MS=60000 HP_COUNTING_MS=20000 HP_POST_MS=20000 HP_GRACE_MS=10000 HP_START_DELAY_MS=3000 npm run dev
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { GameService } from '../core/gameService';
import { CORS_HEADERS, handleRest } from '../core/http';
import { GameError, HTTP_STATUS } from '../core/types';
import { LocalNotifier } from './localNotifier';
import { loadLocalMaps, startDelayFromEnv } from './localEnv';
import { MemoryRepo } from './memoryRepo';
import { TimerScheduler } from './timerScheduler';

export interface DevServer { port: number; close(): Promise<void>; svc: GameService }

export async function startDevServer(opts: { port?: number; env?: NodeJS.ProcessEnv } = {}): Promise<DevServer> {
  const env = opts.env ?? process.env;
  const clock = { now: () => Date.now() };
  const repo = new MemoryRepo();
  const notifier = new LocalNotifier(repo);
  const scheduler = new TimerScheduler(clock);
  const svc = new GameService({ repo, notifier, scheduler, clock, maps: loadLocalMaps(env), startDelayMs: startDelayFromEnv(env) });
  scheduler.bind(svc);
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
        const out = await handleRest(svc, {
          method: req.method ?? 'GET', path: url.pathname, headers, body: Buffer.concat(chunks).toString('utf8') || undefined,
        });
        res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      })();
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.write('HTTP/1.1 ' + status + ' ' + message + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    const connectionId = randomBytes(8).toString('hex');
    svc.connect(url.searchParams.get('gameId') ?? '', url.searchParams.get('token') ?? undefined, connectionId).then(
      () => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          notifier.sockets.set(connectionId, ws);
          let queue: Promise<unknown> = Promise.resolve();
          ws.on('message', (data) => {
            let msg: unknown;
            try { msg = JSON.parse(data.toString()); } catch { msg = undefined; }
            queue = queue.then(() => svc.handleMessage(connectionId, msg as never)).catch((e) => console.error('message failed', e));
          });
          ws.on('close', () => {
            notifier.sockets.delete(connectionId);
            queue.then(() => svc.disconnect(connectionId)).catch((e) => console.error('disconnect failed', e));
          });
          ws.on('error', () => ws.close());
        });
      },
      (e) => {
        if (e instanceof GameError) rejectUpgrade(socket, HTTP_STATUS[e.code], e.code);
        else { console.error('connect failed', e); rejectUpgrade(socket, 500, 'Internal Server Error'); }
      },
    );
  });

  const port = opts.port ?? Number(env.HP_PORT ?? env.PORT ?? 8787);
  await new Promise<void>((resolve) => http.listen(port, resolve));
  const actual = (http.address() as { port: number }).port;
  return {
    port: actual, svc,
    close: async () => {
      scheduler.stop();
      for (const ws of notifier.sockets.values()) ws.terminate();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevServer().then((s) => {
    console.log('HUNG PARLIAMENT dev server: http://localhost:' + s.port + '  ws://localhost:' + s.port + '/ws?gameId=&token=');
  });
}
