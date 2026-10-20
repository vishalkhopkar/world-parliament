import { describe, expect, it } from 'vitest';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { FakeDdb } from './fakeDdb';

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = 't';
const mk = () => new FakeDdb({ tableName: T });
const put = (d: FakeDdb, item: Record<string, unknown>, extra: object = {}) => d.send(new PutCommand({ TableName: T, Item: item, ...extra }));
const err = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { return e as Error & { CancellationReasons?: { Code: string }[] }; }
};

describe('FakeDdb self-tests (the fake itself must be trustworthy)', () => {
  it('put/get/delete with conditions', async () => {
    const d = mk();
    await put(d, { PK: 'a', SK: '1', n: 1 }, { ConditionExpression: 'attribute_not_exists(PK)' });
    expect((await err(put(d, { PK: 'a', SK: '1', n: 2 }, { ConditionExpression: 'attribute_not_exists(PK)' })))?.name).toBe('ConditionalCheckFailedException');
    expect((await d.send(new GetCommand({ TableName: T, Key: { PK: 'a', SK: '1' } }))).Item?.n).toBe(1);
    const del = (x: number) => d.send(new DeleteCommand({ TableName: T, Key: { PK: 'a', SK: '1' }, ConditionExpression: 'n = :x', ExpressionAttributeValues: { ':x': x } }));
    expect((await err(del(9)))?.name).toBe('ConditionalCheckFailedException');
    await del(1);
    expect((await d.send(new GetCommand({ TableName: T, Key: { PK: 'a', SK: '1' } }))).Item).toBeUndefined();
  });

  it('update expressions: SET arithmetic, if_not_exists, list_append, REMOVE, ADD, upsert', async () => {
    const d = mk();
    await put(d, { PK: 'a', SK: '1', n: 10, l: [1], nested: { x: 1 }, gone: 1 });
    const upd = (UpdateExpression: string, vals?: object) =>
      d.send(new UpdateCommand({ TableName: T, Key: { PK: 'a', SK: '1' }, UpdateExpression, ExpressionAttributeValues: vals as any }));
    await upd('SET n = n - :c, l = list_append(l, :e), m = if_not_exists(m, :z), nested.x = :nx REMOVE gone ADD cnt :one',
      { ':c': 3, ':e': [2], ':z': 5, ':nx': 7, ':one': 1 });
    await upd('SET m = if_not_exists(m, :z)', { ':z': 99 });
    expect(d.get('a', '1')).toMatchObject({ n: 7, l: [1, 2], m: 5, nested: { x: 7 }, cnt: 1 });
    expect(d.get('a', '1')).not.toHaveProperty('gone');
    await d.send(new UpdateCommand({ TableName: T, Key: { PK: 'new', SK: 'x' }, UpdateExpression: 'SET v = :v', ExpressionAttributeValues: { ':v': 1 } }));
    expect(d.get('new', 'x')).toEqual({ PK: 'new', SK: 'x', v: 1 });
    expect((await err(upd('SET n = missing - :c', { ':c': 1 })))?.name).toBe('ValidationException');
  });

  it('rejects what real DynamoDB rejects: reserved words, unused names/values, key updates, overlapping paths', async () => {
    const d = mk();
    await put(d, { PK: 'a', SK: '1', status: 'x' });
    const u = (e: string, v?: object, n?: object) => d.send(new UpdateCommand({
      TableName: T, Key: { PK: 'a', SK: '1' }, UpdateExpression: e, ExpressionAttributeValues: v as any, ExpressionAttributeNames: n as any,
    }));
    expect((await err(u('SET status = :v', { ':v': 1 })))?.message).toMatch(/reserved/);
    expect((await err(u('SET ttl = :v', { ':v': 1 })))?.message).toMatch(/reserved/);
    expect((await err(u('SET a = :v', { ':v': 1, ':w': 2 })))?.message).toMatch(/unused/);
    expect((await err(u('SET a = :v', { ':v': 1 }, { '#n': 'x' })))?.message).toMatch(/unused/);
    expect((await err(u('SET a = :v, a = :v', { ':v': 1 })))?.message).toMatch(/overlap/);
    expect((await err(u('SET PK = :v', { ':v': 'z' })))?.message).toMatch(/key/);
    expect(await err(u('SET #s = :v', { ':v': 1 }, { '#s': 'status' }))).toBeNull();
  });

  it('fails loudly on unsupported features', async () => {
    const d = mk();
    await put(d, { PK: 'a', SK: '1' });
    const unsupported = /FakeDdb: unsupported/;
    expect((await err(d.send(new UpdateCommand({ TableName: T, Key: { PK: 'a', SK: '1' }, UpdateExpression: 'DELETE s :v', ExpressionAttributeValues: { ':v': 1 } }))))?.message).toMatch(unsupported);
    expect((await err(d.send(new GetCommand({ TableName: T, Key: { PK: 'a', SK: '1' }, ProjectionExpression: 'x' }))))?.message).toMatch(unsupported);
    expect((await err(put(d, { PK: 'a', SK: '2' }, { ReturnValues: 'ALL_OLD' })))?.message).toMatch(unsupported);
    expect((await err(put(d, { PK: 'a', SK: '2' }, { ConditionExpression: 'weird_fn(PK)' })))?.message).toMatch(unsupported);
    expect((await err(d.send({ constructor: { name: 'ScanCommand' }, input: {} })))?.message).toMatch(unsupported);
  });

  it('query: begins_with, between, comparison, pagination via Limit, GSI, filter, descending', async () => {
    const d = mk();
    for (let i = 0; i < 10; i++) await put(d, { PK: 'p', SK: `S#${i}`, i, GSI1PK: i % 2 ? 'odd' : 'even', GSI1SK: `k${i}` });
    await put(d, { PK: 'q', SK: 'S#0' });
    const q = (o: object) => d.send(new QueryCommand({ TableName: T, ...o } as any));
    const is = (r: any) => r.Items?.map((x: { i: number }) => x.i);
    expect((await q({ KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)', ExpressionAttributeValues: { ':p': 'p', ':s': 'S#' } })).Items).toHaveLength(10);
    expect(is(await q({ KeyConditionExpression: 'PK = :p AND SK BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': 'p', ':a': 'S#2', ':b': 'S#4' } }))).toEqual([2, 3, 4]);
    expect(is(await q({ KeyConditionExpression: 'PK = :p AND SK > :a', ExpressionAttributeValues: { ':p': 'p', ':a': 'S#7' } }))).toEqual([8, 9]);
    const seen: number[] = [];
    let key: object | undefined;
    do {
      const r = await q({ KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'p' }, Limit: 3, ExclusiveStartKey: key });
      seen.push(...is(r)); key = r.LastEvaluatedKey;
    } while (key);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(is(await q({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :c', ExpressionAttributeValues: { ':c': 'odd' } }))).toEqual([1, 3, 5, 7, 9]);
    expect(is(await q({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :c AND GSI1SK = :m', ExpressionAttributeValues: { ':c': 'even', ':m': 'k4' }, Limit: 1 }))).toEqual([4]);
    expect(is(await q({ KeyConditionExpression: 'PK = :p', FilterExpression: 'i >= :m AND (i < :n OR i = :z)', ExpressionAttributeValues: { ':p': 'p', ':m': 2, ':n': 4, ':z': 9 } }))).toEqual([2, 3, 9]);
    expect(is(await q({ KeyConditionExpression: 'PK = :p', ScanIndexForward: false, Limit: 2, ExpressionAttributeValues: { ':p': 'p' } }))).toEqual([9, 8]);
    expect((await err(q({ KeyConditionExpression: 'SK = :s', ExpressionAttributeValues: { ':s': 'x' } })))?.name).toBe('ValidationException');
    expect((await err(q({ IndexName: 'GSI9', KeyConditionExpression: 'PK = :s', ExpressionAttributeValues: { ':s': 'x' } })))?.name).toBe('ValidationException');
  });

  it('transactions are all-or-nothing and report per-item reasons', async () => {
    const d = mk();
    await put(d, { PK: 'a', SK: '1', n: 5 });
    const tx = (items: object[]) => d.send(new TransactWriteCommand({ TransactItems: items as any }));
    const dec = { Update: { TableName: T, Key: { PK: 'a', SK: '1' }, UpdateExpression: 'SET n = n - :c', ConditionExpression: 'n >= :c', ExpressionAttributeValues: { ':c': 3 } } };
    const e = await err(tx([
      dec,
      { Put: { TableName: T, Item: { PK: 'b', SK: '1' }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { ConditionCheck: { TableName: T, Key: { PK: 'zzz', SK: '1' }, ConditionExpression: 'attribute_exists(PK)' } },
    ]));
    expect(e?.name).toBe('TransactionCanceledException');
    expect(e?.CancellationReasons?.map((r) => r.Code)).toEqual(['None', 'None', 'ConditionalCheckFailed']);
    expect(d.get('a', '1')?.n).toBe(5);
    expect(d.get('b', '1')).toBeUndefined();
    expect((await err(tx([{ Put: { TableName: T, Item: { PK: 'x', SK: '1' } } }, { Put: { TableName: T, Item: { PK: 'x', SK: '1' } } }])))?.name).toBe('ValidationException');
    await tx([dec, { Put: { TableName: T, Item: { PK: 'b', SK: '1' } } }]);
    expect(d.get('a', '1')?.n).toBe(2);
    expect(d.get('b', '1')).toBeDefined();
  });

  it('enforces the 400 KB item limit and strips undefined (like removeUndefinedValues)', async () => {
    const d = mk();
    expect((await err(put(d, { PK: 'a', SK: '1', big: 'x'.repeat(401 * 1024) })))?.name).toBe('ValidationException');
    await put(d, { PK: 'a', SK: '1', u: undefined, m: { k: undefined, j: 1 } });
    expect(d.get('a', '1')).toEqual({ PK: 'a', SK: '1', m: { j: 1 } });
  });
});
