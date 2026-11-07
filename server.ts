/** Express setup, event routes and SSE adapted from Manifexus server.ts. */
import express from 'express';
import path from 'path';
import { once } from 'events';
import { DATA_DIR, LEVELS, record, flush, closeLog, queryEvents, scanEvents, subscribe, getLogSettings, updateLogSettings, type EventQuery, type Level } from './server/eventLog';
import { startRetention } from './server/retention';
import { getDiskAlert, startDiskCheck } from './server/diskCheck';

import { startDockerLogs } from './server/sources/dockerLogs';

export const VERSION = '0.1.0';
const startedAt = Date.now();
const eventQueryFrom = (q: Record<string, unknown>): EventQuery => {
  const text = (key: string) => typeof q[key] === 'string' ? q[key] as string : undefined;
  const date = (key: string) => {
    const value = text(key);
    if (!value) return undefined;
    if (!Number.isFinite(Date.parse(value))) throw new Error(`${key} must be an ISO timestamp`);
    return new Date(value).toISOString();
  };
  const level = text('level');
  if (level && !LEVELS.includes(level as Level)) throw new Error('Invalid level');
  const limit = text('limit') === undefined ? undefined : Number(text('limit'));
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error('Invalid limit');
  return { from: date('from'), to: date('to'), level: level as Level | undefined,
    source: text('source'), device: text('device'), eventType: text('eventType'),
    q: text('q'), before: text('before'), limit };
};
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, uptimeS: Math.floor((Date.now() - startedAt) / 1000), dataDir: DATA_DIR, freeBytes: getDiskAlert().freeBytes }));
  app.get('/api/events', async (req, res, next) => {
    try { res.json(await queryEvents(eventQueryFrom(req.query))); } catch (err) { next(err); }
  });
  app.get('/api/events/export', async (req, res, next) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const q = eventQueryFrom(req.query);
      const format = req.query.format || 'jsonl';
      if (format !== 'jsonl' && format !== 'csv') throw new Error('format must be jsonl or csv');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.setHeader('Content-Disposition', `attachment; filename="ptp-logger-events-${stamp}.${format}"`);
      res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
      const fields = ['id', 'ts', 'seq', 'level', 'device', 'source', 'eventType', 'message', 'payload'] as const;
      const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      if (format === 'csv') res.write(fields.join(',') + '\n');
      let count = 0;
      for await (const ev of scanEvents(q, controller.signal)) {
        if (controller.signal.aborted) break;
        const line = format === 'csv' ? fields.map(k => csv(k === 'payload' ? JSON.stringify(ev[k]) : ev[k])).join(',') : JSON.stringify(ev);
        if (!res.write(line + '\n')) await once(res, 'drain', { signal: controller.signal });
        if (q.limit && ++count >= q.limit) break;
      }
      res.end();
    } catch (err) { if (!controller.signal.aborted) next(err); }
  });
  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    // A client that stops reading gets disconnected (it reconnects by itself) rather than buffering forever
    let unsubscribe = () => {};
    const send = (data: string) => {
      if (res.writableLength > 4 * 1024 * 1024) { close(); res.destroy(); return; }
      res.write(data);
    };
    const ping = setInterval(() => send(': ping\n\n'), 20000);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    unsubscribe = subscribe((msg) => {
      if (res.writableLength > 4 * 1024 * 1024) {
        close();
        res.destroy();
        return;
      }
      send(`data: ${JSON.stringify(msg)}\n\n`);
    });
    res.on('close', close);
  });


  app.get('/api/settings', (_req, res) => res.json(getLogSettings()));
  app.post('/api/settings', (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new Error('Expected settings object');
      res.json(updateLogSettings(req.body));
    } catch (err) { next(err); }
  });
  app.use(apiError);
  return app;
}
export async function startServer() {
  const app = createApp();
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  // Mount Vite middleware in development or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }


  app.use(apiError);
  const server = app.listen(Number(process.env.PORT || 3340), '0.0.0.0');
  await once(server, 'listening');
  record('info', 'startup', 'PTP-Logger started', { version: VERSION, dataDir: DATA_DIR });
  const stopDiskCheck = startDiskCheck();
  server.once('close', stopDiskCheck);
  const stopDockerLogs = startDockerLogs();
  server.once('close', stopDockerLogs);
  const retentionTimer = startRetention();
  server.once('close', () => clearInterval(retentionTimer));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    stopDiskCheck();
    record('info', 'shutdown', `PTP-Logger is stopping (${signal})`);
    stopDockerLogs();
    closeLog();
    server.close();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop(signal));
  process.once('beforeExit', () => { if (!stopping) { stopDiskCheck(); stopDockerLogs(); record('info', 'shutdown', 'PTP-Logger is stopping (beforeExit)'); flush(); } });
  return server;
}
const apiError: express.ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const message = err instanceof Error ? err.message : String(err);
  res.status(/Invalid|must be|Expected|format|detail|retentionDays/.test(message) ? 400 : 500).json({ error: message });
};
// Keep imports side-effect free for API fixtures; production/dev entry starts here.
if (process.env.NODE_ENV !== 'test') startServer().catch(err => { console.error(err); process.exitCode = 1; });
