// Builds the GameService with AWS implementations. Everything is created once per Lambda container.
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GameService } from '../core/gameService';
import { GameError, HTTP_STATUS } from '../core/types';
import { ApiGwNotifier } from './apiGwNotifier';
import { DynamoRepo } from './dynamoRepo';
import { awsMaps } from './maps';
import { SfnScheduler } from './sfnScheduler';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

let cached: GameService | undefined;

export function getService(): GameService {
  if (cached) return cached;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const repo = new DynamoRepo(doc, env('TABLE_NAME'));
  const notifier = new ApiGwNotifier(new ApiGatewayManagementApiClient({ endpoint: env('WS_ENDPOINT') }), repo);
  const scheduler = new SfnScheduler(new SFNClient({}), new SchedulerClient({}), {
    stateMachineArn: env('STATE_MACHINE_ARN'),
    schedulerRoleArn: env('SCHEDULER_ROLE_ARN'),
    graceCheckArn: env('GRACE_CHECK_ARN'),
    scheduleGroup: process.env.SCHEDULE_GROUP || 'default',
  });
  cached = new GameService({ repo, notifier, scheduler, clock: { now: () => Date.now() }, maps: awsMaps });
  return cached;
}

export { GameError, HTTP_STATUS };
