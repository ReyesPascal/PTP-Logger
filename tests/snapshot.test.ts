/** New: mocked-spawn fixtures; no real adb daemon or TV connections. Fixture harness adapted from tests/adb.test.ts:1-65. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  devices: {} as Record<string, { ip: string }>,
  spawn: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
vi.mock('../server/tv/devices', () => ({
  getDeviceLabels: () => Object.keys(fixture.devices),
  getDevice: (label: string) => fixture.devices[label],
}));
let dir: string;
let log: typeof import('../server/eventLog');
let snapshots: typeof import('../server/tv/snapshot');
let stop: (() => void) | undefined;
type Reply = { stdout?: string; stderr?: string; code?: number; error?: boolean; hang?: boolean };
let replies: Reply[];
let children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }>;
const events = () => log.recentEvents().filter(e => e.eventType === 'tv-snapshot').reverse();
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-adb-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('ADB_BIN', '/fixture/adb');
  vi.stubEnv('PTP_PKG', 'com.example.ptp');
  fixture.devices = { hisense: { ip: '192.0.2.21' } };
  replies = [];
  children = [];
  fixture.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child);
    const reply = replies.shift() ?? { stdout: 'device\n' };
    Promise.resolve().then(() => {
      if (reply.hang) return;
      if (reply.error) { child.emit('error', new Error('fixture ENOENT')); return; }
      if (reply.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr) child.stderr.write(reply.stderr);
      child.emit('close', reply.code ?? 0);
    });
    return child;
  });
  log = await import('../server/eventLog');
  snapshots = await import('../server/tv/snapshot');
});
afterEach(() => {
  stop?.(); stop = undefined;
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const full = () => replies.push(
  { stdout: 'device\n' }, { stdout: '12345.67 2345.00\n' },
  { stdout: '2: wlan0 inet 192.0.2.21/24\n' }, { stdout: '3: eth0 state DOWN\n' },
  { stdout: 'mWifiInfo SSID: fixture, RSSI: -57, Link speed: 72Mbps\n' },
  { stdout: '    versionName=1.0.3\n' }, { stdout: 'MemTotal: 2000000 kB\nMemAvailable: 456789 kB\n' },
);
describe('TV snapshots with fake adb outputs', () => {
  it('writes one complete snapshot to the common disk log and repeats at ten minutes', async () => {
    full();
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toMatchObject([{ source: 'tv', device: 'hisense', level: 'info', payload: {
      ip: '192.0.2.21', uptimeSeconds: 12345.67, wifiRssiDbm: -57,
      addresses: { wlan0: '2: wlan0 inet 192.0.2.21/24', eth0: '3: eth0 state DOWN' },
      ptpPackage: 'com.example.ptp', ptpVersion: '1.0.3', memAvailableBytes: 456789 * 1024, errors: {},
    } }]);
    expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(events()[0].id);
    expect(fixture.spawn.mock.calls.every(c => c[0] === '/fixture/adb')).toBe(true);
    expect(fixture.spawn.mock.calls.map(c => c[1])).toEqual([
      ['-s', '192.0.2.21:5555', 'get-state'],
      ...['cat /proc/uptime', 'ip addr show dev wlan0', 'ip addr show dev eth0',
        'dumpsys wifi | grep -m1 -i RSSI', 'dumpsys package com.example.ptp | grep -m1 versionName',
        'cat /proc/meminfo'].map(script => ['-s', '192.0.2.21:5555', 'shell', script]),
    ]);
    await vi.advanceTimersByTimeAsync(599999);
    expect(events()).toHaveLength(1);
    full();
    await vi.advanceTimersByTimeAsync(1);
    expect(events()).toHaveLength(2);
  });
  it('skips undiscovered, offline and unauthorized TVs without connecting', async () => {
    fixture.devices = { missing: undefined!, offline: { ip: '192.0.2.22' }, unauthorized: { ip: '192.0.2.23' } };
    replies.push({ code: 1 }, { stdout: 'unauthorized' });
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(events()).toHaveLength(0);
  });
  it('keeps partial results with nulls and errors for failed or malformed fields', async () => {
    replies.push({ stdout: 'device' }, { stdout: 'bad' }, { code: 1 }, { stdout: 'eth0' },
      { stdout: 'RSSI unknown' }, { stdout: 'no package' }, { stdout: 'MemFree: 100 kB' });
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()[0].payload).toMatchObject({ uptimeSeconds: null, addresses: { wlan0: null, eth0: 'eth0' },
      wifiRssiDbm: null, ptpVersion: null, memAvailableBytes: null,
      errors: { uptimeSeconds: expect.any(String), wlan0: expect.any(String), wifiRssiDbm: expect.any(String),
        ptpVersion: expect.any(String), memAvailableBytes: expect.any(String) } });
  });
  it.each(['error', 'timeout', 'stdout-limit', 'stderr-limit'] as const)('bounds %s and retries next interval', async mode => {
    replies.push(mode === 'error' ? { error: true } : mode === 'timeout' ? { hang: true } :
      mode === 'stdout-limit' ? { stdout: 'x'.repeat(65537) } : { stderr: 'x'.repeat(65537) });
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(10000);
    expect(events()).toHaveLength(0);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    full();
    await vi.advanceTimersByTimeAsync(590000);
    expect(events()).toHaveLength(1);
  });
  it('cancels pending commands and clears timers without publishing after stop', async () => {
    const timers = vi.getTimerCount();
    replies.push({ stdout: 'device' }, { hang: true });
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(1200000);
    expect(children[1].kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(events()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(timers);
  });
  it('collects each TV and uses its current discovered address on the next pass', async () => {
    fixture.devices.tcl = { ip: '192.0.2.22' };
    full(); full();
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().map(e => e.device)).toEqual(['hisense', 'tcl']);
    fixture.devices.hisense.ip = '192.0.2.31';
    full(); full();
    await vi.advanceTimersByTimeAsync(600000);
    expect(fixture.spawn.mock.calls[14][1]).toEqual(['-s', '192.0.2.31:5555', 'get-state']);
    expect(events()).toHaveLength(4);
  });
  it('skips package lookup when unset and rejects shell metacharacters before spawning', async () => {
    vi.stubEnv('PTP_PKG', 'com.example;reboot');
    expect(() => snapshots.startSnapshots()).toThrow('PTP_PKG');
    expect(fixture.spawn).not.toHaveBeenCalled();
    vi.stubEnv('PTP_PKG', '');
    full(); replies.splice(5, 1);
    stop = snapshots.startSnapshots();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()[0].payload).toMatchObject({ ptpPackage: null, ptpVersion: null, memAvailableBytes: 456789 * 1024 });
  });
  it('does nothing when discovery is disabled', () => {
    fixture.devices = {};
    const timers = vi.getTimerCount();
    stop = snapshots.startSnapshots();
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
  });
});
