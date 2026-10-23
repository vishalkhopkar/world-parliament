import { describe, expect, it } from 'vitest';
import type { CommittedSet, ServerMessage } from '@hp/shared';
import { committedTotals, committedView } from '@hp/shared';
import { Ctx } from './helpers';

const sets = async (c: Ctx): Promise<CommittedSet[]> => {
  const out: CommittedSet[] = [];
  for (const p of c.p) out.push((await c.repo.getPlayer(c.gameId, p.playerId))!.committed!);
  return out;
};
const keyPaths = (v: unknown, key: string, path: string[] = [], out: string[][] = []): string[][] => {
  if (Array.isArray(v)) v.forEach((x, i) => keyPaths(x, key, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === key) out.push([...path, k]); keyPaths(x, key, [...path, k], out); }
  return out;
};
const deal = (c: Ctx, id: string): Promise<void> => (c.svc as unknown as { dealCommittedFor(g: string, p: string): Promise<void> }).dealCommittedFor(c.gameId, id);

describe('committed voters: dealing', () => {
  it('createGame deals the admin, admit deals each player; cores are distinct', async () => {
    const c = await new Ctx().lobby(3);
    const all = await sets(c);
    for (const s of all) { expect(s).toBeDefined(); expect(s.seats.length).toBeGreaterThan(0); expect(s.seats.some((x) => x.seat === s.core)).toBe(true); }
    expect(new Set(all.map((s) => s.core)).size).toBe(3);
    expect((await c.game()).committedSeq).toBe(3);
  });

  it('a pending player has nothing until admitted; rejected players are never dealt', async () => {
    const c = await new Ctx().lobby(1);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'X' });
    expect((await c.repo.getPlayer(c.gameId, j.playerId))!.committed).toBeUndefined();
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: false });
    expect((await c.repo.getPlayer(c.gameId, j.playerId))!.committed).toBeUndefined();
  });

  it('later deals see earlier ones: no seat above the per-seat cap across players', async () => {
    const c = await new Ctx().lobby(6);
    const tot = committedTotals(await sets(c), c.cfg);
    for (const v of tot.values()) expect(v).toBeLessThanOrEqual(c.cfg.committed.seatMaxPercent);
  });

  it("is idempotent: re-admitting or starting does not change a player's deal", async () => {
    const c = await new Ctx().lobby(3);
    const before = await sets(c);
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: c.p[1].playerId, admit: true });
    await c.svc.start(c.gameId, c.p[0].token);
    expect(await sets(c)).toEqual(before);
    expect((await c.game()).committedSeq).toBe(3);
  });

  it('start() deals an active player that still has no committed voters', async () => {
    const c = await new Ctx().lobby(3);
    const before = await sets(c);
    await c.repo.updatePlayer(c.gameId, c.p[2].playerId, { committed: undefined });
    await c.svc.start(c.gameId, c.p[0].token);
    const after = await sets(c);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2].seats.length).toBeGreaterThan(0);
    expect(after[2].core).not.toBe(after[0].core);
    expect(after[2].core).not.toBe(after[1].core);
  });

  it('two deals racing end with a consistent seq and both players dealt against fresh views', async () => {
    const c = await new Ctx().lobby(1);
    const ids: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: `R${i}` });
      ids.push(j.playerId);
      await c.repo.updatePlayer(c.gameId, j.playerId, { status: 'active' }); // admitted without a deal
    }
    await Promise.all(ids.map((id) => deal(c, id)));
    const all = await Promise.all([c.p[0].playerId, ...ids].map(async (id) => (await c.repo.getPlayer(c.gameId, id))!.committed!));
    expect((await c.game()).committedSeq).toBe(3);
    expect(new Set(all.map((s) => s.core)).size).toBe(3);
    for (const v of committedTotals(all, c.cfg).values()) expect(v).toBeLessThanOrEqual(c.cfg.committed.seatMaxPercent);
  });

  it('a stale seq loses the condition and retries', async () => {
    const c = await new Ctx().lobby(2);
    await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { committed: undefined });
    const real = c.repo.updateGame.bind(c.repo);
    let n = 0;
    c.repo.updateGame = async (g, patch, cond) => {
      if (n++ === 0) await real(g, { committedSeq: 7 }); // someone else bumped it between our read and write
      return real(g, patch, cond);
    };
    await deal(c, c.p[1].playerId);
    expect((await c.game()).committedSeq).toBe(8);
    expect((await sets(c))[1]).toBeDefined();
  });
});

describe('committed voters: privacy', () => {
  it("privateState carries only the owner's own bands", async () => {
    const c = await new Ctx().started(3);
    const all = await sets(c);
    for (let i = 0; i < 3; i++) {
      const ps = await c.svc.privateState(c.gameId, c.p[i].playerId);
      expect(ps.committed).toEqual(committedView(all[i], c.cfg));
      expect(ps.committed!.length).toBeGreaterThan(0);
    }
  });

  it("nothing outbound carries committed data except the recipient's own private.committed", async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.runCampaignToCountingEnd();
    await c.svc.finalise(c.gameId);
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, `${p.conn}x`);
    const all = await sets(c);
    for (const { to, msg } of c.notifier.log) {
      const paths = keyPaths(msg, 'committed');
      for (const path of paths) expect(path).toEqual(['private', 'committed']);
      if (paths.length) {
        expect(msg.type).toBe('hello');
        const i = c.p.findIndex((p) => p.playerId === to);
        expect((msg as Extract<ServerMessage, { type: 'hello' }>).private.committed).toEqual(committedView(all[i], c.cfg));
      }
      const s = JSON.stringify(msg);
      expect(s).not.toContain('"core"');
      expect(s).not.toContain('committedSeq');
    }
    expect(JSON.stringify(await c.repo.getResult(c.gameId))).not.toContain('committed');
    expect(JSON.stringify(await c.svc.getLobby(c.gameId, c.p[1].token))).not.toContain('committed');
  });

  it("a pending player's hello has no committed bands", async () => {
    const c = await new Ctx().lobby(1);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Y' });
    const h = (await c.svc.hello((await c.repo.getPlayer(c.gameId, j.playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
    expect(h.private.committed ?? []).toEqual([]);
    expect(JSON.stringify(h)).not.toContain('"core"');
  });
});

describe('committed voters: polling', () => {
  it('a seat nobody campaigned in is always won; its committed party wins it most of the time', async () => {
    let wins = 0;
    let n = 0;
    for (let k = 0; k < 120; k++) {
      const c = await new Ctx().started(2, 1);
      const [a, b] = await sets(c);
      // a seat in a's top band where b has no committed voters
      const seat = a.seats.find((s) => s.band === 1 && !b.seats.some((x) => x.seat === s.seat))?.seat;
      if (seat === undefined) continue;
      await c.runCampaignToCountingEnd();
      const r = (await c.repo.listSeatResults(c.gameId)).find((x) => x.seat === seat)!;
      expect(r.winner).not.toBeNull();
      n++;
      if (r.winner === c.p[0].playerId) wins++;
    }
    expect(n).toBeGreaterThan(10);
    expect(wins / n).toBeGreaterThan(0.6);
  });
});
