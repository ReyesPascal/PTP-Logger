/** New: cached-source aggregation/route fixtures have no Manifexus equivalent. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server, AddressInfo } from 'node:net';
import type { Alert } from '../server/alerts';

let dir: string;
let alerts: typeof import('../server/alerts');
let log: typeof import('../server/eventLog');
let probes: typeof import('../server/sources/probes');
let power: typeof import('../server/sources/brainHost');
let disk: typeof import('../server/diskCheck');
const unregister: Array<() => void> = [];
let server: Server | undefined;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ptp-alerts-'));
  vi.stubEnv('DATA_DIR', dir);
  probes = await import('../server/sources/probes');
  power = await import('../server/sources/brainHost');
  disk = await import('../server/diskCheck');
  alerts = await import('../server/alerts');
  log = await import('../server/eventLog');
});
beforeEach(() => {
  vi.spyOn(probes, 'getProbeStates').mockReturnValue({});
  vi.spyOn(power, 'getPowerAlert').mockReturnValue(null);
  vi.spyOn(disk, 'getDiskAlert').mockReturnValue({ active: false, freeBytes: null });
});
afterEach(async () => {
  for (const remove of unregister.splice(0)) remove();
  vi.restoreAllMocks();
  if (server) {
    const current = server;
    server = undefined;
    await new Promise<void>(resolve => current.close(() => resolve()));
  }
});
afterAll(() => {
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('active alerts', () => {
  it('ignores healthy, unknown and first-failure probes and inactive host alerts', () => {
    vi.mocked(probes.getProbeStates).mockReturnValue({
      uu: { up: null, failures: 1, checkedAt: null },
      nzbdav: { up: true, failures: 0, checkedAt: null },
      tcl: { up: true, failures: 1, checkedAt: null },
    });
    expect(alerts.getAlerts()).toEqual([]);
  });

  it('combines down services, arbitrary TV names, power and disk, then reflects recovery', () => {
    vi.mocked(probes.getProbeStates).mockReturnValue(Object.fromEntries(['uu', 'nzbdav', 'living-room'].map(device =>
      [device, { up: false, failures: 2, checkedAt: '2026-11-06T00:00:00Z' }])));
    vi.mocked(power.getPowerAlert).mockReturnValue({ level: 'error', message: 'Brain battery low (10%)', onBattery: true, capacity: 10 });
    vi.mocked(disk.getDiskAlert).mockReturnValue({ active: true, freeBytes: 123 });
    expect(alerts.getAlerts()).toEqual([
      { id: 'probe:uu', level: 'warn', source: 'probe', device: 'uu', message: 'Usenet Ultimate is down' },
      { id: 'probe:nzbdav', level: 'warn', source: 'probe', device: 'nzbdav', message: 'nzbdav is down' },
      { id: 'probe:living-room', level: 'warn', source: 'probe', device: 'living-room', message: 'TV living-room is unreachable' },
      { id: 'power:brain', level: 'error', source: 'brain', device: 'brain', message: 'Brain battery low (10%)' },
      { id: 'disk:brain', level: 'warn', source: 'logger', device: 'brain', message: 'Data disk has less than 5 GB free' },
    ]);
    vi.mocked(probes.getProbeStates).mockReturnValue({});
    vi.mocked(power.getPowerAlert).mockReturnValue(null);
    vi.mocked(disk.getDiskAlert).mockReturnValue({ active: false, freeBytes: 9e9 });
    expect(alerts.getAlerts()).toEqual([]);
  });

  it('reads registered sources afresh, returns copies and supports unregistering', () => {
    let active = true;
    const fixture: Alert = { id: 'future', level: 'warn', source: 'future', device: 'brain', message: 'Future alert' };
    const remove = alerts.registerAlertSource(() => active ? [fixture] : []);
    unregister.push(remove);
    unregister.push(alerts.registerAlertSource(() => [{ ...fixture, id: 'second' }]));
    const first = alerts.getAlerts();
    expect(first).toHaveLength(2);
    first[0].message = 'mutated';
    expect(alerts.getAlerts()[0].message).toBe('Future alert');
    active = false;
    expect(alerts.getAlerts().map(a => a.id)).toEqual(['second']);
    active = true;
    remove();
    remove();
    expect(alerts.getAlerts().map(a => a.id)).toEqual(['second']);
  });

  it('serves current combined alerts without starting collectors or recording events', async () => {
    const before = log.recentEvents().length;
    const { createApp } = await import('../server');
    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alerts`;
    const fixture: Alert = { id: 'future', level: 'warn', source: 'future', device: 'brain', message: 'Future alert' };
    const remove = alerts.registerAlertSource(() => [fixture]);
    unregister.push(remove);
    vi.mocked(power.getPowerAlert).mockReturnValue({ level: 'warn', message: 'Brain AC power lost', onBattery: true });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ alerts: [
      { id: 'power:brain', level: 'warn', source: 'brain', device: 'brain', message: 'Brain AC power lost' }, fixture,
    ] });
    remove();
    vi.mocked(power.getPowerAlert).mockReturnValue(null);
    expect(await (await fetch(url)).json()).toEqual({ alerts: [] });
    expect(log.recentEvents()).toHaveLength(before);
  });
});
