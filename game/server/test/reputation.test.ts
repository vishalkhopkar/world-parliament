import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@hp/shared';
import { Ctx } from './helpers';

type Ack = Extract<ServerMessage, { type: 'actionAck' }>;
type Hello = Extract<ServerMessage, { type: 'hello' }>;
const keyPaths = (v: unknown, key: string, path: string[] = [], out: string[][] = []): string[][] => {
  if (Array.isArray(v)) v.forEach((x, i) => keyPaths(x, key, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === key) out.push([...path, k]); keyPaths(x, key, [...path, k], out); }
  return out;
};
const lastAck = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'actionAck').pop() as Ack;

describe('own reputation (swing voters)', () => {
  it('the hello private state has reputation {} before any action, and in the lobby', async () => {
    const lobby = await new Ctx().lobby(2);
    expect((await lobby.svc.privateState(lobby.gameId, lobby.p[0].playerId)).reputation ?? {}).toEqual({});
    const c = await new Ctx().started(2);
    const h = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[0].playerId))!)) as Hello;
    expect(h.private.reputation).toEqual({});
  });

  it('the ack after a rally carries 10 on the rally seat; a second rally raises it; the hello repeats it', async () => {
    const c = await new Ctx().started(2);
    // seat 8 polls in the last phase, so it is still open when the rally cooldown has passed
    await c.send(0, { action: 'campaign', type: 'rally', seat: 8 });
    const a1 = lastAck(c, 0);
    expect(a1.reputation?.[8]).toBe(Math.round((c.cfg.effects.rally.local + c.cfg.effects.rally.global) * c.cfg.display.reputationScale));
    c.clock.advance(c.cfg.cooldowns.rallyMs);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 8 });
    expect(lastAck(c, 0).reputation![8]).toBeGreaterThan(a1.reputation![8]);
    const h = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[0].playerId))!)) as Hello;
    expect(h.private.reputation).toEqual(lastAck(c, 0).reputation);
  });

  it("a roadshow shows too, and another party's numbers never reach you", async () => {
    const c = await new Ctx().started(2);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 2 });
    await c.send(1, { action: 'campaign', type: 'rally', seat: 3 }); // ~111 km from seat 2, where a roadshow has all but died out
    const mine = lastAck(c, 0).reputation!;
    const theirs = lastAck(c, 1).reputation!;
    expect(mine[2]).toBeGreaterThan(theirs[2] ?? 0);
    expect(theirs[3]).toBeGreaterThan(mine[3] ?? 0);
    const hB = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!)) as Hello;
    expect(hB.private.reputation).toEqual(theirs);
    expect(hB.private.reputation![2] ?? 0).toBe(theirs[2] ?? 0);
  });

  it('stays after the seat phase closes (frozen, not lost)', async () => {
    const c = await new Ctx().started(2, 3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    const before = lastAck(c, 0).reputation![1];
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    const p = await c.svc.privateState(c.gameId, c.p[0].playerId);
    expect(p.reputation![1]).toBe(before);
  });

  it('is sent only as private.reputation (hello/private) or actionAck.reputation, always to its owner', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 4 });
    await c.runCampaignToCountingEnd();
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, `${p.conn}x`);
    for (const { msg } of c.notifier.log) {
      for (const path of keyPaths(msg, 'reputation')) {
        if (msg.type === 'actionAck') expect(path).toEqual(['reputation']);
        else expect(path).toEqual(['private', 'reputation']);
        expect(['actionAck', 'hello', 'private']).toContain(msg.type);
      }
    }
    for (const p of c.p) {
      const own = await c.svc.privateState(c.gameId, p.playerId);
      for (const s of c.notifier.log.filter((x) => x.to === p.playerId && x.msg.type === 'actionAck')) {
        const r = (s.msg as Ack).reputation ?? {};
        for (const [seat, v] of Object.entries(r)) expect(own.reputation?.[Number(seat)] ?? 0).toBeGreaterThanOrEqual(v);
      }
    }
  });
});
