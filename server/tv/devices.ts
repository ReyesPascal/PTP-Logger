/** New: Manifexus has no MAC-based TV discovery implementation to adapt. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP, Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../eventLog';
import { globalLogService } from '../globalLogService';
import { readJsonSafe, writeJsonAtomic } from '../safeJson';

const execFileAsync = promisify(execFile);
const DEFAULT_MACS = 'hisense=e8:51:77:f6:b7:ce,tcl=38:e7:c0:3f:be:9d';
const FILE = path.join(DATA_DIR, 'devices.json');
export interface Device { mac: string; ip: string; lastSeen: string }
interface DiscoveryOptions {
  readNeighbours?: (signal: AbortSignal) => Promise<string>;
  probe?: (ip: string, signal: AbortSignal) => Promise<void>;
}
let devices: Record<string, Device> | undefined;
function configured() {
  const entries = (process.env.TV_MACS ?? DEFAULT_MACS).split(',').filter(s => s.trim()).map(entry => {
    const [label, mac, extra] = entry.trim().split('=').map(s => s.trim());
    if (!/^[a-zA-Z0-9_-]+$/.test(label) || !/^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(mac || '') || extra !== undefined) {
      throw new Error('TV_MACS must be comma-separated label=MAC pairs');
    }
    return [label, mac.toLowerCase()] as const;
  });
  return new Map(entries);
}
function savedDevices() {
  if (!devices) {
    devices = Object.create(null) as Record<string, Device>;
    const saved = readJsonSafe<unknown>(FILE, {});
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [label, value] of Object.entries(saved)) {
        const d = value as Device | null;
        if (d && typeof d.mac === 'string' && typeof d.ip === 'string' && isIP(d.ip) === 4 &&
            typeof d.lastSeen === 'string' && Number.isFinite(Date.parse(d.lastSeen))) devices[label] = { ...d };
      }
    }
  }
  return devices;
}
/** Labels shared by discovery and TV collectors, including custom TV_MACS entries. */
export function getDeviceLabels(): string[] { return [...configured().keys()]; }
/** Last known address, including while a TV is offline. Returns a copy. */
export function getDevice(label: string): Device | undefined {
  const device = savedDevices()[label];
  return device && configured().get(label) === device.mac ? { ...device } : undefined;
}
export function parseNeighbours(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const mac = fields[fields.indexOf('lladdr') + 1];
    if (fields.includes('lladdr') && isIP(fields[0]) === 4 &&
        !fields.includes('FAILED') && !fields.includes('INCOMPLETE') && mac) found.set(mac.toLowerCase(), fields[0]);
  }
  return found;
}
async function readNeighbours(signal: AbortSignal) {
  const { stdout } = await execFileAsync('ip', ['neigh'], { signal, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return stdout;
}
/** Only a TCP handshake to populate ARP; no ADB protocol or authentication. */
export function probeAddress(ip: string, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const socket = new Socket();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, 200);
    socket.once('connect', finish);
    socket.once('error', finish);
    signal.addEventListener('abort', finish, { once: true });
    socket.connect(5555, ip);
  });
}
export async function discoverDevices(signal: AbortSignal, options: DiscoveryOptions = {}): Promise<void> {
  const targets = configured();
  if (!targets.size || signal.aborted) return;
  const read = options.readNeighbours ?? readNeighbours;
  let found = parseNeighbours(await read(signal));
  if (signal.aborted) return;
  if ([...targets.values()].some(mac => !found.has(mac))) {
    const probe = options.probe ?? probeAddress;
    for (let first = 1; first <= 254 && !signal.aborted; first += 20) {
      await Promise.all(Array.from({ length: Math.min(20, 255 - first) }, (_, i) => probe(`192.168.4.${first + i}`, signal)));
    }
    if (signal.aborted) return;
    // Keep sightings from the first read if a neighbour ages out during the scan.
    found = new Map([...found, ...parseNeighbours(await read(signal))]);
  }
  if (signal.aborted) return;
  const next: Record<string, Device> = Object.assign(Object.create(null), savedDevices());
  let observed = false;
  for (const [label, mac] of targets) {
    const ip = found.get(mac);
    if (!ip) continue;
    observed = true;
    const previous = next[label];
    if (!previous || previous.ip !== ip || previous.mac !== mac) {
      // Write ahead to the common event store before changing state or publishing the address.
      globalLogService.log({ level: 'info', eventType: 'tv-ip-change', source: 'tv-discovery', device: label,
        message: `${label} TV address changed to ${ip}`, payload: { mac, ip, previousIp: previous?.ip ?? null } });
    }
    next[label] = { mac, ip, lastSeen: new Date().toISOString() };
  }
  if (observed) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(FILE, next);
    devices = next;
  }
}
/** Start only from startServer; one pass at a time, immediately and every five minutes. */
export function startDevices(options: DiscoveryOptions = {}): () => void {
  if (!configured().size) return () => {};
  const controller = new AbortController();
  let running = false;
  const run = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try { await discoverDevices(controller.signal, options); }
    catch (error) {
      if (!controller.signal.aborted) globalLogService.log({ level: 'warn', eventType: 'tv-discovery-error', source: 'tv-discovery',
        device: 'brain', message: 'TV discovery failed', error });
    } finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 5 * 60 * 1000);
  timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
