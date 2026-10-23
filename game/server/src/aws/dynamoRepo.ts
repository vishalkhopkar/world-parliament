import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Action, CoalitionOffer, FinalResult, Government, PlayerId, SeatResult } from '@hp/shared';
import type {
  ConnectionRecord, CountPlan, GameRecord, PlayerRecord, Repo, SpendResult, StoredChat, StoredReport,
} from '../core/types';

export const TTL_SECONDS = 7 * 24 * 3600;
let reportSeq = 0;
/** Tie-break suffix for report sort keys: in-process insertion order + random part (cross-container uniqueness). */
const reportSuffix = () => `${String(reportSeq++ % 1_000_000).padStart(6, '0')}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

type Item = Record<string, unknown>;
const META_KEYS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ttl'];

function strip<T>(item: Item | undefined): T | null {
  if (!item) return null;
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) if (!META_KEYS.includes(k)) out[k] = v;
  return out as T;
}

function isCondFail(e: unknown): boolean {
  return (e as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** Single-table DynamoDB implementation of Repo. `doc.send` is the only SDK surface used (easy to mock). */
export class DynamoRepo implements Repo {
  constructor(
    private readonly doc: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly table: string,
    private readonly now: () => number = Date.now,
  ) {}

  private ttl(): number { return Math.floor(this.now() / 1000) + TTL_SECONDS; }
  private gk(gameId: string) { return `GAME#${gameId}`; }

  // ---------------------------------------------------------------- low level
  private async put(item: Item, condition?: string): Promise<boolean> {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, Item: { ...item, ttl: this.ttl() },
        ...(condition ? { ConditionExpression: condition } : {}),
      }));
      return true;
    } catch (e) {
      if (condition && isCondFail(e)) return false;
      throw e;
    }
  }

  private async get<T>(pk: string, sk: string): Promise<T | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk }, ConsistentRead: true }));
    return strip<T>(r.Item);
  }

  private async query<T>(pk: string, skPrefix: string): Promise<T[]> {
    const out: T[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({
        TableName: this.table, ConsistentRead: true,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
        ExclusiveStartKey: key,
      }));
      for (const it of r.Items ?? []) out.push(strip<T>(it as Item) as T);
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }

  /** Equality-conditional update of top-level attributes; `undefined` removes the attribute (in `cond`: requires it absent). */
  private async update(pk: string, sk: string, patch: Item, cond?: Item): Promise<boolean> {
    const names: Record<string, string> = { '#ttl': 'ttl' };
    const values: Record<string, unknown> = { ':ttl': this.ttl() };
    const sets = ['#ttl = :ttl'];
    const removes: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(patch)) {
      const n = `#p${i}`;
      names[n] = k;
      if (v === undefined) removes.push(n);
      else { values[`:p${i}`] = v; sets.push(`${n} = :p${i}`); }
      i++;
    }
    const conds = ['attribute_exists(PK)'];
    let j = 0;
    for (const [k, v] of Object.entries(cond ?? {})) {
      names[`#c${j}`] = k;
      if (v === undefined) conds.push(`attribute_not_exists(#c${j})`); // cond {attr: undefined} = attribute absent
      else { values[`:c${j}`] = v; conds.push(`#c${j} = :c${j}`); }
      j++;
    }
    const expr = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table, Key: { PK: pk, SK: sk }, UpdateExpression: expr,
        ConditionExpression: conds.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
      return true;
    } catch (e) {
      if (isCondFail(e)) return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- games
  async createGame(game: GameRecord, admin: PlayerRecord): Promise<void> {
    const ttl = this.ttl();
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.table, ConditionExpression: 'attribute_not_exists(PK)',
          Item: { ...game, PK: this.gk(game.gameId), SK: 'META', GSI1PK: `CODE#${game.joinCode}`, GSI1SK: 'META', ttl } } },
        { Put: { TableName: this.table, Item: { ...admin, PK: this.gk(admin.gameId), SK: `PLAYER#${admin.playerId}`, ttl } } },
      ],
    }));
  }
  getGame(gameId: string) { return this.get<GameRecord>(this.gk(gameId), 'META'); }
  async findGameByCode(code: string): Promise<GameRecord | null> {
    const r = await this.doc.send(new QueryCommand({
      TableName: this.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :c AND GSI1SK = :m',
      ExpressionAttributeValues: { ':c': `CODE#${code}`, ':m': 'META' }, Limit: 1,
    }));
    return strip<GameRecord>(r.Items?.[0] as Item | undefined);
  }
  updateGame(gameId: string, patch: Partial<GameRecord>, cond?: Partial<GameRecord>) {
    return this.update(this.gk(gameId), 'META', patch as Item, cond as Item | undefined);
  }
  async markPhaseClosed(gameId: string, n: number): Promise<void> {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table, Key: { PK: this.gk(gameId), SK: 'META' },
        UpdateExpression: 'SET closedPhases = :n, #ttl = :ttl',
        ConditionExpression: 'attribute_exists(PK) AND closedPhases < :n',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':n': n, ':ttl': this.ttl() },
      }));
    } catch (e) {
      if (!isCondFail(e)) throw e;
    }
  }

  // ---------------------------------------------------------------- players
  async putPlayer(p: PlayerRecord) { await this.put({ ...p, PK: this.gk(p.gameId), SK: `PLAYER#${p.playerId}` }); }
  getPlayer(gameId: string, playerId: PlayerId) { return this.get<PlayerRecord>(this.gk(gameId), `PLAYER#${playerId}`); }
  listPlayers(gameId: string) { return this.query<PlayerRecord>(this.gk(gameId), 'PLAYER#'); }
  updatePlayer(gameId: string, playerId: PlayerId, patch: Partial<PlayerRecord>, cond?: Partial<PlayerRecord>) {
    return this.update(this.gk(gameId), `PLAYER#${playerId}`, patch as Item, cond as Item | undefined);
  }

  // ---------------------------------------------------------------- connections
  async putConnection(c: ConnectionRecord) { await this.put({ ...c, PK: `CONN#${c.connectionId}`, SK: 'META' }); }
  getConnection(id: string) { return this.get<ConnectionRecord>(`CONN#${id}`, 'META'); }
  async deleteConnection(id: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: `CONN#${id}`, SK: 'META' } }));
  }

  // ---------------------------------------------------------------- campaign
  /** Budget deduction + insert + game-state guard in one transaction. */
  private async spendAndInsert(
    gameId: string, playerId: PlayerId, cost: number, item: Item, expectClosedPhases: number,
  ): Promise<SpendResult> {
    const ttl = this.ttl();
    // Concurrent actions (several from one player, or all players sharing the game META condition check) make DynamoDB
    // cancel a transaction with TransactionConflict: not a business failure, so retry briefly with jitter.
    for (let attempt = 0; ; attempt++) {
      try { return await this.spendAndInsertOnce(gameId, playerId, cost, item, expectClosedPhases, ttl); } catch (e) {
        const reasons = (e as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
        const isConflict = (e as { name?: string })?.name === 'TransactionCanceledException'
          && !!reasons?.some((r) => r.Code === 'TransactionConflict');
        if (!isConflict || attempt >= 7) throw e;
        await new Promise((r) => setTimeout(r, 15 * 2 ** attempt * (0.5 + Math.random())));
      }
    }
  }

  private async spendAndInsertOnce(
    gameId: string, playerId: PlayerId, cost: number, item: Item, expectClosedPhases: number, ttl: number,
  ): Promise<SpendResult> {
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          { Update: {
            TableName: this.table, Key: { PK: this.gk(gameId), SK: `PLAYER#${playerId}` },
            UpdateExpression: 'SET budget = budget - :cost, #ttl = :ttl',
            ConditionExpression: 'attribute_exists(PK) AND budget >= :cost AND #status = :active',
            ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':cost': cost, ':active': 'active', ':ttl': ttl },
          } },
          { Put: { TableName: this.table, Item: { ...item, ttl }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { ConditionCheck: {
            TableName: this.table, Key: { PK: this.gk(gameId), SK: 'META' },
            ConditionExpression: '#status = :campaign AND closedPhases = :cp',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':campaign': 'campaign', ':cp': expectClosedPhases },
          } },
        ],
      }));
      return 'ok';
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
      if ((e as { name?: string })?.name === 'TransactionCanceledException' && reasons) {
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'insufficient';
        if (reasons[2]?.Code === 'ConditionalCheckFailed') return 'conflict';
      }
      throw e;
    }
  }

  addAction(gameId: string, playerId: PlayerId, cost: number, a: Action, expectClosedPhases: number) {
    return this.spendAndInsert(gameId, playerId, cost, {
      ...a, PK: this.gk(gameId), SK: `ACT#${pad(a.ts, 15)}#${a.playerId}#${a.id}`,
    }, expectClosedPhases);
  }
  listActions(gameId: string) { return this.query<Action>(this.gk(gameId), 'ACT#'); }
  addReport(gameId: string, playerId: PlayerId, cost: number, rep: StoredReport, expectClosedPhases: number) {
    return this.spendAndInsert(gameId, playerId, cost, {
      ...rep, PK: this.gk(gameId), SK: `REP#${playerId}#${pad(rep.ts, 15)}#${reportSuffix()}`,
    }, expectClosedPhases);
  }
  listReports(gameId: string, playerId: PlayerId) { return this.query<StoredReport>(this.gk(gameId), `REP#${playerId}#`); }

  // ---------------------------------------------------------------- results
  async putSeatResults(gameId: string, results: SeatResult[]) {
    for (let i = 0; i < results.length; i += 25) {
      await Promise.all(results.slice(i, i + 25).map((r) => this.put({ ...r, PK: this.gk(gameId), SK: `SEAT#${pad(r.seat, 4)}` })));
    }
  }
  listSeatResults(gameId: string) { return this.query<SeatResult>(this.gk(gameId), 'SEAT#'); }
  async putCountPlan(gameId: string, plan: CountPlan) { await this.put({ ...plan, PK: this.gk(gameId), SK: 'PLAN' }); }
  getCountPlan(gameId: string) { return this.get<CountPlan>(this.gk(gameId), 'PLAN'); }

  // ---------------------------------------------------------------- chat
  async addChat(gameId: string, m: StoredChat) { await this.put({ ...m, PK: this.gk(gameId), SK: `CHAT#${pad(m.ts, 15)}#${m.id}` }); }
  listChat(gameId: string) { return this.query<StoredChat>(this.gk(gameId), 'CHAT#'); }

  // ---------------------------------------------------------------- offers, government, result
  async putOffer(gameId: string, o: CoalitionOffer) { await this.put({ ...o, PK: this.gk(gameId), SK: `OFFER#${o.offerId}` }); }
  getOffer(gameId: string, offerId: string) { return this.get<CoalitionOffer>(this.gk(gameId), `OFFER#${offerId}`); }
  async listOffers(gameId: string) {
    return (await this.query<CoalitionOffer>(this.gk(gameId), 'OFFER#')).sort((a, b) => a.createdAt - b.createdAt);
  }
  putGovernmentIfAbsent(gameId: string, g: Government) {
    return this.put({ ...g, PK: this.gk(gameId), SK: 'GOVT' }, 'attribute_not_exists(PK)');
  }
  getGovernment(gameId: string) { return this.get<Government>(this.gk(gameId), 'GOVT'); }
  putResultIfAbsent(gameId: string, r: FinalResult) {
    return this.put({ ...r, PK: this.gk(gameId), SK: 'RESULT' }, 'attribute_not_exists(PK)');
  }
  getResult(gameId: string) { return this.get<FinalResult>(this.gk(gameId), 'RESULT'); }
}
