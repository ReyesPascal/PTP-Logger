/** New: no Manifexus TV budget/top parser exists. Reuses bounded adbCommand. */
import { adbCommand, getAdbSerial } from './adb';
import { getDeviceLabels } from './devices';
import { setLogcatThrottled } from './logcat';
import { globalLogService } from '../globalLogService';

interface Usage { cpuPercent: number; rssBytes: number }
/** Android toybox and older toolbox top use different column names and RSS units. */
export function parseTop(output: string): Record<'adbd' | 'logd', Usage> {
  const result = { adbd: { cpuPercent: 0, rssBytes: 0 }, logd: { cpuPercent: 0, rssBytes: 0 } };
  let columns: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'PID') {
      columns = line.replace(/[\[\]]/g, ' ').trim().toUpperCase().split(/\s+/);
      continue;
    }
    if (!/^\d+$/.test(fields[0])) continue;
    const index = (...names: string[]) => columns.findIndex(c => names.includes(c));
    const name = fields[index('ARGS', 'CMD', 'COMMAND', 'NAME')]?.split('/').at(-1);
    if (name !== 'adbd' && name !== 'logd') continue;
    const cpu = Number(fields[index('%CPU', 'CPU%')]?.replace(/%$/, ''));
    const rss = /^(\d+(?:\.\d+)?)([KMGT]?)(?:I?B)?$/i.exec(fields[index('RES', 'RSS')] || '');
    if (!Number.isFinite(cpu) || cpu < 0 || !rss) throw new Error('Invalid top process usage');
    // Unsuffixed RES/RSS is KiB on Android top; explicit suffixes use binary units.
    const multiplier = rss[2] ? 1024 ** ('KMGT'.indexOf(rss[2].toUpperCase()) + 1) : 1024;
    result[name].cpuPercent += cpu;
    result[name].rssBytes += Number(rss[1]) * multiplier;
    seen.add(name);
  }
  // Missing processes must not look like zero CPU and falsely restore full logging.
  if (seen.size !== 2) throw new Error('Missing adbd/logd usage in top');
  return result;
}

/** Sequential, nonoverlapping checks; start only from startServer. */
export function startBudget(): () => void {
  const labels = getDeviceLabels();
  if (!labels.length) return () => {};
  const configured = Number(process.env.TV_CPU_BUDGET ?? 5);
  const budget = Number.isFinite(configured) && configured > 0 ? configured : 5;
  const controller = new AbortController();
  const states = new Map(labels.map(label => [label, { serial: '', high: 0, lowSince: undefined as number | undefined, throttled: false }]));
  let running = false;
  const run = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      for (const [device, state] of states) {
        if (controller.signal.aborted) break;
        const serial = getAdbSerial(device);
        if (serial !== state.serial) { state.high = 0; state.lowSince = undefined; state.serial = serial || ''; }
        if (!serial) continue;
        try {
          const usage = parseTop(await adbCommand(['-s', serial, 'shell', 'top', '-b', '-n', '1'], controller.signal));
          if (controller.signal.aborted || getAdbSerial(device) !== serial) continue;
          const cpuPercent = usage.adbd.cpuPercent + usage.logd.cpuPercent;
          const payload = { ...usage, cpuPercent, budgetPercent: budget };
          globalLogService.log({ level: 'debug', eventType: 'tv-budget', source: 'tv', device,
            message: `${device} logging resource usage`, payload });
          state.high = cpuPercent > budget ? state.high + 1 : 0;
          if (!state.throttled && state.high >= 3) {
            globalLogService.log({ level: 'warn', eventType: 'tv-throttle', source: 'tv', device,
              message: `${device} logcat reduced to info and above`, payload });
            state.throttled = true;
            setLogcatThrottled(device, true);
          }
          if (state.throttled && cpuPercent < budget / 2) {
            state.lowSince ??= Date.now();
            if (Date.now() - state.lowSince >= 30 * 60_000) {
              globalLogService.log({ level: 'info', eventType: 'tv-unthrottle', source: 'tv', device,
                message: `${device} full logcat restored`, payload });
              state.throttled = false;
              state.lowSince = undefined;
              setLogcatThrottled(device, false);
            }
          } else state.lowSince = undefined;
        } catch {
          // Failed/partial samples cannot count towards either sustained threshold.
          state.high = 0; state.lowSince = undefined;
        }
      }
    } finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 5 * 60_000);
  timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
