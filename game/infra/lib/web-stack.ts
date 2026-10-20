import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Config, REPO_ROOT } from './config';

export interface WebStackProps extends StackProps { cfg: Config }

export class WebStack extends Stack {
  readonly distribution: cf.Distribution;
  readonly origin: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { cfg } = props;

    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cfg.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.isProd,
    });

    const cacheCommon = { enableAcceptEncodingGzip: true, enableAcceptEncodingBrotli: true };
    // Vite emits /assets/<name>-<hash>.js: immutable, cache for a year.
    const assetsCache = new cf.CachePolicy(this, 'AssetsCache', {
      cachePolicyName: `${cfg.prefix}assets`,
      defaultTtl: Duration.days(365), maxTtl: Duration.days(365), minTtl: Duration.days(1),
      ...cacheCommon,
    });
    // Map files (/maps/<id>/map.json, thumbnail, site/**) are not content-hashed: short TTL.
    const dataCache = new cf.CachePolicy(this, 'DataCache', {
      cachePolicyName: `${cfg.prefix}data`,
      defaultTtl: Duration.hours(1), maxTtl: Duration.days(1), minTtl: Duration.seconds(0),
      ...cacheCommon,
    });
    // index.html: revalidate quickly.
    const htmlCache = new cf.CachePolicy(this, 'HtmlCache', {
      cachePolicyName: `${cfg.prefix}html`,
      defaultTtl: Duration.minutes(1), maxTtl: Duration.minutes(5), minTtl: Duration.seconds(0),
      ...cacheCommon,
    });
    const originAccess = origins.S3BucketOrigin.withOriginAccessControl(bucket);
    const behavior = (cachePolicy: cf.ICachePolicy) => ({
      origin: originAccess,
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
      compress: true,
    });

    this.distribution = new cf.Distribution(this, 'Cdn', {
      comment: `${cfg.prefix}hung-parliament`,
      defaultRootObject: 'index.html',
      priceClass: cf.PriceClass.PRICE_CLASS_200,
      defaultBehavior: behavior(htmlCache),
      additionalBehaviors: {
        'assets/*': behavior(assetsCache),
        'maps/*': behavior(dataCache),
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10),
      })),
    });
    this.origin = `https://${this.distribution.distributionDomainName}`;

    // ---- web bundle (only if built). dist/ already contains /maps/<id>/... (copied from the repo's maps/ folders by vite.config.ts).
    const distDir = path.join(REPO_ROOT, 'game/web/dist');
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
      new s3deploy.BucketDeployment(this, 'DeployWeb', {
        sources: [s3deploy.Source.asset(distDir)],
        destinationBucket: bucket,
        distribution: this.distribution,
        distributionPaths: ['/index.html', '/', '/maps/*'],
        prune: false,
      });
    } else {
      console.warn(`[infra] ${distDir} not found (run "npm run build -w @hp/web") - skipping web bundle deployment`);
    }

    new CfnOutput(this, 'CloudFrontUrl', { value: this.origin });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
