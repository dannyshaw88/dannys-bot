// Shared in-memory profile ID → display label lookup.
// Stores accountLabel (the user-assigned friendly name from account settings)
// falling back to the Instagram username when no label is set.
// Populated by the automation engine on startup and refreshed every reconcile.
// The HTTP logger reads from this synchronously — no async DB round-trip in the
// request path.
const _cache = new Map<number, string>();

export const profileUsernameCache = {
  set(id: number, accountLabel: string | null | undefined, username: string): void {
    _cache.set(id, accountLabel || username);
  },
  setMany(profiles: Array<{ id: number; accountLabel?: string | null; username: string }>): void {
    for (const p of profiles) _cache.set(p.id, p.accountLabel || p.username);
  },
  get(id: number): string | undefined {
    return _cache.get(id);
  },
};
