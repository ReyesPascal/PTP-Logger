/** TV-specific collector is new: Manifexus has no Android/ADB collector.
 * Error isolation copied from Manifexus server/observability.ts:43-49;
 * memory parsing copied from server/systemSpecs.ts:39-45, adapted to remote output.
 * Bounded command execution copied from this app's server/tv/adb.ts:6-41.
 */
import { spawn } from 'node:child_process';
import { getDevice, getDeviceLabels } from './devices';
import { globalLogService } from '../globalLogService';

/** Bounded output, deadline and cancellation; no shell or mutating adb commands. */
function command(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('ADB stopped')); return; }
    const child = spawn(process.env.ADB_BIN || 'adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(output.trim());
    };
    const abort = () => finish(new Error('ADB stopped'));
    const timer = setTimeout(() => finish(new Error('ADB command timed out')), 10_000);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    const read = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { finish(new Error('ADB output limit exceeded')); return; }
      if (!settled) output += chunk.toString('utf8');
    };
    child.stdout.on('data', read);
    // Drain stderr but never mix daemon startup diagnostics with get-state output.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) finish(new Error('ADB output limit exceeded'));
    });
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? undefined : new Error(`ADB exited with code ${code}`)));
  });
}

/** Start only from startServer; serial, nonoverlapping passes every ten minutes.
 * PTP_PKG must be the Android application ID; unset means version is unavailable.
 */
export function startSnapshots(): () => void {
  const labels = getDeviceLabels();
  if (!labels.length) return () => {};
  const pkg = process.env.PTP_PKG || '';
  // adb shell joins arguments remotely: only accept an Android package identifier.
  if (pkg && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(pkg)) {
    throw new Error('PTP_PKG must be an Android package identifier');
  }
  const controller = new AbortController();
  const { signal } = controller;
  let running = false;
  const run = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      for (const device of labels) {
        if (signal.aborted) break;
        const ip = getDevice(device)?.ip;
        if (!ip) continue;
        const args = ['-s', `${ip}:5555`];
        try {
          if (await command([...args, 'get-state'], signal) !== 'device') continue;
        } catch { continue; } // Offline/unauthorized TVs are handled by the keepalive collector.
        const errors: Record<string, string> = {};
        // Copied from environmentSnapshot's safe wrapper; preserve partial snapshots.
        const safe = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
          if (signal.aborted) return null;
          try { return await fn(); }
          catch (err) { errors[key] = (err as Error).message; return null; }
        };
        const shell = (script: string) => command([...args, 'shell', script], signal);
        const number = (value: string | undefined): number => {
          if (value === undefined || !Number.isFinite(Number(value))) throw new Error('Missing or invalid numeric value');
          return Number(value);
        };
        const uptimeSeconds = await safe('uptimeSeconds', async () =>
          number(/^(\d+(?:\.\d+)?)(?:\s|$)/.exec(await shell('cat /proc/uptime'))?.[1]));
        const wlan0 = await safe('wlan0', () => shell('ip addr show dev wlan0'));
        const eth0 = await safe('eth0', () => shell('ip addr show dev eth0'));
        const wifiRssiDbm = await safe('wifiRssiDbm', async () =>
          number(/\bRSSI\s*[:=]?\s*(-?\d+)/i.exec(await shell('dumpsys wifi | grep -m1 -i RSSI'))?.[1]));
        const ptpVersion = pkg ? await safe('ptpVersion', async () => {
          const output = await shell(`dumpsys package ${pkg} | grep -m1 versionName`);
          const version = /\bversionName=([^\s]+)/.exec(output)?.[1];
          if (!version) throw new Error('Missing versionName');
          return version;
        }) : null;
        const memAvailableBytes = await safe('memAvailableBytes', async () => {
          const txt = await shell('cat /proc/meminfo');
          // Remote memory only: never fall back to Brain's os.freemem().
          const kb = (key: string) => number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(txt)?.[1]) * 1024;
          return kb('MemAvailable');
        });
        if (!signal.aborted && getDevice(device)?.ip === ip) {
          globalLogService.log({ level: 'info', eventType: 'tv-snapshot', source: 'tv', device,
            message: `${device} TV snapshot`, payload: { ip, uptimeSeconds, addresses: { wlan0, eth0 },
              wifiRssiDbm, ptpPackage: pkg || null, ptpVersion, memAvailableBytes, errors } });
        }
      }
    } finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 10 * 60 * 1000);
  timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
