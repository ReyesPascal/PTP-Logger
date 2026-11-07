# PTP-Logger — plan (DRAFT, planning only; no code until owner says plan finished)

Purpose: one place on Brain (ThinkPad, 192.168.4.40) that records everything needed to diagnose
Pascal The Popcorn (PTP) on both TVs, mainly for Claude's diagnostics. Private repo
github.com/ReyesPascal/PTP-Logger. Separate app from Manifexus (own Docker stack, not managed by it).

## Owner decisions (2026-11-06)
- Base: logging code from github.com/ReyesPascal/Manifexus- (server/globalLogService.ts, activityLog.ts,
  commandLog.ts, Logs UI), modified for this project only. Same language (TypeScript/Node).
- Port 3340 (http://192.168.4.40:3340 / localhost:3340). Viewer is secondary; main user = Claude.
- Retention: default 14 days, changeable in settings.
- Both TVs (Hisense, TCL), each labeled.
- Private repo: anything allowed (keys, IPs, full URLs fine).
- Capture: as much as possible from every source.
- Order: build PTP-Logger first and test alone; PTP app sender comes after (1.0.3).

## Sources (all into one timeline)
1. PTP app events (after 1.0.3 sender): app start/stop/crash, every source lookup (title, ids, URL,
   status, count, error, ms, cache hit incl. 15 s empty cache), BestSource pick + reasons, playback
   start/stall/fail/retry, network state, settings changes. Buffered on TV when Brain unreachable.
2. TV logcat over ADB (works NOW, before 1.0.3): Brain keeps adb connections to both TVs, streams
   full logcat (PTP + system: reboots, network, decoder, memory) — survives TV reboots.
   Also periodic TV snapshots: uptime, IP, Wi-Fi, PTP version, memory.
3. Usenet Ultimate + nzbdav Docker logs (follow live).
4. Brain host: journal (power off/boot, battery/charger, Wi-Fi, DNS errors), docker events.
5. Health probes every 30 s: UU manifest, nzbdav, TVs reachable (ping/adb) -> up/down events.

## Storage
Daily JSONL files (Manifexus format: id, timestamp, level, eventType, message, source, device, payload).
Retention 14 d default + disk-size cap (setting). Disk now 38 GB free.

## Diagnostics for Claude
- HTTP JSON API: /api/events?from&to&device&source&type&q, /api/timeline?around=<time>&window,
  /api/title/<imdb>, /api/health, /api/export.
- CLI on Brain (`ptp-log ...`) wrapping the API, compact text output to save context.
- Viewer page (from Manifexus Logs UI): filter, live tail, export.

## Open questions -> see chat 2026-11-06
