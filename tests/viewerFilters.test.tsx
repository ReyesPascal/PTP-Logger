import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ActivitySheet, { eventOptions, matchesViewerFilters } from '../src/components/ActivitySheet';
import type { LogEvent } from '../server/eventLog';

const event = (patch: Partial<LogEvent> = {}): LogEvent => ({
  id: '1', ts: '2026-11-06T12:00:00Z', seq: 1, level: 'info',
  eventType: 'journal', message: 'Ready', source: 'brain', device: 'brain', ...patch,
});
const filters = { level: '', alertsOnly: false, device: '', source: '', debounced: '' };

describe('viewer filters', () => {
  it('derives sorted distinct facets from loaded events without missing devices', () => {
    const rows = [event(), event({ device: 'tcl', source: 'tv-logcat' }), event(), event({ device: undefined })];
    expect(eventOptions(rows, 'device')).toEqual(['brain', 'tcl']);
    expect(eventOptions(rows, 'source')).toEqual(['brain', 'tv-logcat']);
  });
  it('keeps the selected facet available when a loaded page has no matches', () => {
    expect(eventOptions([], 'device', 'hisense')).toEqual(['hisense']);
    expect(eventOptions([], 'source')).toEqual([]);
  });
  it('alerts only includes warn and error and overrides the individual level', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      expect(matchesViewerFilters(event({ level }), { ...filters, level: 'debug', alertsOnly: true }))
        .toBe(level === 'warn' || level === 'error');
    }
  });
  it('combines device, source, search and level for loaded and live events', () => {
    const f = { ...filters, level: 'warn', device: 'tcl', source: 'tv-logcat', debounced: 'TIMEOUT' };
    const row = event({ level: 'warn', device: 'tcl', source: 'tv-logcat', payload: { reason: 'timeout' } });
    expect(matchesViewerFilters(row, f)).toBe(true);
    expect(matchesViewerFilters(row, { ...f, device: 'brain' })).toBe(false);
    expect(matchesViewerFilters(row, { ...f, source: 'logger' })).toBe(false);
    expect(matchesViewerFilters(row, { ...f, debounced: 'missing' })).toBe(false);
    expect(matchesViewerFilters(row, { ...f, level: 'error' })).toBe(false);
  });
  it('searches event metadata and accepts unfiltered events', () => {
    expect(matchesViewerFilters(event(), filters)).toBe(true);
    expect(matchesViewerFilters(event(), { ...filters, debounced: 'JOURNAL' })).toBe(true);
  });
  it('renders accessible dropdowns, alerts toggle, and local time jump', () => {
    const html = renderToStaticMarkup(<ActivitySheet />);
    expect(html).toContain('Device <select');
    expect(html).toContain('Source <select');
    expect(html).toContain('Alerts only (warn + error)');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('Jump ±5 minutes');
  });
});
