/** New: Manifexus has no rclone/Drive log archive worker. */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DATA_DIR, LOG_DIR, listEventFiles, record } from './eventLog';
import { readJsonSafe, writeJsonAtomic } from './safeJson';
import { isArchived, type ArchiveState } from './archiveState';
import { registerAlertSource } from './alerts';

export type { ArchiveState } from './archiveState';
const stateFile = path.join(DATA_DIR, 'archive.json');
let running: Promise<void> | undefined;
const minRetry = 5 * 60 * 1000;
const maxRetry = 6 * 60 * 60 * 1000;
let retry = minRetry;
let retryAt = 0;
let failing = false;

function archiveFailed(now: number, err: unknown, day?: string): void {
  failing = true;
  retryAt = now + retry;
  record('error', 'archive-fail', day ? `Archive failed for ${day}` : 'Archive pass failed', {
    day, error: err instanceof Error ? err.message : String(err), retryAt: new Date(retryAt).toISOString(),
  });
  // Copied from Manifexus server/observability.ts:129-133; archive retry bounds differ.
  retry = Math.min(retry * 2, maxRetry);
}

function rclone(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', '10', process.env.RCLONE_BIN || 'rclone', ...args,
      '--transfers', '1', '--checkers', '1', '--buffer-size', '1M'], {
      env: process.env, stdio: ['ignore', 'ignore', 'pipe'], signal,
      timeout: 30 * 60 * 1000, killSignal: 'SIGKILL',
    });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`rclone ${args[0]} failed (${killedBy || code}): ${error}`));
    });
  });
}

/** Shared, sequential pass; state is committed only after every part verifies. No local deletions. */
export function archiveClosedDays(now = Date.now(), signal?: AbortSignal): Promise<void> {
  if (running) return running;
  if (now < retryAt || signal?.aborted) return Promise.resolve();
  const started = Date.now();
  const failureTime = () => now + Math.max(0, Date.now() - started);
  running = archive(now, signal, failureTime).catch(err => {
    if (!signal?.aborted) archiveFailed(failureTime(), err);
  }).finally(() => { running = undefined; });
  return running;
}

async function archive(now: number, signal: AbortSignal | undefined, failureTime: () => number): Promise<void> {
  const state = readJsonSafe<ArchiveState>(stateFile, {});
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid archive state');
  const today = new Date(now).toISOString().slice(0, 10);
  const snapshot = listEventFiles();
  const days = [...new Set(snapshot.filter(f => f.day < today).map(f => f.day))].sort();
  for (const day of days) {
    if (signal?.aborted) return;
    const files = snapshot.filter(f => f.day === day);
    if (isArchived(day) || files.some(f => !f.gz)) continue;
    try {
      const destination = `${(process.env.RCLONE_REMOTE || 'ptpdrive:PTP-Logger-archive').replace(/\/+$/, '')}/${day.slice(0, 7)}/`;
      for (const file of files) {
        if (signal?.aborted) return;
        await rclone(['copy', file.file, destination], signal);
        // Download comparison works even when a remote cannot provide a compatible checksum.
        await rclone(['check', LOG_DIR, destination, '--include', `/${path.basename(file.file)}`,
          '--one-way', '--download'], signal);
      }
      if (signal?.aborted) return;
      const current = listEventFiles().filter(f => f.day === day);
      if (current.length !== files.length || current.some((f, i) =>
        f.file !== files[i].file || f.size !== files[i].size || f.mtime !== files[i].mtime)) {
        throw new Error('Day changed during upload; will retry');
      }
      const verifiedAt = new Date().toISOString();
      state[day] = {
        files: files.map(f => path.basename(f.file)), uploadedAt: verifiedAt, verifiedAt,
        verifiedFiles: files.map(f => ({ name: path.basename(f.file), size: f.size, mtime: f.mtime })),
      };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      writeJsonAtomic(stateFile, state);
      record('info', 'archive', `Archived ${day} to Drive`, { day, files: state[day].files });
    } catch (err) {
      delete state[day];
      if (signal?.aborted) return;
      archiveFailed(failureTime(), err, day);
      return;
    }
  }
  failing = false;
  retry = minRetry;
  retryAt = 0;
}

export function startArchive(): () => void {
  const controller = new AbortController();
  const unregister = registerAlertSource(() => failing ? [{
    id: 'archive:drive', level: 'error', source: 'logger', device: 'brain', message: 'Drive upload failing',
  }] : []);
  let nextPass = 0;
  const run = () => {
    const now = Date.now();
    if (controller.signal.aborted || running || now < (failing ? retryAt : nextPass)) return;
    nextPass = now + 60 * 60 * 1000;
    void archiveClosedDays(now, controller.signal);
  };
  run();
  const timer = setInterval(run, minRetry);
  timer.unref();
  return () => { clearInterval(timer); unregister(); controller.abort(); };
}
