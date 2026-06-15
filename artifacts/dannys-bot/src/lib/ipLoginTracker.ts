const STORAGE_KEY = "equinox_ipLoginEvents_v1";
const WINDOW_MS   = 90 * 60 * 1000;
const PRUNE_MS    = 24 * 60 * 60 * 1000;

interface LoginEvent {
  proxyKey: string;
  ts: number;
}

function makeKey(host: string, port?: number | null): string {
  return port ? `${host}:${port}` : host;
}

function readAll(): LoginEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as LoginEvent[];
    const cutoff = Date.now() - PRUNE_MS;
    return arr.filter(e => e.ts > cutoff);
  } catch {
    return [];
  }
}

function writeAll(events: LoginEvent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {}
}

export function recordLoginEvent(host: string | null | undefined, port?: number | null): void {
  if (!host) return;
  const events = readAll();
  events.push({ proxyKey: makeKey(host, port), ts: Date.now() });
  writeAll(events);
}

export function getMostRecentLoginMs(host: string | null | undefined, port?: number | null): number | null {
  if (!host) return null;
  const key    = makeKey(host, port);
  const cutoff = Date.now() - WINDOW_MS;
  const recent = readAll().filter(e => e.proxyKey === key && e.ts > cutoff);
  if (recent.length === 0) return null;
  return Math.max(...recent.map(e => e.ts));
}
