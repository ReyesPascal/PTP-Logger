/** New: mocked-spawn fixtures; no real adb daemon or TV connections. */
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
let adb: typeof import('../server/tv/adb');
let stop: (() => void) | undefined;
type Reply = { stdout?: string; stderr?: string; code?: number; error?: boolean; hang?: boolean };
let replies: Reply[];
let children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }>;
const events = () => log.recentEvents().filter(e => e.source === 'adb').reverse();
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-adb-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('ADB_BIN', '/fixture/adb');
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
  adb = await import('../server/tv/adb');
});
afterEach(() => {
  stop?.(); stop = undefined;
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ADB keepalive with mocked child processes', () => {
  it('preserves exact bytes and whitespace for low-priority bounded recovery commands', async () => {
    fixture.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      Promise.resolve().then(() => {
        const bytes = Buffer.from('  🍿\n');
        child.stdout.write(bytes.subarray(0, 3)); child.stdout.write(bytes.subarray(3)); child.emit('close', 0);
      });
      return child;
    });
    const result = await adb.adbCommand(['shell', 'fixture'], new AbortController().signal,
      { nice: true, raw: true, maxBytes: 1024, encoding: 'latin1' });
    expect(Buffer.from(result, 'latin1')).toEqual(Buffer.from('  🍿\n'));
    expect(fixture.spawn.mock.calls[0].slice(0, 2)).toEqual(['nice', ['-n', '10', '/fixture/adb', 'shell', 'fixture']]);
  });
  it('connects then verifies, writes transition events to disk, checks every 60 seconds without duplicates', async () => {
    replies.push({ stdout: 'connected\n' }, { stdout: 'device\n', stderr: '* daemon started *\n' });
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.spawn.mock.calls.map(c => c.slice(0, 2))).toEqual([
      ['/fixture/adb', ['connect', '192.0.2.21:5555']], ['/fixture/adb', ['-s', '192.0.2.21:5555', 'get-state']],
    ]);
    expect(events()).toMatchObject([{ eventType: 'adb-up', source: 'adb', device: 'hisense', level: 'info' }]);
    expect(adb.getAdbSerial('hisense')).toBe('192.0.2.21:5555');
    expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(events()[0].id);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(3);
    expect(events()).toHaveLength(1);
  });
  it('detects loss, backs off at 2/4/8 seconds, then recovers and resets the backoff', async () => {
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(0);
    replies.push({ stdout: 'offline\n' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adb.getAdbSerial('hisense')).toBeUndefined();
    replies.push({ code: 1 }, { code: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.spawn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fixture.spawn).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(7999);
    expect(fixture.spawn).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(7);
    expect(events().map(e => e.eventType)).toEqual(['adb-up', 'adb-down', 'adb-up']);
    replies.push({ code: 1 }, { code: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.spawn).toHaveBeenCalledTimes(9);
  });
  it('does not treat exit-zero failed connects or unauthorized get-state as up', async () => {
    replies.push({ stdout: 'failed to connect' }, { stdout: 'unauthorized' });
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().map(e => e.eventType)).toEqual(['adb-down']);
  });
  it.each(['error', 'timeout', 'stdout-limit', 'stderr-limit'] as const)('bounds and recovers from %s', async mode => {
    replies.push(mode === 'error' ? { error: true } : mode === 'timeout' ? { hang: true } :
      mode === 'stdout-limit' ? { stdout: 'x'.repeat(65537) } : { stderr: 'x'.repeat(65537) });
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 10_000 : 0);
    expect(events().map(e => e.eventType)).toEqual(['adb-down']);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2000);
    expect(events().map(e => e.eventType)).toEqual(['adb-down', 'adb-up']);
  });
  it('never overlaps commands for one TV, allows a second TV and kills pending work on stop', async () => {
    const baselineTimers = vi.getTimerCount();
    fixture.devices.tcl = { ip: '192.0.2.22' };
    replies.push({ hang: true });
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(8000);
    expect(fixture.spawn).toHaveBeenCalledTimes(3);
    expect(events()).toMatchObject([{ eventType: 'adb-up', device: 'tcl' }]);
    stop();
    expect(adb.getAdbSerial('tcl')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.spawn).toHaveBeenCalledTimes(3);
    expect(events()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });
  it('waits for discovery and immediately reconnects to a changed address', async () => {
    fixture.devices.hisense = undefined!;
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fixture.spawn).not.toHaveBeenCalled();
    fixture.devices.hisense = { ip: '192.0.2.21' };
    await vi.advanceTimersByTimeAsync(2000);
    fixture.devices.hisense = { ip: '192.0.2.31' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.spawn.mock.calls.slice(-2).map(c => c[1])).toEqual([
      ['connect', '192.0.2.31:5555'], ['-s', '192.0.2.31:5555', 'get-state'],
    ]);
    expect(events().map(e => e.eventType)).toEqual(['adb-up', 'adb-down', 'adb-up']);
  });
  it('caps reconnect backoff at 60 seconds and stops without timers when no TVs are configured', async () => {
    const baselineTimers = vi.getTimerCount();
    fixture.spawn.mockImplementation(() => { throw new Error('fixture missing binary'); });
    stop = adb.startAdb();
    await vi.advanceTimersByTimeAsync(122_000);
    expect(fixture.spawn).toHaveBeenCalledTimes(7); // 0, 2, 6, 14, 30, 62, 122 seconds
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fixture.spawn).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(8);
    stop();
    fixture.devices = {};
    stop = adb.startAdb();
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });
});
