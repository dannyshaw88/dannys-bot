const STORAGE_KEY      = "equinox_ipLoginEvents_v1";
const PRUNE_MS         = 30 * 24 * 60 * 60 * 1000; // keep 30 days so we can check "established" status
const WINDOW_MS        = 24 * 60 * 60 * 1000;       // 24-hour login-count window
const ESTABLISHED_MS   = 24 * 60 * 60 * 1000;       // account is "established" if first login > 24h ago
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
    const arr    = JSON.parse(raw) as LoginEvent[];
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

/**
 * Returns true if a new-account login warning should be shown before verifying.
 *
 * Each browser verify = 1 login (browser + mobile API together count as 1).
 * Instagram appears to allow ~3 new account logins per IP per 24 hours.
 *
 * "Established" exception — an account is NOT counted toward the limit if its
 * first-ever login on this proxy was MORE THAN 24 hours ago.  Those accounts
 * have already been running on the IP for a full day and re-verifying them does
 * not appear to trigger the new-account limit.
 *
 * Warning fires only when BOTH conditions are true:
 *   1. This profileId is NOT "established" on this IP (first login ≤ 24 h ago, or never logged in here), AND
 *   2. At least 3 other distinct non-established profile IDs have already logged in on this IP in the last 24 h.
 */
export function shouldWarnForNewAccount(
  host: string | null | undefined,
  port: number | null | undefined,
  profileId: number,
): boolean {
  if (!host) return false;

  const key    = makeKey(host, port);
  const now    = Date.now();
  const window = now - WINDOW_MS;
  const estCut = now - ESTABLISHED_MS;

  const allForIp = readAll().filter(e => e.proxyKey === key);

  // Helper: find the earliest recorded login for a given profileId on this proxy.
  // Returns null if the account has never been seen on this proxy.
  function firstLoginTs(pid: number): number | null {
    const events = allForIp.filter(e => e.profileId === pid);
    if (events.length === 0) return null;
    return Math.min(...events.map(e => e.ts));
  }

  // An account is "established" on this proxy if its very first login was > 24h ago.
  function isEstablished(pid: number): boolean {
    const first = firstLoginTs(pid);
    return first !== null && first < estCut;
  }

  // This account is already established — re-verify is free, no warning needed.
  if (isEstablished(profileId)) return false;

  // Count distinct non-established profiles that logged in on this IP in the last 24h.
  const recentForIp = allForIp.filter(e => e.ts > window);
  const nonEstablishedInWindow = new Set(
    recentForIp
      .map(e => e.profileId)
      .filter((pid): pid is number => pid != null && !isEstablished(pid))
  );

  return nonEstablishedInWindow.size >= NEW_ACCOUNT_LIMIT;
}
