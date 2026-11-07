import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { globalLogService } from '../globalLogService';

export interface ProbeState {
  up: boolean | null;
  failures: number;
  checkedAt: string | null;
}
let states: Record<string, ProbeState> = {};
export function getProbeStates(): Record<string, ProbeState> {
  return Object.fromEntries(Object.entries(states).map(([device, state]) => [device, { ...state }]));
}

// Copied and adapted from Manifexus server/appIdentity.ts:118–161.
// Only the response status is needed: never retain or download response bodies.
function httpProbe(url: string, accepts: (status: number) => boolean, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'GET', signal, headers: { 'User-Agent': 'PTP-Logger', Accept: '*/*' } }, res => {
        resolve(accepts(res.statusCode || 0));
        res.destroy();
      });
      req.on('error', () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

// New: Manifexus has no TCP health-probe equivalent.
function tcpProbe(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, signal });
    socket.once('connect', () => { resolve(true); socket.destroy(); });
    socket.once('error', () => { resolve(false); socket.destroy(); });
  });
}

interface ProbeOptions {
  uuUrl?: string;
  nzbdavUrl?: string;
  tvHosts?: string;
  /** Allows disposable local TCP fixtures; production always uses 5555. */
  tvPort?: number;
}

export function startProbes(options: ProbeOptions = {}): () => void {
  const targets = new Map<string, (signal: AbortSignal) => Promise<boolean>>();
  const uuUrl = options.uuUrl ?? process.env.UU_URL ?? 'http://192.168.4.40:1337';
  const nzbdavUrl = options.nzbdavUrl ?? process.env.NZBDAV_URL ?? 'http://192.168.4.40:3000';
  targets.set('uu', signal => {
    try { return httpProbe(new URL('/manifest.json', uuUrl).href, s => s >= 200 && s < 300, signal); }
    catch { return Promise.resolve(false); }
  });
  targets.set('nzbdav', signal => httpProbe(nzbdavUrl, s => s > 0 && s < 500, signal));
  for (const entry of (options.tvHosts ?? process.env.TV_HOSTS ?? 'hisense=192.168.4.27,tcl=192.168.4.30').split(',')) {
    const separator = entry.indexOf('=');
    const device = entry.slice(0, separator).trim();
    const host = entry.slice(separator + 1).trim();
    if (separator < 1 || !device || !host || targets.has(device)) continue;
    targets.set(device, signal => tcpProbe(host, options.tvPort ?? 5555, signal));
  }
  const localStates: Record<string, ProbeState> = Object.fromEntries([...targets.keys()].map(device => [device, { up: null, failures: 0, checkedAt: null }]));
  states = localStates;
  let stopped = false;
  let running = false;
  const active = new Set<AbortController>();
  const check = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await Promise.all([...targets].map(async ([device, probe]) => {
        const controller = new AbortController();
        active.add(controller);
        const timeout = setTimeout(() => controller.abort(), 3000);
        timeout.unref();
        let up: boolean;
        try { up = await probe(controller.signal); }
        finally { clearTimeout(timeout); active.delete(controller); }
        if (stopped) return;
        const state = localStates[device];
        const failures = up ? 0 : Math.min(2, state.failures + 1);
        const next = up ? true : failures >= 2 ? false : state.up;
        // Persist the transition before publishing the new state.
        if (next !== null && next !== state.up) {
          globalLogService.log({ level: next ? 'info' : 'warn', eventType: next ? 'probe-up' : 'probe-down',
            source: 'probe', device, message: `${device} is ${next ? 'up' : 'down'}` });
        }
        state.up = next;
        state.failures = failures;
        state.checkedAt = new Date().toISOString();
      }));
    } finally { running = false; }
  };
  const run = () => { void check().catch(error => console.error('Health probes failed:', error)); };
  const timer = setInterval(run, 30000);
  timer.unref();
  run();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const controller of active) controller.abort();
  };
}
