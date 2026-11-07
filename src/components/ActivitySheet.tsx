/** Events/settings view adapted from Manifexus src/components/ActivitySheet.tsx. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEvent, LogSettings } from '../../server/eventLog';
import type { Alert } from '../../server/alerts';
import { copyText } from '../copyText';
type LiveMessage = { kind: 'event'; event: LogEvent };
type Subscribe = (fn: (msg: LiveMessage) => void) => () => void;
const ios = { secondary: '#526277' };
function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const Pre: React.FC<{ children: string; tone?: 'default' | 'error'; max?: number }> = ({ children, tone = 'default', max = 420 }) => (
  <pre
    className="event-data"
    style={{ background: '#f1f5f9', color: tone === 'error' ? '#a12222' : '#243447', maxHeight: max }}
  >
    {children}
  </pre>
);

/** Shows an event's data: command output, file contents and scripts as text; everything else as JSON. */
const EventData: React.FC<{ ev: LogEvent }> = ({ ev }) => {
  const [copied, setCopied] = useState(false);
  const raw = ev.payload;
  const d = raw as Record<string, unknown> | undefined;
  if (d === undefined) return <p className="text-[13px] px-1" style={{ color: ios.secondary }}>No additional data.</p>;
  const blocks: { label: string; text: string; tone?: 'error' }[] = [];
  if (typeof d?.output === 'string' && d.output.trim()) blocks.push({ label: 'Output', text: d.output, tone: ev.level === 'warn' || ev.level === 'error' ? 'error' : undefined });
  if (typeof d?.content === 'string') blocks.push({ label: `Content${typeof d.path === 'string' ? ` of ${d.path}` : ''}`, text: d.content });
  if (typeof d?.script === 'string') blocks.push({ label: 'Script', text: d.script });
  if (typeof d?.stack === 'string') blocks.push({ label: 'Stack trace', text: d.stack, tone: 'error' });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (['output', 'content', 'script', 'stack'].includes(k) && typeof v === 'string') continue;
    if (v !== undefined) rest[k] = v;
  }
  const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const json = JSON.stringify(isObject ? (Object.keys(rest).length || !blocks.length ? rest : undefined) : raw, null, 2);
  return (
    <div className="space-y-2.5">
      {blocks.map((b) => (
        <div key={b.label}>
          <div className="text-[12px] mb-1 px-1" style={{ color: ios.secondary }}>{b.label}</div>
          <Pre tone={b.tone}>{b.text}</Pre>
        </div>
      ))}
      {json && (
        <div>
          {blocks.length > 0 && <div className="text-[12px] mb-1 px-1" style={{ color: ios.secondary }}>Details</div>}
          <Pre>{json}</Pre>
        </div>
      )}
      <div className="flex gap-4 px-1">
        <button
          onClick={async () => {
            if (await copyText(JSON.stringify(ev, null, 2))) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy Event JSON'}
        </button>
      </div>
    </div>
  );
};


/** Original expandable event row, presented as an accessible table row. */
const EventRow: React.FC<{ ev: LogEvent }> = ({ ev }) => {
  const [open, setOpen] = useState(false);
  return <tr>
    <td title={ev.ts}>{new Date(ev.ts).toLocaleDateString()} {fmtClock(ev.ts)}</td>
    <td className={`level ${ev.level}`}>{ev.level}</td><td>{ev.device || '—'}</td>
    <td>{ev.source}</td><td>{ev.eventType}</td>
    <td><button className="event-message" onClick={() => setOpen(o => !o)} aria-expanded={open}>{ev.message}</button>
      {open && <div><p className="muted">{ev.ts} · #{ev.seq} · {ev.id}</p><EventData ev={ev} /></div>}
    </td>
  </tr>;
};
/** New: PTP device/source facets have no Manifexus equivalent. */
export function eventOptions(events: LogEvent[], field: 'device' | 'source', selected = ''): string[] {
  return [...new Set([...events.map(e => e[field] || ''), selected].filter(Boolean))].sort();
}

/** Adapted from Manifexus ActivitySheet.tsx:862–872; shared by loaded rows and live tail. */
export function matchesViewerFilters(e: LogEvent, f: { level: string; alertsOnly: boolean; device: string; source: string; debounced: string }): boolean {
  if (f.alertsOnly ? !['warn', 'error'].includes(e.level) : f.level && f.level !== e.level) return false;
  if (f.device && f.device !== e.device) return false;
  if (f.source && f.source !== e.source) return false;
  return !f.debounced || `${e.message} ${e.eventType} ${e.source} ${e.device || ''} ${JSON.stringify(e.payload ?? '')}`.toLowerCase().includes(f.debounced.toLowerCase());
}

function useEventFilters() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState('');
  const [device, setDevice] = useState('');
  const [source, setSource] = useState('');
  const [live, setLive] = useState(true);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [around, setAround] = useState('');
  const [events, setEvents] = useState<LogEvent[]>([]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);
  const params = useCallback((extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ level: alertsOnly ? undefined : level, device, source, q: debounced, ...extra })) if (v) p.set(k, v);
    return p.toString();
  }, [level, device, source, debounced, alertsOnly]);
  return { search, setSearch, debounced, level, setLevel, device, setDevice, source, setSource, live, setLive, alertsOnly, setAlertsOnly, around, setAround, events, setEvents, params };
}
type EventFilters = ReturnType<typeof useEventFilters>;
const EventsView: React.FC<{ subscribe: Subscribe; filters: EventFilters }> = ({ subscribe, filters }) => {
  const [error, setError] = useState<string>();
  const { params, around, events, setEvents } = filters;
  const visible = events.filter(e => matchesViewerFilters(e, filters));


  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current++; }, []);

  const load = useCallback(
    async (more = false) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const r = await fetch(`${around ? '/api/timeline' : '/api/events'}?${params({ around: around || undefined, limit: '300', before: more ? cursor : undefined })}`, { cache: 'no-store' });
        if (!r.ok) throw new Error('Could not load events');
        const j = await r.json();
        if (id !== requestId.current) return;
        const page: LogEvent[] = j.events || [];
        // Timeline pages arrive oldest first; older pages precede the current page.
        setEvents(prev => !more ? page : around
          ? [...page, ...prev].slice(0, 2000)
          : [...prev, ...page].slice(-2000));
        setError(undefined);
        setCursor(j.nextCursor);

      } catch (err) { if (id === requestId.current) setError(String(err)); } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [params, cursor, around, setEvents]
  );

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, around]);

  // Live tail: filters are read through a ref so the subscription stays put while they change
  const liveFilter = useRef(filters);
  liveFilter.current = filters;
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.kind !== 'event') return;
        const f = liveFilter.current;
        const e = msg.event;
        if (!f.live || f.around || !matchesViewerFilters(e, f)) return;
        setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 2000)));
      }),
    [subscribe]
  );

  return (
    <section>
      {error && <p role="alert">{error}</p>}
      <div className="table-scroll"><table>
        <thead><tr>{['Time', 'Level', 'Device', 'Source', 'Type', 'Message / payload'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{visible.map(e => <EventRow key={e.id} ev={e} />)}</tbody>
      </table></div>
      {!visible.length && <p>{loading ? 'Loading…' : 'No events match these filters.'}</p>}
      {cursor && <button disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Show Older'}</button>}
      <p className="muted">{visible.length} events shown · {around ? 'oldest first · ±5 minutes' : 'newest first'} · viewer keeps up to 2,000 rows{filters.alertsOnly && ' · warnings/errors from loaded pages'}</p>
    </section>
  );
};

const LogSettingsView: React.FC = () => {
  const [s, setS] = useState<LogSettings | null>(null);
  const [error, setError] = useState('');
  const load = async () => {
    try { const r = await fetch('/api/settings'); if (!r.ok) throw new Error('Could not load settings'); setS(await r.json()); }
    catch (err) { setError(String(err)); }
  };
  useEffect(() => { load(); }, []);
  const save = async (patch: Partial<LogSettings>) => {
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!r.ok) throw new Error('Could not save settings');
      setS(await r.json()); setError('');
    } catch (err) { setError(String(err)); }
  };
  return <details><summary>Settings</summary>
    {error && <p role="alert">{error}</p>}
    {s && <form onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); save({ retentionDays: Number(form.get('retentionDays')) }); }}>
      <label>Retention days <input key={s.retentionDays} name="retentionDays" type="number" min="1" max="3650" defaultValue={s.retentionDays} required /></label>
      <button>Save</button><p className="muted">Detail: everything. P0 retains every file; archive verification and cleanup arrive in later parts.</p>
    </form>}
  </details>;
};
/** Fetch adapted from Manifexus src/components/ActivitySheet.tsx:839–854.
 * New banner/poll lifecycle: Manifexus has no active-status banner. */
const AlertsBanner: React.FC = () => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let pending: AbortController | undefined;
    const load = async () => {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const r = await fetch('/api/alerts', { cache: 'no-store', signal: controller.signal });
        if (!r.ok) throw new Error('Could not load alerts');
        const j = await r.json();
        if (!stopped) { setAlerts(j.alerts); setError(''); }
      } catch {
        if (!stopped) setError('Could not refresh alerts; displayed alerts may be out of date.');
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { stopped = true; clearInterval(timer); pending?.abort(); };
  }, []);
  if (!alerts.length && !error) return null;
  return <aside role="alert" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #dc2626', borderRadius: 6, padding: '12px 16px', marginBottom: 16 }}>
    {alerts.length > 0 && <><strong>Active alerts</strong><ul>{alerts.map((alert, i) => <li key={`${alert.source}:${alert.id}:${i}`}>{alert.message}</li>)}</ul></>}
    {error && <p>{error}</p>}
  </aside>;
};

export default function ActivitySheet() {
  const filters = useEventFilters();
  const [jumpTime, setJumpTime] = useState('');
  const devices = useMemo(() => eventOptions(filters.events, 'device', filters.device), [filters.events, filters.device]);
  const sources = useMemo(() => eventOptions(filters.events, 'source', filters.source), [filters.events, filters.source]);
  const listeners = useRef(new Set<(msg: LiveMessage) => void>());
  const subscribe = useCallback<Subscribe>(fn => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    if (!filters.live || filters.around) { setStatus(filters.around ? 'Timeline' : 'Paused'); return; }
    const es = new EventSource('/api/stream');
    es.onopen = () => setStatus('Live');
    es.onerror = () => setStatus('Reconnecting');
    es.onmessage = m => {
      let msg: LiveMessage;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg?.kind !== 'event' || !msg.event) return;
      for (const fn of listeners.current) fn(msg);
    };
    return () => es.close();
  }, [filters.live, filters.around]);
  return <main>
    <AlertsBanner />
    <header><h1>PTP-Logger</h1><span role="status">{status}</span></header>
    <div className="toolbar">
      <label>Level <select disabled={filters.alertsOnly} value={filters.level} onChange={e => filters.setLevel(e.target.value)}><option value="">All</option>{['trace','debug','info','warn','error'].map(l => <option key={l}>{l}</option>)}</select></label>
      <label>Device <select value={filters.device} onChange={e => filters.setDevice(e.target.value)}><option value="">All</option>{devices.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label>Source <select value={filters.source} onChange={e => filters.setSource(e.target.value)}><option value="">All</option>{sources.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <label><input type="checkbox" checked={filters.alertsOnly} onChange={e => filters.setAlertsOnly(e.target.checked)} /> Alerts only (warn + error)</label>
      <label>Search <input type="search" value={filters.search} onChange={e => filters.setSearch(e.target.value)} /></label>
      <label><input type="checkbox" disabled={!!filters.around} checked={filters.live && !filters.around} onChange={e => filters.setLive(e.target.checked)} /> Live tail</label>
      {['jsonl','csv'].map(format => <button key={format} disabled={filters.alertsOnly || !!filters.around} title={filters.alertsOnly || filters.around ? 'Return to all levels and latest events to export' : undefined} onClick={() => download(`/api/events/export?${filters.params({ format })}`)}>Export {format.toUpperCase()}</button>)}
    </div>
    <form className="toolbar" onSubmit={e => { e.preventDefault(); if (jumpTime) filters.setAround(new Date(jumpTime).toISOString()); }}>
      <label>Around time (local) <input type="datetime-local" step="1" required value={jumpTime} onChange={e => setJumpTime(e.target.value)} /></label>
      <button>Jump ±5 minutes</button>
      {filters.around && <button type="button" onClick={() => filters.setAround('')}>Return to latest</button>}
    </form>
    <EventsView subscribe={subscribe} filters={filters} />
    <LogSettingsView />
  </main>;
}
