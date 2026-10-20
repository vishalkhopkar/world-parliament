import { DeleteConnectionCommand, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import type { PlayerId, ServerMessage } from '@hp/shared';
import type { Notifier, Repo } from '../core/types';

const arr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

export class ApiGwNotifier implements Notifier {
  constructor(private readonly client: Pick<ApiGatewayManagementApiClient, 'send'>, private readonly repo: Repo) {}

  /** Sends in order to one connection. A gone connection (410) is removed from the table. */
  private async post(connectionId: string, msgs: ServerMessage[]): Promise<void> {
    for (const m of msgs) {
      try {
        await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(m)) }));
      } catch (e) {
        const name = (e as { name?: string })?.name;
        const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (name === 'GoneException' || status === 410) {
          await this.repo.deleteConnection(connectionId).catch(() => undefined);
          return;
        }
        console.error('postToConnection failed', connectionId, name, (e as Error)?.message);
        return; // never let one bad socket break the game logic
      }
    }
  }

  async sendToConnection(connectionId: string, msg: ServerMessage | ServerMessage[]) { await this.post(connectionId, arr(msg)); }

  async sendToPlayer(gameId: string, playerId: PlayerId, msg: ServerMessage | ServerMessage[]) {
    const p = await this.repo.getPlayer(gameId, playerId);
    if (p?.connectionId) await this.post(p.connectionId, arr(msg));
  }

  /** Same audience as the test FakeNotifier: pending (not yet admitted) and rejected players never receive broadcasts. */
  async broadcast(gameId: string, msg: ServerMessage | ServerMessage[]) {
    const msgs = arr(msg);
    const players = await this.repo.listPlayers(gameId);
    await Promise.all(players.filter((p) => p.connectionId && p.status !== 'rejected' && p.status !== 'pending').map((p) => this.post(p.connectionId as string, msgs)));
  }

  async closeConnection(connectionId: string) {
    try {
      await this.client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (e) {
      if ((e as { name?: string })?.name !== 'GoneException') throw e;
    }
  }
}
