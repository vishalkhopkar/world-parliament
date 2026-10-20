import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import type { Config } from './config';

export interface DataStackProps extends StackProps { cfg: Config }

export class DataStack extends Stack {
  readonly table: ddb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    this.table = new ddb.Table(this, 'Table', {
      tableName: `${cfg.prefix}game`,
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: cfg.isProd },
      removalPolicy: cfg.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    // Join-code lookup
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });
  }
}
