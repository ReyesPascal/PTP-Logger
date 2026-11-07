import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { globalLogService } from '../server/globalLogService';
import { getProbeStates, startProbes } from '../server/sources/probes';

vi.mock('../server/globalLogService', () => ({ globalLogService: { log: vi.fn() } }));

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error('Probe fixture did not settle');
}

describe('health probes with local fixtures', () => {
  let server: http.Server;
  let tcp: net.Server;
  let stop = () => {};
  let url: string;
  let status: number;
  let hang: boolean;
  let requests: string[];
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.mocked(globalLogService.log).mockClear();
    status = 200;
    hang = false;
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url!);
      if (!hang) { res.writeHead(status); res.end('fixture'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    tcp = net.createServer(socket => socket.end());
  });
  afterEach(async () => {
    stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (tcp.listening) await new Promise<void>(resolve => tcp.close(() => resolve()));
  });
  const events = () => vi.mocked(globalLogService.log).mock.calls.map(([entry]) => entry);
  async function cycle() {
    const previous = getProbeStates();
    await vi.advanceTimersByTimeAsync(30000);
    await until(() => Object.entries(getProbeStates()).every(([device, state]) => state.checkedAt !== previous[device].checkedAt));
  }

  it('uses the correct paths/status rules, debounces failures, and logs transitions only', async () => {
    status = 404;
    stop = startProbes({ uuUrl: url + '/ignored', nzbdavUrl: url, tvHosts: '' });
    await until(() => Object.values(getProbeStates()).every(state => state.checkedAt !== null));
    expect(requests.sort()).toEqual(['/', '/manifest.json']);
    expect(getProbeStates()).toMatchObject({ uu: { up: null, failures: 1 }, nzbdav: { up: true } });
    await cycle();
    expect(events().map(e => [e.device, e.eventType, e.level, e.source])).toEqual([
      ['nzbdav', 'probe-up', 'info', 'probe'], ['uu', 'probe-down', 'warn', 'probe'],
    ]);
    await cycle();
    expect(events()).toHaveLength(2);
    status = 204;
    await cycle();
    expect(getProbeStates().uu).toMatchObject({ up: true, failures: 0 });
    status = 503;
    await cycle();
    expect(getProbeStates().uu.up).toBe(true);
    status = 200;
    await cycle();
    expect(events()).toHaveLength(3);
    status = 500;
    await cycle();
    await cycle();
    expect(getProbeStates().nzbdav.up).toBe(false);
    expect(events().filter(e => e.eventType === 'probe-down')).toHaveLength(3);
    const snapshot = getProbeStates();
    snapshot.uu.up = true;
    expect(getProbeStates().uu.up).toBe(false);
  });

  it('handles TCP success, a closed port, and recovery', async () => {
    tcp.listen(0, '127.0.0.1');
    await once(tcp, 'listening');
    const port = (tcp.address() as net.AddressInfo).port;
    stop = startProbes({ uuUrl: url, nzbdavUrl: url, tvHosts: 'fixture=127.0.0.1', tvPort: port });
    await until(() => Object.values(getProbeStates()).every(state => state.up === true));
    await new Promise<void>(resolve => tcp.close(() => resolve()));
    await cycle();
    await until(() => getProbeStates().fixture.failures === 1);
    expect(getProbeStates().fixture.up).toBe(true);
    await cycle();
    await until(() => getProbeStates().fixture.up === false);
    tcp.listen(port, '127.0.0.1');
    await once(tcp, 'listening');
    await cycle();
    await until(() => getProbeStates().fixture.up === true);
    expect(events().filter(e => e.device === 'fixture').map(e => e.eventType)).toEqual(['probe-up', 'probe-down', 'probe-up']);
  });

  it('bounds stalled HTTP/TCP checks to three seconds and cancels on stop', async () => {
    hang = true;
    // A socket that never connects, but still implements Node's AbortSignal handling.
    const connect = vi.spyOn(net, 'connect').mockImplementation((options: any) => new net.Socket({ signal: options.signal }));
    stop = startProbes({ uuUrl: url, nzbdavUrl: url, tvHosts: 'fixture=127.0.0.1' });
    await until(() => requests.length === 2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(getProbeStates().fixture.checkedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await until(() => getProbeStates().uu.failures === 1 && getProbeStates().fixture.failures === 1);
    expect(events()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(27000);
    await until(() => requests.length === 4);
    await vi.advanceTimersByTimeAsync(3000);
    await until(() => getProbeStates().uu.up === false && getProbeStates().fixture.up === false);
    expect(events()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(27000);
    await until(() => requests.length === 6);
    const snapshot = getProbeStates();
    stop();
    await vi.advanceTimersByTimeAsync(90000);
    await delay(20);
    expect(getProbeStates()).toEqual(snapshot);
    expect(requests).toHaveLength(6);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
