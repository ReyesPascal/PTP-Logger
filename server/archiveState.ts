/** New: Manifexus has no verified Drive archive state or retention gate. */
import path from 'path';
import { DATA_DIR, listEventFiles } from './eventLog';
import { readJsonSafe } from './safeJson';

export type ArchiveState = Record<string, {
  files: string[];
  uploadedAt: string;
  verifiedAt?: string;
  verifiedFiles?: Array<{ name: string; size: number; mtime: number }>;
}>;

/** Fail closed for legacy entries, incomplete uploads, and changed/backfilled parts. */
export function isArchived(day: string): boolean {
  const state = readJsonSafe<ArchiveState>(path.join(DATA_DIR, 'archive.json'), {});
  const entry = state && Object.hasOwn(state, day) ? state[day] : undefined;
  if (!entry || typeof entry.verifiedAt !== 'string' || !Number.isFinite(Date.parse(entry.verifiedAt)) ||
    !Array.isArray(entry.files) || !Array.isArray(entry.verifiedFiles)) return false;
  const files = listEventFiles().filter(f => f.day === day);
  if (!files.length || files.length !== entry.files.length || files.length !== entry.verifiedFiles.length) return false;
  return files.every(file => file.gz && entry.files.includes(path.basename(file.file)) &&
    entry.verifiedFiles!.some(verified => verified && verified.name === path.basename(file.file) &&
      verified.size === file.size && verified.mtime === file.mtime));
}
