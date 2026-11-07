import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const { record, spawnProcess } = vi.hoisted(() => ({ record: vi.fn(), spawnProcess: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnProcess }));
vi.mock('../server/eventLog', () => ({ record }));
import { getPowerAlert, startBrainHost, watchJournal } from '../server/sources/brainHost';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}
let stop = () => {};
let dir: string;
async function settle() {
  // Real filesystem I/O can finish while interval/reconnect clocks stay controlled.
  await delay(75);
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  record.mockReset();
  spawnProcess.mockReset();
  vi.stubEnv('JOURNAL', 'off');
  dir = await mkdtemp(path.join(os.tmpdir(), 'brain-host-'));
});
afterEach(async () => { stop(); stop = () => {}; vi.useRealTimers(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe('journal collector', () => {
  it('launches the required journalctl command and flushes pending data on shutdown', () => {
    const child = fakeChild();
    spawnProcess.mockReturnValue(child);
    stop = watchJournal();
    expect(spawnProcess).toHaveBeenCalledWith('journalctl', ['-f', '-o', 'json', '--since', 'now'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.write(JSON.stringify({ MESSAGE: 'pending at stop' }));
    stop();
    expect(record.mock.calls[0]?.[2]).toBe('pending at stop');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0);
  });
  it('maps priorities, metadata and microsecond timestamps across chunk boundaries', () => {
    const child = fakeChild();
    stop = watchJournal(() => child as unknown as ChildProcess);
    const entries = ['0', '1', '2', '3', '4', '5', '6', '7', undefined].map(PRIORITY => JSON.stringify({ PRIORITY, MESSAGE: 'hello ✓', _SYSTEMD_UNIT: 'fixture.service', _PID: '42', __REALTIME_TIMESTAMP: '1735689600123456' }));
    const input = entries.join('\n') + '\n';
    child.stdout.write(input.slice(0, 23));
    child.stdout.write(input.slice(23));
    expect(record.mock.calls.map(c => c[0])).toEqual(['error', 'error', 'error', 'error', 'warn', 'info', 'info', 'info', 'info']);
    expect(record).toHaveBeenCalledWith('error', 'journal', 'hello ✓', { unit: 'fixture.service', pid: '42' }, { source: 'brain', device: 'brain', ts: '2025-01-01T00:00:00.123Z' });
  });
  it('preserves malformed/oversized input in bounded durable raw fragments', () => {
    const child = fakeChild();
    stop = watchJournal(() => child as unknown as ChildProcess);
    const huge = JSON.stringify({ MESSAGE: 'x'.repeat(180000) });
    child.stdout.write(huge + '\ninvalid json\n' + JSON.stringify({ MESSAGE: [104, 105], __REALTIME_TIMESTAMP: 'bad' }) + '\n');
    const fragments = record.mock.calls.filter(c => c[3]?.rawJson && c[2] !== 'invalid json');
    expect(fragments.map(c => c[2]).join('')).toBe(huge);
    expect(fragments.every(c => c[2].length <= 65536)).toBe(true);
    expect(record.mock.calls.at(-1)?.[2]).toBe('hi');
  });
  it('reconnects once on error+close with exponential backoff capped at 60 seconds', async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; });
    stop = watchJournal(spawn);
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const child = children.at(-1)!;
      child.emit('error', new Error('fixture unavailable'));
      child.emit('close', 1);
      const count = spawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(spawn).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(count + 1);
    }
    stop();
    expect(children.at(-1)!.kill).toHaveBeenCalledWith('SIGTERM');
    children.at(-1)!.emit('close', 0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(spawn).toHaveBeenCalledTimes(8);
  });
  it('flushes the last unterminated journal line on child exit', () => {
    const child = fakeChild();
    stop = watchJournal(() => child as unknown as ChildProcess);
    child.stdout.write(JSON.stringify({ MESSAGE: 'last' }));
    child.emit('close', 1);
    expect(record.mock.calls[0]?.[2]).toBe('last');
  });
  it('retries synchronous spawn failure and cancels pending reconnect on stop', async () => {
    const spawn = vi.fn(() => { throw new Error('missing journalctl'); });
    stop = watchJournal(spawn);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawn).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('power collector', () => {
  async function supply(name: string, fields: Record<string, string>) {
    await mkdir(path.join(dir, name), { recursive: true });
    for (const [field, value] of Object.entries(fields)) await writeFile(path.join(dir, name, field), value + '\n');
  }
  async function tick() { await vi.advanceTimersByTimeAsync(60000); await settle(); }
  it('records initial state and changes, alerts on AC loss/low battery, and clears on recovery', async () => {
    await supply('AC', { type: 'Mains', online: '1' });
    await supply('BAT0', { type: 'Battery', status: 'Charging', capacity: '70' });
    vi.stubEnv('POWER_SUPPLY_DIR', dir);
    const spawn = vi.fn();
    stop = startBrainHost({ spawnJournal: spawn });
    await settle();
    expect(spawn).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(getPowerAlert()).toBeNull();
    await tick();
    expect(record).toHaveBeenCalledTimes(1);
    await supply('AC', { online: '0' });
    await supply('BAT0', { status: 'Discharging' });
    await tick();
    expect(getPowerAlert()).toMatchObject({ level: 'warn', onBattery: true, capacity: 70 });
    await supply('BAT0', { capacity: '19' });
    await tick();
    expect(getPowerAlert()).toMatchObject({ level: 'error', capacity: 19 });
    expect(record.mock.calls.at(-1)?.slice(0, 3)).toEqual(['error', 'power', 'Brain battery low (19%)']);
    const copy = getPowerAlert()!; copy.level = 'warn';
    expect(getPowerAlert()?.level).toBe('error');
    await supply('AC', { online: '1' });
    await supply('BAT0', { status: 'Charging' });
    await tick();
    expect(getPowerAlert()).toBeNull();
    stop();
    const count = record.mock.calls.length;
    await tick();
    expect(record).toHaveBeenCalledTimes(count);
  });
  it('handles missing optional fields and invalid capacity without a false low battery alert', async () => {
    await supply('BAT0', { type: 'Battery', status: 'Discharging', capacity: 'broken' });
    stop = startBrainHost({ powerSupplyDir: dir });
    await settle();
    expect(getPowerAlert()).toMatchObject({ level: 'warn', capacity: undefined });
    await supply('BAT0', { capacity: '20' });
    await tick();
    expect(getPowerAlert()?.level).toBe('warn');
  });
  it('records a read failure once, retries each minute and records recovery', async () => {
    const missing = path.join(dir, 'missing');
    stop = startBrainHost({ powerSupplyDir: missing });
    await settle();
    expect(record).toHaveBeenCalledTimes(1);
    await tick();
    expect(record).toHaveBeenCalledTimes(1);
    await mkdir(missing);
    await tick();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.at(-1)?.[0]).toBe('info');
  });
});
