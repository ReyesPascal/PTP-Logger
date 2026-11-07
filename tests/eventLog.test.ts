import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';

let dir: string;
let log: typeof import('../server/eventLog');
let servers: Server[];
beforeEach(async () => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-p0-'));
  process.env.DATA_DIR = path.join(dir, 'new-data');
  log = await import('../server/eventLog');
  servers = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  fs.rmSync(dir, { recursive: true, force: true }); // only disposable fixture data
});
async function api(app?: express.Express) {
  const { createApp } = await import('../server');
  const parent = app || express();
  parent.use(createApp());
  const server = parent.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
const seed = () => [
  log.record('debug', 'decoder', 'decoder warmup', { token: 'PRIVATE', url: 'http://192.168.4.27/key' }, { ts: '2026-11-05T23:59:59.999Z', device: 'hisense', source: 'tv-logcat' }),
  log.record('error', 'decoder', 'Decoder failed', { code: 'UniquePayload' }, { ts: '2026-11-06T00:00:00.000Z', device: 'tcl', source: 'tv-logcat' }),
  log.record('info', 'health', 'UU available', undefined, { ts: '2026-11-06T01:00:00.000Z', device: 'brain', source: 'uu' }),
];

describe('Manifexus event store adaptation', () => {
  it('writes ahead before subscription, flushes and reads back unchanged private payloads', async () => {
    let seen = false;
    const unsubscribe = log.subscribe(({ event }) => {
      const lines = fs.readFileSync(path.join(log.LOG_DIR, `events-${event.ts.slice(0, 10)}.jsonl`), 'utf8');
      expect(lines).toContain(event.id);
      seen = true;
    });
    const events = seed();
    unsubscribe();
    expect(seen).toBe(true);
    log.flush();
    const result = await log.queryEvents({});
    expect(result.events).toEqual([...events].reverse());
    expect(result.events[2].payload).toEqual({ token: 'PRIVATE', url: 'http://192.168.4.27/key' });
    expect(log.recentEvents(0)).toEqual([]);
  });
  it('uses UTC day filenames and millisecond timestamps, including offset input', () => {
    log.record('trace', 'fixture', 'offset', null, { ts: '2026-11-05T19:00:00-06:00' });
    log.flush();
    expect(log.listEventFiles().map(f => path.basename(f.file))).toEqual(['events-2026-11-06.jsonl']);
    expect(log.recentEvents()[0].ts).toBe('2026-11-06T01:00:00.000Z');
  });
  it('filters device/source/level/type/text/payload and inclusive from/to', async () => {
    const events = seed();
    for (const [query, expected] of [
      [{ device: 'hisense' }, [events[0]]], [{ source: 'uu' }, [events[2]]],
      [{ level: 'error' }, [events[1]]], [{ q: 'DECODER' }, [events[1], events[0]]],
      [{ q: 'uniquepayload' }, [events[1]]], [{ eventType: 'health' }, [events[2]]],
      [{ from: events[1].ts, to: events[1].ts }, [events[1]]],
      [{ source: 'uu', device: 'tcl' }, []],
    ] as const) expect((await log.queryEvents(query)).events).toEqual(expected);
  });
  it('continues 50 MB-style part splitting with a small fixture threshold, keeping every event', async () => {
    log.setPartMaxBytesForTest(1);
    const events = seed();
    log.record('warn', 'fixture', 'fourth', undefined, { ts: events[2].ts });
    log.flush();
    expect(log.listEventFiles().map(f => path.basename(f.file))).toEqual([
      'events-2026-11-06-3.jsonl', 'events-2026-11-06-2.jsonl', 'events-2026-11-06.jsonl', 'events-2026-11-05.jsonl',
    ]);
    expect((await log.queryEvents({})).events).toHaveLength(4);
  });
  it('resumes an existing part and isolates a torn crash line', async () => {
    fs.mkdirSync(log.LOG_DIR, { recursive: true });
    const file = path.join(log.LOG_DIR, 'events-2026-11-06-2.jsonl');
    fs.writeFileSync(file, '{"partial":');
    const ev = log.record('info', 'fixture', 'after crash', {}, { ts: '2026-11-06T01:00:00Z' });
    log.flush();
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\{"partial":\n/);
    expect((await log.queryEvents({})).events).toEqual([ev]);
  });
  it('sorts bounded pages even for late arrivals and same-ms sequence ties', async () => {
    const ts = '2026-11-06T01:00:00.000Z';
    const a = log.record('info', 'a', 'first', undefined, { ts });
    const b = log.record('info', 'b', 'second', undefined, { ts });
    const old = log.record('info', 'late', 'late arrival', undefined, { ts: '2026-11-06T00:00:00.000Z' });
    const page1 = await log.queryEvents({ limit: 1 });
    expect(page1.events).toEqual([b]);
    const page2 = await log.queryEvents({ limit: 1, before: page1.nextCursor });
    expect(page2.events).toEqual([a]);
    const page3 = await log.queryEvents({ limit: 1, before: page2.nextCursor });
    expect(page3.events).toEqual([old]);
    expect(page3.nextCursor).toBeUndefined();
  });
  it('has a 5000-event ring while keeping older events on disk', async () => {
    for (let i = 0; i < 5002; i++) log.record('trace', 'fixture', String(i));
    expect(log.recentEvents(6000)).toHaveLength(5000);
    expect((await log.queryEvents({ q: '"never"' })).events).toHaveLength(0);
    expect((await log.queryEvents({ limit: 1, q: '5001' })).events[0].message).toBe('5001');
    const lines = fs.readFileSync(log.listEventFiles()[0].file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5002);
    expect(JSON.parse(lines[0]).message).toBe('0');
  });
  it('defaults to 14/everything and persists updated settings outside logs', async () => {
    expect(log.getLogSettings()).toEqual({ retentionDays: 14, detail: 'everything' });
    expect(log.updateLogSettings({ retentionDays: 21 })).toEqual({ retentionDays: 21, detail: 'everything' });
    expect(JSON.parse(fs.readFileSync(path.join(log.DATA_DIR, 'settings.json'), 'utf8'))).toEqual(log.getLogSettings());
    expect(() => log.updateLogSettings({ retentionDays: NaN })).toThrow();
    log.closeLog();
    process.removeListener('beforeExit', log.flush);
    vi.resetModules();
    log = await import('../server/eventLog');
    expect(log.getLogSettings().retentionDays).toBe(21);
  });
  it('keeps all old files when retention settings change, with no deletion API/code', async () => {
    seed();
    const files = log.listEventFiles().map(f => ({ name: f.file, bytes: fs.readFileSync(f.file) }));
    log.updateLogSettings({ retentionDays: 1 });
    await log.queryEvents({});
    log.flush();
    for (const f of files) expect(fs.readFileSync(f.name).subarray(0, f.bytes.length)).toEqual(f.bytes);
    for (const file of ['server/eventLog.ts', 'server.ts', 'server/safeJson.ts']) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/);
    }
    const url = await api();
    expect((await fetch(url + '/api/logs/clear', { method: 'POST' })).status).toBe(404);
  });
  it('propagates disk failures before publishing and bounds pending retries', () => {
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => log.record('error', 'fixture', 'must survive')).toThrow('disk full');
    expect(() => log.record('error', 'fixture', 'not accepted')).toThrow('disk full');
    expect(listener).not.toHaveBeenCalled();
    expect(log.recentEvents()).toEqual([]);
    write.mockRestore();
    log.flush();
    const text = fs.readFileSync(log.listEventFiles()[0].file, 'utf8');
    expect(text).toContain('must survive');
    expect(text).not.toContain('not accepted');
    unsubscribe();
  });
  it('syncs the writer at least once per second', async () => {
    const sync = vi.spyOn(fs, 'fsyncSync');
    log.record('info', 'fixture', 'buffer sync');
    await new Promise(r => setTimeout(r, 1100));
    expect(sync).toHaveBeenCalled();
  });
});

describe('HTTP API on a random local port', () => {
  it('finds titles in messages and payloads within inclusive default and custom day windows', async () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const add = (age: number, message: string, payload?: unknown, source = 'docker') =>
      log.record('info', 'fixture', message, payload, { ts: new Date(now - age).toISOString(), source });
    const week = 7 * 86400000;
    const boundary = add(week, 'playing tt1234567');
    add(week + 1, 'old tt1234567');
    const payload = add(86400000, 'request', { title: { imdb: 'tt1234567' } }, 'tv-logcat');
    const latest = add(0, 'finished tt1234567', undefined, '__proto__');
    add(-1, 'future tt1234567');
    add(0, 'unrelated tt7654321');
    const url = await api();
    const result = await fetch(url + '/api/title/tt1234567').then(r => r.json());
    expect(result).toEqual({ events: [latest, payload, boundary], summary: {
      total: 3, bySource: { docker: 1, 'tv-logcat': 1, ['__proto__']: 1 }, byLevel: { info: 3 },
    } });
    const custom = await fetch(url + '/api/title/tt1234567?days=1').then(r => r.json());
    expect(custom.events).toEqual([latest, payload]);
    expect(custom.summary.total).toBe(2);
    expect(await fetch(url + '/api/title/tt9999999').then(r => r.json())).toEqual({
      events: [], summary: { total: 0, bySource: {}, byLevel: {} },
    });
  });
  it('returns only the newest 500 title matches while counting every match across sources and levels', async () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Multiple parts, same-ms ties, and a late arrival exercise disk ordering rather than ring order.
    log.setPartMaxBytesForTest(20000);
    const events = [];
    for (let i = 0; i < 502; i++) events.push(log.record(i % 2 ? 'error' : 'info', 'fixture', `tt1234567 ${i}`, undefined,
      { ts: new Date(now).toISOString(), source: i % 2 ? 'tv-logcat' : 'docker' }));
    log.record('warn', 'fixture', 'tt1234567 late', undefined, { ts: new Date(now - 86400000).toISOString(), source: 'brain' });
    const url = await api();
    const result = await fetch(url + '/api/title/tt1234567?limit=10000').then(r => r.json());
    expect(result.events).toEqual(events.slice(2).reverse());
    expect(result.summary).toEqual({ total: 503, bySource: { docker: 251, 'tv-logcat': 251, brain: 1 },
      byLevel: { info: 251, error: 251, warn: 1 } });
  });
  it('rejects malformed title IDs and invalid or repeated day ranges', async () => {
    const url = await api();
    for (const suffix of ['1234567', 'tt', 'tt123abc', 'TT1234567', 'tt1234567?days=',
      'tt1234567?days=0', 'tt1234567?days=-1', 'tt1234567?days=NaN', 'tt1234567?days=Infinity',
      'tt1234567?days=1e300', 'tt1234567?days=1&days=2', 'tt1234567?days[x]=1']) {
      const res = await fetch(url + '/api/title/' + suffix);
      expect(res.status, suffix).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });
  it('returns a chronological timeline across sources and days with inclusive default boundaries', async () => {
    const center = Date.parse('2026-11-06T00:00:00Z');
    const add = (offset: number, source: string, device: string) => log.record('info', 'fixture', String(offset), undefined,
      { ts: new Date(center + offset * 1000).toISOString(), source, device });
    const last = add(300, 'docker', 'brain');
    add(301, 'docker', 'brain');
    const first = add(-300, 'tv-logcat', 'tcl');
    add(-301, 'tv-logcat', 'tcl');
    const middle = add(0, 'uu', 'brain');
    const tie = add(0, 'docker', 'brain');
    const url = await api();
    const timeline = async (query: string) => fetch(url + '/api/timeline?' + query).then(r => r.json());
    const expected = [first, middle, tie, last];
    expect((await timeline('around=2026-11-06T00:00:00Z')).events).toEqual(expected);
    expect((await timeline(`around=${center}`)).events).toEqual(expected);
    expect((await timeline('around=2026-11-05T18:00:00-06:00')).events).toEqual(expected);
    expect((await timeline(`around=${center}&device=brain&source=docker`)).events).toEqual([tie, last]);
    expect((await timeline(`around=${center}&window=0`)).events).toEqual([middle, tie]);
    expect((await timeline(`around=${center}&window=0.5&source=missing`)).events).toEqual([]);
    const page = await timeline(`around=${center}&limit=2`);
    expect(page.events).toEqual([tie, last]);
    const older = await timeline(`around=${center}&limit=2&before=${encodeURIComponent(page.nextCursor)}`);
    expect(older.events).toEqual([first, middle]);
    expect(older.nextCursor).toBeUndefined();
  });
  it('rejects missing, malformed, repeated and out-of-range timeline parameters', async () => {
    const url = await api();
    for (const query of ['', 'around=', 'around=bad', 'around=2026-11-06', 'around=Infinity',
      'around=999999999999999999999', 'around=2026-99-99T00:00:00Z', 'around=0&window=NaN',
      'around=0&window=-1', 'around=0&window=', 'around=0&window=1e300',
      'around=0&around=1', 'around=0&window=1&window=2', 'around=0&device[x]=tcl',
      'around=0&source=a&source=b', 'around=0&limit=oops']) {
      const res = await fetch(url + '/api/timeline?' + query);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });
  it('paginates dense timelines without silently losing events above the store page cap', async () => {
    const ts = '2026-11-06T00:00:00.000Z';
    for (let i = 0; i < 5002; i++) log.record('info', 'fixture', String(i), undefined, { ts });
    const url = await api();
    const page = await fetch(url + '/api/timeline?around=' + ts).then(r => r.json());
    expect(page.events).toHaveLength(5000);
    expect(page.events[0].message).toBe('2');
    expect(page.events[4999].message).toBe('5001');
    const older = await fetch(url + '/api/timeline?around=' + ts + '&before=' + encodeURIComponent(page.nextCursor)).then(r => r.json());
    expect(older.events.map((e: { message: string }) => e.message)).toEqual(['0', '1']);
    expect(older.nextCursor).toBeUndefined();
  });
  it('serves health, normalized query filters and settings', async () => {
    seed();
    const url = await api();
    const health = await fetch(url + '/api/health').then(r => r.json());
    expect(health).toMatchObject({ ok: true, version: '0.1.0', dataDir: log.DATA_DIR });
    expect(health.uptimeS).toBeGreaterThanOrEqual(0);
    const result = await fetch(url + '/api/events?device=tcl&level=error&source=tv-logcat&from=2026-11-05T18:00:00-06:00').then(r => r.json());
    expect(result.events.map((e: { message: string }) => e.message)).toEqual(['Decoder failed']);
    const settings = await fetch(url + '/api/settings').then(r => r.json());
    expect(settings.retentionDays).toBe(14);
    const saved = await fetch(url + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 30 }) }).then(r => r.json());
    expect(saved.retentionDays).toBe(30);
    for (const query of ['level=nope', 'limit=oops', 'from=bad']) expect((await fetch(url + '/api/events?' + query)).status).toBe(400);
  });
  it('streams JSONL and quoted CSV with the same filters and no export cap', async () => {
    seed();
    log.record('warn', 'csv', 'line,"quoted"\nsecond', { key: 'secret' }, { source: 'uu' });
    const url = await api();
    const jsonl = await fetch(url + '/api/events/export?source=uu&format=jsonl').then(r => r.text());
    expect(jsonl.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(2);
    const csv = await fetch(url + '/api/events/export?source=uu&format=csv').then(r => r.text());
    expect(csv).toContain('id,ts,seq,level,device,source,eventType,message,payload\n');
    expect(csv).toContain('"line,""quoted""\nsecond"');
    expect(csv).toContain('"{""key"":""secret""}"');
    expect((await fetch(url + '/api/events/export?format=oops')).status).toBe(400);
  });
  it('delivers SSE only after disk append', async () => {
    const url = await api();
    const controller = new AbortController();
    const res = await fetch(url + '/api/stream', { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const event = log.record('info', 'fixture', 'streamed');
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(event.id);
    expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(event.id);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
  it('disconnects an SSE client above the 4 MB writable buffer threshold', async () => {
    let queued = 0;
    const parent = express();
    parent.use((_req, res, next) => { Object.defineProperty(res, 'writableLength', { get: () => queued }); next(); });
    const url = await api(parent);
    const res = await fetch(url + '/api/stream');
    const reading = res.text();
    queued = 4 * 1024 * 1024 + 1;
    log.record('info', 'fixture', 'slow reader');
    await expect(reading).rejects.toThrow();
  });
});
