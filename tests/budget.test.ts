/** New: fake top output and verified serials; no real adb or TVs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ command: vi.fn(), filter: vi.fn(), log: vi.fn(),
  serials: {} as Record<string, string | undefined> }));
vi.mock('../server/tv/adb', () => ({ adbCommand: fixture.command, getAdbSerial: (label: string) => fixture.serials[label] }));
vi.mock('../server/tv/devices', () => ({ getDeviceLabels: () => Object.keys(fixture.serials) }));
vi.mock('../server/tv/logcat', () => ({ setLogcatThrottled: fixture.filter }));
vi.mock('../server/globalLogService', () => ({ globalLogService: { log: fixture.log } }));
import { parseTop, startBudget } from '../server/tv/budget';
const interval = 5 * 60_000;
const top = (cpu = 3) => `Tasks: 180 total\nPID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ ARGS
100 logd 20 0 2G 2048 1024 S ${cpu} 0.1 0:00.01 logd
101 shell 20 0 1G 1.5M 100 S ${cpu} 0.1 0:00.02 /system/bin/adbd --root_seclabel=u:r:su:s0
102 root 20 0 1G 1M 100 R 99 1 0:00.03 top -b -n 1`;
let stop: (() => void) | undefined;
const start = async () => { stop = startBudget(); await vi.advanceTimersByTimeAsync(0); };
const event = (type: string) => fixture.log.mock.calls.map(c => c[0]).filter(e => e.eventType === type);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  vi.stubEnv('TV_CPU_BUDGET', '5');
  fixture.serials = { hisense: '192.0.2.21:5555' };
  fixture.command.mockReset().mockResolvedValue(top()); fixture.filter.mockReset(); fixture.log.mockReset();
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('TV budget with fake top', () => {
  it('parses toybox units, toolbox headers, and sums matching processes only', () => {
    expect(parseTop(top())).toEqual({ logd: { cpuPercent: 3, rssBytes: 2097152 }, adbd: { cpuPercent: 3, rssBytes: 1572864 } });
    expect(parseTop(`PID PR CPU% S #THR VSS RSS PCY UID Name
1 20 1.5% S 1 100K 25K fg logd logd
2 20 2% S 1 100K 30K fg shell adbd`)).toEqual({
      logd: { cpuPercent: 1.5, rssBytes: 25600 }, adbd: { cpuPercent: 2, rssBytes: 30720 } });
    expect(parseTop(top().replace('S %CPU', 'S[%CPU]'))).toEqual(parseTop(top()));
    expect(parseTop(top() + '\n103 shell 20 0 1G 1M 100 S 1 0.1 0:00.02 adbd').adbd.cpuPercent).toBe(4);
  });
  it('rejects missing headers, missing processes, and invalid values', () => {
    for (const text of ['', 'unavailable', top().replace('logd\n', 'other\n'), top().replace('2048', 'bad'), top().replace('S 3 ', 'S NaN ')]) {
      expect(() => parseTop(text)).toThrow();
    }
  });
  it('samples immediately, records CPU and RSS, and throttles after exactly three high checks', async () => {
    await start();
    expect(fixture.command).toHaveBeenCalledWith(['-s', '192.0.2.21:5555', 'shell', 'top', '-b', '-n', '1'], expect.any(AbortSignal));
    expect(event('tv-budget')[0]).toMatchObject({ level: 'debug', source: 'tv', device: 'hisense', payload: { cpuPercent: 6, budgetPercent: 5 } });
    await vi.advanceTimersByTimeAsync(interval); expect(fixture.filter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(interval); expect(fixture.filter.mock.calls).toEqual([['hisense', true]]);
    await vi.advanceTimersByTimeAsync(3 * interval);
    expect(event('tv-throttle')).toHaveLength(1);
    expect(event('tv-throttle')[0].level).toBe('warn');
  });
  it('restores full capture only after 30 continuous minutes below half the budget', async () => {
    await start(); await vi.advanceTimersByTimeAsync(2 * interval);
    fixture.command.mockResolvedValue(top(1));
    await vi.advanceTimersByTimeAsync(6 * interval); expect(event('tv-unthrottle')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(interval);
    expect(fixture.filter.mock.calls).toEqual([['hisense', true], ['hisense', false]]);
    expect(event('tv-unthrottle')[0]).toMatchObject({ level: 'info', source: 'tv', device: 'hisense' });
    fixture.command.mockResolvedValue(top());
    await vi.advanceTimersByTimeAsync(3 * interval);
    expect(fixture.filter.mock.calls.at(-1)).toEqual(['hisense', true]);
  });
  it('resets high streaks on normal, failed, or missing samples, and honors a custom budget', async () => {
    vi.stubEnv('TV_CPU_BUDGET', '10'); fixture.command.mockResolvedValue(top(6));
    await start(); await vi.advanceTimersByTimeAsync(interval);
    fixture.command.mockResolvedValueOnce(top(5)); // Exactly the budget is not over it.
    await vi.advanceTimersByTimeAsync(interval);
    await vi.advanceTimersByTimeAsync(2 * interval); expect(fixture.filter).not.toHaveBeenCalled();
    fixture.command.mockRejectedValueOnce(new Error('offline')); await vi.advanceTimersByTimeAsync(interval);
    await vi.advanceTimersByTimeAsync(2 * interval); expect(fixture.filter).not.toHaveBeenCalled();
    fixture.command.mockResolvedValueOnce('bad top'); await vi.advanceTimersByTimeAsync(interval);
    await vi.advanceTimersByTimeAsync(3 * interval); expect(fixture.filter).toHaveBeenCalledWith('hisense', true);
  });
  it('resets recovery on threshold equality, failure, and disconnection', async () => {
    await start(); await vi.advanceTimersByTimeAsync(2 * interval);
    fixture.command.mockResolvedValue(top(1)); await vi.advanceTimersByTimeAsync(5 * interval);
    fixture.command.mockResolvedValueOnce(top(1.25)); // Exactly half is not below half.
    await vi.advanceTimersByTimeAsync(interval);
    await vi.advanceTimersByTimeAsync(5 * interval);
    fixture.command.mockRejectedValueOnce(new Error('offline')); await vi.advanceTimersByTimeAsync(interval);
    await vi.advanceTimersByTimeAsync(5 * interval);
    fixture.serials.hisense = undefined; await vi.advanceTimersByTimeAsync(interval);
    fixture.serials.hisense = '192.0.2.21:5555'; await vi.advanceTimersByTimeAsync(6 * interval);
    expect(event('tv-unthrottle')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(interval); expect(event('tv-unthrottle')).toHaveLength(1);
  });
  it('keeps TVs independent and skips disconnected TVs', async () => {
    fixture.serials.tcl = '192.0.2.22:5555'; fixture.serials.offline = undefined;
    fixture.command.mockImplementation(async (args: string[]) => top(args[1].includes('.21:') ? 3 : 1));
    await start(); await vi.advanceTimersByTimeAsync(2 * interval);
    expect(fixture.command).toHaveBeenCalledTimes(6);
    expect(fixture.filter.mock.calls).toEqual([['hisense', true]]);
  });
  it('does not overlap passes, aborts on stop, and ignores late results and stale addresses', async () => {
    let resolve!: (output: string) => void;
    fixture.command.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    const baseline = vi.getTimerCount(); await start();
    await vi.advanceTimersByTimeAsync(2 * interval); expect(fixture.command).toHaveBeenCalledTimes(1);
    fixture.serials.hisense = '192.0.2.31:5555'; resolve(top()); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(interval);
    const signal = fixture.command.mock.calls[1][1] as AbortSignal;
    stop!(); expect(signal.aborted).toBe(true);
    resolve(top()); await vi.advanceTimersByTimeAsync(10 * interval);
    expect(fixture.log).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(baseline);
  });
  it('is idle without configured TVs and defaults invalid budget values to 5', async () => {
    fixture.serials = {}; const baseline = vi.getTimerCount(); await start();
    expect(vi.getTimerCount()).toBe(baseline); expect(fixture.command).not.toHaveBeenCalled();
    fixture.serials = { hisense: '192.0.2.21:5555' }; vi.stubEnv('TV_CPU_BUDGET', 'bad');
    await start(); expect(event('tv-budget')[0].payload.budgetPercent).toBe(5);
  });
});
