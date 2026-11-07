/** Copied from dockerLogs.ts:5-42; shared to prevent competing sources.json writers. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, flush } from '../eventLog';
import { readJsonSafe, writeJsonAtomic } from '../safeJson';

const stateFile = path.join(DATA_DIR, 'sources.json');
let state: Record<string, unknown> | undefined;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function loadSourceState() {
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
  writeJsonAtomic(stateFile, loadSourceState());
  dirty = false;
}
export function checkpointSource(container: string, ts: unknown) {
  loadSourceState()[container] = ts;
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = undefined; save(); }, 5000);
    saveTimer.unref();
  }
}
export function flushSourceState() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  save();
}
