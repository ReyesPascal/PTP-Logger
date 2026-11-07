/** New: Manifexus has no adb connection/keepalive implementation to adapt. */
import { spawn } from 'node:child_process';
import { getDevice, getDeviceLabels } from './devices';
import { globalLogService } from '../globalLogService';

/** Bounded output, deadline and cancellation; no shell or mutating adb commands. */
export function adbCommand(args: string[], signal: AbortSignal, options: { raw?: boolean; maxBytes?: number; nice?: boolean; encoding?: 'utf8' | 'latin1' } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('ADB stopped')); return; }
    const bin = process.env.ADB_BIN || 'adb';
    const child = spawn(options.nice ? 'nice' : bin, options.nice ? ['-n', '10', bin, ...args] : args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else { const text = Buffer.concat(output).toString(options.encoding ?? 'utf8'); resolve(options.raw ? text : text.trim()); }
    };
    const abort = () => finish(new Error('ADB stopped'));
    const timer = setTimeout(() => finish(new Error('ADB command timed out')), 10_000);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    const read = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 64 * 1024)) { finish(new Error('ADB output limit exceeded')); return; }
      if (!settled) output.push(chunk);
    };
    child.stdout.on('data', read);
    // Drain stderr but never mix daemon startup diagnostics with get-state output.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 64 * 1024)) finish(new Error('ADB output limit exceeded'));
    });
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? undefined : new Error(`ADB exited with code ${code}`)));
  });
}

const connected = new Map<string, string>();
/** Current verified serial; collectors never initiate connections themselves. */
export function getAdbSerial(label: string): string | undefined { return connected.get(label); }

interface Connection { ip?: string; up?: boolean; running: boolean; next: number; backoff: number }
/** Start only from startServer. Per-TV serial commands; healthy TVs checked every 60 s. */
export function startAdb(): () => void {
  const labels = getDeviceLabels();
  if (!labels.length) return () => {};
  const controller = new AbortController();
  const states = new Map<string, Connection>(labels.map(label => [label, { running: false, next: 0, backoff: 2000 }]));
  const transition = (label: string, state: Connection, up: boolean) => {
    if (state.up === up || controller.signal.aborted) return;
    if (up && state.ip) connected.set(label, `${state.ip}:5555`);
    else connected.delete(label);
    globalLogService.log({ level: up ? 'info' : 'warn', eventType: up ? 'adb-up' : 'adb-down', source: 'adb',
      device: label, message: `${label} ADB ${up ? 'connected' : 'disconnected'}`, payload: { ip: state.ip } });
    state.up = up;
  };
  const run = async (label: string, state: Connection, ip: string) => {
    state.running = true;
    let up = false;
    try {
      if (!state.up) await adbCommand(['connect', `${ip}:5555`], controller.signal);
      up = await adbCommand(['-s', `${ip}:5555`, 'get-state'], controller.signal) === 'device';
    } catch { /* A failed command is a down state, including missing adb and timeouts. */ }
    finally { state.running = false; }
    if (controller.signal.aborted) return;
    transition(label, state, up);
    state.next = Date.now() + (up ? 60_000 : state.backoff);
    state.backoff = up ? 2000 : Math.min(60_000, state.backoff * 2);
  };
  const tick = () => {
    if (controller.signal.aborted) return;
    for (const [label, state] of states) {
      if (state.running) continue;
      const ip = getDevice(label)?.ip;
      if (ip !== state.ip) {
        if (state.up) transition(label, state, false);
        state.ip = ip;
        state.next = 0;
        state.backoff = 2000;
      }
      if (ip && Date.now() >= state.next) void run(label, state, ip);
    }
  };
  tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return () => { clearInterval(timer); controller.abort(); connected.clear(); };
}
