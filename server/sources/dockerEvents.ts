/** Copied from Manifexus server/observability.ts:119-206; adapted for the
 * logger's event schema, bounded streaming, resume, and explicit shutdown. */
import http from 'http';
import { record } from '../eventLog';

function handleDockerEvent(line: string): string | undefined {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object' || (e.Type && e.Type !== 'container')) return;
  const attrs = e.Actor?.Attributes || {};
  const cid = String(e.Actor?.ID || e.id || '');
  const name = String(attrs.name || cid.slice(0, 12));
  const action = String(e.Action || e.status || '');
  if (!action) return;
  // String-valued nanoseconds retain precision; Docker's numeric representation
  // is still sufficient for the millisecond timestamps used by the store.
  const nano = String(e.timeNano ?? '');
  const millis = /^\d+$/.test(nano) ? Number(BigInt(nano) / 1000000n) : NaN;
  const ts = Number.isFinite(millis) && Math.abs(millis) <= 8640000000000000
    ? new Date(millis).toISOString() : undefined;
  const health = action.startsWith('health_status:') ? action.split(':')[1].trim() : undefined;
  const data = {
    container: name,
    id: cid.slice(0, 12),
    action,
    exitCode: attrs.exitCode !== undefined && Number.isFinite(Number(attrs.exitCode)) ? Number(attrs.exitCode) : undefined,
    health,
  };
  const level = ['die', 'oom', 'kill'].includes(action) ? 'error' : health === 'unhealthy' ? 'warn' : 'info';
  record(level, 'container-event', `${name} ${action}`, data, { source: 'docker', device: 'brain', ts });
  return ts ? `${BigInt(nano) / 1000000000n}.${(BigInt(nano) % 1000000000n).toString().padStart(9, '0')}` : undefined;
}

export function watchDockerEvents(): () => void {
  let retry = 2000;
  let stopped = false;
  let since: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let req: http.ClientRequest | undefined;
  let response: http.IncomingMessage | undefined;
  const connect = () => {
    if (stopped) return;
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    // One reconnect per connection: resets fire on request and response.
    let reconnecting = false;
    const reconnect = () => {
      if (reconnecting || stopped) return;
      reconnecting = true;
      response?.destroy();
      req?.destroy();
      timer = setTimeout(connect, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60000);
    };
    req = http.request({
      socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
      path: `/events?filters=${filters}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
      method: 'GET', headers: { Host: 'docker' },
    }, (res) => {
      response = res;
      if (stopped || reconnecting) { res.destroy(); return; }
      if (res.statusCode !== 200) { reconnect(); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        let offset = 0;
        while (offset < chunk.length) {
          const nl = chunk.indexOf('\n', offset);
          const end = nl < 0 ? chunk.length : nl;
          // Reject an invalid/oversized stream without accumulating unlimited
          // memory. Reconnect from the last recorded event rather than skip it.
          if (buf.length + end - offset > 1024 * 1024) { reconnect(); return; }
          buf += chunk.slice(offset, end);
          if (nl < 0) break;
          const line = buf.trim();
          buf = '';
          if (line) {
            const cursor = handleDockerEvent(line);
            if (cursor) { since = cursor; retry = 2000; }
          }
          offset = nl + 1;
        }
      });
      res.on('end', () => {
        if (buf.trim()) {
          const cursor = handleDockerEvent(buf.trim());
          if (cursor) { since = cursor; retry = 2000; }
        }
        reconnect();
      });
      res.on('error', reconnect);
      res.on('close', reconnect);
    });
    req.on('error', reconnect);
    req.end();
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    response?.destroy();
    req?.destroy();
  };
}

export function startDockerEvents(): () => void {
  return process.env.DOCKER_EVENTS === 'off' ? () => {} : watchDockerEvents();
}
