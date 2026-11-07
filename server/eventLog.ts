/** Adapted from Manifexus activityLog.ts: event-only daily JSONL, writer, ring and queries. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { readJsonSafe, writeJsonAtomic } from './safeJson';

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error'];

export interface LogEvent {
  id: string;
  ts: string;
  seq: number;
  level: Level;
  eventType: string;
  message: string;
  source: string;
  device?: string;
  payload?: unknown;
}
export interface LogSettings { retentionDays: number; detail: 'everything' }
const DEFAULT_SETTINGS: LogSettings = { retentionDays: 14, detail: 'everything' };
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RING_SIZE = 5000;
let partMaxBytes = 50 * 1024 * 1024;
/** Only used by fixture tests; production always uses 50 MB parts. */
export function setPartMaxBytesForTest(bytes: number) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test-only part limit');
  partMaxBytes = bytes;
}
function ensureDir() { fs.mkdirSync(LOG_DIR, { recursive: true }); }
const savedSettings = readJsonSafe<unknown>(SETTINGS_FILE, DEFAULT_SETTINGS);
const loaded = savedSettings && typeof savedSettings === 'object' ? savedSettings as Partial<LogSettings> : DEFAULT_SETTINGS;
let settings: LogSettings = {
  retentionDays: typeof loaded.retentionDays === 'number' && Number.isFinite(loaded.retentionDays) && loaded.retentionDays >= 1 && loaded.retentionDays <= 3650 ? Math.round(loaded.retentionDays) : 14,
  detail: 'everything',
};
export function getLogSettings(): LogSettings { return { ...settings }; }
export function updateLogSettings(patch: Partial<LogSettings>): LogSettings {
  const next = { ...settings };
  if (patch.detail !== undefined && patch.detail !== 'everything') throw new Error('detail must be everything');
  if (patch.retentionDays !== undefined) {
    if (!Number.isFinite(patch.retentionDays) || patch.retentionDays < 1 || patch.retentionDays > 3650) throw new Error('retentionDays must be between 1 and 3650');
    next.retentionDays = Math.round(patch.retentionDays);
  }
  ensureDir();
  writeJsonAtomic(SETTINGS_FILE, next);
  settings = next;
  record('info', 'settings', 'Log settings changed', next);
  return getLogSettings();
}

const dayOf = (iso: string) => iso.slice(0, 10);

const partPath = (day: string, n: number) => path.join(LOG_DIR, n === 1 ? `events-${day}.jsonl` : `events-${day}-${n}.jsonl`);

/** The part being appended to: events-YYYY-MM-DD.jsonl, then -2, -3… as each reaches partMaxBytes. */
let writeTarget: { day: string; part: number } | undefined;

function currentFile(day: string): string {
  if (!writeTarget || writeTarget.day !== day) {
    // Continue the highest existing part for the day.
    const parts = listEventFiles().filter((f) => f.day === day).map((f) => f.part);
    const next = { day, part: parts.length ? parts.reduce((max, n) => Math.max(max, n), 1) : 1 };
    // Backfilled events must use a new part if the previous part is already compressed.
    if (parts.length && fs.existsSync(partPath(day, next.part) + '.gz')) next.part++;
    endWithNewline(partPath(day, next.part));
    writeTarget = next;
  }
  let file = partPath(day, writeTarget.part);
  try {
    if (fs.statSync(file).size >= partMaxBytes) {
      writeTarget.part++;
      file = partPath(day, writeTarget.part);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return file;
}

/** If the last process was killed mid-write, finish its partial line so it can't swallow the next event. */
function endWithNewline(file: string) {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (!size) return;
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    if (b[0] !== 0x0a) fs.appendFileSync(file, '\n');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The original bounded buffer is drained to disk before publication. Keep one open
// descriptor and fsync at least every second (and before changing day/part).
let buffer: Buffer[] = [];
let bufferFile: string | undefined;
let bufferDay = '';
let writer: { file: string; fd: number } | undefined;
function appendBuffered() {
  if (!buffer.length) return;
  ensureDir();
  const file = bufferFile ??= currentFile(bufferDay);
  if (writer?.file !== file) {
    if (writer) { fs.fsyncSync(writer.fd); fs.closeSync(writer.fd); writer = undefined; }
    writer = { file, fd: fs.openSync(file, 'a') };
  }
  while (buffer.length) {
    const bytes = buffer[0];
    let offset = 0;
    try {
      while (offset < bytes.length) offset += fs.writeSync(writer.fd, bytes, offset, bytes.length - offset);
    } catch (err) {
      // Fail closed: never publish an event that failed its write-ahead append.
      buffer[0] = bytes.subarray(offset);
      throw err;
    }
    buffer.shift();
  }
  bufferFile = undefined;
}
export function flush(): void {
  appendBuffered();
  if (writer) {
    fs.fsyncSync(writer.fd);
    if (bufferDay < new Date().toISOString().slice(0, 10)) {
      fs.closeSync(writer.fd);
      writer = undefined;
      writeTarget = undefined;
    }
  }
}
export function closeLog(): void {
  flush();
  if (writer) { fs.closeSync(writer.fd); writer = undefined; }
  clearInterval(flushTimer);
  process.removeListener('beforeExit', flush);
}
const flushTimer = setInterval(flush, 1000);
flushTimer.unref();
process.on('beforeExit', flush);

/** Event log files, newest first */
export function listEventFiles(): { file: string; day: string; part: number; size: number; mtime: number; gz: boolean }[] {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .map((f) => {
        const m = f.match(/^events-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl(\.gz)?$/);
        if (!m) return null;
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { file: path.join(LOG_DIR, f), day: m[1], part: m[2] ? parseInt(m[2], 10) : 1, size: st.size, mtime: st.mtimeMs, gz: Boolean(m[3]) };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => (a.day === b.day ? b.part - a.part : a.day < b.day ? 1 : -1));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

type Listener = (msg: { kind: 'event'; event: LogEvent }) => void;
const listeners = new Set<Listener>();
const ring: LogEvent[] = [];

function broadcast(msg: Parameters<Listener>[0]) {
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      // ignore
    }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let seq = 0;
export function record(
  level: Level,
  eventType: string,
  message: string,
  payload?: unknown,
  opts: { source?: string; device?: string; ts?: string } = {}
): LogEvent {
  if (buffer.length) flush(); // A failed append must drain before accepting another event.
  const ts = new Date(opts.ts || Date.now()).toISOString();
  const ev: LogEvent = {
    id: crypto.randomBytes(6).toString('hex'),
    ts,
    seq: ++seq,
    level,
    eventType,
    message,
    source: opts.source || 'logger',
    device: opts.device,
    payload,
  };
  const day = dayOf(ts);
  if (bufferDay && day !== bufferDay) flush();
  bufferDay = day;
  buffer.push(Buffer.from(JSON.stringify(ev) + '\n'));
  appendBuffered(); // Write ahead: subscribers only see events already appended to disk.
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  broadcast({ kind: 'event', event: ev });
  return ev;
}

export const log = {
  trace: (type: string, message: string, payload?: unknown) => record('trace', type, message, payload),
  debug: (type: string, message: string, payload?: unknown) => record('debug', type, message, payload),
  info: (type: string, message: string, payload?: unknown) => record('info', type, message, payload),
  warn: (type: string, message: string, payload?: unknown) => record('warn', type, message, payload),
  error: (type: string, message: string, payload?: unknown) => record('error', type, message, payload),
};
export function recentEvents(n = 200): LogEvent[] { return n <= 0 ? [] : ring.slice(-Math.min(n, RING_SIZE)).reverse(); }

export interface EventQuery {
  from?: string; to?: string; level?: Level; source?: string; device?: string;
  eventType?: string; q?: string; limit?: number; before?: string;
}
export function matches(ev: LogEvent, q: EventQuery, searchLower = q.q?.trim().toLowerCase()): boolean {
  if (q.level && ev.level !== q.level) return false;
  if (q.source && ev.source !== q.source) return false;
  if (q.device && ev.device !== q.device) return false;
  if (q.eventType && ev.eventType !== q.eventType) return false;
  if (q.from && ev.ts < q.from) return false;
  if (q.to && ev.ts > q.to) return false;
  if (searchLower && !`${ev.message} ${ev.eventType} ${ev.source} ${ev.device || ''} ${JSON.stringify(ev.payload ?? '')}`.toLowerCase().includes(searchLower)) return false;
  return true;
}
// id breaks ties across process restarts with the same timestamp and sequence.
export const cursorOf = (e: LogEvent) => `${e.ts}|${String(e.seq).padStart(12, '0')}|${e.id}`;
/** Files newest-first, lines streamed with bounded read buffers. Export uses this directly. */
export async function* scanEvents(q: EventQuery = {}, signal?: AbortSignal): AsyncGenerator<LogEvent> {
  flush();
  const fromDay = q.from ? dayOf(q.from) : undefined;
  const toDay = q.to ? dayOf(q.to) : undefined;
  const files = listEventFiles();
  const plainFiles = new Set(files.filter(f => !f.gz).map(f => f.file));
  for (const f of files) {
    // A crash between publishing gzip and removing JSONL must not duplicate events.
    if (f.gz && plainFiles.has(f.file.slice(0, -3))) continue;
    if (signal?.aborted) return;
    if (fromDay && f.day < fromDay) break;
    if ((toDay && f.day > toDay) || (q.before && f.day > q.before.slice(0, 10))) continue;
    let gz = f.gz;
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(f.file, 'r'); }
    catch (err) {
      // Compression may have published and removed JSONL since the directory snapshot.
      if (f.gz || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      handle = await fs.promises.open(f.file + '.gz', 'r');
      gz = true;
    }
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, signal });
    const gunzip = gz ? createGunzip() : undefined;
    const input = gunzip ?? stream;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    // Attach rejection handling immediately; pipeline propagates read and gunzip failures.
    const pumping = gunzip ? pipeline(stream, gunzip).catch(err => { input.destroy(err); }) : undefined;
    try {
      for await (const line of lines) {
        if (signal?.aborted) return;
        let ev: LogEvent;
        try { ev = JSON.parse(line); } catch { continue; } // preserve, but skip a torn crash line
        if (!ev || typeof ev.ts !== 'string' || typeof ev.id !== 'string' || !LEVELS.includes(ev.level)) continue;
        if (q.before && cursorOf(ev) >= q.before) continue;
        if (matches(ev, q)) yield ev;
      }
    } finally { lines.close(); stream.destroy(); input.destroy(); await pumping; }
  }
}
/** Manifexus query shape, with bounded top-N selection instead of whole-file reads. */
export async function queryEvents(q: EventQuery = {}): Promise<{ events: LogEvent[]; nextCursor?: string }> {
  const limit = Number.isFinite(q.limit) ? Math.min(Math.max(Math.floor(q.limit!), 1), 5000) : 300;
  const out: LogEvent[] = [];
  for await (const ev of scanEvents(q)) {
    if (out.length > limit && dayOf(ev.ts) < dayOf(out[out.length - 1].ts)) break;
    const key = cursorOf(ev);
    let lo = 0, hi = out.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cursorOf(out[mid]) > key) lo = mid + 1; else hi = mid; }
    if (lo <= limit) { out.splice(lo, 0, ev); if (out.length > limit + 1) out.pop(); }
  }
  const more = out.length > limit;
  const events = out.slice(0, limit);
  return { events, nextCursor: more ? cursorOf(events[events.length - 1]) : undefined };
}
