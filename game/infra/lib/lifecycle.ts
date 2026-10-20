import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface LifecycleProps {
  prefix: string;
  isProd: boolean;
  phaseClose: lambda.IFunction;
  countReveal: lambda.IFunction;
  finalise: lambda.IFunction;
  graceCheck: lambda.IFunction;
  /** Fixed names (the ARNs are computed from them elsewhere to avoid circular references). */
  stateMachineName: string;
  schedulerRoleName: string;
  scheduleGroupName: string;
}

/**
 * Game lifecycle state machine + EventBridge Scheduler role/group.
 *
 * Input: { gameId, timeline, phaseClosesIso: string[], countingEndIso, postCountingEndIso } (see README).
 */
export class Lifecycle extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, p: LifecycleProps) {
    super(scope, id);

    const retry = { errors: ['States.TaskFailed', 'Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException'],
      maxAttempts: 2, interval: Duration.seconds(3), backoffRate: 2 };

    // Any unrecoverable failure ends the game via finalise({error:true}).
    const failFinalise = new tasks.LambdaInvoke(this, 'FinaliseOnError', {
      lambdaFunction: p.finalise,
      payload: sfn.TaskInput.fromObject({ gameId: sfn.JsonPath.stringAt('$.gameId'), error: true }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    const catchAll = { errors: ['States.ALL'], resultPath: '$.error' };

    // ---- phases: Map over phaseClosesIso, sequentially
    const waitClose = new sfn.Wait(this, 'WaitPhaseClose', { time: sfn.WaitTime.timestampPath('$.closeAtIso') });
    const phaseClose = new tasks.LambdaInvoke(this, 'PhaseClose', {
      lambdaFunction: p.phaseClose,
      payload: sfn.TaskInput.fromObject({
        gameId: sfn.JsonPath.stringAt('$.gameId'),
        phase: sfn.JsonPath.numberAt('$.phase'),
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    phaseClose.addRetry(retry);
    const phases = new sfn.Map(this, 'Phases', {
      itemsPath: '$.phaseClosesIso',
      maxConcurrency: 1,
      itemSelector: {
        'gameId.$': '$.gameId',
        'closeAtIso.$': '$$.Map.Item.Value',
        'phase.$': 'States.MathAdd($$.Map.Item.Index, 1)', // 1-based phase number
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    phases.itemProcessor(waitClose.next(phaseClose));
    phases.addCatch(failFinalise, catchAll);

    // ---- counting loop
    const countReveal = new tasks.LambdaInvoke(this, 'CountReveal', {
      lambdaFunction: p.countReveal,
      payload: sfn.TaskInput.fromObject({ gameId: sfn.JsonPath.stringAt('$.gameId') }),
      payloadResponseOnly: true,
      resultPath: '$.count', // { done: boolean, nextAtIso: string }
    });
    countReveal.addRetry(retry);
    countReveal.addCatch(failFinalise, catchAll);
    const waitNext = new sfn.Wait(this, 'WaitNextReveal', { time: sfn.WaitTime.timestampPath('$.count.nextAtIso') });
    waitNext.next(countReveal);

    // ---- end
    const waitEnd = new sfn.Wait(this, 'WaitPostCountingEnd', { time: sfn.WaitTime.timestampPath('$.postCountingEndIso') });
    const finalise = new tasks.LambdaInvoke(this, 'Finalise', {
      lambdaFunction: p.finalise,
      payload: sfn.TaskInput.fromObject({ gameId: sfn.JsonPath.stringAt('$.gameId') }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    finalise.addRetry(retry);
    finalise.addCatch(failFinalise, catchAll);

    const choice = new sfn.Choice(this, 'CountingDone?')
      .when(sfn.Condition.booleanEquals('$.count.done', true), waitEnd.next(finalise))
      .otherwise(waitNext);

    const definition = phases.next(countReveal).next(choice);

    const logGroup = new logs.LogGroup(this, 'SfnLogs', {
      logGroupName: `/aws/vendedlogs/states/${p.stateMachineName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: p.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'GameLifecycle', {
      stateMachineName: p.stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
    });

    // ---- EventBridge Scheduler: the server creates one-time at(...) schedules per disconnect.
    new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: p.scheduleGroupName });
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: p.schedulerRoleName,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
    });
    p.graceCheck.grantInvoke(this.schedulerRole);
  }
}
