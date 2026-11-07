/** Adapted from Manifexus globalLogService.ts; forwards source/device into the common timeline. */
import { record, type Level } from './eventLog';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type LogEventType = string;

const LEVEL: Record<string, Level> = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', CRITICAL: 'error' };

interface LogInput {
  level: LogLevel | Lowercase<LogLevel> | string;
  eventType?: string; source?: string; device?: string; message: string; payload?: unknown; error?: unknown;
}
export const globalLogService = {
  log(entry: LogInput): void {
    const lvl = LEVEL[String(entry.level).toUpperCase()] || (entry.level === 'trace' ? 'trace' : 'info');
    const payload = entry.error === undefined ? entry.payload : {
      payload: entry.payload,
      error: entry.error instanceof Error ? { message: entry.error.message, stack: entry.error.stack } : entry.error,
    };
    record(lvl, entry.eventType || 'event', entry.message, payload, { source: entry.source, device: entry.device });
  },
};
