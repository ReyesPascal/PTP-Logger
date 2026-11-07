/** Socket/reconnect adapted from Manifexus server/observability.ts:119-150;
 * frame decoding adapted from server/dockerService.ts:1657-1718.
 * Decode incrementally instead of collecting the entire response. */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { DATA_DIR, flush, record } from '../eventLog';
import { readJsonSafe, writeJsonAtomic } from '../safeJson';

const stateFile = path.join(DATA_DIR, 'sources.json');
let state: Record<string, unknown> | undefined;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function loadState() {
  if (!state) {
    const saved = readJsonSafe<unknown>(stateFile, {});
    state = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  }
  return state;
}
function save() {
  if (!dirty) return;
  // A durable cursor must never get ahead of durable event data.
  flush();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(stateFile, loadState());
  dirty = false;
}
function checkpoint(container: string, ts: string) {
  loadState()[container] = ts;
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = undefined; save(); }, 5000);
    saveTimer.unref();
  }
}
// Preserve Docker's nanoseconds: Date.parse alone would collapse distinct lines.
function timestampKey(ts: string): string | undefined {
  const m = ts.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/);
  return m && Number.isFinite(Date.parse(ts)) ? `${m[1]}.${(m[2] || '').padEnd(9, '0')}Z` : undefined;
}

export function followContainer({ container, source }: { container: string; source: string }): () => void {
  const saved = loadState()[container];
  let lastTs = typeof saved === 'string' && timestampKey(saved) ? saved : new Date().toISOString();
  checkpoint(container, lastTs);
  let retry = 2000;
  let stopped = false;
  let down = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let req: http.ClientRequest | undefined;
  let response: http.IncomingMessage | undefined;
  const status = (level: 'warn' | 'info', type: string, message: string) =>
    record(level, type, message, { container }, { source, device: 'brain' });

  const connect = () => {
    if (stopped) return;
    // One reconnect per connection: resets may fire on both request and response.
    let reconnecting = false;
    const reconnect = () => {
      if (reconnecting || stopped) return;
      reconnecting = true;
      response?.destroy();
      req?.destroy();
      if (!down) { status('warn', 'source-down', `Container log connection lost: ${container}`); down = true; }
      timer = setTimeout(connect, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60000);
    };
    req = http.request({
      socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
      path: `/containers/${encodeURIComponent(container)}/logs?follow=1&stdout=1&stderr=1&timestamps=1&since=${encodeURIComponent(lastTs)}`,
      method: 'GET', headers: { Host: 'docker' },
    }, (res) => {
      response = res;
      if (stopped || reconnecting) { res.destroy(); return; }
      if (res.statusCode !== 200) { reconnect(); return; }
      retry = 2000;
      if (down) { status('info', 'source-up', `Container log connection restored: ${container}`); down = false; }

      // Per-stream UTF-8 decoders and bounded line segments. Exceptionally long
      // lines are recorded in pieces, keeping all text without unbounded RAM.
      const streams = new Map<string, { decoder: StringDecoder; text: string; ts?: string; skip: boolean }>();
      const lineLimit = 64 * 1024;
      const emit = (s: { text: string; ts?: string; skip: boolean }, stream: string, final: boolean) => {
        let text = s.text;
        if (!s.ts) {
          const match = text.match(/^(\S+) /);
          if (match && timestampKey(match[1])) {
            s.ts = match[1];
            s.skip = timestampKey(s.ts)! <= timestampKey(lastTs)!;
            text = text.slice(match[0].length);
          }
        }
        if (!s.skip) {
          const level = /\b(error|fatal|exception)\b/i.test(text) ? 'error' : /\bwarn/i.test(text) ? 'warn' : 'info';
          record(level, 'container-log', text, { container, stream }, { source, device: 'brain', ts: s.ts });
          // Only checkpoint complete lines so a disconnect cannot drop a suffix.
          if (final && s.ts && timestampKey(s.ts)! > timestampKey(lastTs)!) {
            lastTs = s.ts;
            checkpoint(container, lastTs);
          }
        }
        s.text = '';
        if (final) { s.ts = undefined; s.skip = false; }
      };
      const consume = (bytes: Buffer, stream: string) => {
        let s = streams.get(stream);
        if (!s) { s = { decoder: new StringDecoder('utf8'), text: '', skip: false }; streams.set(stream, s); }
        const text = s.decoder.write(bytes);
        let offset = 0;
        while (offset < text.length) {
          const nl = text.indexOf('\n', offset);
          const end = nl < 0 ? text.length : nl;
          const take = Math.min(end - offset, lineLimit - s.text.length);
          s.text += text.slice(offset, offset + take);
          offset += take;
          if (offset === nl) {
            if (s.text.endsWith('\r')) s.text = s.text.slice(0, -1);
            emit(s, stream, true);
            offset++;
          } else if (s.text.length === lineLimit) emit(s, stream, false);
        }
      };
      // At most eight bytes of frame header are carried; frame bodies stream
      // directly to their line decoder even when a frame spans many chunks.
      let header = Buffer.alloc(0);
      let framed: boolean | undefined;
      let remaining = 0;
      let stream = 'stdout';
      res.on('data', (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (framed === false) { consume(chunk.subarray(offset), 'stdout'); break; }
          if (remaining) {
            const n = Math.min(remaining, chunk.length - offset);
            consume(chunk.subarray(offset, offset + n), stream);
            remaining -= n;
            offset += n;
            continue;
          }
          const n = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + n)]);
          offset += n;
          if (header.length < 8) continue;
          const valid = (header[0] === 1 || header[0] === 2) && header[1] === 0 && header[2] === 0 && header[3] === 0;
          if (framed === undefined) framed = valid;
          if (!framed) { consume(header, 'stdout'); header = Buffer.alloc(0); continue; }
          if (!valid) { reconnect(); return; }
          stream = header[0] === 2 ? 'stderr' : 'stdout';
          remaining = header.readUInt32BE(4);
          header = Buffer.alloc(0);
        }
      });
      res.on('end', () => {
        if (framed === undefined && header.length) consume(header, 'stdout');
        // A truncated frame is replayed from the last complete line on reconnect.
        if (framed && (remaining || header.length)) { reconnect(); return; }
        for (const [name, s] of streams) {
          s.text += s.decoder.end();
          if (s.text || s.ts) emit(s, name, true);
        }
        reconnect();
      });
      res.on('error', reconnect);
      res.on('close', reconnect);
    });
    req.on('error', reconnect);
    req.end();
  };
  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    response?.destroy();
    req?.destroy();
    clearTimeout(saveTimer);
    saveTimer = undefined;
    save();
  };
}

export function startDockerLogs(): () => void {
  if (process.env.DOCKER_LOGS === 'off') return () => {};
  const stops = [followContainer({ container: 'usenet-ultimate', source: 'uu' }), followContainer({ container: 'nzbdav', source: 'nzbdav' })];
  return () => { for (const stop of stops) stop(); };
}
