import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { GithubOidcStack } from '../lib/oidc-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();
const cfg = loadConfig(app);
const env = { region: cfg.region, account: cfg.account };
const S = `HungParliament-${cfg.stage}`;

const data = new DataStack(app, `${S}-Data`, { env, cfg });
const web = new WebStack(app, `${S}-Web`, { env, cfg });
const api = new ApiStack(app, `${S}-Api`, { env, cfg, table: data.table, reportBucket: data.reportBucket, webOrigin: web.origin });

if (app.node.tryGetContext('oidc')) {
  new GithubOidcStack(app, 'GithubOidcStack', {
    env, existingProviderArn: app.node.tryGetContext('oidcProviderArn'),
  });
}

Tags.of(app).add('app', 'hung-parliament');
Tags.of(app).add('stage', cfg.stage);
