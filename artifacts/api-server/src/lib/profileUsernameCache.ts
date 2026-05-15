// Shared in-memory profile ID → username lookup.
// Populated by the automation engine on startup and kept up-to-date as
// profiles are loaded.  The HTTP logger reads from this synchronously —
// no async DB round-trip needed in the request path.
const _cache = new Map<number, string>();

export const profileUsernameCache = {
  set(id: number, username: string): void {
    _cache.set(id, username);
  },
  setMany(profiles: Array<{ id: number; username: string }>): void {
    for (const p of profiles) _cache.set(p.id, p.username);
  },
  get(id: number): string | undefined {
    return _cache.get(id);
  },
};
