/** Age retention copied and adapted from Manifexus server/activityLog.ts:744-757. */
import fs from 'fs';
import { flush, getLogSettings, listEventFiles, record } from './eventLog';
import { isArchived } from './archiveState';

export function expiredDays(now = Date.now()): string[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const cutoffDay = new Date(now - getLogSettings().retentionDays * 86400000).toISOString().slice(0, 10);
  return [...new Set(listEventFiles()
    .filter(f => f.day < cutoffDay && f.day < today)
    .map(f => f.day))];
}

export function enforceRetention(now = Date.now()): void {
  flush();
  const expired = new Set(expiredDays(now));
  const deleted: string[] = [];
  const keptNotArchived: string[] = [];
  const files = listEventFiles();
  for (const day of expired) {
    if (!isArchived(day)) {
      keptNotArchived.push(day);
      continue;
    }
    for (const f of files) {
      if (f.day === day) fs.unlinkSync(f.file);
    }
    deleted.push(day);
  }
  if (deleted.length || keptNotArchived.length) {
    record('info', 'retention', `Retention deleted ${deleted.length} days; kept ${keptNotArchived.length} days awaiting archive`, { deleted, keptNotArchived });
  }
}

export function startRetention(): ReturnType<typeof setInterval> {
  enforceRetention();
  const timer = setInterval(enforceRetention, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
