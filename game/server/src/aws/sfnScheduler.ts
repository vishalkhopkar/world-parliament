import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { SFNClient } from '@aws-sdk/client-sfn';
import type { GameTimeline, PlayerId } from '@hp/shared';
import type { Scheduler } from '../core/types';

export interface SfnSchedulerConfig {
  stateMachineArn: string;
  schedulerRoleArn: string;
  graceCheckArn: string;
  /** EventBridge Scheduler group for the one-time grace-check schedules (env SCHEDULE_GROUP). */
  scheduleGroup: string;
}

/** at(yyyy-mm-ddThh:mm:ss) in UTC. */
export function atExpression(ms: number): string {
  return `at(${new Date(ms).toISOString().slice(0, 19)})`;
}

export class SfnScheduler implements Scheduler {
  constructor(
    private readonly sfn: Pick<SFNClient, 'send'>,
    private readonly scheduler: Pick<SchedulerClient, 'send'>,
    private readonly cfg: SfnSchedulerConfig,
  ) {}

  async startLifecycle(gameId: string, timeline: GameTimeline): Promise<void> {
    const iso = (ms: number) => new Date(ms).toISOString();
    const input = {
      gameId, timeline,
      phaseClosesIso: timeline.phaseCloses.map(iso),
      countingEndIso: iso(timeline.countingEnd),
      postCountingEndIso: iso(timeline.postCountingEnd),
    };
    try {
      await this.sfn.send(new StartExecutionCommand({
        stateMachineArn: this.cfg.stateMachineArn, name: `game-${gameId}`, input: JSON.stringify(input),
      }));
    } catch (e) {
      if ((e as { name?: string })?.name !== 'ExecutionAlreadyExists') throw e; // idempotent
    }
  }

  async scheduleGraceCheck(gameId: string, playerId: PlayerId, atMs: number): Promise<string> {
    const name = `grace-${gameId}-${playerId}-${atMs}`.slice(0, 64);
    try {
      await this.scheduler.send(new CreateScheduleCommand({
        Name: name,
        GroupName: this.cfg.scheduleGroup,
        ScheduleExpression: atExpression(atMs),
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: this.cfg.graceCheckArn,
          RoleArn: this.cfg.schedulerRoleArn,
          Input: JSON.stringify({ gameId, playerId }),
        },
      }));
    } catch (e) {
      // the name is deterministic (game, player, time): a retried request hits an identical schedule
      if ((e as { name?: string })?.name !== 'ConflictException') throw e;
    }
    return name;
  }

  async cancelGraceCheck(name: string): Promise<void> {
    try {
      await this.scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: this.cfg.scheduleGroup }));
    } catch (e) {
      if ((e as { name?: string })?.name !== 'ResourceNotFoundException') throw e;
    }
  }
}
