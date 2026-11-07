/** New: Manifexus has no active-alert aggregator or source registry. */
import { getProbeStates } from './sources/probes';
import { getPowerAlert } from './sources/brainHost';
import { getDiskAlert } from './diskCheck';

export interface Alert {
  id: string;
  level: 'warn' | 'error';
  source: string;
  device: string;
  message: string;
}

type AlertSource = () => readonly Alert[];
const sources = new Set<AlertSource>();

/** Sources return their current active alerts; unregister when their owner stops. */
export function registerAlertSource(source: AlertSource): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

/** Read cached collector state only; importing or reading alerts starts no work. */
export function getAlerts(): Alert[] {
  const alerts: Alert[] = [];
  for (const [device, state] of Object.entries(getProbeStates())) {
    if (state.up !== false) continue;
    const name = device === 'uu' ? 'Usenet Ultimate' : device;
    alerts.push({ id: `probe:${device}`, level: 'warn', source: 'probe', device,
      message: device === 'uu' || device === 'nzbdav' ? `${name} is down` : `TV ${device} is unreachable` });
  }
  const power = getPowerAlert();
  if (power) alerts.push({ id: 'power:brain', level: power.level, source: 'brain', device: 'brain', message: power.message });
  const disk = getDiskAlert();
  if (disk.active) alerts.push({ id: 'disk:brain', level: 'warn', source: 'logger', device: 'brain', message: 'Data disk has less than 5 GB free' });
  for (const source of sources) {
    for (const alert of source()) alerts.push({ ...alert });
  }
  return alerts;
}
