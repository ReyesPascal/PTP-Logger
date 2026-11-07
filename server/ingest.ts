import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LEVELS, flush, record, type Level } from './eventLog';
import { readJsonSafe, writeJsonAtomic } from './safeJson';

const IDS_FILE = path.join(DATA_DIR, 'ingest-ids.json');
const MAX_IDS = 50_000;
let ids: Set<string> | undefined;
let dirty = false;

function rememberedIds(): Set<string> {
  if (!ids) {
    // Adapted from Manifexus server/backupAuto.ts:64 (safe state loading).
    const saved = readJsonSafe<unknown>(IDS_FILE, []);
    ids = new Set<string>();
    if (Array.isArray(saved)) {
      for (const key of saved.slice(-MAX_IDS)) {
        if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) ids.add(key);
      }
    }
  }
  return ids;
}

interface ClientEvent {
  id: string;
  ts: string;
  level: Level;
  eventType: string;
  message: string;
  payload?: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Validate the whole batch before its first write. Client IDs are dedupe keys, not store IDs. */
export function ingest(body: unknown): { accepted: number; duplicates: number } {
  if (!object(body) || !nonempty(body.device) || !Array.isArray(body.events) || body.events.length > 1000) {
    throw new Error('Invalid ingest: device and events array (max 1000) required');
  }
  for (const event of body.events) {
    if (!object(event) || !nonempty(event.id) || !nonempty(event.eventType) || typeof event.message !== 'string' ||
        !LEVELS.includes(event.level as Level) || typeof event.ts !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.ts) ||
        !Number.isFinite(Date.parse(event.ts))) {
      throw new Error('Invalid ingest event: id, ISO ts, level, eventType and message required');
    }
  }
  const known = rememberedIds();
  let accepted = 0, duplicates = 0;
  for (const event of body.events as ClientEvent[]) {
    // Fixed-size keys avoid retaining up to 50,000 request-sized strings.
    const key = crypto.createHash('sha256').update(JSON.stringify([body.device, event.id])).digest('hex');
    if (known.has(key)) { duplicates++; continue; }
    record(event.level, event.eventType, event.message, event.payload,
      { source: 'ptp-app', device: body.device, ts: event.ts });
    known.add(key); // Remember only after the write-ahead append succeeds.
    if (known.size > MAX_IDS) known.delete(known.values().next().value!);
    dirty = true;
    accepted++;
  }
  return { accepted, duplicates };
}

function saveIds(): void {
  if (!dirty) return;
  // IDs must never become durable before their corresponding event data.
  flush();
  // Copied from Manifexus server/backupAuto.ts:65-68; changed state path/data.
  fs.mkdirSync(path.dirname(IDS_FILE), { recursive: true });
  writeJsonAtomic(IDS_FILE, [...rememberedIds()], { pretty: false });
  dirty = false;
}

/** Only startServer owns the persistence timer; shutdown also saves pending IDs. */
export function startIngest(): () => void {
  rememberedIds();
  const save = () => {
    try { saveIds(); }
    catch (err) { console.error('[Ingest] Could not save dedupe IDs; will retry', err); }
  };
  const timer = setInterval(save, 10_000);
  timer.unref();
  return () => { clearInterval(timer); save(); };
}
