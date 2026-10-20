import type { WebSocket } from 'ws';
import type { PlayerId, ServerMessage } from '@hp/shared';
import type { Notifier, Repo } from '../core/types';

const arr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** Notifier over in-process `ws` sockets (mirrors ApiGwNotifier). */
export class LocalNotifier implements Notifier {
  readonly sockets = new Map<string, WebSocket>();
  constructor(private readonly repo: Repo) {}

  private post(connectionId: string, msgs: ServerMessage[]): void {
    const ws = this.sockets.get(connectionId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    for (const m of msgs) ws.send(JSON.stringify(m));
  }

  async sendToConnection(connectionId: string, msg: ServerMessage | ServerMessage[]) { this.post(connectionId, arr(msg)); }

  async sendToPlayer(gameId: string, playerId: PlayerId, msg: ServerMessage | ServerMessage[]) {
    const p = await this.repo.getPlayer(gameId, playerId);
    if (p?.connectionId) this.post(p.connectionId, arr(msg));
  }

  async broadcast(gameId: string, msg: ServerMessage | ServerMessage[]) {
    const msgs = arr(msg);
    for (const p of await this.repo.listPlayers(gameId)) {
      if (p.connectionId && p.status !== 'rejected') this.post(p.connectionId, msgs);
    }
  }

  async closeConnection(connectionId: string) {
    this.sockets.get(connectionId)?.close(1008, 'rejected');
  }
}
