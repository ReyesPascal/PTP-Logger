import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';

let dir: string;
let log: typeof import('../server/eventLog');
let tv: typeof import('../server/tv/devices');
const stops: Array<() => void> = [];
const hisense = '192.168.4.21 dev wlan0 lladdr E8:51:77:F6:B7:CE REACHABLE';
const tcl = '192.168.4.22 dev wlan0 lladdr 38:e7:c0:3f:be:9d STALE';
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-devices-'));
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('TV_MACS', 'hisense=e8:51:77:f6:b7:ce,tcl=38:e7:c0:3f:be:9d');
  log = await import('../server/eventLog');
  tv = await import('../server/tv/devices');
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MAC-based TV discovery (no real network)', () => {
  it('parses case-insensitive MACs, ignores IPv6, incomplete and failed rows', () => {
    expect([...tv.parseNeighbours(`${hisense}\n${tcl}\n192.168.4.8 dev eth0 INCOMPLETE\n192.168.4.9 dev eth0 lladdr aa:bb:cc:dd:ee:ff FAILED\nfe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE`)]).toEqual([
      ['e8:51:77:f6:b7:ce', '192.168.4.21'], ['38:e7:c0:3f:be:9d', '192.168.4.22'],
    ]);
  });
  it('records changes before saving addresses, updates lastSeen without duplicate events, keeps offline devices', async () => {
    const probe = vi.fn();
    let ahead = false;
    const unsubscribe = log.subscribe(({ event }) => {
      if (event.eventType !== 'tv-ip-change') return;
      ahead = true;
      expect(fs.existsSync(path.join(log.DATA_DIR, 'devices.json'))).toBe(false);
      expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(event.id);
    });
    await tv.discoverDevices(signal(), { readNeighbours: async () => `${hisense}\n${tcl}`, probe });
    unsubscribe();
    expect(ahead).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    const first = tv.getDevice('hisense')!;
    expect(JSON.parse(fs.readFileSync(path.join(log.DATA_DIR, 'devices.json'), 'utf8')).hisense).toEqual(first);
    first.ip = 'mutated';
    expect(tv.getDevice('hisense')?.ip).toBe('192.168.4.21');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    await tv.discoverDevices(signal(), { readNeighbours: async () => `${hisense}\n${tcl}`, probe });
    expect(tv.getDevice('hisense')?.lastSeen).toBe('2030-01-01T00:00:00.000Z');
    expect(log.recentEvents()).toHaveLength(2);
    const moved = hisense.replace('192.168.4.21', '192.168.4.31');
    await tv.discoverDevices(signal(), { readNeighbours: async () => moved, probe });
    expect(tv.getDevice('tcl')?.ip).toBe('192.168.4.22');
    expect(log.recentEvents()[0]).toMatchObject({ eventType: 'tv-ip-change', source: 'tv-discovery', device: 'hisense', level: 'info',
      payload: { previousIp: '192.168.4.21', ip: '192.168.4.31' } });
    expect(log.recentEvents()).toHaveLength(3);
  });
  it('scans all 254 addresses at most 20 at a time then rereads neighbours', async () => {
    const readNeighbours = vi.fn().mockResolvedValueOnce(hisense).mockResolvedValueOnce(tcl);
    const addresses: string[] = [];
    let active = 0;
    let peak = 0;
    const probe = async (ip: string) => {
      addresses.push(ip);
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    };
    await tv.discoverDevices(signal(), { readNeighbours, probe });
    expect(readNeighbours).toHaveBeenCalledTimes(2);
    expect(addresses).toEqual(Array.from({ length: 254 }, (_, i) => `192.168.4.${i + 1}`));
    expect(peak).toBe(20);
    expect(tv.getDevice('hisense')?.ip).toBe('192.168.4.21');
    expect(tv.getDevice('tcl')?.ip).toBe('192.168.4.22');
  });
  it('uses a fake ip executable for the child-process path and reloads saved custom devices', async () => {
    vi.stubEnv('TV_MACS', 'lounge=aa:bb:cc:dd:ee:ff');
    fs.writeFileSync(path.join(dir, 'ip'), '#!/bin/sh\n[ "$1" = neigh ] || exit 1\nprintf "%s\\n" "192.168.4.50 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    await tv.discoverDevices(signal());
    const saved = tv.getDevice('lounge');
    log.closeLog();
    process.removeListener('beforeExit', log.flush);
    vi.resetModules();
    log = await import('../server/eventLog');
    tv = await import('../server/tv/devices');
    expect(tv.getDevice('lounge')).toEqual(saved);
    vi.stubEnv('TV_MACS', 'lounge=00:11:22:33:44:55');
    expect(tv.getDevice('lounge')).toBeUndefined();
    expect(tv.getDevice('missing')).toBeUndefined();
  });
  it('aborts an active scan without another batch, reread, or state publication', async () => {
    const controller = new AbortController();
    const readNeighbours = vi.fn().mockResolvedValue(hisense);
    const probe = vi.fn(async () => { controller.abort(); });
    await tv.discoverDevices(controller.signal, { readNeighbours, probe });
    expect(probe).toHaveBeenCalledTimes(20);
    expect(readNeighbours).toHaveBeenCalledTimes(1);
    expect(tv.getDevice('hisense')).toBeUndefined();
    expect(log.recentEvents()).toHaveLength(0);
  });
  it('starts immediately, prevents overlapping passes, retries every five minutes and stops cleanly', async () => {
    vi.useFakeTimers();
    let resolve!: (output: string) => void;
    const readNeighbours = vi.fn().mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }))
      .mockResolvedValue(`${hisense}\n${tcl}`);
    const stop = tv.startDevices({ readNeighbours });
    stops.push(stop);
    expect(readNeighbours).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(readNeighbours).toHaveBeenCalledTimes(1);
    resolve(`${hisense}\n${tcl}`);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(readNeighbours).toHaveBeenCalledTimes(2);
    stop();
    expect(readNeighbours.mock.calls[0][0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(readNeighbours).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports read failures and retries without clearing saved state', async () => {
    await tv.discoverDevices(signal(), { readNeighbours: async () => `${hisense}\n${tcl}` });
    const previous = tv.getDevice('hisense');
    vi.useFakeTimers();
    const readNeighbours = vi.fn().mockRejectedValueOnce(new Error('fixture ip unavailable')).mockResolvedValue(`${hisense}\n${tcl}`);
    stops.push(tv.startDevices({ readNeighbours }));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.recentEvents()[0]).toMatchObject({ eventType: 'tv-discovery-error', level: 'warn', source: 'tv-discovery' });
    expect(tv.getDevice('hisense')).toEqual(previous);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(readNeighbours).toHaveBeenCalledTimes(2);
  });
  it('allows an empty configuration and rejects invalid MACs without starting work', () => {
    const readNeighbours = vi.fn();
    vi.stubEnv('TV_MACS', '');
    tv.startDevices({ readNeighbours })();
    expect(readNeighbours).not.toHaveBeenCalled();
    vi.stubEnv('TV_MACS', 'hisense=not-a-mac');
    expect(() => tv.startDevices({ readNeighbours })).toThrow('TV_MACS must be');
    vi.stubEnv('TV_MACS', undefined);
    stops.push(tv.startDevices({ readNeighbours: async () => `${hisense}\n${tcl}` }));
  });
  it.each(['connect', 'error', 'timeout', 'abort'] as const)('destroys TCP probe sockets on %s (200 ms maximum)', async mode => {
    vi.useFakeTimers();
    let socket!: Socket;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) { socket = this; return this; });
    const destroy = vi.spyOn(Socket.prototype, 'destroy');
    const controller = new AbortController();
    const done = tv.probeAddress('192.0.2.1', controller.signal);
    expect(socket.connect).toHaveBeenCalledWith(5555, '192.0.2.1');
    if (mode === 'timeout') {
      await vi.advanceTimersByTimeAsync(199);
      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else if (mode === 'abort') controller.abort();
    else if (mode === 'error') socket.emit('error', new Error('fixture refused'));
    else socket.emit('connect');
    await done;
    expect(destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
