// The WebSocket stage's default throttle also limits the server's own PostToConnection pushes (a counting step sends hundreds of
// seatUpdates at once). 20 rps / burst 50 made API Gateway answer 429 and clients lost seat declarations.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';
import { WebStack } from '../lib/web-stack';
import type { Config } from '../lib/config';

const cfg: Config = { stage: 'dev', prefix: 'hp-dev-', isProd: false, region: 'ap-south-1', account: '111111111111', budgetUsd: 20 };

describe('ApiStack websocket stage throttle', () => {
  const app = new App();
  const env = { region: cfg.region, account: cfg.account };
  const data = new DataStack(app, 'D', { env, cfg });
  const web = new WebStack(app, 'W', { env, cfg });
  const api = new ApiStack(app, 'A', { env, cfg, table: data.table, reportBucket: data.reportBucket, webOrigin: web.origin });
  const t = Template.fromStack(api);

  it('allows enough requests per second for a full counting broadcast', () => {
    const stages = Object.values(t.findResources('AWS::ApiGatewayV2::Stage')) as { Properties: { StageName?: string; DefaultRouteSettings?: { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number } } }[];
    const live = stages.find((s) => s.Properties.StageName === 'live');
    expect(live).toBeDefined();
    expect(live!.Properties.DefaultRouteSettings?.ThrottlingRateLimit).toBeGreaterThanOrEqual(500);
    expect(live!.Properties.DefaultRouteSettings?.ThrottlingBurstLimit).toBeGreaterThanOrEqual(1000);
  });
});
