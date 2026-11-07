import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';

let dir: string;
let log: typeof import('../server/eventLog');
let service: typeof import('../server/ingest');
let server: Server | undefined;
let stop: (() => void) | undefined;
const event = (id = 'one') => ({ id, ts: '2026-11-06T01:02:03-06:00', level: 'info', eventType: 'playback', message: 'Playing', payload: { title: 'tt123' } });
const batch = (id = 'one', device = 'tcl') => ({ device, events: [event(id)] });
const key = (device: string, id: string) => crypto.createHash('sha256').update(JSON.stringify([device, id])).digest('hex');
const stateFile = () => path.join(dir, 'data', 'ingest-ids.json');

beforeEach(async () => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-ingest-'));
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  log = await import('../server/eventLog');
  service = await import('../server/ingest');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stop?.(); stop = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  log.closeLog();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function api() {
  const { createApp } = await import('../server');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/ingest`;
  return (body: unknown, raw = false) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body as string : JSON.stringify(body),
  });
}

describe('PTP app ingest', () => {
  it('accepts the exact README curl example body', async () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const section = readme.split('## Ingest contract (PTP 1.0.3 sender)')[1]?.split('\n## ')[0];
    const body = section?.match(/<<'JSON'\n([\s\S]*?)\nJSON\n/)?.[1];
    expect(body, 'README ingest curl example must contain a JSON heredoc').toBeDefined();
    const post = await api();
    const response = await post(body!, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });
    const example = JSON.parse(body!);
    expect((await log.queryEvents({ source: 'ptp-app', device: example.device })).events).toEqual([
      expect.objectContaining({
        ts: example.events[0].ts, level: example.events[0].level,
        eventType: example.events[0].eventType, message: example.events[0].message,
        payload: example.events[0].payload,
      }),
    ]);
  });

  it('acks batches and device-scoped duplicates, including duplicates within a batch; writes before publishing', async () => {
    const post = await api();
    const seen: unknown[] = [];
    const unsubscribe = log.subscribe(({ event: stored }) => {
      expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain(stored.id);
      seen.push(stored);
    });
    expect(await (await post({ device: 'tcl', events: [event(), event(), event('two')] })).json()).toEqual({ accepted: 2, duplicates: 1 });
    expect(await (await post(batch())).json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(await (await post(batch('one', 'hisense'))).json()).toEqual({ accepted: 1, duplicates: 0 });
    unsubscribe();
    expect(seen).toHaveLength(3);
    expect((await log.queryEvents({ source: 'ptp-app', device: 'tcl' })).events).toHaveLength(2);
    expect(log.recentEvents()[0]).toMatchObject({
      ts: '2026-11-06T07:02:03.000Z', level: 'info', eventType: 'playback', message: 'Playing',
      source: 'ptp-app', device: 'hisense', payload: { title: 'tt123' },
    });
  });

  it('rejects invalid input before recording any of the batch', async () => {
    const post = await api();
    const invalid = [null, [], {}, { device: '', events: [] }, { device: 5, events: [] },
      { device: 'tcl', events: {} }, { device: 'tcl', events: Array(1001).fill(event()) }];
    for (const patch of [{ id: '' }, { id: 1 }, { ts: 'yesterday' }, { ts: 123 }, { ts: '2026-11-06' },
      { level: 'fatal' }, { level: null }, { eventType: '' }, { message: null }]) {
      invalid.push({ device: 'tcl', events: [event(), { ...event('bad'), ...patch }] });
    }
    invalid.push({ device: 'tcl', events: [null] });
    for (const body of invalid) expect((await post(body)).status).toBe(400);
    expect((await post('{broken', true)).status).toBe(400);
    expect(log.listEventFiles()).toEqual([]);
    expect(await (await post({ device: 'tcl', events: [] })).json()).toEqual({ accepted: 0, duplicates: 0 });
  });

  it('accepts 1000 events and bodies above 1 MB, rejects bodies above 2 MB with 400', async () => {
    const post = await api();
    const events = Array.from({ length: 1000 }, (_, i) => ({ ...event(String(i)), message: 'x'.repeat(1100) }));
    expect(await (await post({ device: 'tcl', events })).json()).toEqual({ accepted: 1000, duplicates: 0 });
    expect((await post({ device: 'tcl', events: [{ ...event('huge'), message: 'x'.repeat(2 * 1024 * 1024) }] })).status).toBe(400);
    expect((await log.queryEvents({ source: 'ptp-app', limit: 2000 })).events).toHaveLength(1000);
  });

  it('saves every 10 seconds, fsyncs events first, skips clean writes and reloads after restart', async () => {
    vi.useFakeTimers();
    stop = service.startIngest();
    service.ingest(batch());
    expect(fs.existsSync(stateFile())).toBe(false);
    const sync = vi.spyOn(log, 'flush');
    const rename = vi.spyOn(fs, 'renameSync');
    await vi.advanceTimersByTimeAsync(9999);
    expect(fs.existsSync(stateFile())).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toEqual([key('tcl', 'one')]);
    expect(sync).toHaveBeenCalled();
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rename).toHaveBeenCalledTimes(1);
    service.ingest(batch('two'));
    stop(); stop = undefined;
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toHaveLength(2);
    log.closeLog();
    vi.resetModules();
    log = await import('../server/eventLog');
    service = await import('../server/ingest');
    expect(service.ingest(batch())).toEqual({ accepted: 0, duplicates: 1 });
    expect(service.ingest(batch('two'))).toEqual({ accepted: 0, duplicates: 1 });
  });

  it('retains only the last 50,000 accepted device/id pairs with collision-safe encoding', () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(Array.from({ length: 50_000 }, (_, i) => key('tcl', String(i)))));
    expect(service.ingest(batch('0'))).toEqual({ accepted: 0, duplicates: 1 });
    expect(service.ingest(batch('new'))).toEqual({ accepted: 1, duplicates: 0 });
    expect(service.ingest(batch('1'))).toEqual({ accepted: 0, duplicates: 1 });
    expect(service.ingest(batch('0'))).toEqual({ accepted: 1, duplicates: 0 });
    expect(service.ingest(batch('b:c', 'a'))).toEqual({ accepted: 1, duplicates: 0 });
    expect(service.ingest(batch('c', 'a:b'))).toEqual({ accepted: 1, duplicates: 0 });
    service.startIngest()();
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toHaveLength(50_000);
  });

  it('does not dedupe failed record writes and retries failed state saves', async () => {
    const write = vi.spyOn(log, 'record').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => service.ingest(batch())).toThrow('disk full');
    write.mockRestore();
    expect(service.ingest(batch())).toEqual({ accepted: 1, duplicates: 0 });
    vi.useFakeTimers();
    stop = service.startIngest();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(report).toHaveBeenCalledOnce();
    expect(fs.existsSync(stateFile())).toBe(false);
    rename.mockRestore();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toEqual([key('tcl', 'one')]);
  });
});
