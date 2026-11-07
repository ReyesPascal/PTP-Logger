# PTP-Logger

Private TypeScript/Node timeline for diagnosing Pascal The Popcorn on Hisense and TCL TVs. P0 provides durable event storage, an HTTP API, and a small viewer. Collectors, app ingest, diagnostics CLI, Drive archives, and verified retention cleanup are later parts.

## Run

Requires Node 22.

```sh
npm ci
npm run dev
# http://localhost:3340
```

`PORT` defaults to `3340`; the server binds `0.0.0.0`. `DATA_DIR` defaults to `./data` and is created if missing.

```sh
npm run build
NODE_ENV=production npm start
npm run lint
npm test
```

Docker configuration is supplied; it has not been run as part of P0. The runtime uses the non-root `node` user (UID/GID 1000), nice level 10, 0.5 CPU and 256 MB RAM. Prepare the bind directory so UID 1000 can write it before starting:

```sh
mkdir -p data
# Ensure data is writable by UID 1000 on your host.
docker compose up -d --build
```

## API

- `GET /api/health`: `ok`, `version`, `uptimeS`, absolute `dataDir`.
- `GET /api/events`: newest-first `{ events, nextCursor? }`. Filters: `from`, `to` (ISO timestamps, inclusive), `level` (exact), `source`, `device`, `eventType`, `q` (case-insensitive message/metadata/payload search), `limit` (default 300, max 5000), `before` (opaque exclusive cursor). Pass `nextCursor` unchanged as `before` to page.
- `GET /api/events/export?format=jsonl|csv`: same filters. Streams all matches unless `limit` is supplied. Files visited newest day/part first, lines in append order; export is not globally time sorted.
- `GET /api/stream`: SSE `data: {"kind":"event","event":...}`. 20 s heartbeat; clients exceeding 4 MB queued output are disconnected. Reconnect/query the durable API for missed events.
- `GET /api/settings`, `POST /api/settings`: `{ "retentionDays": 14, "detail": "everything" }`. Retention days 1–3650; P0 only records this setting and never deletes logs.

Example: `/api/events?device=hisense&source=tv-logcat&level=error&q=decoder`.

## Storage and extension points

`server/eventLog.ts` is adapted from Manifexus `server/activityLog.ts`. Use `record(level, eventType, message, payload?, { source?, device?, ts? })`, or `globalLogService.log(...)`. `subscribe`, `queryEvents`, `scanEvents`, `flush`, `getLogSettings`, and `updateLogSettings` are available for later parts.

Events retain `{ id, ts, seq, level, eventType, message, source, device?, payload? }` as JSONL in `DATA_DIR/logs/events-YYYY-MM-DD.jsonl` (UTC), then `-2`, `-3`, etc. at 50 MB. A single event may cross the part threshold. Messages, keys, IPs, URLs and payloads are retained without redaction or truncation. Supply JSON-serializable payloads.

The original writer now appends before updating the 5,000-event memory ring or notifying subscribers, and syncs the open file every second, on day/part switch, and on SIGINT/SIGTERM/beforeExit. Append/sync failures propagate rather than silently discarding events. Abrupt power loss before the next sync can still lose the latest kernel-buffered writes; a flush performs an explicit disk sync. Torn JSON lines from a previous crash are preserved and skipped while reading. Queries stream lines and keep at most `limit + 1` matches; exports respect HTTP backpressure. The browser keeps at most 2,000 rows.

Settings live at `DATA_DIR/settings.json`, using Manifexus's atomic write/backup helper. There is no size cap, deletion endpoint, retention timer, redaction, Docker management, authentication, or AI code.
