import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let dir: string;
let log: typeof import('../server/eventLog');
let disk: typeof import('../server/diskCheck');
let stop: (() => void) | undefined;
const stats = (freeBytes: number) => ({ bavail: freeBytes / 1000, bsize: 1000 }) as fs.StatsFs;
const interval = 10 * 60 * 1000;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-disk-'));
  vi.stubEnv('DATA_DIR', dir);
  log = await import('../server/eventLog');
  disk = await import('../server/diskCheck');
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  log.closeLog();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('data disk monitor', () => {
  it('checks immediately and every ten minutes with an unreferenced timer; stops cleanly', async () => {
    const statfs = vi.spyOn(fsp, 'statfs').mockResolvedValue(stats(6e9));
    const timer = vi.spyOn(globalThis, 'setInterval');
    expect(disk.getDiskAlert()).toEqual({ active: false, freeBytes: null });
    stop = disk.startDiskCheck();
    expect(timer.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(statfs).toHaveBeenCalledExactlyOnceWith(dir);
    expect(disk.getDiskAlert()).toEqual({ active: false, freeBytes: 6e9 });
    expect(log.recentEvents()).toEqual([]);
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(statfs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statfs).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(interval);
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it('warns once per low-space episode and recovers at exactly 5 GB', async () => {
    const statfs = vi.spyOn(fsp, 'statfs').mockResolvedValue(stats(5e9 - 1000));
    stop = disk.startDiskCheck();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(interval);
    expect(disk.getDiskAlert()).toEqual({ active: true, freeBytes: 5e9 - 1000 });
    statfs.mockResolvedValue(stats(5e9));
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(disk.getDiskAlert()).toEqual({ active: false, freeBytes: 5e9 });
    statfs.mockResolvedValue(stats(1e9));
    await vi.advanceTimersByTimeAsync(interval);
    expect(log.recentEvents().map(e => [e.eventType, e.level, e.source])).toEqual([
      ['disk-low', 'warn', 'logger'], ['disk-ok', 'info', 'logger'], ['disk-low', 'warn', 'logger'],
    ]);
    const persisted = (await log.queryEvents({ eventType: 'disk-low' })).events;
    expect(persisted).toHaveLength(2);
    expect(persisted.some(e => (e.payload as { freeBytes: number }).freeBytes === 1e9)).toBe(true);
    const snapshot = disk.getDiskAlert();
    snapshot.active = false;
    expect(disk.getDiskAlert().active).toBe(true);
  });

  it('preserves the last alert on statfs failure and retries next interval', async () => {
    const statfs = vi.spyOn(fsp, 'statfs').mockResolvedValue(stats(1e9));
    stop = disk.startDiskCheck();
    await vi.advanceTimersByTimeAsync(0);
    statfs.mockRejectedValueOnce(new Error('fixture statfs failure'));
    await vi.advanceTimersByTimeAsync(interval);
    expect(disk.getDiskAlert()).toEqual({ active: true, freeBytes: 1e9 });
    expect(log.recentEvents().filter(e => e.eventType === 'disk-check')).toMatchObject([
      { level: 'error', source: 'logger', payload: { error: 'fixture statfs failure' } },
    ]);
    statfs.mockResolvedValue(stats(6e9));
    await vi.advanceTimersByTimeAsync(interval);
    expect(disk.getDiskAlert()).toEqual({ active: false, freeBytes: 6e9 });
  });

  it('skips overlapping checks and discards results after stopping', async () => {
    let finish!: (value: fs.StatsFs) => void;
    const statfs = vi.spyOn(fsp, 'statfs').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    stop = disk.startDiskCheck();
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(statfs).toHaveBeenCalledTimes(1);
    stop();
    finish(stats(1e9));
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.getDiskAlert()).toEqual({ active: false, freeBytes: null });
    expect(log.recentEvents()).toEqual([]);
  });

  it('exposes cached freeBytes in health without starting background work in createApp', async () => {
    const statfs = vi.spyOn(fsp, 'statfs').mockResolvedValue(stats(7e9));
    const { createApp } = await import('../server');
    vi.useRealTimers();
    const server = createApp().listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
      expect(await fetch(url).then(r => r.json())).toMatchObject({ ok: true, freeBytes: null });
      expect(statfs).not.toHaveBeenCalled();
      stop = disk.startDiskCheck();
      await vi.waitFor(() => expect(disk.getDiskAlert().freeBytes).toBe(7e9));
      expect(await fetch(url).then(r => r.json())).toMatchObject({ ok: true, freeBytes: 7e9 });
      expect(statfs).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});
