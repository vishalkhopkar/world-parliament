// AWS: stores election CSVs in the private report bucket (env REPORT_BUCKET) under elections/<name>.
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ReportSink } from '../core/reportSink';

export class S3ReportSink implements ReportSink {
  constructor(private s3: Pick<S3Client, 'send'>, private bucket: string) {}

  async saveElectionCsv(name: string, csv: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: `elections/${name}`, Body: csv, ContentType: 'text/csv; charset=utf-8',
    }));
  }
}
