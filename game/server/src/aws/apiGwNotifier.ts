import { DeleteConnectionCommand, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import type { PlayerId, ServerMessage } from '@hp/shared';
import type { Notifier, Repo } from '../core/types';

const arr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** API Gateway answers 429 when too many frames are pushed at once (a counting step sends many seatUpdates). */
const isThrottle = (name?: string, status?: number) =>
  status === 429 || name === 'TooManyRequestsException' || name === 'ThrottlingException' || name === 'LimitExceededException';
const THROTTLE_RETRIES = 6;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ApiGwNotifier implements Notifier {
  constructor(
    private readonly client: Pick<ApiGatewayManagementApiClient, 'send'>,
    private readonly repo: Repo,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  /**
   * Sends in order to one connection. A gone connection (410) is removed from the table. A throttled post (429) is retried
   * with backoff; if it still fails that one message is skipped but the rest of the batch is STILL sent (dropping the tail of
   * a batch silently left clients with seats that were never declared on their map).
   */
  private async post(connectionId: string, msgs: ServerMessage[]): Promise<void> {
    for (const m of msgs) {
      const data = Buffer.from(JSON.stringify(m));
      for (let attempt = 0; ; attempt++) {
        try {
          await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
          break;
        } catch (e) {
          const name = (e as { name?: string })?.name;
          const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
          if (name === 'GoneException' || status === 410) {
            await this.repo.deleteConnection(connectionId).catch(() => undefined);
            return;
          }
          if (isThrottle(name, status)) {
            if (attempt < THROTTLE_RETRIES) { await this.sleep(20 * 2 ** attempt * (0.5 + Math.random())); continue; }
            console.error('postToConnection throttled, message skipped', connectionId, name, (e as Error)?.message);
            break; // skip this message, keep sending the rest
          }
          console.error('postToConnection failed', connectionId, name, (e as Error)?.message);
          return; // never let one bad socket break the game logic
        }
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
