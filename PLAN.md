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

## Owner decisions round 2 (2026-11-06)
- Capture everything ever needed, never lost — but must NOT hurt CPU/memory (Tailscale did).
  Limits: Docker cpus=0.5, mem 256 MB, nice/ionice low; on TVs only adb logcat stream (logd already runs).
  Measure TV CPU/RAM before/after (esp. TCL MT5867, 1.4 GB); auto-throttle (drop verbose tags) if over budget.
- TVs found by MAC (ARP/LAN scan), not fixed IP. Hisense now 192.168.4.27.
- Brain charger/battery events: yes.
- Storage: last 14 d local (changeable) + gzip archive of every closed day to owner's Google Drive
  (2 TB) via rclone, kept forever (never lost). Owner does the one-time Google login (`! rclone config`).
  Local disk cap 10 GB as safety; nothing deleted locally until its archive upload is verified.
- Alerts: banner/list inside PTP-Logger page only (UU down, nzbdav down, Brain on battery, TV unreachable,
  Drive upload failing).
- Build: senior-dev orchestrator workflow (lead reviews, briefs saved first, Codex for feature parts,
  1 Claude ptp-worker for small fixes). New repo -> no merge conflicts, parts are mostly disjoint.

## Build parts (draft)
P0 skeleton: copy Manifexus logger + Logs UI, strip Docker/stack code, Dockerfile/compose, port 3340.
P1 storage: JSONL daily files, retention setting, disk cap, gzip.
P2 sources: UU + nzbdav docker logs, Brain journal/battery/docker events, health probes, alerts.
P3 TVs: MAC discovery, adb connect keepalive, logcat stream + snapshots, resource budget/throttle.
P4 Drive archive: rclone upload of closed days, verify, then allow local delete.
P5 diagnostics: query API + `ptp-log` CLI (compact output for Claude) + viewer filters.
P6 ingest endpoint for PTP app events (ready for the 1.0.3 sender).
Then: run 24 h, measure CPU/RAM on Brain + both TVs, owner check.

## Drive setup (DONE 2026-11-06)
rclone v1.76.0 at ~/.local/bin/rclone (sha256 verified). Remote `ptpdrive:` (Google Drive, scope drive.file =
only files rclone created), config ~/.config/rclone/rclone.conf (600). Archive folder ptpdrive:PTP-Logger/
(test file drive-test.txt uploaded OK). Drive: 5 TiB total, 50.8 GiB used.
WARNING: uses rclone's shared client_id, being retired during 2026 -> owner to create own Google client_id
(https://rclone.org/drive/#making-your-own-client-id) or archive uploads may stop. P4 must alert on upload failure.
