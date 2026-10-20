import type { App } from 'aws-cdk-lib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  stage: 'dev' | 'prod';
  prefix: string;
  isProd: boolean;
  region: string;
  account?: string;
  budgetUsd: number;
  alertEmail?: string;
}

/** Repo root (…/world-parliament), derived from this file's location (game/infra/lib). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const GAME_ROOT = path.join(REPO_ROOT, 'game');

export function loadConfig(app: App): Config {
  const stage = String(app.node.tryGetContext('stage') ?? 'dev');
  if (stage !== 'dev' && stage !== 'prod') throw new Error(`stage must be dev|prod, got ${stage}`);
  const alertEmail = app.node.tryGetContext('alertEmail');
  return {
    stage,
    prefix: `hp-${stage}-`,
    isProd: stage === 'prod',
    region: 'ap-south-1',
    account: process.env.CDK_DEFAULT_ACCOUNT,
    budgetUsd: Number(app.node.tryGetContext('budgetUsd') ?? 20),
    alertEmail: alertEmail ? String(alertEmail) : undefined,
  };
}
