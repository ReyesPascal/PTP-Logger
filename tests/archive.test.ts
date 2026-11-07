/** New: disposable rclone fixture for the new Drive archive worker. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

let dir: string;
let log: typeof import('../server/eventLog');
let archive: typeof import('../server/archive');
const now = Date.parse('2026-11-06T12:00:00Z');
const fake = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const [cmd, src, dst, ...flags] = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({cmd, src, dst, flags, config:process.env.RCLONE_CONFIG})+'\\n');
if (process.env.FAIL === cmd) { process.stderr.write('fixture failure'.repeat(1000)); process.exit(1); }
if (process.env.HANG === 'yes') { setInterval(() => {}, 1000); }
else {
  const root = path.join(process.env.REMOTE_DIR, dst.split(':')[1]);
  fs.mkdirSync(root, {recursive:true});
  if (cmd === 'copy') fs.copyFileSync(src, path.join(root, path.basename(src)));
  else if (cmd === 'check') {
    const name = flags[flags.indexOf('--include')+1].slice(1);
    if (!fs.readFileSync(path.join(src,name)).equals(fs.readFileSync(path.join(root,name)))) process.exit(2);
    if (process.env.MUTATE === 'yes') fs.writeFileSync(path.join(src,'events-2026-11-05-9.jsonl'), 'late arrival');
  } else process.exit(3);
}
`;
beforeEach(async () => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-archive-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('CALLS', path.join(dir, 'calls'));
  vi.stubEnv('REMOTE_DIR', path.join(dir, 'remote'));
  vi.stubEnv('RCLONE_REMOTE', 'fixture:custom/archive/');
  vi.stubEnv('RCLONE_CONFIG', path.join(dir, 'rclone.conf'));
  vi.stubEnv('RCLONE_BIN', path.join(dir, 'fake-rclone'));
  vi.stubEnv('FAIL', '');
  vi.stubEnv('HANG', '');
  vi.stubEnv('MUTATE', '');
  fs.writeFileSync(process.env.RCLONE_BIN!, fake, { mode: 0o700 });
  log = await import('../server/eventLog');
  archive = await import('../server/archive');
  fs.mkdirSync(log.LOG_DIR, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  log.closeLog();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(day: string, part = 1, gz = true) {
  const name = `events-${day}${part === 1 ? '' : '-' + part}.jsonl${gz ? '.gz' : ''}`;
  const file = path.join(log.LOG_DIR, name);
  fs.writeFileSync(file, gz ? gzipSync('fixture\n') : 'fixture\n');
  return file;
}
function calls(): Array<{ cmd: string; src: string; dst: string; flags: string[]; config: string }> {
  return fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
}
const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'archive.json'), 'utf8'));

describe('Drive archive', () => {
  it('uploads only fully compressed closed days, verifies sequential parts, persists and skips completed days', async () => {
    const files = [fixture('2026-11-05'), fixture('2026-11-05', 2)];
    fixture('2026-11-04'); fixture('2026-11-04', 2, false);
    fixture('2026-11-06'); fixture('2026-11-07');
    const pass = archive.archiveClosedDays(now);
    expect(archive.archiveClosedDays(now)).toBe(pass);
    await pass;
    expect(calls().map(c => c.cmd)).toEqual(['copy', 'check', 'copy', 'check']);
    for (const c of calls()) {
      expect(c.dst).toBe('fixture:custom/archive/2026-11/');
      expect(c.config).toBe(process.env.RCLONE_CONFIG);
      expect(c.flags).toEqual(expect.arrayContaining(['--transfers', '1', '--checkers', '1', '--buffer-size', '1M']));
      if (c.cmd === 'check') expect(c.flags).toEqual(expect.arrayContaining(['--one-way', '--download']));
    }
    expect(Object.keys(state())).toEqual(['2026-11-05']);
    expect(state()['2026-11-05']).toEqual({ files: files.map(f => path.basename(f)).reverse(), uploadedAt: expect.any(String) });
    for (const file of files) {
      expect(fs.readFileSync(path.join(dir, 'remote/custom/archive/2026-11', path.basename(file)))).toEqual(fs.readFileSync(file));
    }
    await archive.archiveClosedDays(now);
    expect(calls()).toHaveLength(4);
    expect(log.recentEvents()).toEqual([expect.objectContaining({ level: 'info', eventType: 'archive', source: 'logger' })]);
  });

  for (const failure of ['copy', 'check']) {
    it(`retains every local part and retries after ${failure} failure`, async () => {
      const files = [fixture('2026-11-05'), fixture('2026-11-05', 2)];
      vi.stubEnv('FAIL', failure);
      await archive.archiveClosedDays(now);
      expect(fs.existsSync(path.join(dir, 'archive.json'))).toBe(false);
      expect(files.every(f => fs.existsSync(f))).toBe(true);
      expect(log.recentEvents()[0]).toMatchObject({ level: 'error', eventType: 'archive', source: 'logger' });
      expect(JSON.stringify(log.recentEvents()[0]).length).toBeLessThan(5000);
      vi.stubEnv('FAIL', '');
      await archive.archiveClosedDays(now);
      expect(state()['2026-11-05'].files).toHaveLength(2);
    });
  }

  it('does not mark a day complete if backfilled data arrives during upload', async () => {
    fixture('2026-11-05');
    vi.stubEnv('MUTATE', 'yes');
    await archive.archiveClosedDays(now);
    expect(fs.existsSync(path.join(dir, 'archive.json'))).toBe(false);
    expect(log.recentEvents()[0]).toMatchObject({ level: 'error', payload: { error: 'Day changed during upload; will retry' } });
  });

  it('preserves prior state, including through a corrupt primary JSON recovery', async () => {
    const prior = { '2026-11-03': { files: ['events-2026-11-03.jsonl.gz'], uploadedAt: '2026-11-04T00:00:00Z' } };
    fs.writeFileSync(path.join(dir, 'archive.json.bak'), JSON.stringify(prior));
    fs.writeFileSync(path.join(dir, 'archive.json'), '{broken');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fixture('2026-11-05');
    await archive.archiveClosedDays(now);
    expect(state()['2026-11-03']).toEqual(prior['2026-11-03']);
    expect(state()['2026-11-05'].files).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('logs a missing executable without marking or removing the day', async () => {
    const file = fixture('2026-11-05');
    vi.stubEnv('RCLONE_BIN', path.join(dir, 'missing'));
    await archive.archiveClosedDays(now);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive.json'))).toBe(false);
    expect(log.recentEvents()[0]).toMatchObject({ level: 'error', eventType: 'archive' });
  });

  it('runs hourly with an unreferenced timer, stops and cancels an active child', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(now);
    const timers = vi.spyOn(globalThis, 'setInterval');
    vi.stubEnv('HANG', 'yes');
    fixture('2026-11-05');
    const stop = archive.startArchive();
    const pass = archive.archiveClosedDays(now);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(timers.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls()).toHaveLength(1);
    stop();
    await pass;
    expect(fs.existsSync(path.join(dir, 'archive.json'))).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls()).toHaveLength(1);
    expect(log.recentEvents()).toEqual([]);
    timers.mockRestore();
  });
});
