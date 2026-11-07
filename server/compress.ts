/** New: Manifexus has no streaming gzip event-log compactor. */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { constants, createGzip, createGunzip } from 'zlib';
import { flush, listEventFiles, LOG_DIR, record } from './eventLog';

// Count bytes, LF delimiters and a possible final unterminated line without buffering lines.
function counter() {
  let lines = 0, bytes = 0, last = -1;
  const hash = createHash('sha256');
  return {
    add(chunk: Buffer) {
      hash.update(chunk);
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
      if (chunk.length) last = chunk[chunk.length - 1];
    },
    result: () => ({ lines: lines + (bytes && last !== 10 ? 1 : 0), bytes, hash: hash.digest('hex') }),
  };
}

async function countFile(file: string, gz: boolean) {
  const count = counter();
  const sink = new Writable({ write(chunk, _encoding, done) { count.add(chunk); done(); } });
  const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  if (gz) await pipeline(source, createGunzip(), sink);
  else await pipeline(source, sink);
  return count.result();
}

function syncDirectory() {
  const fd = fs.openSync(LOG_DIR, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

let running: Promise<void> | undefined;
/** Closed UTC days only. Concurrent callers share one sequential, bounded-memory pass. */
export function compressClosedDays(now = Date.now()): Promise<void> {
  if (running) return running;
  running = compress(now).finally(() => { running = undefined; });
  return running;
}

async function compress(now: number): Promise<void> {
  flush();
  const today = new Date(now).toISOString().slice(0, 10);
  for (const file of listEventFiles()) {
    if (file.gz || file.day >= today) continue;
    const target = file.file + '.gz';
    const temp = target + `.${process.pid}.${randomUUID()}.tmp`;
    let tempCreated = false;
    try {
      const before = fs.statSync(file.file);
      let original: Awaited<ReturnType<typeof countFile>>;
      const existing = fs.existsSync(target);
      if (existing) {
        // Recover a crash after gzip publication; never trust an existing archive blindly.
        original = await countFile(file.file, false);
      } else {
        const count = counter();
        const meter = new Transform({ transform(chunk, _encoding, done) {
          count.add(chunk);
          // Yield between bounded chunks; fast zlib in its worker avoids monopolizing CPU.
          setImmediate(() => done(null, chunk));
        } });
        const output = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
        tempCreated = true;
        await pipeline(fs.createReadStream(file.file, { highWaterMark: 64 * 1024 }), meter,
          createGzip({ level: constants.Z_BEST_SPEED }), output);
        original = count.result();
      }
      const verified = await countFile(existing ? target : temp, true);
      if (verified.lines !== original.lines || verified.bytes !== original.bytes || verified.hash !== original.hash) {
        throw new Error('Gzip verification failed: source and decompressed content differ');
      }
      const fd = fs.openSync(existing ? target : temp, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const after = fs.statSync(file.file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
        throw new Error('Source changed during gzip compression');
      }
      // No asynchronous gap from the final source check through publication and removal.
      if (!existing) fs.renameSync(temp, target);
      syncDirectory();
      fs.unlinkSync(file.file);
      syncDirectory();
      record('info', 'compression', `Compressed ${path.basename(file.file)}`, { day: file.day, part: file.part, lines: verified.lines });
    } catch (err) {
      record('error', 'compression', `Compression failed for ${path.basename(file.file)}`, {
        file: path.basename(file.file), jsonlRetained: fs.existsSync(file.file), error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (tempCreated) fs.rmSync(temp, { force: true });
    }
  }
}
