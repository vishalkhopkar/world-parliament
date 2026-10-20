import { describe, expect, it } from 'vitest';
import { Ctx } from './helpers';
import { dealCandidateColumns } from '../src/core/gameService';

/** Candidate columns: when the host starts the game every active player is dealt one distinct random column (0-based)
 *  of the map's candidates.csv; all of that party's candidates come from it. Server-internal, never sent to clients. */
async function columnsOf(c: Ctx): Promise<(number | undefined)[]> {
  const players = await c.repo.listPlayers(c.gameId);
  return c.p.map((tp) => players.find((p) => p.playerId === tp.playerId)?.candidateColumn);
}

describe('dealCandidateColumns', () => {
  it('returns `count` distinct columns inside 0..columns-1', () => {
    for (let count = 0; count <= 10; count++) {
      const cols = dealCandidateColumns(count, 10);
      expect(cols).toHaveLength(count);
      expect(new Set(cols).size).toBe(count);
      for (const c of cols) { expect(Number.isInteger(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(10); }
    }
  });

  it('dealing all columns is a permutation of 0..columns-1 (the last player gets the only one left)', () => {
    expect([...dealCandidateColumns(10, 10)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is random: every column shows up in position 0 over many deals', () => {
    const first = new Set<number>();
    for (let i = 0; i < 400; i++) first.add(dealCandidateColumns(3, 10)[0]);
    expect(first.size).toBe(10);
  });

  it('refuses to deal more columns than exist', () => {
    expect(() => dealCandidateColumns(11, 10)).toThrow();
  });
});

describe('candidate columns at game start', () => {
  it('nobody has a column while the game is still in the lobby (party setup does not assign one)', async () => {
    const c = new Ctx();
    await c.lobby(4);
    expect(await columnsOf(c)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('start gives every active player a distinct column in range', async () => {
    for (let n = 2; n <= 10; n++) {
      const c = new Ctx();
      await c.lobby(n);
      await c.svc.start(c.gameId, c.p[0].token);
      const cols = (await columnsOf(c)) as number[];
      expect(new Set(cols).size).toBe(n);
      for (const col of cols) { expect(Number.isInteger(col)).toBe(true); expect(col).toBeLessThan(c.cfg.players.max); }
    }
  });

  it('with 10 players all 10 columns are used', async () => {
    const c = new Ctx();
    await c.lobby(10);
    await c.svc.start(c.gameId, c.p[0].token);
    expect([...((await columnsOf(c)) as number[])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is random across games (the admin does not always get the same column)', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const c = new Ctx();
      await c.lobby(2);
      await c.svc.start(c.gameId, c.p[0].token);
      seen.add(((await columnsOf(c)) as number[])[0]);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('rejected and never-admitted players get no column, and a failed start deals nothing that sticks', async () => {
    const c = new Ctx();
    await c.lobby(3);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Pending' }); // never admitted
    await c.svc.start(c.gameId, c.p[0].token);
    const players = await c.repo.listPlayers(c.gameId);
    expect(players.find((p) => p.playerId === j.playerId)?.candidateColumn).toBeUndefined();
    expect(players.filter((p) => p.candidateColumn !== undefined)).toHaveLength(3);
  });

  it('AI players are dealt a column like everybody else', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Bot', kind: 'agent' });
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: true });
    await c.svc.setParty(c.gameId, j.token, { party: { name: 'Robots', colour: 'lime', symbol: 'star', avatar: 'xi' } });
    await c.svc.start(c.gameId, c.p[0].token);
    const cols = (await c.repo.listPlayers(c.gameId)).filter((p) => p.status === 'active').map((p) => p.candidateColumn);
    expect(cols.every((x) => x !== undefined)).toBe(true);
    expect(new Set(cols).size).toBe(3);
  });

  it('the column is never exposed: not in the lobby view, the start response or any message', async () => {
    const c = new Ctx();
    await c.started(3);
    const view = await c.svc.getLobby(c.gameId, c.p[0].token);
    expect(JSON.stringify(view)).not.toContain('candidateColumn');
    expect(c.notifier.log.length).toBeGreaterThan(0);
    for (const s of c.notifier.log) expect(JSON.stringify(s.msg)).not.toContain('candidateColumn');
  });
});
