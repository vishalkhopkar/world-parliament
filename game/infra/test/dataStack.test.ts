// CDK assertion: private, encrypted, retained S3 bucket for election CSV reports.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DataStack } from '../lib/data-stack';
import type { Config } from '../lib/config';

const cfg: Config = { stage: 'dev', prefix: 'hp-dev-', isProd: false, region: 'ap-south-1', budgetUsd: 20 };

describe('DataStack report bucket', () => {
  const stack = new DataStack(new App(), 'D', { cfg });
  const t = Template.fromStack(stack);
  it('has a private bucket with encryption', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    });
  });
  it('is retained on delete', () => {
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });
  it('exposes the bucket', () => expect(stack.reportBucket).toBeDefined());
});
