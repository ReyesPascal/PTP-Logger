/** New: fake spawn and serial fixtures; never contacts an ADB daemon or TV. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ spawn: vi.fn(), serials: {} as Record<string, string | undefined> }));
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
vi.mock('../server/tv/devices', () => ({ getDeviceLabels: () => Object.keys(fixture.serials) }));
vi.mock('../server/tv/adb', async original => ({ ...await original<typeof import('../server/tv/adb')>(),
  getAdbSerial: (label: string) => fixture.serials[label] }));
const boot1 = '11111111-1111-1111-1111-111111111111';
const boot2 = '22222222-2222-2222-2222-222222222222';
let boot: string;
let dir: string;
let log: typeof import('../server/eventLog');
let collector: typeof import('../server/tv/logcat');
let stop: (() => void) | undefined;
type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
let children: Child[];
let streams: Child[];
let ts: string;
const line = (msg: string, priority = 'I', stamp = ts) => `${stamp} 1000 123 456 ${priority} Fixture: ${msg}\n`;
const events = () => log.recentEvents().filter(e => e.source === 'tv-logcat').reverse();
const logged = () => events().filter(e => e.eventType === 'logcat');
const start = async () => { stop = collector.startLogcat(); await vi.advanceTimersByTimeAsync(0); };
const reconnect = async () => { streams.at(-1)!.emit('close', 1); await vi.advanceTimersByTimeAsync(2000); };
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-logcat-'));
  vi.stubEnv('DATA_DIR', dir); vi.stubEnv('ADB_BIN', '/fixture/adb');
  ts = (Date.now() / 1000 + 1).toFixed(6);
  fixture.serials = { hisense: '192.0.2.21:5555' };
  boot = boot1; children = []; streams = [];
  fixture.spawn.mockReset().mockImplementation((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child);
    if (args.includes('logcat')) streams.push(child);
    else Promise.resolve().then(() => { child.stdout.write(boot); child.emit('close', 0); });
    return child;
  });
  log = await import('../server/eventLog');
  collector = await import('../server/tv/logcat');
});
afterEach(() => {
  stop?.(); stop = undefined;
  log.closeLog(); process.removeListener('beforeExit', log.flush);
  vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true });
});

describe('TV logcat capture with fake spawn', () => {
  it('waits for verified ADB, uses the exact command and maps priorities with metadata and timestamp', async () => {
    fixture.serials.hisense = undefined;
    await start(); await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.spawn).not.toHaveBeenCalled();
    fixture.serials.hisense = '192.0.2.21:5555';
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.spawn.mock.calls.map(c => c.slice(0, 2))).toEqual([
      ['/fixture/adb', ['-s', '192.0.2.21:5555', 'shell', 'cat', '/proc/sys/kernel/random/boot_id']],
      ['/fixture/adb', ['-s', '192.0.2.21:5555', 'logcat', '-v', 'epoch,uid,printable', '-T', '1793966400.000000']],
    ]);
    streams[0].stdout.write('--------- beginning of main\n');
    for (const p of ['V', 'D', 'I', 'W', 'E', 'F']) streams[0].stdout.write(line(p, p));
    expect(logged().map(e => e.level)).toEqual(['debug', 'debug', 'info', 'warn', 'error', 'error']);
    expect(logged()[0]).toMatchObject({ ts: '2026-11-06T12:00:01.000Z', source: 'tv-logcat', device: 'hisense',
      payload: { tag: 'Fixture', pid: 123, uid: '1000' }, message: 'V' });
    expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(logged()[0].id);
  });
  it('decodes split UTF-8 and split lines, accepts named UIDs and preserves microseconds for resume', async () => {
    await start();
    const bytes = Buffer.from(line('hello 🍿', 'W', `${ts.slice(0, -6)}123456`).replace('1000', 'u0_a123'));
    const split = bytes.indexOf(Buffer.from('🍿')) + 2;
    streams[0].stdout.write(bytes.subarray(0, split));
    expect(logged()).toHaveLength(0);
    streams[0].stdout.write(bytes.subarray(split));
    expect(logged()[0]).toMatchObject({ message: 'hello 🍿', payload: { uid: 'u0_a123' }, ts: '2026-11-06T12:00:01.123Z' });
    await reconnect();
    expect(fixture.spawn.mock.calls.at(-1)![1].at(-1)).toBe(`${ts.slice(0, -6)}123456`);
  });
  it('skips inclusive replay but retains identical repeated lines and new lines at the boundary', async () => {
    await start();
    streams[0].stdout.write(line('same') + line('same') + line('other'));
    await reconnect();
    streams[1].stdout.write(line('old', 'I', '1793966400.000000') + line('same') + line('same') + line('other') + line('same'));
    expect(logged().map(e => e.message)).toEqual(['same', 'same', 'other', 'same']);
  });
  it('saves durable cursors and boot ID, reloads after restart, and preserves Docker cursors', async () => {
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ 'usenet-ultimate': '2026-11-06T00:00:00Z' }));
    await start(); streams[0].stdout.write(line('saved'));
    await vi.advanceTimersByTimeAsync(5000);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
    expect(state).toEqual({ 'usenet-ultimate': '2026-11-06T00:00:00Z', 'tv-logcat:hisense': { ts, count: 1, boot: boot1 } });
    stop!(); stop = undefined;
    log.closeLog(); process.removeListener('beforeExit', log.flush);
    vi.resetModules();
    log = await import('../server/eventLog'); collector = await import('../server/tv/logcat');
    await start();
    streams[1].stdout.write(line('saved') + line('new'));
    expect(logged().map(e => e.message)).toEqual(['new']);
    const stored = (await log.queryEvents({ source: 'tv-logcat', eventType: 'logcat' })).events;
    expect(stored.map(e => e.message).sort()).toEqual(['new', 'saved']);
  });
  it('records reboot before resetting the cursor and captures logs after a backwards clock jump', async () => {
    await start(); streams[0].stdout.write(line('before'));
    boot = boot2; await reconnect();
    expect(fixture.spawn.mock.calls.at(-1)![1].at(-1)).toBe('0.000000');
    streams[1].stdout.write(line('after', 'I', '1700000000.123456'));
    expect(events().filter(e => e.eventType === 'tv-reboot')).toMatchObject([
      { level: 'info', device: 'hisense', payload: { previousBootId: boot1, bootId: boot2 } },
    ]);
    expect(logged().map(e => e.message)).toEqual(['before', 'after']);
    await reconnect();
    expect(events().filter(e => e.eventType === 'tv-reboot')).toHaveLength(1);
  });
  it('kills on down/address changes and shuts down pending boot commands with no late work', async () => {
    const baseline = vi.getTimerCount();
    await start(); const first = streams[0];
    fixture.serials.hisense = undefined; await vi.advanceTimersByTimeAsync(2000);
    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
    first.stdout.write(line('late')); expect(logged()).toHaveLength(0);
    fixture.serials.hisense = '192.0.2.31:5555'; await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.spawn.mock.calls.at(-1)![1][1]).toBe('192.0.2.31:5555');
    stop!(); expect(streams[1].kill).toHaveBeenCalledWith('SIGKILL');
    const calls = fixture.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.spawn).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(baseline);
  });
  it('backs off failed streams, caps at 60 seconds, and avoids double reconnects', async () => {
    await start();
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const old = streams.at(-1)!; const count = streams.length;
      old.emit('error', new Error('offline')); old.emit('close', 1);
      await vi.advanceTimersByTimeAsync(delay - 1); expect(streams).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(streams).toHaveLength(count + 1);
    }
    expect(events().filter(e => e.eventType === 'source-down')).toHaveLength(7);
  });
  it('bounds boot commands, retries timeouts and missing executables without overlapping', async () => {
    fixture.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      children.push(child); return child;
    });
    await start(); await vi.advanceTimersByTimeAsync(9999);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    fixture.spawn.mockImplementation(() => { throw new Error('ENOENT'); });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events().filter(e => e.eventType === 'source-down')).toHaveLength(2);
    stop!(); await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
  });
  it('captures two TVs independently and cancels a pending boot check before shutdown', async () => {
    fixture.serials.tcl = '192.0.2.22:5555';
    await start();
    expect(streams).toHaveLength(2);
    streams[0].stdout.write(line('one'));
    streams[1].stdout.write(line('two'));
    expect(logged().map(e => [e.device, e.message])).toEqual([['hisense', 'one'], ['tcl', 'two']]);
    stop!();
    fixture.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      children.push(child); return child;
    });
    const baseline = vi.getTimerCount();
    await start();
    const pending = children.slice(-2);
    stop!();
    for (const child of pending) {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.stdout.write(boot1); child.emit('close', 0);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(baseline);
  });
  it('segments huge lines without losing text, deduplicates segments and replays incomplete suffixes', async () => {
    await start();
    const huge = line('x'.repeat(180000));
    streams[0].stdout.write(huge.slice(0, 140000));
    expect(logged().length).toBeGreaterThan(0);
    await reconnect(); streams[1].stdout.write(huge);
    expect(logged().map(e => e.message).join('')).toBe('x'.repeat(180000));
    expect(logged().every(e => e.message.length <= 65536)).toBe(true);
    streams[1].stdout.write(line('partial').slice(0, -1));
    await reconnect(); streams[2].stdout.write(huge + line('partial'));
    expect(logged().at(-1)!.message).toBe('partial');
    expect(logged().map(e => e.message).join('')).toBe('x'.repeat(180000) + 'partial');
  });
  it('shares live source state with Docker, flushes on stop, and is idle with no TVs', async () => {
    await start(); streams[0].stdout.write(line('tv'));
    const state = await import('../server/sources/sourceState');
    state.checkpointSource('nzbdav', '2026-11-06T12:01:00Z');
    stop!();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'))).toMatchObject({
      nzbdav: '2026-11-06T12:01:00Z', 'tv-logcat:hisense': { ts, count: 1 },
    });
    fixture.serials = {};
    const baseline = vi.getTimerCount(); stop = collector.startLogcat();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
