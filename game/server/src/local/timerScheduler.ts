import type { GameTimeline, PlayerId } from '@hp/shared';
import type { GameService } from '../core/gameService';
import type { Clock, Scheduler } from '../core/types';

/** setTimeout-based lifecycle mirroring the Step Functions state machine + EventBridge Scheduler. */
export class TimerScheduler implements Scheduler {
  private svc!: GameService;
  private timers = new Set<NodeJS.Timeout>();
  /** The pending lifecycle timers of each game (cleared by restartLifecycle). */
  private gameTimers = new Map<string, Set<NodeJS.Timeout>>();
  /** Per game: the token of its current lifecycle loop. A loop whose token is no longer current stops at its next step. */
  private loops = new Map<string, number>();
  private graces = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private n = 0;
  private tokens = 0;
  /** How often the post-counting wait asks whether the game has already finished. */
  static readonly POLL_MS = 1000;

  constructor(private readonly clock: Clock) {}

  bind(svc: GameService): void { this.svc = svc; }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.graces.values()) clearTimeout(t);
    this.timers.clear();
    this.gameTimers.clear();
    this.graces.clear();
  }

  private sleepUntil(gameId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const own = this.gameTimers.get(gameId) ?? new Set<NodeJS.Timeout>();
      this.gameTimers.set(gameId, own);
      const t = setTimeout(() => { this.timers.delete(t); own.delete(t); resolve(); }, Math.max(0, ms - this.clock.now()));
      this.timers.add(t);
      own.add(t);
    });
  }

  async startLifecycle(gameId: string, timeline: GameTimeline): Promise<void> {
    this.run(gameId, timeline);
  }

  /** Cancel the game's running loop (its pending timers are cleared; a step already running finishes, then it stops) and start a new one. */
  async restartLifecycle(gameId: string, timeline: GameTimeline): Promise<void> {
    for (const t of this.gameTimers.get(gameId) ?? []) { clearTimeout(t); this.timers.delete(t); }
    this.gameTimers.delete(gameId);
    this.run(gameId, timeline);
  }

  private run(gameId: string, timeline: GameTimeline): void {
    const token = ++this.tokens;
    this.loops.set(gameId, token);
    const gone = () => this.stopped || this.loops.get(gameId) !== token;
    void (async () => {
      try {
        if (timeline.preCampaignEnd !== undefined) {
          await this.sleepUntil(gameId, timeline.preCampaignEnd);
          if (gone()) return;
          await this.svc.openCampaign(gameId);
          if (gone()) return; // restarted while this step ran
        }
        for (let p = 0; p < timeline.phaseCloses.length; p++) {
          await this.sleepUntil(gameId, timeline.phaseCloses[p]);
          if (gone()) return;
          await this.svc.phaseClose(gameId, p);
        }
        for (;;) {
          if (gone()) return;
          const r = await this.svc.countReveal(gameId);
          if (r.done) break;
          await this.sleepUntil(gameId, r.nextAtMs);
        }
        // A government that forms in post-counting finishes the game at once: stop waiting as soon as that happens
        // (checked in slices of at most POLL_MS), otherwise finalise at postCountingEnd.
        while (this.clock.now() < timeline.postCountingEnd) {
          if (gone()) return;
          if (await this.svc.isFinished(gameId)) break;
          await this.sleepUntil(gameId, Math.min(timeline.postCountingEnd, this.clock.now() + TimerScheduler.POLL_MS));
        }
        if (gone()) return;
        await this.svc.finalise(gameId); // idempotent: a no-op when the game already finished
      } catch (e) {
        if (gone()) return;
        console.error(`[lifecycle ${gameId}] failed`, e);
        await this.svc.finalise(gameId, { error: true }).catch((e2) => console.error('finalise(error) failed', e2));
      } finally {
        if (this.loops.get(gameId) === token) { this.loops.delete(gameId); this.gameTimers.delete(gameId); }
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
