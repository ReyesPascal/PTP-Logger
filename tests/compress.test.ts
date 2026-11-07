import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

let dir: string;
let log: typeof import('../server/eventLog');
let compress: typeof import('../server/compress');
const now = Date.parse('2026-11-06T23:59:59Z');
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-compress-'));
  vi.stubEnv('DATA_DIR', dir);
  log = await import('../server/eventLog');
  compress = await import('../server/compress');
  fs.mkdirSync(log.LOG_DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  log.closeLog();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(day: string, part = 1, text?: string) {
  const ev = { id: `${day}-${part}`, ts: `${day}T12:00:00.000Z`, seq: part,
    level: 'info', eventType: 'fixture', message: 'fixture café', source: 'test' };
  const file = path.join(log.LOG_DIR, `events-${day}${part === 1 ? '' : '-' + part}.jsonl`);
  const content = text ?? JSON.stringify(ev) + '\n';
  fs.writeFileSync(file, content);
  return { ev, file, content };
}

describe('closed UTC day compression', () => {
  it('verifies all closed parts, leaves today and future untouched, and queries mixed formats', async () => {
    const first = fixture('2026-11-04');
    const second = fixture('2026-11-04', 2);
    const yesterday = fixture('2026-11-05');
    const today = fixture('2026-11-06');
    const future = fixture('2026-11-07');
    await compress.compressClosedDays(now);
    for (const f of [first, second, yesterday]) {
      expect(fs.existsSync(f.file)).toBe(false);
      expect(gunzipSync(fs.readFileSync(f.file + '.gz')).toString()).toBe(f.content);
    }
    for (const f of [today, future]) {
      // Compression's own diagnostic events may append to today's active log.
      expect(fs.readFileSync(f.file, 'utf8').startsWith(f.content)).toBe(true);
      expect(fs.existsSync(f.file + '.gz')).toBe(false);
    }
    expect(fs.readFileSync(future.file, 'utf8')).toBe(future.content);
    expect(log.listEventFiles().filter(f => f.gz)).toHaveLength(3);
    const ordered = [future.ev, today.ev, yesterday.ev, second.ev, first.ev];
    const one = await log.queryEvents({ eventType: 'fixture', limit: 2 });
    const two = await log.queryEvents({ eventType: 'fixture', limit: 2, before: one.nextCursor });
    const three = await log.queryEvents({ eventType: 'fixture', before: two.nextCursor });
    expect([...one.events, ...two.events, ...three.events]).toEqual(ordered);
    const scanned = [];
    for await (const ev of log.scanEvents({ source: 'test', from: '2026-11-04', to: '2026-11-05T23:59:59Z' })) scanned.push(ev);
    expect(scanned).toEqual([yesterday.ev, second.ev, first.ev]);
  });

  it('keeps JSONL when existing gzip is corrupt or has matching lines but different content', async () => {
    const corrupt = fixture('2026-11-04');
    const mismatch = fixture('2026-11-05');
    fs.writeFileSync(corrupt.file + '.gz', 'not gzip');
    fs.writeFileSync(mismatch.file + '.gz', gzipSync(mismatch.content.replace('café', 'wrong')));
    await compress.compressClosedDays(now);
    for (const f of [corrupt, mismatch]) expect(fs.readFileSync(f.file, 'utf8')).toBe(f.content);
    expect((await log.queryEvents({ eventType: 'fixture' })).events).toEqual([mismatch.ev, corrupt.ev]);
    expect(log.recentEvents().filter(e => e.eventType === 'compression')).toHaveLength(2);
    expect(log.recentEvents().every(e => e.level === 'error')).toBe(true);
    expect(fs.readdirSync(log.LOG_DIR).some(f => f.endsWith('.tmp'))).toBe(false);
  });

  it('recovers a verified duplicate after a crash without duplicate query results', async () => {
    const f = fixture('2026-11-05');
    fs.writeFileSync(f.file + '.gz', gzipSync(f.content));
    expect((await log.queryEvents({ source: 'test' })).events).toEqual([f.ev]);
    await compress.compressClosedDays(now);
    expect(fs.existsSync(f.file)).toBe(false);
    expect((await log.queryEvents({ source: 'test' })).events).toEqual([f.ev]);
  });

  it('streams large lines and preserves an unterminated last line and empty files', async () => {
    const large = fixture('2026-11-05', 1, 'x'.repeat(300_000) + '\nlast');
    const empty = fixture('2026-11-05', 2, '');
    const first = compress.compressClosedDays(now);
    expect(compress.compressClosedDays(now)).toBe(first);
    await first;
    for (const f of [large, empty]) expect(gunzipSync(fs.readFileSync(f.file + '.gz')).toString()).toBe(f.content);
    expect(log.recentEvents().filter(e => e.eventType === 'compression').map(e => e.payload)).toEqual([
      { day: '2026-11-05', part: 1, lines: 2 }, { day: '2026-11-05', part: 2, lines: 0 },
    ]);
  });

  it('keeps JSONL and removes temporary output if verification of newly written gzip fails', async () => {
    const f = fixture('2026-11-05');
    const read = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      if (String(file).endsWith('.tmp')) fs.writeFileSync(String(file), 'corrupt gzip');
      return read(file, options);
    });
    await compress.compressClosedDays(now);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.content);
    expect(fs.existsSync(f.file + '.gz')).toBe(false);
    expect(fs.readdirSync(log.LOG_DIR).some(f => f.endsWith('.tmp'))).toBe(false);
    expect(log.recentEvents()[0]).toMatchObject({ level: 'error', eventType: 'compression' });
  });

  it('propagates corrupt gzip read errors without hanging or unhandled stream errors', async () => {
    fs.writeFileSync(path.join(log.LOG_DIR, 'events-2026-11-05.jsonl.gz'), 'bad gzip');
    await expect(log.queryEvents({})).rejects.toThrow();
  });

  it('keeps a source that changes during compression', async () => {
    const f = fixture('2026-11-05');
    const read = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      if (String(file).endsWith('.tmp')) fs.appendFileSync(f.file, 'late arrival\n');
      return read(file, options);
    });
    await compress.compressClosedDays(now);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.content + 'late arrival\n');
    expect(fs.existsSync(f.file + '.gz')).toBe(false);
    expect(log.recentEvents()[0]).toMatchObject({ level: 'error', payload: { jsonlRetained: true } });
  });

  it('closes gzip streams on early generator return and abort', async () => {
    const f = fixture('2026-11-05');
    fs.writeFileSync(f.file + '.gz', gzipSync(f.content.repeat(2000)));
    fs.unlinkSync(f.file);
    const first = log.scanEvents({ source: 'test' });
    expect((await first.next()).value).toEqual(f.ev);
    await first.return(undefined);
    const controller = new AbortController();
    const second = log.scanEvents({ source: 'test' }, controller.signal);
    expect((await second.next()).value).toEqual(f.ev);
    controller.abort();
    expect((await second.next()).done).toBe(true);
  });

  it('reads published gzip if JSONL is removed after the directory snapshot', async () => {
    const f = fixture('2026-11-05');
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...args) => {
      if (String(file) === f.file) {
        fs.writeFileSync(f.file + '.gz', gzipSync(f.content));
        fs.unlinkSync(f.file);
      }
      return open(file, ...args);
    });
    expect((await log.queryEvents({ source: 'test' })).events).toEqual([f.ev]);
  });

  it('can append backfilled events after their original part has been compressed', async () => {
    const old = log.record('info', 'fixture', 'before compression', undefined, { ts: '2026-11-05T01:00:00Z' });
    await compress.compressClosedDays(now);
    const late = log.record('info', 'fixture', 'late', undefined, { ts: '2026-11-05T02:00:00Z' });
    expect((await log.queryEvents({ eventType: 'fixture' })).events).toEqual([late, old]);
    expect(log.listEventFiles().filter(f => f.day === '2026-11-05').map(f => [f.part, f.gz])).toEqual([[2, false], [1, true]]);
  });
});
