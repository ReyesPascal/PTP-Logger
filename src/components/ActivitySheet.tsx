/** Events/settings view adapted from Manifexus src/components/ActivitySheet.tsx. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEvent, LogSettings } from '../../server/eventLog';
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
function useEventFilters() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState('');
  const [device, setDevice] = useState('');
  const [source, setSource] = useState('');
  const [live, setLive] = useState(true);
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);
  const params = useCallback((extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ level, device, source, q: debounced, ...extra })) if (v) p.set(k, v);
    return p.toString();
  }, [level, device, source, debounced]);
  return { search, setSearch, debounced, level, setLevel, device, setDevice, source, setSource, live, setLive, params };
}
type EventFilters = ReturnType<typeof useEventFilters>;
const EventsView: React.FC<{ subscribe: Subscribe; filters: EventFilters }> = ({ subscribe, filters }) => {
  const [error, setError] = useState<string>();
  const { params, live, level, device, source, debounced } = filters;
  const [events, setEvents] = useState<LogEvent[]>([]);


  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current++; }, []);

  const load = useCallback(
    async (more = false) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const r = await fetch(`/api/events?${params({ limit: '300', before: more ? cursor : undefined })}`, { cache: 'no-store' });
        if (!r.ok) throw new Error('Could not load events');
        const j = await r.json();
        if (id !== requestId.current) return;
        setEvents((prev) => (more ? [...prev, ...(j.events || [])].slice(-2000) : j.events || []));
        setError(undefined);
        setCursor(j.nextCursor);

      } catch (err) { if (id === requestId.current) setError(String(err)); } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [params, cursor]
  );

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Live tail: filters are read through a ref so the subscription stays put while they change
  const liveFilter = useRef({ live, level, device, source, debounced });
  liveFilter.current = { live, level, device, source, debounced };
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.kind !== 'event') return;
        const { live: on, level: lv, device: dv, source: src, debounced: q } = liveFilter.current;
        const e = msg.event;
        if (!on || (lv && lv !== e.level)) return;
        if (dv && dv !== e.device) return;
        if (src && src !== e.source) return;
        if (q && !`${e.message} ${e.eventType} ${e.source} ${e.device || ''} ${JSON.stringify(e.payload ?? '')}`.toLowerCase().includes(q.toLowerCase())) return;
        setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 2000)));
      }),
    [subscribe]
  );

  return (
    <section>
      {error && <p role="alert">{error}</p>}
      <div className="table-scroll"><table>
        <thead><tr>{['Time', 'Level', 'Device', 'Source', 'Type', 'Message / payload'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{events.map(e => <EventRow key={e.id} ev={e} />)}</tbody>
      </table></div>
      {!events.length && <p>{loading ? 'Loading…' : 'No events match these filters.'}</p>}
      {cursor && <button disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Show Older'}</button>}
      <p className="muted">{events.length} events shown · newest first · viewer keeps up to 2,000 rows</p>
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
export default function ActivitySheet() {
  const filters = useEventFilters();
  const listeners = useRef(new Set<(msg: LiveMessage) => void>());
  const subscribe = useCallback<Subscribe>(fn => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    if (!filters.live) { setStatus('Paused'); return; }
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
  }, [filters.live]);
  return <main>
    <header><h1>PTP-Logger</h1><span role="status">{status}</span></header>
    <div className="toolbar">
      <label>Level <select value={filters.level} onChange={e => filters.setLevel(e.target.value)}><option value="">All</option>{['trace','debug','info','warn','error'].map(l => <option key={l}>{l}</option>)}</select></label>
      <label>Device <input placeholder="hisense, tcl, brain" value={filters.device} onChange={e => filters.setDevice(e.target.value)} /></label>
      <label>Source <input placeholder="tv-logcat, uu, logger…" value={filters.source} onChange={e => filters.setSource(e.target.value)} /></label>
      <label>Search <input type="search" value={filters.search} onChange={e => filters.setSearch(e.target.value)} /></label>
      <label><input type="checkbox" checked={filters.live} onChange={e => filters.setLive(e.target.checked)} /> Live tail</label>
      {['jsonl','csv'].map(format => <button key={format} onClick={() => download(`/api/events/export?${filters.params({ format })}`)}>Export {format.toUpperCase()}</button>)}
    </div>
    <EventsView subscribe={subscribe} filters={filters} />
    <LogSettingsView />
  </main>;
}
