// Local dev: writes election CSVs to game/data/elections/ (override with HP_REPORT_DIR).
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportSink } from '../core/reportSink';

const DEFAULT_DIR = resolve(fileURLToPath(new URL('../../../data/elections', import.meta.url)));

export class FileReportSink implements ReportSink {
  readonly dir: string;
  constructor(dir: string) { this.dir = resolve(dir); }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FileReportSink {
    return new FileReportSink(env.HP_REPORT_DIR || DEFAULT_DIR);
  }

  async saveElectionCsv(name: string, csv: string): Promise<void> {
    if (basename(name) !== name || !name) throw new Error(`Invalid report file name: ${name}`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(resolve(this.dir, name), csv, 'utf8');
  }
}
