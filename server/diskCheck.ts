/** Free-space calculation adapted from Manifexus server/dataBackupService.ts:508-516. */
import fs from 'node:fs/promises';
import { DATA_DIR, record } from './eventLog';

const LOW_DISK_BYTES = 5_000_000_000;
let alert: { active: boolean; freeBytes: number | null } = { active: false, freeBytes: null };

export function getDiskAlert(): { active: boolean; freeBytes: number | null } {
  return { ...alert };
}

/** Start only from startServer; stopping also discards any pending statfs result. */
export function startDiskCheck(): () => void {
  let stopped = false;
  let running = false;
  const check = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const st = await fs.statfs(DATA_DIR);
      if (stopped) return;
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      const active = freeBytes < LOW_DISK_BYTES;
      if (active !== alert.active) {
        record(active ? 'warn' : 'info', active ? 'disk-low' : 'disk-ok',
          active ? 'Data disk has less than 5 GB free' : 'Data disk free space recovered', { freeBytes });
      }
      alert = { active, freeBytes };
    } catch (err) {
      if (!stopped) record('error', 'disk-check', 'Unable to check data disk free space', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally { running = false; }
  };
  void check();
  const timer = setInterval(() => { void check(); }, 10 * 60 * 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
