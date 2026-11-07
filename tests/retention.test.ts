import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../server/archiveState', () => ({ isArchived: vi.fn(() => false) }));
vi.mock('../server/compress', () => ({ compressClosedDays: vi.fn(async () => {}) }));

let dir: string;
let log: typeof import('../server/eventLog');
let retention: typeof import('../server/retention');
let archived: typeof import('../server/archiveState');
const now = Date.parse('2026-11-06T23:59:59Z');
const names = ['events-2026-10-22.jsonl', 'events-2026-10-22-2.jsonl',
  'events-2026-10-23.jsonl', 'events-2026-11-05.jsonl', 'events-2026-11-06.jsonl'];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-retention-'));
  vi.stubEnv('DATA_DIR', dir);
  log = await import('../server/eventLog');
  retention = await import('../server/retention');
  archived = await import('../server/archiveState');
  vi.mocked(archived.isArchived).mockReset().mockReturnValue(false);
  fs.mkdirSync(log.LOG_DIR, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(log.LOG_DIR, name), '\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  log.closeLog();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const remaining = () => log.listEventFiles().map(f => path.basename(f.file)).sort();

describe('archive-gated age retention', () => {
  it('keeps unarchived expired days and records one summary', async () => {
    const flush = vi.spyOn(log, 'flush');
    retention.enforceRetention(now);
    expect(flush).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([...names].sort());
    const events = (await log.queryEvents({ eventType: 'retention' })).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'info', payload: {
      deleted: [], keptNotArchived: ['2026-10-22'],
    } });
  });

  it('deletes every part of archived expired days, keeping the cutoff, recent days and today', async () => {
    vi.mocked(archived.isArchived).mockReturnValue(true);
    retention.enforceRetention(now);
    expect(remaining()).toEqual(names.slice(2).sort());
    expect(archived.isArchived).toHaveBeenCalledExactlyOnceWith('2026-10-22');
    const events = (await log.queryEvents({ eventType: 'retention' })).events;
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ deleted: ['2026-10-22'], keptNotArchived: [] });
    retention.enforceRetention(now);
    expect((await log.queryEvents({ eventType: 'retention' })).events).toHaveLength(1);
  });

  it('uses changed retention settings and never expires today or future days', () => {
    log.updateLogSettings({ retentionDays: 30 });
    expect(retention.expiredDays(now)).toEqual([]);
    log.updateLogSettings({ retentionDays: 1 });
    fs.writeFileSync(path.join(log.LOG_DIR, 'events-2026-11-07.jsonl'), '\n');
    expect(retention.expiredDays(now)).toEqual(['2026-10-23', '2026-10-22']);
    vi.mocked(archived.isArchived).mockReturnValue(true);
    retention.enforceRetention(now);
    expect(remaining()).toEqual(['events-2026-11-05.jsonl', 'events-2026-11-06.jsonl', 'events-2026-11-07.jsonl']);
  });

  it('summarizes deleted and unarchived days together once', () => {
    log.updateLogSettings({ retentionDays: 1 });
    vi.mocked(archived.isArchived).mockImplementation(day => day === '2026-10-22');
    retention.enforceRetention(now);
    expect(log.recentEvents().filter(e => e.eventType === 'retention')).toMatchObject([
      { payload: { deleted: ['2026-10-22'], keptNotArchived: ['2026-10-23'] } },
    ]);
  });

  it('uses UTC boundaries and skips summary events when no days expire', () => {
    expect(retention.expiredDays(Date.parse('2026-11-06T00:00:00Z'))).toEqual(['2026-10-22']);
    log.updateLogSettings({ retentionDays: 3650 });
    retention.enforceRetention(now);
    expect(log.recentEvents().filter(e => e.eventType === 'retention')).toEqual([]);
  });

  it('includes gzip parts in archive-gated day retention', () => {
    const gzip = path.join(log.LOG_DIR, 'events-2026-10-22-3.jsonl.gz');
    fs.writeFileSync(gzip, 'fixture');
    retention.enforceRetention(now);
    expect(fs.existsSync(gzip)).toBe(true);
    vi.mocked(archived.isArchived).mockReturnValue(true);
    retention.enforceRetention(now);
    expect(fs.existsSync(gzip)).toBe(false);
    expect(remaining()).toEqual(names.slice(2).sort());
  });

  it('runs immediately, then hourly with an unreferenced timer', async () => {
    const { compressClosedDays } = await import('../server/compress');
    vi.mocked(compressClosedDays).mockClear();
    vi.setSystemTime(Date.parse('2026-11-06T12:00:00Z'));
    const timer = retention.startRetention();
    expect(timer.hasRef()).toBe(false);
    expect(archived.isArchived).toHaveBeenCalledTimes(1);
    expect(compressClosedDays).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(archived.isArchived).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(archived.isArchived).toHaveBeenCalledTimes(2);
    expect(compressClosedDays).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it('skips overlapping maintenance while compression is still running', async () => {
    const { compressClosedDays } = await import('../server/compress');
    let finish!: () => void;
    vi.mocked(compressClosedDays).mockClear().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const timer = retention.startRetention();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(compressClosedDays).toHaveBeenCalledTimes(1);
    expect(archived.isArchived).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(compressClosedDays).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });
});
