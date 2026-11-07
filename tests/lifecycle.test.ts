import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Source launcher keeps npm test independent of pre-existing build output.
const launcher = `
  const { startServer } = await import('./server.ts');
  process.env.NODE_ENV = 'production';
  const server = await startServer();
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
  if (process.env.FIXTURE_EXIT === 'beforeExit') server.close();
`;
describe('real process lifecycle with disposable data', () => {
  for (const mode of ['SIGTERM', 'SIGINT', 'beforeExit'] as const) {
    it(`persists startup and shutdown for ${mode}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-lifecycle-'));
      fs.mkdirSync(path.join(dir, 'power'));
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', launcher], {
        cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dir, DOCKER_LOGS: 'off', DOCKER_EVENTS: 'off', JOURNAL: 'off', POWER_SUPPLY_DIR: path.join(dir, 'power'), PORT: '0', FIXTURE_EXIT: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      const exited = once(child, 'exit');
      try {
        const ready = new Promise<number>((resolve, reject) => {
          let output = '';
          child.stdout.on('data', chunk => {
            output += String(chunk);
            if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0]).port); } catch (err) { reject(err); } }
          });
          child.once('error', reject);
          child.once('exit', code => { if (code) reject(new Error(errors)); });
        });
        const port = await ready;
        if (mode !== 'beforeExit') {
          const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json());
          expect(health).toMatchObject({ ok: true, dataDir: dir });
          child.kill(mode);
        }
        const [code] = await exited;
        expect(errors).toBe('');
        expect(code).toBe(0);
        const lines = fs.readdirSync(path.join(dir, 'logs')).flatMap(file => fs.readFileSync(path.join(dir, 'logs', file), 'utf8').trim().split('\n'));
        const events = lines.map(line => JSON.parse(line)).filter(event => event.source === 'logger');
        expect(events.map(e => e.eventType)).toEqual(['startup', 'shutdown']);
        expect(events.every(e => e.source === 'logger')).toBe(true);
        expect(events[1].message).toContain(mode);
      } finally {
        if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
