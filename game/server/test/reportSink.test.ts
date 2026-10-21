// Election CSV report: pure builder, service hook, local file sink, S3 sink.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { SeatResult } from '@hp/shared';
import { buildElectionCsv, electionReportName, noopReportSink } from '../src/core/reportSink';
import type { ReportSink } from '../src/core/reportSink';
import { FileReportSink } from '../src/local/fileReportSink';
import { S3ReportSink } from '../src/aws/s3ReportSink';
import { GameService } from '../src/core/gameService';
import { Ctx } from './helpers';

const parties = [
  { playerId: 'p1', name: 'Alpha' },
  { playerId: 'p2', name: 'Beta, "Best" Party' },
  { playerId: 'p3', name: 'Gamma' }, // eliminated, no shares anywhere
];
const res = (seat: number, shares: Record<string, number>): SeatResult => ({
  seat, phase: 0, winner: Object.keys(shares)[0] ?? null, shares,
});

describe('buildElectionCsv', () => {
  const csv = buildElectionCsv([3, 1, 2], [res(1, { p1: 0.6, p2: 0.4 }), res(3, { p1: 1 / 3, p2: 2 / 3 })], parties);
  const lines = csv.trimEnd().split('\n');
  it('header is seat + party names (escaped), one column per party incl. eliminated', () => {
    expect(lines[0]).toBe('seat,Alpha,"Beta, ""Best"" Party",Gamma');
  });
  it('one row per seat in seat order, including seats without results', () => {
    expect(lines.length).toBe(1 + 3);
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['1', '2', '3']);
  });
  it('values are percentages with 2 decimals; missing -> 0.00', () => {
    expect(lines[1]).toBe('1,60.00,40.00,0.00');
    expect(lines[2]).toBe('2,0.00,0.00,0.00');
    expect(lines[3]).toBe('3,33.33,66.67,0.00');
  });
  it('rows with an outcome sum to ~100', () => {
    for (const l of [lines[1], lines[3]]) {
      const sum = l.split(',').slice(1).reduce((a, v) => a + Number(v), 0);
      expect(Math.abs(sum - 100)).toBeLessThan(0.05);
    }
  });
  it('ends with a newline', () => expect(csv.endsWith('\n')).toBe(true));
});

describe('electionReportName / noopReportSink', () => {
  it('election-<UTC timestamp>-<gameId>.csv', () => {
    expect(electionReportName(Date.UTC(2026, 9, 20, 14, 32, 5, 999), 'g1')).toBe('election-2026-10-20T14-32-05Z-g1.csv');
  });
  it('noop sink resolves', async () => {
    await expect(noopReportSink.saveElectionCsv('a.csv', 'x')).resolves.toBeUndefined();
  });
});

class FakeSink implements ReportSink {
  saved: { name: string; csv: string }[] = [];
  fail = false;
  async saveElectionCsv(name: string, csv: string) {
    if (this.fail) throw new Error('disk full');
    this.saved.push({ name, csv });
  }
}

async function finishedCtx(sink: ReportSink) {
  const c = new Ctx();
  c.svc = new GameService({
    repo: c.repo, notifier: c.notifier, scheduler: c.scheduler, clock: c.clock, maps: c.maps, startDelayMs: 1000, reportSink: sink,
  });
  await c.started(3);
  await c.runCampaignToCountingEnd();
  return c;
}

describe('GameService reportSink hook', () => {
  it('writes exactly one CSV when the election finishes, none on repeated finalise', async () => {
    const sink = new FakeSink();
    const c = await finishedCtx(sink);
    expect(sink.saved).toHaveLength(0);
    c.clock.advance(5000);
    await c.svc.finalise(c.gameId);
    await c.svc.finalise(c.gameId);
    expect(sink.saved).toHaveLength(1);
    const { name, csv } = sink.saved[0];
    expect(name).toBe(electionReportName(c.clock.now(), c.gameId));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('seat,Party 0,Party 1,Party 2');
    expect(lines.length).toBe(1 + c.map.seatCount);
    expect(csv).not.toContain('P0');
  });
  it('a failing sink does not block finishing', async () => {
    const sink = new FakeSink();
    sink.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = await finishedCtx(sink);
    await c.svc.finalise(c.gameId);
    expect((await c.game()).status).toBe('finished');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('FileReportSink', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('creates the directory and writes the file', async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'hp-rep-')), 'nested', 'elections');
    await new FileReportSink(dir).saveElectionCsv('election-x.csv', 'a,b\n');
    expect(readdirSync(dir)).toEqual(['election-x.csv']);
    expect(readFileSync(join(dir, 'election-x.csv'), 'utf8')).toBe('a,b\n');
  });
  it('rejects names that escape the directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hp-rep-'));
    await expect(new FileReportSink(dir).saveElectionCsv('../evil.csv', 'x')).rejects.toThrow();
  });
  it('HP_REPORT_DIR overrides the default directory', () => {
    expect(FileReportSink.fromEnv({ HP_REPORT_DIR: join(tmpdir(), 'xyz') }).dir).toMatch(/xyz$/);
    expect(FileReportSink.fromEnv({}).dir).toMatch(/data[\\/]elections$/);
  });
});

describe('S3ReportSink', () => {
  it('PutObject with bucket, key, csv body', async () => {
    const send = vi.fn().mockResolvedValue({});
    await new S3ReportSink({ send } as never, 'my-bucket').saveElectionCsv('election-x.csv', 'a,b\n');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: 'my-bucket', Key: 'elections/election-x.csv', Body: 'a,b\n' });
    expect(cmd.input.ContentType).toContain('text/csv');
  });
});
