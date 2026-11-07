/** Express setup, event routes and SSE adapted from Manifexus server.ts. */
import express from 'express';
import path from 'path';
import { once } from 'events';
import { DATA_DIR, LEVELS, record, flush, closeLog, queryEvents, scanEvents, cursorOf, subscribe, getLogSettings, updateLogSettings, type EventQuery, type Level, type LogEvent } from './server/eventLog';
import { startRetention } from './server/retention';
import { startArchive } from './server/archive';
import { getDiskAlert, startDiskCheck } from './server/diskCheck';

import { startDockerLogs } from './server/sources/dockerLogs';
import { startDockerEvents } from './server/sources/dockerEvents';
import { startDevices } from './server/tv/devices';
import { startAdb } from './server/tv/adb';
import { startBrainHost } from './server/sources/brainHost';
import { startProbes } from './server/sources/probes';
import { getAlerts } from './server/alerts';
import { ingest, startIngest } from './server/ingest';

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
  app.post('/api/ingest', express.json({ limit: '2mb' }), (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try { res.json(ingest(req.body)); } catch (err) { next(err); }
  }, ((err, _req, res, next) => {
    // Body parser failures (including malformed JSON and the 2 MB cap) are bad input.
    if (err.status >= 400 && err.status < 500) res.status(400).json({ error: err.message });
    else next(err);
  }) as express.ErrorRequestHandler);
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/alerts', (_req, res) => res.set('Cache-Control', 'no-store').json({ alerts: getAlerts() }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, uptimeS: Math.floor((Date.now() - startedAt) / 1000), dataDir: DATA_DIR, freeBytes: getDiskAlert().freeBytes }));
  app.get('/api/events', async (req, res, next) => {
    try { res.json(await queryEvents(eventQueryFrom(req.query))); } catch (err) { next(err); }
  });
  // Adapted from Manifexus server.ts:279-282 (query) and :295 (chronological order).
  app.get('/api/timeline', async (req, res, next) => {
    try {
      const text = (key: string) => {
        const value = req.query[key];
        if (value !== undefined && typeof value !== 'string') throw new Error(`${key} must be a single string`);
        return value as string | undefined;
      };
      const around = text('around');
      if (!around || !/^(?:[+-]?\d+|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/.test(around)) {
        throw new Error('around must be an ISO timestamp or epoch milliseconds');
      }
      const center = /^[+-]?\d+$/.test(around) ? Number(around) : Date.parse(around);
      const seconds = text('window');
      const window = seconds === undefined ? 300 : Number(seconds);
      if (seconds?.trim() === '' || !Number.isFinite(window) || window < 0) throw new Error('window must be non-negative seconds');
      const from = new Date(center - window * 1000);
      const to = new Date(center + window * 1000);
      if (!Number.isFinite(center) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
        throw new Error('Invalid timeline range');
      }
      const q = eventQueryFrom({ from: from.toISOString(), to: to.toISOString(),
        device: text('device'), source: text('source'), limit: text('limit') ?? '5000', before: text('before') });
      // Bounded pages, newest page first; use nextCursor as before to read older pages.
      const result = await queryEvents(q);
      res.json({ ...result, events: result.events.reverse() });
    } catch (err) { next(err); }
  });
  // Adapted from Manifexus server.ts:279-282; title summaries scan the full window.
  app.get('/api/title/:id', async (req, res, next) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const id = req.params.id;
      if (!/^tt\d+$/.test(id)) throw new Error('Invalid IMDb title ID');
      const rawDays = req.query.days;
      if (rawDays !== undefined && typeof rawDays !== 'string') throw new Error('days must be a single number');
      const days = rawDays === undefined ? 7 : Number(rawDays);
      const now = Date.now();
      const from = new Date(now - days * 86400000);
      if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(from.getTime())) {
        throw new Error('days must be positive and form a valid date range');
      }
      const events: LogEvent[] = [];
      const summary = { total: 0, bySource: Object.create(null) as Record<string, number>, byLevel: Object.create(null) as Record<string, number> };
      for await (const ev of scanEvents({ q: id, from: from.toISOString(), to: new Date(now).toISOString() }, controller.signal)) {
        summary.total++;
        summary.bySource[ev.source] = (summary.bySource[ev.source] ?? 0) + 1;
        summary.byLevel[ev.level] = (summary.byLevel[ev.level] ?? 0) + 1;
        // Reuse queryEvents' bounded top-N ordering, including late arrivals and timestamp ties.
        const key = cursorOf(ev);
        let lo = 0, hi = events.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (cursorOf(events[mid]) > key) lo = mid + 1; else hi = mid; }
        if (lo < 500) { events.splice(lo, 0, ev); if (events.length > 500) events.pop(); }
      }
      if (!controller.signal.aborted) res.json({ events, summary });
    } catch (err) { if (!controller.signal.aborted) next(err); }
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
  // Background work: ONE line per collector/timer below (owner 2026-11-06: parallel lanes merge here).
  const stoppers: Array<() => void> = [];
  stoppers.push(startArchive());
  stoppers.push(startDiskCheck());
  stoppers.push(startDockerEvents());
  stoppers.push(startDockerLogs());
  stoppers.push(startBrainHost());
  stoppers.push(startProbes());
  stoppers.push(startIngest());
  stoppers.push(startDevices());
  stoppers.push(startAdb());
  const retentionTimer = startRetention(); stoppers.push(() => clearInterval(retentionTimer));
  // (end of background work list)
  const stopAll = () => { for (const s of stoppers.splice(0)) s(); };
  server.once('close', stopAll);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    record('info', 'shutdown', `PTP-Logger is stopping (${signal})`);
    stopAll();
    closeLog();
    server.close();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop(signal));
  process.once('beforeExit', () => { if (!stopping) { stopAll(); record('info', 'shutdown', 'PTP-Logger is stopping (beforeExit)'); flush(); } });
  return server;
}
const apiError: express.ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return; }
  const message = err instanceof Error ? err.message : String(err);
  res.status(/Invalid|must be|Expected|format|detail|retentionDays/.test(message) ? 400 : 500).json({ error: message });
};
// Keep imports side-effect free for API fixtures; production/dev entry starts here.
if (process.env.NODE_ENV !== 'test') startServer().catch(err => { console.error(err); process.exitCode = 1; });
