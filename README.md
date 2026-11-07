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

## Ingest contract (PTP 1.0.3 sender)

Send `POST http://<brain-host>:3340/api/ingest` with `Content-Type: application/json`. The body is an object with a stable, nonempty `device` string (for example `tcl` or `hisense`) and an `events` array. Each event contains:

| Field | Contract |
| --- | --- |
| `id` | Nonempty string, unique per event on that device; generate once and preserve across retries and app restarts. A UUID is suitable. |
| `ts` | Client event time as an ISO timestamp with timezone, such as `2026-11-06T07:02:03.000Z`. |
| `level` | `trace`, `debug`, `info`, `warn`, or `error`. |
| `eventType` | Nonempty string, such as `playback-start`. |
| `message` | String describing the event. |
| `payload` | Optional JSON value with diagnostic details. |

The server stores the client timestamp (normalized to UTC), level, event type, message, and payload with source `ptp-app` and the supplied device. It assigns its own stored event ID; the client `id` is only a deduplication key.

Batch at most 1,000 events and keep the complete UTF-8 JSON request within 2 MiB (2,097,152 bytes), including the envelope. A practical sender policy is to flush every 5 seconds or at 100 events, splitting earlier by encoded byte size. An empty batch is accepted. The server validates the whole batch before writing any events. Success is HTTP 200 with `{"accepted":1,"duplicates":0}`; both counters count events in that request, including repeated IDs within the batch. Invalid JSON, fields, or an oversized body returns HTTP 400 with an `error` string.

Sender behavior for PTP 1.0.3: persist each event to an offline disk queue on the TV before attempting delivery. Keep one request in flight and remove queued events only after a valid HTTP 200 acknowledgement whose `accepted + duplicates` equals the sent batch length. On a timeout, connection failure, server error, or missing/invalid acknowledgement, retain the batch and retry the same device/IDs with exponential backoff and jitter (for example 1 second up to 60 seconds). Continue buffering while Brain is unavailable; bound memory by reading batches from disk. If disk capacity is exhausted, surface the failure and apply backpressure instead of silently dropping queued events. On HTTP 400, retain and flag the rejected batch for correction or splitting; avoid a tight retry loop. These are sender requirements; this repository implements the receiver.

Deduplication uses the `(device, id)` pair: a retry counts as a duplicate even if its contents change. Use a new ID for a new event. The server remembers the latest 50,000 accepted pairs across all devices, saves them every 10 seconds and on orderly shutdown, and writes event data before remembering IDs. Delivery is at least once: retries after ID eviction or an abrupt server exit before the next ID save can create duplicate stored events. A request that fails during writing may have recorded part of its batch; retry all its original IDs.

Example (replace `brain-host` with Brain's reachable hostname or IP; repeating this request normally returns `{"accepted":0,"duplicates":1}`):

```sh
curl --fail-with-body -X POST 'http://brain-host:3340/api/ingest' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "device": "tcl",
  "events": [
    {
      "id": "b28d1c08-3491-4bae-831d-46299edf5d4f",
      "ts": "2026-11-06T07:02:03.000Z",
      "level": "info",
      "eventType": "playback-start",
      "message": "Playback started",
      "payload": { "titleId": "tt1234567", "appVersion": "1.0.3" }
    }
  ]
}
JSON
```

## Storage and extension points

`server/eventLog.ts` is adapted from Manifexus `server/activityLog.ts`. Use `record(level, eventType, message, payload?, { source?, device?, ts? })`, or `globalLogService.log(...)`. `subscribe`, `queryEvents`, `scanEvents`, `flush`, `getLogSettings`, and `updateLogSettings` are available for later parts.

Events retain `{ id, ts, seq, level, eventType, message, source, device?, payload? }` as JSONL in `DATA_DIR/logs/events-YYYY-MM-DD.jsonl` (UTC), then `-2`, `-3`, etc. at 50 MB. A single event may cross the part threshold. Messages, keys, IPs, URLs and payloads are retained without redaction or truncation. Supply JSON-serializable payloads.

The original writer now appends before updating the 5,000-event memory ring or notifying subscribers, and syncs the open file every second, on day/part switch, and on SIGINT/SIGTERM/beforeExit. Append/sync failures propagate rather than silently discarding events. Abrupt power loss before the next sync can still lose the latest kernel-buffered writes; a flush performs an explicit disk sync. Torn JSON lines from a previous crash are preserved and skipped while reading. Queries stream lines and keep at most `limit + 1` matches; exports respect HTTP backpressure. The browser keeps at most 2,000 rows.

Settings live at `DATA_DIR/settings.json`, using Manifexus's atomic write/backup helper. There is no size cap, deletion endpoint, retention timer, redaction, Docker management, authentication, or AI code.
