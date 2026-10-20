# HUNG PARLIAMENT infrastructure (AWS CDK, ap-south-1)

## Stacks (per stage; names `HungParliament-<stage>-…`, resources prefixed `hp-<stage>-`)
| Stack | Contents |
|---|---|
| `-Data` | DynamoDB table `hp-<stage>-game` (on-demand, PK/SK strings, TTL attr `ttl`, GSI `GSI1` = `GSI1PK`/`GSI1SK` for join codes). PITR + RETAIN in prod; DESTROY in dev. |
| `-Web` | Private S3 bucket + CloudFront (OAC, SPA fallback 403/404 -> /index.html). Deploys `game/web/dist` (only if built). The Vite build copies every `maps/<id>/{map.json, thumbnail.*, site/**}` into `dist/maps/<id>/`, so the map files are served at `/maps/<id>/...` (cache behaviour `maps/*`, 1 h TTL); there is no separate map-data deployment. |
| `-Api` | 8 Node 22 / ARM64 / 512 MB esbuild Lambdas (`game/server/src/handlers/<name>.ts`: lobby, ws-connect, ws-disconnect, ws-message, phase-close, count-reveal, finalise, grace-check), HTTP API (lobby REST, CORS: CloudFront + http://localhost:5173), WebSocket API (stage `live`, throttle burst 50 / rate 20), Step Functions lifecycle state machine, EventBridge Scheduler group + role, CloudWatch alarms, optional budget. |
| `GithubOidcStack` | Optional, only with `-c oidc=true`: GitHub OIDC provider + role `hp-github-deploy`. |

Map packages: every `maps/<id>/site/data/game.json` is statically imported by `game/server/src/maps.generated.ts` (written by `npm run gen:maps` in `game/` from `maps/*/map.json`), so esbuild inlines all maps into each Lambda bundle; adding a map folder + running `gen:maps` is enough.

Why Api + orchestration are one stack: the Lambdas need the state machine ARN / scheduler role ARN, while the state
machine and scheduler role need the Lambdas; separate stacks would be circular. Inside the stack, function / state
machine / scheduler-role names are fixed and their ARNs are computed from names (and the WS endpoint from the API id).

## Context options
`-c stage=dev|prod` (default dev) · `-c budgetUsd=20` · `-c alertEmail=you@x.com` (budget is only created when set) ·
`-c oidc=true [-c oidcProviderArn=arn:...]` (adds GithubOidcStack).

## Commands (from `game/infra`)
```
npx cdk bootstrap aws://<account>/ap-south-1     # once per account/region
npm run build -w @hp/web                          # from game/, so the web bundle is deployed
npx cdk synth -c stage=dev
npx cdk deploy --all -c stage=dev
npx cdk deploy --all -c stage=prod --require-approval never
```
Synth works without credentials (account is an environment-agnostic token unless `CDK_DEFAULT_ACCOUNT` is set).

## Outputs
`-Web`: `CloudFrontUrl`, `BucketName`. `-Api`: `HttpApiUrl`, `WebSocketUrl` (wss://…/live), `WebSocketManagementEndpoint`
(https, used for PostToConnection), `StateMachineArn`, `SchedulerRoleArn`.

## Lambda environment (all functions)
`TABLE_NAME, WS_ENDPOINT, STATE_MACHINE_ARN, SCHEDULER_ROLE_ARN, SCHEDULE_GROUP, GRACE_CHECK_ARN, MAP_BASE_URL (https://<cloudfront>/maps), STAGE`, plus `NODE_OPTIONS=--enable-source-maps`.
IAM: table read/write (incl. GSI), `execute-api:ManageConnections` on the WS stage, `states:StartExecution`, `scheduler:Create/Delete/GetSchedule` on group `SCHEDULE_GROUP`, `iam:PassRole` on the scheduler role.
Schedules must be created in group `SCHEDULE_GROUP` with `RoleArn = SCHEDULER_ROLE_ARN` and target `GRACE_CHECK_ARN`.

## State machine input (started once per game by the `start` handler)
```json
{
  "gameId": "g_abc",
  "timeline": { "campaignStart": 0, "phaseCloses": [0], "campaignEnd": 0, "countingEnd": 0, "postCountingEnd": 0 },
  "phaseClosesIso": ["2026-10-20T10:00:00Z"],
  "countingEndIso": "…",
  "postCountingEndIso": "…"
}
```
`timeline` is informational (epoch ms); the machine uses the ISO parallel arrays (`phaseClosesIso` same order/length as `phaseCloses`).
Flow: Map over `phaseClosesIso` (concurrency 1, 1-based `phase` = index+1): Wait until `closeAtIso` -> `phase-close {gameId, phase}`.
Then loop `count-reveal {gameId}` -> must return `{done: boolean, nextAtIso: string}`; while not done, Wait until `nextAtIso` and repeat.
Then Wait until `postCountingEndIso` -> `finalise {gameId}`. Task retries: 2 with backoff; any failure -> `finalise {gameId, error: true}`.
`finalise` may also be invoked early by the server and must be idempotent. `countingEndIso` is currently unused by the machine.

## One-time GitHub Actions OIDC setup
1. `npx cdk deploy GithubOidcStack -c oidc=true` (add `-c oidcProviderArn=…` if the account already has the GitHub OIDC provider).
2. Copy output `DeployRoleArn` into the repo secret `AWS_DEPLOY_ROLE_ARN`. The role trusts only
   `repo:vishalkhopkar/world-parliament:ref:refs/heads/main` and may only assume the CDK bootstrap roles (`cdk-*`).
3. `.github/workflows/game-deploy.yml` then deploys `-c stage=prod` on pushes to main touching `game/**`.
