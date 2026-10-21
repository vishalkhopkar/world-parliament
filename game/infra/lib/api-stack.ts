import { ArnFormat, Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integ from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import type * as ddb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { type Config, GAME_ROOT } from './config';
import { Lifecycle } from './lifecycle';

export interface ApiStackProps extends StackProps {
  cfg: Config;
  table: ddb.ITable;
  /** Receives the election CSV reports (written by whichever Lambda finishes a game). */
  reportBucket: s3.IBucket;
  /** https://<cloudfront-domain> */
  webOrigin: string;
}

const WS_ACTIONS = ['ping', 'campaign', 'buyReport', 'chat', 'proposeGovernment', 'respondOffer', 'withdrawOffer'];

const HTTP_ROUTES: [apigw.HttpMethod, string][] = [
  [apigw.HttpMethod.POST, '/games'],
  [apigw.HttpMethod.POST, '/games/join'],
  [apigw.HttpMethod.GET, '/games/{gameId}'],
  [apigw.HttpMethod.POST, '/games/{gameId}/admit'],
  [apigw.HttpMethod.POST, '/games/{gameId}/admission'],
  [apigw.HttpMethod.POST, '/games/{gameId}/settings'],
  [apigw.HttpMethod.POST, '/games/{gameId}/party'],
  [apigw.HttpMethod.POST, '/games/{gameId}/start'],
];

/**
 * Lambdas + HTTP API + WebSocket API + lifecycle state machine + scheduler + alarms/budget.
 *
 * One stack on purpose: the Lambdas need the WS endpoint, the state machine ARN and the scheduler role ARN,
 * while the state machine / scheduler role need the Lambdas. Splitting would create circular cross-stack
 * references. Inside the stack we avoid cycles by giving the state machine, scheduler role and functions fixed
 * names and computing ARNs / the WS endpoint from names and the API id.
 */
export class ApiStack extends Stack {
  readonly httpApi: apigw.HttpApi;
  readonly wsApi: apigw.WebSocketApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { cfg, table, reportBucket, webOrigin } = props;
    const P = cfg.prefix;

    // ---- fixed-name ARNs (no resource references -> no cycles)
    const fnName = (n: string) => `${P}${n}`;
    const fnArn = (n: string) => this.formatArn({ service: 'lambda', resource: 'function', resourceName: fnName(n), arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    const stateMachineName = `${P}game-lifecycle`;
    const stateMachineArn = this.formatArn({ service: 'states', resource: 'stateMachine', resourceName: stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    const schedulerRoleName = `${P}scheduler`;
    const schedulerRoleArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${schedulerRoleName}`;
    const scheduleGroupName = `${P}grace`;

    // ---- WebSocket API (created before Lambdas: only its id is needed for env)
    this.wsApi = new apigw.WebSocketApi(this, 'WsApi', {
      apiName: `${P}ws`,
      routeSelectionExpression: '$request.body.action',
    });
    const wsStage = new apigw.WebSocketStage(this, 'WsStage', {
      webSocketApi: this.wsApi,
      stageName: 'live',
      autoDeploy: true,
      throttle: { burstLimit: 50, rateLimit: 20 },
    });
    const wsEndpoint = `https://${this.wsApi.apiId}.execute-api.${this.region}.${Aws.URL_SUFFIX}/live`;

    // ---- Lambdas
    const env: Record<string, string> = {
      TABLE_NAME: table.tableName,
      REPORT_BUCKET: reportBucket.bucketName,
      WS_ENDPOINT: wsEndpoint,
      STATE_MACHINE_ARN: stateMachineArn,
      SCHEDULER_ROLE_ARN: schedulerRoleArn,
      SCHEDULE_GROUP: scheduleGroupName,
      GRACE_CHECK_ARN: fnArn('grace-check'),
      MAP_BASE_URL: `${webOrigin}/maps`,
      STAGE: cfg.stage,
      NODE_OPTIONS: '--enable-source-maps',
    };
    const fns: Record<string, nodejs.NodejsFunction> = {};
    const mkFn = (handlerName: string, timeout = 15) => {
      const fn = new nodejs.NodejsFunction(this, `Fn-${handlerName}`, {
        functionName: fnName(handlerName),
        entry: path.join(GAME_ROOT, 'server/src/handlers', `${handlerName}.ts`),
        handler: 'handler',
        projectRoot: GAME_ROOT,
        depsLockFilePath: path.join(GAME_ROOT, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(timeout),
        tracing: lambda.Tracing.ACTIVE,
        environment: env,
        logGroup: new logs.LogGroup(this, `Logs-${handlerName}`, {
          logGroupName: `/aws/lambda/${fnName(handlerName)}`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cfg.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        }),
        bundling: {
          forceDockerBundling: false,
          format: nodejs.OutputFormat.ESM,
          target: 'node22',
          sourceMap: true,
          minify: false,
          mainFields: ['module', 'main'],
          // CJS deps bundled into ESM output may call require()
          banner: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
        },
      });
      table.grantReadWriteData(fn);
      reportBucket.grantPut(fn); // any handler can finish a game (finalise, count-reveal, ...)
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [this.formatArn({ service: 'execute-api', resource: this.wsApi.apiId, resourceName: 'live/*/@connections/*', arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [stateMachineArn] }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${scheduleGroupName}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRoleArn] }));
      fns[handlerName] = fn;
      return fn;
    };
    const lobby = mkFn('lobby', 10);
    const wsConnect = mkFn('ws-connect', 10);
    const wsDisconnect = mkFn('ws-disconnect', 10);
    const wsMessage = mkFn('ws-message', 15);
    const phaseClose = mkFn('phase-close', 60);
    const countReveal = mkFn('count-reveal', 60);
    const finalise = mkFn('finalise', 60);
    const graceCheck = mkFn('grace-check', 30);

    // ---- HTTP API (lobby)
    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${P}http`,
      corsPreflight: {
        allowOrigins: [webOrigin, 'http://localhost:5173'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: Duration.hours(1),
      },
    });
    const lobbyIntegration = new integ.HttpLambdaIntegration('LobbyIntegration', lobby);
    for (const [method, routePath] of HTTP_ROUTES) {
      this.httpApi.addRoutes({ path: routePath, methods: [method], integration: lobbyIntegration });
    }

    // ---- WebSocket routes
    this.wsApi.addRoute('$connect', { integration: new integ.WebSocketLambdaIntegration('ConnectIntegration', wsConnect) });
    this.wsApi.addRoute('$disconnect', { integration: new integ.WebSocketLambdaIntegration('DisconnectIntegration', wsDisconnect) });
    const msgIntegration = new integ.WebSocketLambdaIntegration('MessageIntegration', wsMessage);
    this.wsApi.addRoute('$default', { integration: msgIntegration });
    for (const action of WS_ACTIONS) this.wsApi.addRoute(action, { integration: msgIntegration });

    // ---- lifecycle state machine + scheduler
    const lifecycle = new Lifecycle(this, 'Lifecycle', {
      prefix: P, isProd: cfg.isProd, phaseClose, countReveal, finalise, graceCheck,
      stateMachineName, schedulerRoleName, scheduleGroupName,
    });

    // ---- ops: alarms
    for (const [name, fn] of Object.entries(fns)) {
      new cw.Alarm(this, `Alarm-${name}-errors`, {
        alarmName: `${P}${name}-errors`,
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
    }
    new cw.Alarm(this, 'Alarm-sfn-failed', {
      alarmName: `${P}lifecycle-failed`,
      metric: lifecycle.stateMachine.metricFailed({ period: Duration.minutes(5) }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    const throttles = new cw.MathExpression({
      expression: 'r + w',
      period: Duration.minutes(5),
      usingMetrics: {
        r: table.metric('ReadThrottleEvents', { statistic: 'Sum', period: Duration.minutes(5) }),
        w: table.metric('WriteThrottleEvents', { statistic: 'Sum', period: Duration.minutes(5) }),
      },
    });
    new cw.Alarm(this, 'Alarm-ddb-throttles', {
      alarmName: `${P}ddb-throttles`,
      metric: throttles,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // ---- ops: budget (only with -c alertEmail=...)
    if (cfg.alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${P}monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: cfg.budgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: cfg.alertEmail! }],
        })),
      });
    }

    // ---- outputs
    new CfnOutput(this, 'HttpApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'WebSocketUrl', { value: wsStage.url });
    new CfnOutput(this, 'WebSocketManagementEndpoint', { value: wsEndpoint });
    new CfnOutput(this, 'StateMachineArn', { value: lifecycle.stateMachine.stateMachineArn });
    new CfnOutput(this, 'SchedulerRoleArn', { value: lifecycle.schedulerRole.roleArn });
  }
}
