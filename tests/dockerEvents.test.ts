// Unix-socket fixture pattern reused from tests/dockerLogs.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { once } from 'events';

async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const event = (action: string, attrs: Record<string, string> = {}) => JSON.stringify({
  Type: 'container', Action: action, timeNano: '1793980800123456789',
  Actor: { ID: '1234567890abcdef', Attributes: { name: 'popcorn 🍿', ...attrs } },
});

describe('Docker events over a fake Unix socket', () => {
  let dir: string;
  let server: http.Server;
  let stop: (() => void) | undefined;
  let store: typeof import('../server/eventLog');
  let docker: typeof import('../server/sources/dockerEvents');
  beforeEach(async () => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-events-'));
    vi.stubEnv('DATA_DIR', dir);
    vi.stubEnv('DOCKER_SOCKET_PATH', path.join(dir, 'docker.sock'));
    vi.stubEnv('DOCKER_EVENTS', 'on');
    store = await import('../server/eventLog');
    docker = await import('../server/sources/dockerEvents');
    server = http.createServer();
    server.listen(process.env.DOCKER_SOCKET_PATH);
    await once(server, 'listening');
  });
  afterEach(async () => {
    stop?.();
    stop = undefined;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.closeLog();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records split UTF-8 lines, all requested levels, payloads and Docker timestamps to disk', async () => {
    const actions = ['start', 'die', 'oom', 'kill', 'health_status: unhealthy', 'health_status: healthy', 'destroy'];
    server.on('request', (req, res) => {
      expect(req.method).toBe('GET');
      const url = new URL(req.url!, 'http://docker');
      expect(url.pathname).toBe('/events');
      expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ type: ['container'] });
      res.writeHead(200);
      const bytes = Buffer.from('bad json\nnull\n' + actions.map(a => event(a, { exitCode: '0' })).join('\n') + '\n');
      let i = 0;
      const send = () => {
        if (i === bytes.length || res.destroyed) return;
        res.write(bytes.subarray(i, ++i));
        setImmediate(send);
      };
      send();
    });
    stop = docker.startDockerEvents();
    await until(() => store.recentEvents().length === actions.length);
    const events = store.recentEvents().reverse();
    expect(events.map(e => e.level)).toEqual(['info', 'error', 'error', 'error', 'warn', 'info', 'info']);
    expect(events.every(e => e.eventType === 'container-event' && e.source === 'docker' && e.device === 'brain')).toBe(true);
    expect(events[1]).toMatchObject({ message: 'popcorn 🍿 die', ts: new Date(1793980800123).toISOString(),
      payload: { container: 'popcorn 🍿', id: '1234567890ab', action: 'die', exitCode: 0 } });
    expect(events[4].payload).toMatchObject({ health: 'unhealthy' });
    store.flush();
    const files = fs.readdirSync(path.join(dir, 'logs'));
    expect(files.flatMap(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8').trim().split('\n')).map(l => JSON.parse(l).message))
      .toEqual(actions.map(a => `popcorn 🍿 ${a}`));
  });

  it('reconnects once after EOF, resumes by nanoseconds and cancels reconnect on stop', async () => {
    const requests: URL[] = [];
    server.on('request', (req, res) => {
      requests.push(new URL(req.url!, 'http://docker'));
      res.writeHead(200);
      if (requests.length === 1) res.end(event('start') + '\n');
      else res.end(event('die') + '\n');
    });
    stop = docker.watchDockerEvents();
    await until(() => store.recentEvents().length === 2);
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.has('since')).toBe(false);
    expect(requests[1].searchParams.get('since')).toBe('1793980800.123456789');
    stop();
    stop();
    await new Promise(resolve => setTimeout(resolve, 2200));
    expect(requests).toHaveLength(2);
  });

  it('rejects HTTP error bodies, retries and handles legacy fields and invalid time', async () => {
    let requests = 0;
    server.on('request', (_req, res) => {
      if (++requests === 1) { res.writeHead(503); res.end(event('kill') + '\n'); return; }
      res.writeHead(200);
      res.write(JSON.stringify({ status: 'start', id: 'abcdef0123456789', timeNano: '9999999999999999999999999999' }) + '\n');
    });
    stop = docker.watchDockerEvents();
    await until(() => store.recentEvents().length === 1);
    expect(requests).toBe(2);
    expect(store.recentEvents()[0]).toMatchObject({ message: 'abcdef012345 start', level: 'info' });
    expect(Date.parse(store.recentEvents()[0].ts)).toBeGreaterThan(Date.now() - 10000);
  });

  it('bounds an unterminated line and reconnects without recording partial input', async () => {
    let requests = 0;
    server.on('request', (_req, res) => {
      res.writeHead(200);
      if (++requests === 1) res.end('x'.repeat(1024 * 1024 + 1));
      else res.write(event('start') + '\n');
    });
    stop = docker.watchDockerEvents();
    await until(() => store.recentEvents().length === 1);
    expect(requests).toBe(2);
    expect(store.recentEvents()[0].message).toBe('popcorn 🍿 start');
  });

  it('does no background work at import or with DOCKER_EVENTS=off', async () => {
    const requests = vi.fn();
    server.on('request', requests);
    vi.stubEnv('DOCKER_EVENTS', 'off');
    stop = docker.startDockerEvents();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests).not.toHaveBeenCalled();
    expect(store.recentEvents()).toEqual([]);
  });
});
