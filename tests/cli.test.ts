import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { build } from 'esbuild';

const exec = promisify(execFile);
let binaryDir: string;
let binary: string;
let dir: string;
let server: Server;
let url: string;
let log: typeof import('../server/eventLog');
let previousDataDir: string | undefined;
beforeAll(async () => {
  binaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-cli-bin-'));
  binary = path.join(binaryDir, 'ptp-log.cjs');
  await build({ entryPoints: ['bin/ptp-log'], outfile: binary, bundle: true, platform: 'node', format: 'cjs' });
});
afterAll(() => fs.rmSync(binaryDir, { recursive: true, force: true }));
beforeEach(async () => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-cli-'));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  log = await import('../server/eventLog');
  const { createApp } = await import('../server');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  log.closeLog();
  process.removeListener('beforeExit', log.flush);
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});
const cli = (args: string[], base = url) => exec(process.execPath, [binary, ...args], {
  env: { ...process.env, PTP_LOG_URL: base }, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
});
const jsonLines = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
function seed() {
  return [
    log.record('info', 'play', 'playing tt123', { secret: 'PAYLOAD_ONLY' }, { device: 'tcl', source: 'tv', ts: '2026-11-06T12:34:56.123Z' }),
    log.record('warn', 'probe-down', 'offline\nsecond\rline\x1b[31m', undefined, { device: 'brain', source: 'probe', ts: '2026-11-06T12:34:57.123Z' }),
    log.record('error', 'decoder', 'failed tt123', { code: 7 }, { device: 'tcl', source: 'tv', ts: '2026-11-06T12:34:58.123Z' }),
  ];
}

describe('built ptp-log CLI against createApp on a random port', () => {
  it('prints compact chronological tail output without payload and with safe single lines', async () => {
    seed();
    const { stdout, stderr } = await cli(['tail']);
    expect(stderr).toBe('');
    expect(stdout).toBe('12:34:56.123 I tcl/tv play: playing tt123\n12:34:57.123 W brain/probe probe-down: offline second line [31m\n12:34:58.123 E tcl/tv decoder: failed tt123\n');
    expect(stdout).not.toContain('PAYLOAD_ONLY');
  });
  it('honors count and all tail filters; JSON includes the complete original payload', async () => {
    const events = seed();
    const result = await cli(['tail', '-n', '1', '--device', 'tcl', '--source', 'tv', '--level', 'info', '--json']);
    expect(jsonLines(result.stdout)).toEqual([events[0]]);
    expect(jsonLines((await cli(['tail', '-n', '2', '--json'])).stdout)).toEqual(events.slice(1));
  });
  it('defaults to 20 events and handles empty results', async () => {
    expect((await cli(['tail'])).stdout).toBe('');
    for (let n = 0; n < 25; n++) log.record('info', 'fixture', String(n));
    const events = jsonLines((await cli(['tail', '--json'])).stdout);
    expect(events).toHaveLength(20);
    expect(events[0].message).toBe('5');
    expect(events[19].message).toBe('24');
  });
  it('queries around ISO and epoch times with default and explicit windows', async () => {
    const events = seed();
    const around = events[1].ts;
    expect(jsonLines((await cli(['around', around, '--json'])).stdout)).toEqual(events);
    expect(jsonLines((await cli(['around', String(Date.parse(around)), '0', '--json'])).stdout)).toEqual([events[1]]);
    expect((await cli(['around', '-1', '0', '--json'])).stdout).toBe('');
  });
  it('queries titles in the last seven days, preserving payloads and chronological order', async () => {
    const now = Date.now();
    log.record('info', 'old', 'tt123', undefined, { ts: new Date(now - 8 * 86400000).toISOString() });
    const first = log.record('info', 'play', 'matching tt123', undefined, { ts: new Date(now - 2000).toISOString() });
    log.record('info', 'other', 'tt999');
    const second = log.record('error', 'fail', 'payload match', { title: 'tt123' });
    expect(jsonLines((await cli(['title', 'tt123', '--json'])).stdout)).toEqual([first, second]);
  });
  it('merges warning/error alerts and caps the merged result at the newest 20', async () => {
    const events = [];
    for (let n = 0; n < 25; n++) events.push(log.record(n % 2 ? 'error' : 'warn', 'fixture', String(n)));
    log.record('info', 'not-alert', 'ignore');
    expect(jsonLines((await cli(['alerts', '--json'])).stdout)).toEqual(events.slice(5));
    expect((await cli(['alerts'])).stdout.split('\n').filter(Boolean)).toHaveLength(20);
  });
  it('prints health as compact text or complete JSON', async () => {
    const text = (await cli(['health'])).stdout;
    expect(text).toContain('ok=true version=');
    expect(text.trim().split('\n')).toHaveLength(1);
    const health = JSON.parse((await cli(['health', '--json'])).stdout);
    expect(health).toMatchObject({ ok: true, dataDir: dir, freeBytes: null });
  });
  it('writes large output completely when stdout applies backpressure', async () => {
    for (let n = 0; n < 100; n++) log.record('info', 'large', String(n), { data: 'x'.repeat(2000) });
    const events = jsonLines((await cli(['tail', '-n', '100', '--json'])).stdout);
    expect(events).toHaveLength(100);
    expect(events[99].payload.data).toHaveLength(2000);
  });
  it('shows usage and rejects invalid inputs with a nonzero exit code', async () => {
    expect((await cli(['--help'])).stdout).toContain('PTP_LOG_URL');
    for (const args of [[], ['--help']]) expect((await cli(args)).stderr).toBe('');
    for (const args of [
      ['unknown'], ['tail', '-n'], ['tail', '-n', '0'], ['tail', '-n', '5001'], ['tail', '-n', '1.5'],
      ['tail', '--level', 'fatal'], ['tail', '--device'], ['tail', '--bad'], ['tail', 'extra'],
      ['tail', '-n', '1', '-n', '2'], ['around'], ['title', '../bad'], ['health', '--source', 'tv'],
    ]) await expect(cli(args)).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('ptp-log:') });
  });
  it('reports API and connection failures without dumping stack traces', async () => {
    await expect(cli(['around', 'invalid'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('HTTP 400') });
    await expect(cli(['around', '2026-11-06T12:00:00Z', 'bad'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('HTTP 400') });
    await expect(cli(['health'], 'http://127.0.0.1:0')).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'ptp-log: fetch failed\n' });
  });
});
