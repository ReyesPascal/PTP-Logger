// New Unix-socket fixtures: exercise the copied decoder without Docker or TVs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { once } from 'events';

function frame(stream: number, text: string) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('Docker log following over a fake Unix socket', () => {
  let dir: string;
  let server: http.Server;
  let stop: (() => void) | undefined;
  let store: typeof import('../server/eventLog');
  let docker: typeof import('../server/sources/dockerLogs');
  beforeEach(async () => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-docker-'));
    vi.stubEnv('DATA_DIR', dir);
    vi.stubEnv('DOCKER_SOCKET_PATH', path.join(dir, 'docker.sock'));
    store = await import('../server/eventLog');
    docker = await import('../server/sources/dockerLogs');
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

  it('decodes split headers, streams, UTF-8 and levels; resumes without duplicates', async () => {
    const a = '2099-01-01T00:00:00.123456781Z';
    const b = '2099-01-01T00:00:00.123456782Z';
    const c = '2099-01-01T00:00:00.123456783Z';
    const requests: URL[] = [];
    server.on('request', (req, res) => {
      requests.push(new URL(req.url!, 'http://docker'));
      expect(req.method).toBe('GET');
      res.writeHead(200);
      if (requests.length === 1) {
        const bytes = Buffer.concat([frame(1, `${a} ready 🍿\n`), frame(2, `${b} WARNING low space\n`)]);
        // Includes mid-header, mid-body and multibyte UTF-8 boundaries.
        let i = 0;
        const send = () => {
          if (i === bytes.length) { res.end(); return; }
          res.write(bytes.subarray(i, ++i));
          setImmediate(send);
        };
        send();
      } else {
        res.write(Buffer.concat([frame(2, `${b} WARNING low space\n`), frame(2, `${c} fatal exception\n`)]));
      }
    });
    const before = Date.now();
    stop = docker.followContainer({ container: 'usenet-ultimate', source: 'uu' });
    await until(() => store.recentEvents().filter(e => e.eventType === 'container-log').length === 3);
    const logs = store.recentEvents().filter(e => e.eventType === 'container-log').reverse();
    expect(logs.map(e => [e.message, e.level, e.payload, e.source, e.device])).toEqual([
      ['ready 🍿', 'info', { container: 'usenet-ultimate', stream: 'stdout' }, 'uu', 'brain'],
      ['WARNING low space', 'warn', { container: 'usenet-ultimate', stream: 'stderr' }, 'uu', 'brain'],
      ['fatal exception', 'error', { container: 'usenet-ultimate', stream: 'stderr' }, 'uu', 'brain'],
    ]);
    expect(logs[0].ts).toBe('2099-01-01T00:00:00.123Z');
    expect(requests[0].pathname).toBe('/containers/usenet-ultimate/logs');
    for (const key of ['follow', 'stdout', 'stderr', 'timestamps']) expect(requests[0].searchParams.get(key)).toBe('1');
    expect(requests[0].searchParams.get('since')).toMatch(/^\d+\.\d{9}$/);
    expect(Number(requests[0].searchParams.get('since')) * 1000).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(requests[1].searchParams.get('since')).toBe(docker.dockerSince(b));
    expect(store.recentEvents().filter(e => e.eventType === 'source-down')).toHaveLength(1);
    expect(store.recentEvents().filter(e => e.eventType === 'source-up')).toHaveLength(1);
    stop();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'))['usenet-ultimate']).toBe(c);
  });

  it('reads plain TTY lines and persists checkpoints while running', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200);
      res.write('2099-02-01T01:02:03.000000001Z error tty output\n');
    });
    stop = docker.followContainer({ container: 'nzbdav', source: 'nzbdav' });
    await until(() => store.recentEvents().some(e => e.message === 'error tty output'));
    expect(store.recentEvents().find(e => e.message === 'error tty output')).toMatchObject({ level: 'error', source: 'nzbdav', payload: { stream: 'stdout' } });
    await until(() => fs.existsSync(path.join(dir, 'sources.json')), 6500);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8')).nzbdav).toBe('2099-02-01T01:02:03.000000001Z');
  }, 10000);

  it('loads saved timestamps, rejects HTTP error bodies and retries with backoff', async () => {
    // Module state is loaded lazily when following starts.
    const ts = '2099-03-01T00:00:00.000000001Z';
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ nzbdav: ts, unrelated: { keep: true } }));
    const since: string[] = [];
    server.on('request', (req, res) => {
      since.push(new URL(req.url!, 'http://docker').searchParams.get('since')!);
      if (since.length === 1) { res.writeHead(404); res.end('error must not become container output'); }
      else { res.writeHead(200); res.write(`${ts} duplicate\n2099-03-01T00:00:01.000000001Z recovered\n`); }
    });
    stop = docker.followContainer({ container: 'nzbdav', source: 'nzbdav' });
    await until(() => store.recentEvents().some(e => e.message === 'recovered'));
    expect(since).toEqual([docker.dockerSince(ts), docker.dockerSince(ts)]);
    expect(store.recentEvents().filter(e => e.eventType === 'container-log').map(e => e.message)).toEqual(['recovered']);
    stop();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8')).unrelated).toEqual({ keep: true });
  });

  it('replays a truncated frame and keeps large output bounded without losing text', async () => {
    const ts = '2099-04-01T00:00:00.000000001Z';
    const text = 'x'.repeat(150000);
    const requests: URL[] = [];
    server.on('request', (req, res) => {
      requests.push(new URL(req.url!, 'http://docker'));
      res.writeHead(200);
      const bytes = frame(1, `${ts} ${text}\n`);
      if (requests.length === 1) res.end(bytes.subarray(0, 100));
      else res.write(bytes);
    });
    stop = docker.followContainer({ container: 'nzbdav', source: 'nzbdav' });
    await until(() => store.recentEvents().filter(e => e.eventType === 'container-log').length === 3);
    const logs = store.recentEvents().filter(e => e.eventType === 'container-log').reverse();
    expect(logs.map(e => e.message).join('')).toBe(text);
    expect(logs.every(e => e.message.length <= 64 * 1024)).toBe(true);
    expect(requests[1].searchParams.get('since')).toBe(requests[0].searchParams.get('since'));
  });

  it('disables startup with DOCKER_LOGS=off', () => {
    vi.stubEnv('DOCKER_LOGS', 'off');
    const requests = vi.fn();
    server.on('request', requests);
    stop = docker.startDockerLogs();
    expect(requests).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'sources.json'))).toBe(false);
  });
});
