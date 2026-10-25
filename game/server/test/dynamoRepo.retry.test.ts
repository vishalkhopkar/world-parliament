import { describe, expect, it } from 'vitest';
import type { Action } from '@hp/shared';
import type { PlayerRecord } from '../src/core/types';
import { DynamoRepo } from '../src/aws/dynamoRepo';
import { FakeDdb } from './fakes/fakeDdb';

const NOW = 1_800_000_000_000;
const conflict = () => Object.assign(new Error('Transaction cancelled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'TransactionConflict' }],
});

/** Wraps the fake; after `arm(n)` the next `n` TransactWrite calls fail with a TransactionConflict (as DynamoDB does under contention). */
function flaky() {
  const ddb = new FakeDdb();
  let left = 0, tries = 0;
  const doc = { send: async (c: unknown) => {
    if (c?.constructor?.name === 'TransactWriteCommand') { tries++; if (left-- > 0) throw conflict(); }
    return ddb.send(c);
  } };
  return { repo: new DynamoRepo(doc as never, ddb.tableName, () => NOW), tries: () => tries, arm: (n: number) => { left = n; tries = 0; } };
}

const seed = async (repo: DynamoRepo) => {
  const p: PlayerRecord = { gameId: 'g1', playerId: 'p0', nickname: 'n', tokenHash: 'h', isAdmin: true, status: 'active', budget: 1000, joinedAt: NOW };
  await repo.createGame({
    gameId: 'g1', joinCode: 'C1', mapId: 'test', phases: 3, status: 'campaign', admissionOpen: false, adminId: 'p0',
    createdAt: NOW, timeline: null, closedPhases: 0, revealedStep: 0,
  }, p);
};
const act = (id: string): Action => ({ id, playerId: 'p0', type: 'roadshow', seat: 1, ts: NOW });

describe('DynamoRepo campaign transaction under contention', () => {
  it('retries a TransactionConflict and still records the action once', async () => {
    const { repo, tries, arm } = flaky();
    await seed(repo); arm(2);
    expect(await repo.addAction('g1', 'p0', 400, act('a1'), 0)).toBe('ok');
    expect(tries()).toBe(3);
    expect((await repo.getPlayer('g1', 'p0'))?.budget).toBe(600);
  });

  it('a rally retried after a TransactionConflict is still subject to the cooldown condition (re-evaluated, never bypassed)', async () => {
    const { repo, tries, arm } = flaky();
    await seed(repo);
    const rally = (id: string, ts: number): Action => ({ ...act(id), type: 'rally', ts });
    arm(2);
    expect(await repo.addAction('g1', 'p0', 100, rally('r1', NOW), 0, { rallyGapMs: 30_000 })).toBe('ok');
    expect(tries()).toBe(3);
    arm(2);
    expect(await repo.addAction('g1', 'p0', 100, rally('r2', NOW + 1), 0, { rallyGapMs: 30_000 })).toBe('cooldown');
    expect(tries()).toBe(3); // conflicts retried, the cooldown failure is final (not retried)
    expect((await repo.getPlayer('g1', 'p0'))?.budget).toBe(900);
    expect(await repo.listActions('g1')).toHaveLength(1);
  });

  it('gives up with the original error when the conflict never clears', async () => {
    const { repo, arm } = flaky();
    await seed(repo); arm(1000);
    await expect(repo.addAction('g1', 'p0', 400, act('a2'), 0)).rejects.toThrow('Transaction cancelled');
  });
});
