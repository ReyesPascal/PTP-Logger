/** New: PTPDiag fixtures; all adb commands are mocked, with no TV/daemon access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ command: vi.fn(), serial: undefined as string | undefined }));
vi.mock('../server/tv/adb', () => ({ adbCommand: fixture.command, getAdbSerial: () => fixture.serial }));
vi.mock('../server/tv/devices', () => ({ getDeviceLabels: () => ['hisense'] }));
let dir: string;
let log: typeof import('../server/eventLog');
let diag: typeof import('../server/tv/ptpDiag');
let state: typeof import('../server/sources/sourceState');
let stop: (() => void) | undefined;
let files: Record<string, Buffer>;
const json = (id: string, extra = {}) => JSON.stringify({ e: 'seek-start', t: 1794018355000, id, lvl: 'i', fromMs: 55000, toMs: 85000, ...extra });
const events = () => log.recentEvents().filter(e => e.source === 'ptp').reverse();
const pull = () => diag.pullPtpDiag('hisense', '192.0.2.21:5555', new AbortController().signal);
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-diag-')); vi.stubEnv('DATA_DIR', dir);
  fixture.serial = undefined; files = {};
  fixture.command.mockReset().mockImplementation(async (args: string[], signal: AbortSignal) => {
    if (signal.aborted) throw new Error('aborted');
    const script = args.at(-1)!;
    if (script.includes('ls -l')) return Object.entries(files).map(([name, bytes]) =>
      `-rw-rw---- 1 u0_a123 media_rw ${bytes.length} 2026-11-06 12:00 ${name}`).join('\n');
    const m = script.match(/tail -c \+(\d+) .*\/(ptpdiag-\d+\.jsonl) \| head -c (\d+)/)!;
    return files[m[2]].subarray(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[3])).toString('latin1');
  });
  log = await import('../server/eventLog'); diag = await import('../server/tv/ptpDiag');
  state = await import('../server/sources/sourceState');
});
afterEach(() => {
  stop?.(); stop = undefined; state.flushSourceState(); log.closeLog(); process.removeListener('beforeExit', log.flush);
  vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true });
});
describe('PTPDiag decoding', () => {
  it('joins long consecutive same-pid fragments, dedupes IDs across live/pulled events, and maps levels', async () => {
    const parser = new diag.PtpDiagParser('hisense');
    const text = json('split', { detail: '🍿'.repeat(2000) });
    parser.line(123, text.slice(0, 3500)); expect(events()).toHaveLength(0);
    parser.line(123, text.slice(3500, 7000)); parser.line(123, text.slice(7000));
    expect(parser.pending).toBe(false);
    parser.line(123, text);
    for (const lvl of ['d', 'i', 'w', 'e']) parser.line(123, json(lvl, { lvl }));
    files['ptpdiag-0.jsonl'] = Buffer.from(text + '\n' + json('pull') + '\n'); await pull();
    expect(events().map(e => e.level)).toEqual(['info', 'info', 'info', 'warn', 'error', 'info']);
    expect(events()[0]).toMatchObject({ eventType: 'ptp-seek-start', device: 'hisense', ts: '2026-11-07T02:25:55.000Z',
      message: expect.stringMatching(/^seek-start fromMs=55000 toMs=85000/), payload: JSON.parse(text) });
    expect(events().at(-1)?.payload).toMatchObject({ id: 'pull', pulled: true });
    expect(fs.readFileSync(log.listEventFiles()[0].file, 'utf8')).toContain('ptp-seek-start');
  });
  it('bounds deduplication to 50,000 IDs and refreshes recently seen IDs', () => {
    const spy = vi.spyOn(log, 'record').mockImplementation(() => undefined as never);
    try {
      const parser = new diag.PtpDiagParser('hisense');
      for (let id = 0; id < 50_000; id++) parser.line(1, json(String(id)));
      parser.line(1, json('0')); // Refresh the oldest entry.
      parser.line(1, json('50000')); // Evicts ID 1.
      parser.line(1, json('0'));
      expect(spy).toHaveBeenCalledTimes(50_001);
      parser.line(1, json('1'));
      expect(spy).toHaveBeenCalledTimes(50_002);
    } finally { spy.mockRestore(); }
  }, 30_000);
  it('does not join different pids; bounds invalid raw diagnostics and expires abandoned fragments', () => {
    const parser = new diag.PtpDiagParser('hisense');
    parser.line(1, '{"e":'); parser.line(2, json('other'));
    parser.line(2, 'not json' + 'x'.repeat(10000));
    parser.line(2, '{"e":'); vi.advanceTimersByTime(6000); parser.expire();
    expect(events().map(e => e.eventType)).toEqual(['ptp-raw', 'ptp-seek-start', 'ptp-raw', 'ptp-raw']);
    expect(events()[2].message.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(events()[2].payload).length).toBeLessThan(4200);
    parser.line(2, json('invalid-date', { t: 9e99 }));
    expect(events().at(-1)?.eventType).toBe('ptp-raw');
  });
});
describe('PTPDiag recovery pulls', () => {
  it('checkpoints byte offsets, retries partial UTF-8 lines, resumes after restart, and resets truncated files', async () => {
    const name = 'ptpdiag-0.jsonl';
    const first = Buffer.from(json('one', { title: '🍿' }) + '\n');
    const second = Buffer.from(json('two', { title: '🍿' }) + '\n');
    files[name] = Buffer.concat([first, second.subarray(0, second.length - 5)]);
    await pull();
    expect(events()).toHaveLength(1);
    expect(state.loadSourceState()['ptp-files:hisense']).toEqual({ [name]: { offset: first.length, size: files[name].length } });
    state.flushSourceState();
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
    expect(disk['ptp-files:hisense'][name].offset).toBe(first.length);
    files[name] = Buffer.concat([first, second]); await pull();
    expect(fixture.command.mock.calls.at(-1)?.[0].at(-1)).toContain(`tail -c +${first.length + 1}`);
    expect(events().at(-1)?.payload).toMatchObject({ id: 'two', title: '🍿', pulled: true });
    await pull();
    expect(fixture.command.mock.calls.at(-1)?.[0].at(-1)).toContain('ls -l');
    files[name] = Buffer.from(json('new') + '\n'); await pull();
    expect(fixture.command.mock.calls.at(-1)?.[0].at(-1)).toContain('tail -c +1 ');
    expect(events().at(-1)?.payload).toMatchObject({ id: 'new' });
    expect(fixture.command.mock.calls.every(c => c[2].nice === true && c[2].raw === true)).toBe(true);
    // Reload persisted checkpoints in a fresh module instance.
    state.flushSourceState(); vi.resetModules();
    const fresh = await import('../server/tv/ptpDiag');
    fixture.command.mockClear(); await fresh.pullPtpDiag('hisense', 'serial', new AbortController().signal);
    expect(fixture.command).toHaveBeenCalledTimes(1);
    (await import('../server/sources/sourceState')).flushSourceState();
    const freshLog = await import('../server/eventLog');
    freshLog.closeLog(); process.removeListener('beforeExit', freshLog.flush);
  });
  it('joins file lines across bounded byte reads without corrupting UTF-8', async () => {
    const text = json('large', { detail: '🍿'.repeat(300_000) });
    files['ptpdiag-0.jsonl'] = Buffer.from(text + '\n'); await pull();
    expect(events()).toHaveLength(1);
    expect(events()[0].payload).toMatchObject({ id: 'large', detail: '🍿'.repeat(300_000), pulled: true });
    expect(fixture.command).toHaveBeenCalledTimes(3);
    expect((state.loadSourceState()['ptp-files:hisense'] as any)['ptpdiag-0.jsonl'].offset).toBe(Buffer.byteLength(text) + 1);
  });
  it('caps a pull at 20 MB, keeps other source checkpoints, and never advances after an adb failure', async () => {
    const name = 'ptpdiag-1.jsonl';
    // Exact 1 MiB lines, with malformed JSON exercising the bounded raw path.
    files[name] = Buffer.from(('x'.repeat(1024 * 1024 - 1) + '\n').repeat(21));
    state.checkpointSource('docker', 'keep'); await pull();
    expect((state.loadSourceState()['ptp-files:hisense'] as any)[name].offset).toBe(20 * 1024 * 1024);
    expect(state.loadSourceState().docker).toBe('keep');
    fixture.command.mockRejectedValueOnce(new Error('offline'));
    await expect(pull()).rejects.toThrow('offline');
    expect((state.loadSourceState()['ptp-files:hisense'] as any)[name].offset).toBe(20 * 1024 * 1024);
    expect(events().every(e => e.message.length <= 512)).toBe(true);
  });
  it('pulls immediately on reconnect and every ten minutes, reports missing once per connect, and stops cleanly', async () => {
    fixture.command.mockResolvedValue('PTPDIAG_MISSING\n');
    const baseline = vi.getTimerCount(); stop = diag.startPtpDiag();
    expect(fixture.command).not.toHaveBeenCalled();
    fixture.serial = 'serial'; log.record('info', 'adb-up', 'up', undefined, { source: 'adb', device: 'hisense' });
    await vi.advanceTimersByTimeAsync(0); expect(fixture.command).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000); expect(fixture.command).toHaveBeenCalledTimes(2);
    expect(events().filter(e => e.eventType === 'ptp-unavailable')).toHaveLength(1);
    fixture.serial = undefined; log.record('warn', 'adb-down', 'down', undefined, { source: 'adb', device: 'hisense' });
    fixture.serial = 'serial'; log.record('info', 'adb-up', 'up', undefined, { source: 'adb', device: 'hisense' });
    await vi.advanceTimersByTimeAsync(0); expect(fixture.command).toHaveBeenCalledTimes(3);
    expect(events().filter(e => e.eventType === 'ptp-unavailable')).toHaveLength(2);
    stop(); stop = undefined;
    await vi.advanceTimersByTimeAsync(1_200_000); expect(fixture.command).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
