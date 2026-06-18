const STORAGE_KEY = "equinox_ipLoginEvents_v1";
const PRUNE_MS    = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_LIMIT = 3;

interface LoginEvent {
  proxyKey: string;
  ts: number;
  profileId?: number;
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

export function recordLoginEvent(host: string | null | undefined, port?: number | null, profileId?: number): void {
  if (!host) return;
  const events = readAll();
  events.push({ proxyKey: makeKey(host, port), ts: Date.now(), profileId });
  writeAll(events);
}

export function getMostRecentLoginMs(host: string | null | undefined, port?: number | null): number | null {
  if (!host) return null;
  const key    = makeKey(host, port);
  const cutoff = Date.now() - PRUNE_MS;
  const recent = readAll().filter(e => e.proxyKey === key && e.ts > cutoff);
  if (recent.length === 0) return null;
  return Math.max(...recent.map(e => e.ts));
}

/**
 * Returns true if a new-account login warning should be shown before verifying.
 *
 * Warning fires only when BOTH conditions are true:
 *   1. This profileId has NOT been verified on this IP in the last 24 h (new account on this IP), AND
 *   2. At least 3 other distinct profile IDs have already been verified on this IP today.
 *
 * Accounts that have been previously verified on this IP are excluded — they can be
 * re-verified freely (e.g. to refresh a session) without triggering the warning.
 */
export function shouldWarnForNewAccount(
  host: string | null | undefined,
  port: number | null | undefined,
  profileId: number,
): boolean {
  if (!host) return false;
  const key    = makeKey(host, port);
  const cutoff = Date.now() - PRUNE_MS;
  const recentForIp = readAll().filter(e => e.proxyKey === key && e.ts > cutoff);
  const alreadyKnown = recentForIp.some(e => e.profileId === profileId);
  if (alreadyKnown) return false;
  const distinctProfiles = new Set(recentForIp.map(e => e.profileId).filter((id): id is number => id != null));
  return distinctProfiles.size >= NEW_ACCOUNT_LIMIT;
}
