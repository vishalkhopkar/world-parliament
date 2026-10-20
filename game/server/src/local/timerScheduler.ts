import type { GameTimeline, PlayerId } from '@hp/shared';
import type { GameService } from '../core/gameService';
import type { Clock, Scheduler } from '../core/types';

/** setTimeout-based lifecycle mirroring the Step Functions state machine + EventBridge Scheduler. */
export class TimerScheduler implements Scheduler {
  private svc!: GameService;
  private timers = new Set<NodeJS.Timeout>();
  private graces = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private n = 0;

  constructor(private readonly clock: Clock) {}

  bind(svc: GameService): void { this.svc = svc; }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.graces.values()) clearTimeout(t);
    this.timers.clear();
    this.graces.clear();
  }

  private sleepUntil(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.timers.delete(t); resolve(); }, Math.max(0, ms - this.clock.now()));
      this.timers.add(t);
    });
  }

  async startLifecycle(gameId: string, timeline: GameTimeline): Promise<void> {
    void (async () => {
      try {
        for (let p = 0; p < timeline.phaseCloses.length; p++) {
          await this.sleepUntil(timeline.phaseCloses[p]);
          if (this.stopped) return;
          await this.svc.phaseClose(gameId, p);
        }
        for (;;) {
          const r = await this.svc.countReveal(gameId);
          if (r.done) break;
          await this.sleepUntil(r.nextAtMs);
          if (this.stopped) return;
        }
        await this.sleepUntil(timeline.postCountingEnd);
        if (this.stopped) return;
        await this.svc.finalise(gameId);
      } catch (e) {
        console.error(`[lifecycle ${gameId}] failed`, e);
        await this.svc.finalise(gameId, { error: true }).catch((e2) => console.error('finalise(error) failed', e2));
      }
    })();
  }

  async scheduleGraceCheck(gameId: string, playerId: PlayerId, atMs: number): Promise<string> {
    const name = `grace-${gameId}-${playerId}-${this.n++}`;
    const t = setTimeout(() => {
      this.graces.delete(name);
      this.svc.graceCheck(gameId, playerId).catch((e) => console.error('graceCheck failed', e));
    }, Math.max(0, atMs - this.clock.now()));
    this.graces.set(name, t);
    return name;
  }

  async cancelGraceCheck(name: string): Promise<void> {
    const t = this.graces.get(name);
    if (t) clearTimeout(t);
    this.graces.delete(name);
  }
}
