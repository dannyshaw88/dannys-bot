import * as https from "https";

const HIKER_HOST = "api.hikerapi.com";

/** Thrown when HikerAPI has no cached data for a user (not a hard error — caller may fall back). */
export class HikerCacheMissError extends Error {
  constructor(msg: string) { super(msg); this.name = "HikerCacheMissError"; }
}

function hikerGet(path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HIKER_HOST,
        path,
        method: "GET",
        headers: {
          "x-access-key": token,
          "Accept": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`HikerAPI parse error (${res.statusCode}): ${data.slice(0, 200)}`)); }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(25_000, () => { req.destroy(new Error("HikerAPI request timeout")); });
    req.end();
  });
}

// ── Module-level username → pk cache (shared across all HikerApiClient instances) ──
// Prevents repeated v1/user/by/username calls for the same username within the same
// server process. TTL of 24 h — profile PKs never change so a long TTL is safe.
const USERNAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
interface UsernameCacheEntry { data: { pk: string; username: string }; expiresAt: number; }
const usernameCache = new Map<string, UsernameCacheEntry>();

export class HikerApiClient {
  constructor(private readonly token: string) {}

  async testConnection(): Promise<boolean> {
    try {
      const j = await hikerGet(`/v1/user/by/username?username=instagram`, this.token);
      return !!(j?.pk);
    } catch {
      return false;
    }
  }

  async getUserByUsername(username: string): Promise<{ pk: string; username: string } | null> {
    const cacheKey = username.toLowerCase();
    const cached = usernameCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      if (!j?.pk) return null;
      const data = { pk: String(j.pk), username: String(j.username) };
      usernameCache.set(cacheKey, { data, expiresAt: Date.now() + USERNAME_CACHE_TTL_MS });
      return data;
    } catch (e: any) {
      console.error(`[hikerApi] getUserByUsername @${username} error: ${e?.message}`);
      return null;
    }
  }

  async getProfileStats(username: string): Promise<{ followersCount: number; followingCount: number; postsCount: number } | null> {
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      if (!j?.pk) return null;
      return {
        followersCount: Number(j.follower_count ?? j.edge_followed_by?.count ?? 0),
        followingCount: Number(j.following_count ?? j.edge_follow?.count ?? 0),
        postsCount:     Number(j.media_count ?? j.edge_owner_to_timeline_media?.count ?? 0),
      };
    } catch (e: any) {
      console.error(`[hikerApi] getProfileStats @${username} error: ${e?.message}`);
      return null;
    }
  }

  async getUserProfile(username: string): Promise<{ biography: string | null; fullName: string | null } | null> {
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      if (!j?.pk) return null;
      return {
        biography: j.biography ?? null,
        fullName: j.full_name ?? null,
      };
    } catch (e: any) {
      console.error(`[hikerApi] getUserProfile @${username} error: ${e?.message}`);
      return null;
    }
  }

  async getUserRecentMediaId(userId: string): Promise<string | null> {
    try {
      const j = await hikerGet(`/v1/user/medias?user_id=${encodeURIComponent(userId)}&amount=1`, this.token);
      const items: any[] = Array.isArray(j) ? j : [];
      if (!items.length) return null;
      const item = items[0];
      return String(item.id ?? item.pk ?? "") || null;
    } catch (e: any) {
      console.error(`[hikerApi] getUserRecentMediaId ${userId} error: ${e?.message}`);
      return null;
    }
  }

  async getFollowers(userId: string, max = 50): Promise<{ pk: string; username: string; fullName: string }[]> {
    const amount = Math.min(Math.max(max, 1), 200);

    const extractUsers = (j: any): { pk: string; username: string; fullName: string }[] => {
      const arr: any[] = Array.isArray(j) ? j
        : Array.isArray(j?.users)           ? j.users
        : Array.isArray(j?.items)           ? j.items
        : Array.isArray(j?.data)            ? j.data
        : Array.isArray(j?.response?.users) ? j.response.users
        : [];
      return arr
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({ pk: String(u.pk), username: String(u.username), fullName: String(u.full_name ?? "") }));
    };

    // Try /v2/ first (fresher cache).
    try {
      const j = await hikerGet(`/v2/user/followers?user_id=${encodeURIComponent(userId)}&amount=${amount}`, this.token);
      if (j && !Array.isArray(j) && (j.detail || j.exc_type)) {
        const detail: string = j.detail ?? j.exc_type ?? JSON.stringify(j);
        // "Entries not found" = transient cache miss → fall through to /v1/ fallback.
        if (/entries not found|not found/i.test(detail)) {
          console.log(`[hikerApi] getFollowers ${userId}: /v2/ cache miss ("${detail}"), trying /v1/…`);
          throw new HikerCacheMissError(detail);
        }
        const msg = `HikerAPI getFollowers error: ${detail}`;
        console.error(`[hikerApi] ${msg}`);
        throw new Error(msg);
      }
      const users = extractUsers(j);
      console.log(`[hikerApi] getFollowers userId=${userId} → ${users.length} users (v2, raw keys: ${JSON.stringify(Object.keys(j ?? {}))})`);
      return users.slice(0, max);
    } catch (e: any) {
      if (!(e instanceof HikerCacheMissError)) {
        console.error(`[hikerApi] getFollowers ${userId} error: ${e?.message}`);
        throw e;
      }
    }

    // /v1/ fallback — different cache layer, may have data when /v2/ doesn't.
    try {
      const j = await hikerGet(`/v1/user/followers?user_id=${encodeURIComponent(userId)}&amount=${amount}`, this.token);
      if (j && !Array.isArray(j) && (j.detail || j.exc_type)) {
        const detail: string = j.detail ?? j.exc_type ?? JSON.stringify(j);
        console.log(`[hikerApi] getFollowers ${userId}: /v1/ also cache miss ("${detail}")`);
        throw new HikerCacheMissError(`HikerAPI getFollowers error: ${detail}`);
      }
      const users = extractUsers(j);
      console.log(`[hikerApi] getFollowers userId=${userId} → ${users.length} users (v1 fallback, raw keys: ${JSON.stringify(Object.keys(j ?? {}))})`);
      return users.slice(0, max);
    } catch (e: any) {
      console.error(`[hikerApi] getFollowers ${userId} error (v1 fallback): ${e?.message}`);
      throw e;
    }
  }

  async getFollowings(userId: string, max = 50): Promise<{ pk: string; username: string; fullName: string }[]> {
    // Normalise any HikerAPI response shape into { users[], cursor, more }.
    const extractPage = (j: any): { users: { pk: string; username: string; fullName: string }[]; nextMaxId: string | null; more: boolean } => {
      // Unwrap a possible top-level `response` envelope.
      const envelope: any = (j && !Array.isArray(j) && j?.response && typeof j.response === "object") ? j.response : j;
      const arr: any[] = Array.isArray(envelope)       ? envelope
        : Array.isArray(envelope?.users)               ? envelope.users
        : Array.isArray(envelope?.items)               ? envelope.items
        : Array.isArray(envelope?.data)                ? envelope.data
        : Array.isArray(j?.users)                      ? j.users
        : Array.isArray(j?.items)                      ? j.items
        : Array.isArray(j?.data)                       ? j.data
        : [];
      const users = arr
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({ pk: String(u.pk), username: String(u.username), fullName: String(u.full_name ?? "") }));
      const nextMaxId = envelope?.next_max_id ? String(envelope.next_max_id) : null;
      const more: boolean = !!(envelope?.more_available ?? (users.length > 0 && !!nextMaxId));
      return { users, nextMaxId, more };
    };

    const PAGE_SIZE = 200;
    const accumulated: { pk: string; username: string; fullName: string }[] = [];
    let nextMaxId: string | null = null;
    const maxPages = Math.ceil(max / PAGE_SIZE) + 5; // safety ceiling

    for (let page = 0; page < maxPages && accumulated.length < max; page++) {
      let pageResult: { users: { pk: string; username: string; fullName: string }[]; nextMaxId: string | null; more: boolean } | null = null;

      // Try v2 first — it returns a proper paginated envelope with next_max_id.
      try {
        const qs = new URLSearchParams({ user_id: userId, amount: String(PAGE_SIZE) });
        if (nextMaxId) qs.set("next_max_id", nextMaxId);
        const j = await hikerGet(`/v2/user/following?${qs}`, this.token);
        if (j && !Array.isArray(j) && (j.detail || j.exc_type)) {
          const detail: string = j.detail ?? j.exc_type ?? JSON.stringify(j);
          if (/entries not found|not found/i.test(detail)) {
            console.log(`[hikerApi] getFollowings ${userId} page ${page}: /v2/ cache miss, trying /v1/…`);
          } else {
            console.warn(`[hikerApi] getFollowings ${userId} page ${page} v2 error: ${detail}`);
          }
        } else {
          pageResult = extractPage(j);
        }
      } catch (e: any) {
        console.warn(`[hikerApi] getFollowings v2 ${userId} page ${page}: ${e?.message} — trying v1`);
      }

      // Fall back to v1 if v2 failed or returned an error.
      if (!pageResult) {
        try {
          const qs = new URLSearchParams({ user_id: userId, amount: String(PAGE_SIZE) });
          if (nextMaxId) qs.set("next_max_id", nextMaxId);
          const j = await hikerGet(`/v1/user/following?${qs}`, this.token);
          if (j && !Array.isArray(j) && !j?.response && (j.detail || j.exc_type)) {
            console.warn(`[hikerApi] getFollowings ${userId} page ${page} v1 error: ${j.detail ?? j.exc_type}`);
            break;
          }
          pageResult = extractPage(j);
        } catch (e: any) {
          console.error(`[hikerApi] getFollowings ${userId} page ${page} v1 error: ${e?.message}`);
          break;
        }
      }

      accumulated.push(...pageResult.users);
      console.log(`[hikerApi] getFollowings ${userId} page ${page}: +${pageResult.users.length} (total ${accumulated.length}/${max}, nextMaxId=${pageResult.nextMaxId ?? "none"}, more=${pageResult.more})`);

      nextMaxId = pageResult.nextMaxId;
      if (!pageResult.more || !nextMaxId || pageResult.users.length === 0) break;
    }

    return accumulated.slice(0, max);
  }

  // Fetches shortcodes for trending Instagram Reels (media_type=2 / clips) from
  // popular high-volume accounts.  Falls back to getPublicShortcodes if no reel-
  // specific media is found.  Returns up to `n` shortcodes.
  async getTrendingReelShortcodes(n = 3): Promise<string[]> {
    const REEL_ACCOUNTS = ["instagram", "natgeo", "creators", "reels", "nasa", "discovery"];
    const shortcodes: string[] = [];

    for (const username of REEL_ACCOUNTS) {
      if (shortcodes.length >= n) break;
      try {
        const user = await this.getUserByUsername(username);
        if (!user) continue;
        const j = await hikerGet(
          `/v1/user/medias?user_id=${encodeURIComponent(user.pk)}&amount=12`,
          this.token,
        );
        const items: any[] = Array.isArray(j) ? j
          : Array.isArray(j?.response) ? j.response
          : Array.isArray(j?.items)    ? j.items
          : [];
        for (const item of items) {
          if (shortcodes.length >= n) break;
          const mediaType: number = item?.media_type ?? 0;
          const productType: string = item?.product_type ?? "";
          const isReel = mediaType === 2 || productType === "clips";
          if (!isReel) continue;
          const mediaId = String(item.id ?? item.pk ?? "");
          if (!mediaId) continue;
          const sc = item.code || this.mediaIdToShortcode(mediaId);
          if (sc && sc !== "0") shortcodes.push(sc);
        }
      } catch { /* non-fatal — best-effort */ }
    }

    if (shortcodes.length === 0) {
      return this.getPublicShortcodes(n);
    }
    return shortcodes.slice(0, n);
  }

  // Fetches shortcodes from well-known public Instagram accounts for use as
  // warmup browsing URLs before a signup attempt.  Returns up to `n` shortcodes.
  // Falls back gracefully: skips accounts that don't respond, returns whatever
  // was collected (may be fewer than `n`).
  async getPublicShortcodes(n = 3): Promise<string[]> {
    const WARMUP_ACCOUNTS = ["instagram", "natgeo", "nasa"];
    const shortcodes: string[] = [];

    for (const username of WARMUP_ACCOUNTS) {
      if (shortcodes.length >= n) break;
      try {
        const user = await this.getUserByUsername(username);
        if (!user) continue;
        const j = await hikerGet(
          `/v1/user/medias?user_id=${encodeURIComponent(user.pk)}&amount=6`,
          this.token,
        );
        const items: any[] = Array.isArray(j) ? j
          : Array.isArray(j?.response) ? j.response
          : Array.isArray(j?.items)    ? j.items
          : [];
        for (const item of items) {
          if (shortcodes.length >= n) break;
          const mediaId = String(item.id ?? item.pk ?? "");
          if (!mediaId) continue;
          const sc = item.code || this.mediaIdToShortcode(mediaId);
          if (sc && sc !== "0") shortcodes.push(sc);
        }
      } catch { /* non-fatal — warmup is best-effort */ }
    }
    return shortcodes;
  }

  // Converts a numeric media ID (e.g. "3123456789012345678_123") to the
  // base64url shortcode Instagram uses in post URLs.
  private mediaIdToShortcode(id: string): string {
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const numericPart = id.split("_")[0];
    let n = BigInt(numericPart);
    let result = "";
    while (n > 0n) {
      result = ALPHA[Number(n % 64n)] + result;
      n = n / 64n;
    }
    return result || "0";
  }

  // Fetches the recent photo/album feed of a username.
  // Returns the same shape as InstagramWebClient.getUserFeedItems so the
  // engine can swap between the two without any glue code.
  async getUserFeedItems(username: string): Promise<Array<{
    mediaId: string;
    shortcode: string;
    imageUrl: string;
    caption: string;
    takenAt: number;
  }>> {
    try {
      const user = await this.getUserByUsername(username);
      if (!user) {
        console.error(`[hikerApi] getUserFeedItems @${username}: user lookup returned null`);
        return [];
      }
      const j = await hikerGet(
        `/v1/user/medias?user_id=${encodeURIComponent(user.pk)}&amount=12`,
        this.token,
      );
      // HikerAPI may return an error object like { detail: "..." } — detect and throw early
      if (j && !Array.isArray(j) && typeof j.detail === "string") {
        console.error(`[hikerApi] getUserFeedItems @${username} (pk=${user.pk}): HikerAPI error — "${j.detail}"`);
        return [];
      }
      // HikerAPI may return a plain array OR a wrapper object — handle both
      const items: any[] = Array.isArray(j)
        ? j
        : Array.isArray(j?.response) ? j.response
        : Array.isArray(j?.items)    ? j.items
        : Array.isArray(j?.data)     ? j.data
        : [];
      if (items.length === 0) {
        console.error(`[hikerApi] getUserFeedItems @${username} (pk=${user.pk}): unexpected response shape — keys=${JSON.stringify(Object.keys(j ?? {}))}`);
      }
      const results: { mediaId: string; shortcode: string; imageUrl: string; caption: string; takenAt: number }[] = [];
      for (const item of items) {
        const mediaType: number = item?.media_type ?? 1;
        if (mediaType !== 1 && mediaType !== 8) continue;
        const mediaId = String(item.id ?? item.pk ?? "");
        if (!mediaId) continue;
        // HikerAPI sometimes returns `code` (the shortcode) directly
        const shortcode = item.code || this.mediaIdToShortcode(mediaId);
        const caption = item.caption?.text ?? item.caption ?? "";
        const takenAt = item.taken_at ?? Math.floor(Date.now() / 1000);
        const firstMedia = mediaType === 8 ? (item.carousel_media?.[0] ?? item) : item;
        const candidates: any[] = firstMedia.image_versions2?.candidates ?? [];
        const imageUrl = candidates[0]?.url ?? firstMedia.thumbnail_url ?? "";
        if (!imageUrl) continue;
        results.push({ mediaId, shortcode, imageUrl, caption: String(caption), takenAt });
      }
      return results;
    } catch (e: any) {
      console.error(`[hikerApi] getUserFeedItems @${username} error: ${e?.message}`);
      return [];
    }
  }

  async getHashtagUsers(
    hashtag: string,
    max = 50,
    cursor = "",
  ): Promise<{ users: { pk: string; username: string; fullName: string }[]; nextCursor: string | null }> {
    try {
      const tag = hashtag.replace(/^#/, "");
      const amount = Math.min(Math.max(max, 1), 200);
      const qs = new URLSearchParams({ name: tag, amount: String(amount) });
      if (cursor) qs.set("next_max_id", cursor);
      const j = await hikerGet(`/v2/hashtag/medias/recent?${qs}`, this.token);
      const response = j?.response ?? j;
      const sections: any[] = Array.isArray(response?.sections) ? response.sections : [];
      const seen = new Set<string>();
      const users: { pk: string; username: string; fullName: string }[] = [];
      for (const section of sections) {
        const lc = section?.layout_content ?? {};
        const medias: any[] = lc.medias ?? lc.fill_items ?? [];
        for (const item of medias) {
          const media = item?.media ?? item;
          const u = media?.user ?? media?.owner;
          if (!u?.pk || !u?.username) continue;
          if (seen.has(String(u.pk))) continue;
          seen.add(String(u.pk));
          users.push({ pk: String(u.pk), username: String(u.username), fullName: String(u.full_name ?? "") });
          if (users.length >= max) break;
        }
        if (users.length >= max) break;
      }
      const nextCursor = (response?.more_available && response?.next_max_id)
        ? String(response.next_max_id)
        : null;
      console.error(`[hikerApi] getHashtagUsers #${tag}: ${users.length} users, nextCursor=${nextCursor ?? "none"}`);
      return { users, nextCursor };
    } catch (e: any) {
      console.error(`[hikerApi] getHashtagUsers #${hashtag} error: ${e?.message}`);
      return { users: [], nextCursor: null };
    }
  }
}
