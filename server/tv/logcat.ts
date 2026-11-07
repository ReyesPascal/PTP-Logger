/** New: no Manifexus logcat implementation exists. Streaming/checkpoints adapted
 * from sources/dockerLogs.ts:45-150; commands reuse tv/adb.ts:7-40. */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { record, type Level } from '../eventLog';
import { checkpointSource, flushSourceState, loadSourceState } from '../sources/sourceState';
import { adbCommand, getAdbSerial } from './adb';
import { getDeviceLabels } from './devices';

type LogcatProcess = ChildProcessByStdio<null, Readable, Readable>;
interface Cursor { ts: string; count: number; boot?: string }
interface Capture {
  cursor: Cursor; serial?: string; controller?: AbortController;
  child?: LogcatProcess; next: number; retry: number;
}
const levels: Record<string, Level> = { V: 'debug', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'error' };
const epoch = (s: string) => /^\d{1,12}\.\d{1,9}$/.test(s) ? BigInt(s.split('.')[0]) * 1_000_000_000n + BigInt(s.split('.')[1].padEnd(9, '0')) : undefined;
const now = () => (Date.now() / 1000).toFixed(6);
function savedCursor(label: string): Cursor {
  const saved = loadSourceState()[`tv-logcat:${label}`] as Cursor | undefined;
  return saved && typeof saved.ts === 'string' && epoch(saved.ts) !== undefined &&
    Number.isSafeInteger(saved.count) && saved.count >= 0 ?
    { ts: saved.ts, count: saved.count, boot: typeof saved.boot === 'string' ? saved.boot : undefined } : { ts: now(), count: 0 };
}

/** One stream per verified ADB connection. All buffers and retries are bounded. */
export function startLogcat(): () => void {
  const states = new Map<string, Capture>(getDeviceLabels().map(label =>
    [label, { cursor: savedCursor(label), next: 0, retry: 2000 }]));
  if (!states.size) return () => {};
  let stopped = false;
  const checkpoint = (label: string, state: Capture) => checkpointSource(`tv-logcat:${label}`, { ...state.cursor });
  const cancel = (state: Capture) => {
    state.controller?.abort();
    state.controller = undefined;
    state.child?.kill('SIGKILL');
    state.child = undefined;
  };
  const connect = async (label: string, state: Capture, serial: string) => {
    const controller = new AbortController();
    state.controller = controller;
    let child: LogcatProcess | undefined;
    let failed = false;
    const lost = (error?: unknown) => {
      if (failed || stopped || controller.signal.aborted) return;
      failed = true;
      cancel(state);
      state.next = Date.now() + state.retry;
      state.retry = Math.min(60_000, state.retry * 2);
      record('warn', 'source-down', `${label} logcat disconnected`,
        { error: error instanceof Error ? error.message : String(error ?? 'stream closed') }, { source: 'tv-logcat', device: label });
    };
    try {
      const boot = await adbCommand(['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id'], controller.signal);
      if (stopped || controller.signal.aborted) return;
      if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(boot)) throw new Error('Invalid TV boot id');
      if (state.cursor.boot && state.cursor.boot !== boot) {
        record('info', 'tv-reboot', `${label} rebooted`, { previousBootId: state.cursor.boot, bootId: boot }, { source: 'tv-logcat', device: label });
        // A reboot may move the wall clock backwards. Read all available logs.
        state.cursor = { ts: '0.000000', count: 0, boot };
      } else state.cursor.boot = boot;
      checkpoint(label, state);
      child = spawn(process.env.ADB_BIN || 'adb', ['-s', serial, 'logcat', '-v', 'epoch,uid,printable', '-T', state.cursor.ts],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      state.child = child;
      // logcat replays inclusively. Count records at the boundary (including
      // identical lines) instead of dropping every line with the same timestamp.
      const boundary = epoch(state.cursor.ts)!;
      let remaining = state.cursor.count;
      const decoder = new StringDecoder('utf8');
      let text = '';
      let header: { ts: string; uid: string; pid: number; tag: string; level: Level } | undefined;
      const emit = (final: boolean) => {
        let message = text;
        if (!header) {
          // epoch,uid includes uid, pid and tid. UID may be numeric or a name.
          const m = message.match(/^\s*(\d+\.\d+)\s+(\S+)\s+(\d+)\s+\d+\s+([VDIWEF])\s+([^:]*): ?/);
          if (!m || epoch(m[1]) === undefined) { text = ''; return; }
          header = { ts: m[1], uid: m[2], pid: Number(m[3]), level: levels[m[4]], tag: m[5].trim() };
          message = message.slice(m[0].length);
        }
        const key = epoch(header.ts)!;
        if (key >= epoch(state.cursor.ts)!) {
          if (key === boundary && remaining > 0) remaining--;
          else {
            record(header.level, 'logcat', message, { tag: header.tag, pid: header.pid, uid: header.uid },
              { source: 'tv-logcat', device: label, ts: new Date(Number(key / 1_000_000n)).toISOString() });
            state.retry = 2000;
            state.cursor.count = key === epoch(state.cursor.ts) ? state.cursor.count + 1 : 1;
            state.cursor.ts = header.ts;
            checkpoint(label, state);
          }
        }
        text = '';
        if (final) header = undefined;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed || controller.signal.aborted) return;
        try {
          const decoded = decoder.write(chunk);
          let offset = 0;
          while (offset < decoded.length) {
            const nl = decoded.indexOf('\n', offset);
            const end = nl < 0 ? decoded.length : nl;
            const take = Math.min(end - offset, 64 * 1024 - text.length);
            text += decoded.slice(offset, offset + take);
            offset += take;
            if (offset === nl) { if (text.endsWith('\r')) text = text.slice(0, -1); emit(true); offset++; }
            else if (text.length === 64 * 1024) emit(false);
          }
        } catch (error) { lost(error); }
      });
      // Drain diagnostics without buffering; adb failures are retried on close.
      child.stderr.on('data', () => {});
      child.stdout.on('error', lost);
      child.stderr.on('error', lost);
      child.once('error', lost);
      child.once('close', () => lost());
      // Incomplete trailing lines are replayed; never checkpoint an unseen suffix.
    } catch (error) { lost(error); }
  };
  const tick = () => {
    if (stopped) return;
    for (const [label, state] of states) {
      const serial = getAdbSerial(label);
      if (serial !== state.serial) {
        cancel(state);
        state.serial = serial;
        state.next = 0;
        state.retry = 2000;
      }
      if (serial && !state.controller && Date.now() >= state.next) void connect(label, state, serial);
    }
  };
  tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const state of states.values()) cancel(state);
    flushSourceState();
  };
}
