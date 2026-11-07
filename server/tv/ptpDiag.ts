/** New: no PTPDiag implementation exists in Manifexus (name search).
 * Collector lifecycle/checkpoint pattern adapted from tv/logcat.ts:33-177;
 * bounded commands reuse tv/adb.ts:7-40. */
import { record, subscribe, type Level } from '../eventLog';
import { checkpointSource, flushSourceState, loadSourceState } from '../sources/sourceState';
import { adbCommand, getAdbSerial } from './adb';
import { getDeviceLabels } from './devices';

const directory = '/sdcard/Android/data/com.arvio.tv/files/ptpdiag';
const maxLine = 10 * 1024 * 1024;
const readSize = 1024 * 1024;
const ids = new Map<string, true>();
const levels: Record<string, Level> = { d: 'info', i: 'info', w: 'warn', e: 'error' };
function raw(label: string, text: string, pulled = false) {
  record('warn', 'ptp-raw', text.slice(0, 512), { raw: text.slice(0, 4096), ...(pulled ? { pulled: true } : {}) },
    { source: 'ptp', device: label });
}
/** Returns false for incomplete/invalid JSON; records only after successful validation. */
function diagnostic(label: string, text: string, pulled = false): boolean {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.e !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(value.e) || typeof value.t !== 'number' ||
      !Number.isFinite(value.t) || !Number.isFinite(new Date(value.t).getTime())) return false;
  if (typeof value.id === 'string' && value.id.length <= 1024 && ids.has(value.id)) {
    ids.delete(value.id); ids.set(value.id, true); return true;
  }
  const fields = Object.entries(value).filter(([key, v]) => !['e', 't', 'seq', 'id', 'lvl'].includes(key) &&
    ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 3);
  const summary = [value.e, ...fields.map(([k, v]) => `${k.slice(0, 40)}=${String(v).slice(0, 80)}`)].join(' ');
  const level = typeof value.lvl === 'string' && Object.hasOwn(levels, value.lvl) ? levels[value.lvl] : 'info';
  record(level, `ptp-${value.e}`, summary,
    { ...value, ...(pulled ? { pulled: true } : {}) }, { source: 'ptp', device: label, ts: new Date(value.t).toISOString() });
  // Add only after write-ahead succeeds, so failed writes remain replayable.
  if (typeof value.id === 'string' && value.id.length <= 1024) {
    ids.set(value.id, true);
    if (ids.size > 50_000) ids.delete(ids.keys().next().value!);
  }
  return true;
}
function incomplete(text: string): boolean {
  let depth = 0, quoted = false, escaped = false;
  if (!text.trimStart().startsWith('{')) return false;
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return quoted || depth > 0;
}
/** One bounded join buffer per TV; only consecutive same-pid fragments can join. */
export class PtpDiagParser {
  private text = '';
  private pid?: number;
  private last = 0;
  constructor(private label: string) {}
  get pending() { return !!this.text; }
  expire() { if (this.pending && Date.now() - this.last >= 5000) this.flush(); }
  flush() { if (this.text) raw(this.label, this.text); this.text = ''; this.pid = undefined; }
  line(pid: number, text: string) {
    if (this.pid !== pid) this.flush();
    this.pid = pid;
    this.last = Date.now();
    this.text += text;
    if (this.text.length > maxLine) { this.flush(); return; }
    if (diagnostic(this.label, this.text)) { this.text = ''; this.pid = undefined; }
    else if (!incomplete(this.text)) this.flush();
  }
}
interface FileCursor { offset: number; size: number }
type Files = Record<string, FileCursor>;
/** Sequential, bounded byte reads. Only complete lines advance the durable offset. */
export async function pullPtpDiag(label: string, serial: string, signal: AbortSignal, missing?: () => void) {
  const command = (script: string, maxBytes = 64 * 1024, binary = false) => adbCommand(['-s', serial, 'shell', script], signal,
    { raw: true, maxBytes, nice: true, encoding: binary ? 'latin1' : 'utf8' });
  // The sentinel distinguishes an older app from permission/transport failures.
  const listing = await command(`if [ -d ${directory} ]; then ls -l ${directory}; else echo PTPDIAG_MISSING; fi`);
  if (signal.aborted) return;
  if (listing.trim() === 'PTPDIAG_MISSING') { missing?.(); return; }
  const key = `ptp-files:${label}`;
  const saved = loadSourceState()[key] as Files | undefined;
  const files: Files = {};
  let remaining = 20 * 1024 * 1024;
  const entries = listing.split('\n').flatMap(line => {
    const match = line.match(/^-\S+\s+(?:\d+\s+)?\S+\s+\S+\s+(\d+)\s+.*\s(ptpdiag-\d+\.jsonl)$/);
    return match && Number.isSafeInteger(Number(match[1])) ? [{ name: match[2], size: Number(match[1]) }] : [];
  }).slice(0, 5);
  for (const { name, size } of entries) {
    const old = saved?.[name];
    let offset = old && Number.isSafeInteger(old.offset) && old.offset >= 0 && old.offset <= size &&
      Number.isSafeInteger(old.size) && old.size <= size ? old.offset : 0;
    files[name] = { offset, size };
    let readOffset = offset;
    let pending = Buffer.alloc(0);
    while (readOffset < size && remaining > 0 && !signal.aborted) {
      const count = Math.min(readSize, size - readOffset, remaining);
      const text = await command(`tail -c +${readOffset + 1} ${directory}/${name} | head -c ${count}`, count + 4096, true);
      if (signal.aborted) return;
      const bytes = Buffer.from(text, 'latin1');
      if (bytes.length > count) throw new Error('PTPDiag read exceeded requested size');
      remaining -= bytes.length;
      readOffset += bytes.length;
      const buffer = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
        const line = buffer.subarray(start, end).toString('utf8');
        if (line.trim() && (end - start > maxLine || !diagnostic(label, line, true))) raw(label, line, true);
        start = end + 1;
      }
      offset += start;
      pending = Buffer.from(buffer.subarray(start));
      if (pending.length > maxLine) {
        raw(label, pending.toString('utf8'), true); offset = readOffset; pending = Buffer.alloc(0);
      }
      files[name] = { offset, size };
      checkpointSource(key, { ...saved, ...files });
      if (bytes.length < count) break;
    }
    files[name] = { offset, size };
  }
  if (!signal.aborted) checkpointSource(key, files);
}

/** Starts only from startServer; connection events trigger immediate recovery pulls. */
export function startPtpDiag(): () => void {
  const states = new Map<string, { serial?: string; controller?: AbortController; next: number; missing: boolean }>(
    getDeviceLabels().map(label => [label, { next: 0, missing: false }]));
  if (!states.size) return () => {};
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    for (const [label, state] of states) {
      const serial = getAdbSerial(label);
      if (state.serial !== serial) {
        state.controller?.abort(); state.controller = undefined;
        state.serial = serial; state.next = 0; state.missing = false;
      }
      if (!serial || state.controller || Date.now() < state.next) continue;
      const controller = new AbortController(); state.controller = controller;
      void pullPtpDiag(label, serial, controller.signal, () => {
        if (state.missing) return;
        state.missing = true;
        record('info', 'ptp-unavailable', `${label} PTPDiag directory not available`, undefined, { source: 'ptp', device: label });
      }).catch(error => {
        if (!controller.signal.aborted) record('warn', 'ptp-pull', `${label} PTPDiag pull failed`,
          { error: String(error) }, { source: 'ptp', device: label });
      }).finally(() => {
        if (state.controller === controller) { state.controller = undefined; state.next = Date.now() + 600_000; }
      });
    }
  };
  const unsubscribe = subscribe(({ event }) => {
    if (event.source !== 'adb' || !event.device) return;
    const state = states.get(event.device);
    if (!state) return;
    state.controller?.abort(); state.controller = undefined; state.serial = undefined; state.next = 0; state.missing = false;
    tick();
  });
  tick();
  const timer = setInterval(tick, 60_000); timer.unref();
  return () => { stopped = true; clearInterval(timer); unsubscribe();
    for (const state of states.values()) state.controller?.abort(); flushSourceState(); };
}
