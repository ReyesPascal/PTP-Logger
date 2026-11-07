/** Journal reconnect/framing adapted from Manifexus server/observability.ts:119–173.
 * Power supply collection is new: Manifexus has no journal/sysfs collector. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { record, type Level } from '../eventLog';

const context = { source: 'brain', device: 'brain' };
const MAX_LINE = 64 * 1024;
export type PowerAlert = { level: 'warn' | 'error'; message: string; onBattery: boolean; capacity?: number };
let powerAlert: PowerAlert | null = null;
export function getPowerAlert(): PowerAlert | null { return powerAlert && { ...powerAlert }; }

type Supply = { name: string; type?: string; online?: string; status?: string; capacity?: number };
type Options = { spawnJournal?: () => ChildProcess; powerSupplyDir?: string };

export function watchJournal(spawnJournal: () => ChildProcess = () => spawn('journalctl', ['-f', '-o', 'json', '--since', 'now'], { stdio: ['ignore', 'pipe', 'pipe'] })) {
  let stopped = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 2000;
  let flushPending = () => {};
  const connect = () => {
    if (stopped) return;
    let reconnecting = false;
    let buf = '';
    let fragment = 0;
    let stderr = '';
    const raw = (message: string, partial: boolean) => {
      record('warn', 'journal', message, { rawJson: true, fragment: fragment++, continued: partial }, context);
    };
    const line = (value: string) => {
      if (fragment) { raw(value, false); fragment = 0; return; }
      if (!value.trim()) return;
      let e: Record<string, unknown>;
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected journal object');
        e = parsed;
      } catch { raw(value, false); fragment = 0; return; }
      const priority = Number(e.PRIORITY);
      const level: Level = Number.isFinite(priority) && priority >= 0 && priority <= 3 ? 'error' : priority === 4 ? 'warn' : 'info';
      const millis = Number(e.__REALTIME_TIMESTAMP) / 1000;
      const ts = e.__REALTIME_TIMESTAMP !== undefined && Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
        ? new Date(Math.floor(millis)).toISOString() : undefined;
      const message = Array.isArray(e.MESSAGE) && e.MESSAGE.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
        ? Buffer.from(e.MESSAGE).toString('utf8') : String(e.MESSAGE ?? '');
      record(level, 'journal', message, { unit: e._SYSTEMD_UNIT, pid: e._PID }, { ...context, ts });
      retry = 2000;
    };
    flushPending = () => {
      if (buf || fragment) line(buf);
      buf = '';
      fragment = 0;
    };
    const reconnect = () => {
      if (reconnecting || stopped) return;
      reconnecting = true;
      flushPending();
      record('warn', 'journal', 'journalctl stopped; reconnecting', { retryMs: retry, stderr }, context);
      timer = setTimeout(connect, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60000);
    };
    try { child = spawnJournal(); } catch (err) { stderr = String(err); reconnect(); return; }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stopped) return;
      // Consume chunks incrementally, preserving oversized JSON as durable raw fragments.
      let offset = 0;
      while (offset < chunk.length) {
        const nl = chunk.indexOf('\n', offset);
        const end = nl < 0 ? chunk.length : nl;
        const take = Math.min(end - offset, MAX_LINE - buf.length);
        buf += chunk.slice(offset, offset + take);
        offset += take;
        if (offset === end && nl >= 0) { line(buf); buf = ''; offset++; }
        else if (buf.length === MAX_LINE) { raw(buf, true); buf = ''; }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', err => { stderr = String(err); reconnect(); });
    child.once('close', reconnect);
  };
  connect();
  return () => {
    if (stopped) return;
    flushPending();
    stopped = true;
    if (timer) clearTimeout(timer);
    child?.kill('SIGTERM');
    // Escalate if a broken child ignores shutdown; the timer does not keep Node alive.
    const target = child;
    const killTimer = setTimeout(() => { if (target && target.exitCode === null && target.signalCode === null) target.kill('SIGKILL'); }, 2000);
    killTimer.unref();
    target?.once('close', () => clearTimeout(killTimer));
  };
}

export function startBrainHost(options: Options = {}) {
  let stopped = false;
  let busy = false;
  let previous: string | undefined;
  let failed = false;
  powerAlert = null;
  const dir = options.powerSupplyDir ?? process.env.POWER_SUPPLY_DIR ?? '/sys/class/power_supply';
  const stopJournal = process.env.JOURNAL === 'off' ? () => {} : watchJournal(options.spawnJournal);
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const supplies: Supply[] = [];
      for (const name of (await readdir(dir)).sort()) {
        const read = async (field: string) => {
          try { return (await readFile(path.join(dir, name, field), 'utf8')).trim(); }
          catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
        };
        const type = await read('type');
        const online = await read('online');
        const status = await read('status');
        const capacityText = await read('capacity');
        const number = capacityText === undefined ? NaN : Number(capacityText);
        const capacity = Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined;
        supplies.push({ name, type, online, status, capacity });
      }
      if (stopped) return;
      const batteries = supplies.filter(s => s.type === 'Battery');
      const ac = supplies.filter(s => s.type !== 'Battery' && s.online !== undefined);
      const onBattery = batteries.some(s => s.status === 'Discharging') || (ac.length > 0 && ac.every(s => s.online === '0'));
      const capacities = batteries.flatMap(s => s.capacity === undefined ? [] : [s.capacity]);
      const capacity = capacities.length ? Math.min(...capacities) : undefined;
      const alert: PowerAlert | null = onBattery ? {
        level: capacity !== undefined && capacity < 20 ? 'error' : 'warn',
        message: capacity !== undefined && capacity < 20 ? `Brain battery low (${capacity}%)` : 'Brain AC power lost',
        onBattery, capacity,
      } : null;
      const snapshot = JSON.stringify(supplies);
      if (snapshot !== previous || failed) {
        record(alert?.level ?? 'info', 'power', alert?.message ?? 'Brain power supply changed', { supplies, onBattery, capacity }, context);
        previous = snapshot;
      }
      powerAlert = alert;
      failed = false;
    } catch (err) {
      if (!stopped && !failed) {
        record('warn', 'power', 'Unable to read Brain power supplies', { error: String(err) }, context);
        failed = true;
      }
    } finally { busy = false; }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, 60000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); stopJournal(); };
}
