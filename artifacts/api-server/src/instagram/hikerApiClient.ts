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

// ── Module-level recently-seen reel shortcodes cache ─────────────────────────
// Tracks shortcodes returned in the last hour so consecutive warmup sessions
// never show the same reel twice.  TTL of 1 h keeps the pool rotating.
const SEEN_REELS_TTL_MS = 60 * 60 * 1000;
interface _SeenReelEntry { sc: string; addedAt: number; }
const _seenReels: _SeenReelEntry[] = [];

function _getSeenReelSet(): Set<string> {
  const now = Date.now();
  // Evict entries older than TTL (array is insertion-ordered so slice from front)
  while (_seenReels.length > 0 && now - _seenReels[0].addedAt > SEEN_REELS_TTL_MS) {
    _seenReels.shift();
  }
  return new Set(_seenReels.map(e => e.sc));
}

function _markReelSeen(sc: string): void {
  _seenReels.push({ sc, addedAt: Date.now() });
}

// ── Module-level username → pk cache (shared across all HikerApiClient instances) ──
// Prevents repeated v1/user/by/username calls for the same username within the same
// server process. TTL of 24 h — profile PKs never change so a long TTL is safe.
const USERNAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
interface UsernameCacheEntry { data: { pk: string; username: string }; expiresAt: number; }
const usernameCache = new Map<string, UsernameCacheEntry>();

// Normalise any HikerAPI user-object response shape into a flat user object.
// HikerAPI has returned user data at multiple levels across versions:
//   { pk, username, ... }          — legacy flat (v1 old)
//   { user: { pk, username } }     — wrapped in .user  (v1 current)
//   { response: { pk, username } } — wrapped in .response
//   { data: { pk, username } }     — wrapped in .data
//   { result: { pk, username } }   — wrapped in .result
function resolveUserObj(j: any): any | null {
  if (!j || typeof j !== "object") return null;
  // Try unwrap candidates in priority order
  const candidates = [j, j.user, j.response, j.data, j.result];
  for (const c of candidates) {
    if (c && typeof c === "object" && (c.pk || c.id)) return c;
  }
  return null;
}

export class HikerApiClient {
  constructor(private readonly token: string) {}

  async testConnection(): Promise<boolean> {
    // Try a few popular usernames — HikerAPI's cache may not have all of them
    const testUsernames = ["instagram", "cristiano", "leomessi"];
    for (const username of testUsernames) {
      try {
        const j = await hikerGet(`/v1/user/by/username?username=${username}`, this.token);
        const topKeys = j && typeof j === "object" ? Object.keys(j) : [];
        console.log(`[hikerApi] testConnection @${username} raw keys: ${JSON.stringify(topKeys)}`);

        // Explicit auth failure signals — these mean the token is bad
        if (j && typeof j === "object" && !Array.isArray(j)) {
          const msg = (j.detail ?? j.error ?? j.message ?? "").toString().toLowerCase();
          if (/invalid.*token|unauthorized|forbidden|not.*authenticat|api.?key/i.test(msg)) {
            console.error(`[hikerApi] testConnection: auth error — "${msg}"`);
            return false;
          }
          // {"state":false,"error":"Service Unavailable"} — service down, NOT an auth error
          if (j.state === false && j.error) {
            console.log(`[hikerApi] testConnection @${username}: service error "${j.error}", trying next username`);
            continue;
          }
        }

        // Resolved user object = definitive success
        const u = resolveUserObj(j);
        console.log(`[hikerApi] testConnection @${username} resolved pk=${u?.pk ?? u?.id ?? "null"}`);
        if (u?.pk || u?.id) return true;

        // Non-error non-empty object = API is reachable, token is likely valid
        if (j && typeof j === "object" && !Array.isArray(j) && topKeys.length > 0) {
          console.log(`[hikerApi] testConnection @${username}: got ${topKeys.length} keys — treating as connected`);
          return true;
        }

        // Empty array [] = endpoint reachable but no cached data — token is still valid
        if (Array.isArray(j)) {
          console.log(`[hikerApi] testConnection @${username}: got empty array — API reachable, token valid`);
          return true;
        }
      } catch (e: any) {
        console.error(`[hikerApi] testConnection @${username} error: ${e?.message}`);
      }
    }
    return false;
  }

  async getUserByUsername(username: string): Promise<{ pk: string; username: string } | null> {
    const cacheKey = username.toLowerCase();
    const cached = usernameCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      const u = resolveUserObj(j);
      if (!u?.pk && !u?.id) return null;
      const data = { pk: String(u.pk ?? u.id), username: String(u.username) };
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
      const u = resolveUserObj(j);
      if (!u?.pk && !u?.id) return null;
      return {
        followersCount: Number(u.follower_count ?? u.edge_followed_by?.count ?? 0),
        followingCount: Number(u.following_count ?? u.edge_follow?.count ?? 0),
        postsCount:     Number(u.media_count ?? u.edge_owner_to_timeline_media?.count ?? 0),
      };
    } catch (e: any) {
      console.error(`[hikerApi] getProfileStats @${username} error: ${e?.message}`);
      return null;
    }
  }

  async getUserProfile(username: string): Promise<{ biography: string | null; fullName: string | null } | null> {
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      const u = resolveUserObj(j);
      if (!u?.pk && !u?.id) return null;
      return {
        biography: u.biography ?? null,
        fullName: u.full_name ?? null,
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

  async getFollowers(userId: string, max = 50): Promise<{ pk: string; username: string; fullName: string; isVerified?: boolean; isPrivate?: boolean; followerCount?: number }[]> {
    const amount = Math.min(Math.max(max, 1), 200);

    const extractUsers = (j: any): { pk: string; username: string; fullName: string; isVerified?: boolean; isPrivate?: boolean; followerCount?: number }[] => {
      const arr: any[] = Array.isArray(j) ? j
        : Array.isArray(j?.users)           ? j.users
        : Array.isArray(j?.items)           ? j.items
        : Array.isArray(j?.data)            ? j.data
        : Array.isArray(j?.response?.users) ? j.response.users
        : [];
      return arr
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({
          pk: String(u.pk),
          username: String(u.username),
          fullName: String(u.full_name ?? ""),
          ...(u.is_verified  !== undefined && { isVerified:   Boolean(u.is_verified)            }),
          ...(u.is_private   !== undefined && { isPrivate:    Boolean(u.is_private)             }),
          ...(u.follower_count !== undefined && { followerCount: Number(u.follower_count)       }),
        }));
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

  // Fetches shortcodes for trending Instagram Reels by querying popular hashtags
  // (#reels, #viral, #trending, #fyp) via HikerAPI's hashtag endpoints.
  // This returns organic trending content from Instagram's actual trending pool,
  // NOT from high-profile corporate/celebrity accounts (NBA, CNN, ESPN, etc.).
  // Falls back to a neutral organic account list if the hashtag endpoints fail.
  async getTrendingReelShortcodes(n = 3): Promise<string[]> {
    // Hashtags that surface trending/viral Instagram Reels — shuffled per call
    const ALL_HASHTAGS = ["reels", "viral", "trending", "fyp", "explore", "instagram"];
    const hashtags = [...ALL_HASHTAGS];
    for (let i = hashtags.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [hashtags[i], hashtags[j]] = [hashtags[j], hashtags[i]];
    }

    const seen = _getSeenReelSet();
    const shortcodes: string[] = [];

    for (const tag of hashtags) {
      if (shortcodes.length >= n) break;
      try {
        let items: any[] = [];
        // Try v2 endpoint first, fall back to v1
        for (const endpoint of [
          `/v2/hashtag/medias/recent?name=${encodeURIComponent(tag)}&amount=20`,
          `/v1/hashtag/medias/recent?name=${encodeURIComponent(tag)}&amount=20`,
        ]) {
          try {
            const j = await hikerGet(endpoint, this.token);
            const raw: any[] = Array.isArray(j) ? j
              : Array.isArray(j?.response) ? j.response
              : Array.isArray(j?.items)    ? j.items
              : Array.isArray(j?.sections) ? (j.sections as any[]).flatMap((s: any) => s?.layout_content?.medias?.map((m: any) => m?.media) ?? [])
              : [];
            if (raw.length > 0) { items = raw; break; }
          } catch { /* try next endpoint */ }
        }
        for (const item of items) {
          if (shortcodes.length >= n) break;
          if (!item) continue;
          const mediaType: number = item?.media_type ?? 0;
          const productType: string = item?.product_type ?? "";
          const isReel = mediaType === 2 || productType === "clips";
          if (!isReel) continue;
          const mediaId = String(item.id ?? item.pk ?? "");
          if (!mediaId) continue;
          const sc = item.code || this.mediaIdToShortcode(mediaId);
          if (sc && sc !== "0" && !seen.has(sc)) {
            shortcodes.push(sc);
            _markReelSeen(sc);
            seen.add(sc);
          }
        }
        if (items.length > 0) {
          console.log(`[hikerApi] getTrendingReelShortcodes #${tag}: ${items.length} items, ${shortcodes.length}/${n} reels collected`);
        }
      } catch (err: any) {
        console.warn(`[hikerApi] getTrendingReelShortcodes #${tag} error: ${err?.message}`);
      }
    }

    if (shortcodes.length === 0) {
      console.warn(`[hikerApi] getTrendingReelShortcodes: hashtag endpoints returned nothing, falling back to organic accounts`);
      return this._getTrendingReelShortcodesFromAccounts(n);
    }
    return shortcodes.slice(0, n);
  }

  // Fallback: neutral organic/lifestyle accounts — NOT corporate brands or celebrities.
  // Only used when the hashtag-based approach returns nothing.
  private async _getTrendingReelShortcodesFromAccounts(n = 3): Promise<string[]> {
    const ALL_ORGANIC = [
      "instagram", "natgeo", "nasa", "discovery", "creators",
      "earthpix", "travelandleisure", "foodnetwork", "buzzfeed",
    ];
    const accounts = [...ALL_ORGANIC];
    for (let i = accounts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
    }
    const seen = _getSeenReelSet();
    const shortcodes: string[] = [];
    for (const username of accounts) {
      if (shortcodes.length >= n) break;
      try {
        const user = await this.getUserByUsername(username);
        if (!user) continue;
        const j = await hikerGet(
          `/v1/user/medias?user_id=${encodeURIComponent(user.pk)}&amount=20`,
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
          if (sc && sc !== "0" && !seen.has(sc)) {
            shortcodes.push(sc);
            _markReelSeen(sc);
            seen.add(sc);
          }
        }
      } catch { /* non-fatal */ }
    }
    if (shortcodes.length === 0) return this.getPublicShortcodes(n);
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

  // Fetches up to `count` posts from a user's feed by their user ID.
  // Returns the same {mediaId, shortcode, username} shape as viewUserFeed
  // so the engine can swap between the two without glue code.
  async getUserFeedByUserId(userId: string, count: number): Promise<Array<{mediaId: string; shortcode: string; username: string}>> {
    try {
      const j = await hikerGet(`/v1/user/medias?user_id=${encodeURIComponent(userId)}&amount=${Math.min(Math.max(count, 1), 20)}`, this.token);
      if (j && !Array.isArray(j) && typeof j.detail === "string") {
        console.error(`[hikerApi] getUserFeedByUserId ${userId}: HikerAPI error — "${j.detail}"`);
        return [];
      }
      const items: any[] = Array.isArray(j) ? j
        : Array.isArray(j?.response) ? j.response
        : Array.isArray(j?.items)    ? j.items
        : Array.isArray(j?.data)     ? j.data
        : [];
      const results: {mediaId: string; shortcode: string; username: string}[] = [];
      for (const item of items) {
        const mediaId = String(item.id ?? item.pk ?? "");
        if (!mediaId) continue;
        const shortcode = item.code || this.mediaIdToShortcode(mediaId);
        const username  = String(item.user?.username ?? "");
        results.push({ mediaId, shortcode, username });
      }
      return results;
    } catch (e: any) {
      console.error(`[hikerApi] getUserFeedByUserId ${userId} error: ${e?.message}`);
      return [];
    }
  }

  async getHashtagUsers(
    hashtag: string,
    max = 50,
    cursor = "",
  ): Promise<{ users: { pk: string; username: string; fullName: string; isVerified?: boolean; isPrivate?: boolean; followerCount?: number }[]; nextCursor: string | null }> {
    const tag = hashtag.replace(/^#/, "");
    const amount = Math.min(Math.max(max, 1), 200);

    // Extract users from any HikerAPI hashtag response shape.
    // Logs response structure so unexpected shapes are visible in server logs.
    const extractFromResponse = (j: any, endpointLabel: string): { users: { pk: string; username: string; fullName: string }[]; nextCursor: string | null } => {
      // Log top-level shape for diagnostics
      const topKeys = j && typeof j === "object" ? Object.keys(j) : [];
      console.log(`[hikerApi] getHashtagUsers #${tag} ${endpointLabel} raw keys: ${JSON.stringify(topKeys).slice(0, 200)}`);

      // Unwrap envelope — try j.response first, then j itself
      const envelope = (j?.response && typeof j.response === "object") ? j.response : j;
      const envKeys = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? Object.keys(envelope) : [];
      if (envKeys.length > 0 && envelope !== j) {
        console.log(`[hikerApi] getHashtagUsers #${tag} ${endpointLabel} envelope keys: ${JSON.stringify(envKeys).slice(0, 200)}`);
      }

      // Candidate flat arrays — ordered by likelihood for HikerAPI v1
      const flatItems: any[] = Array.isArray(envelope)              ? envelope
        : Array.isArray(envelope?.items)                            ? envelope.items
        : Array.isArray(envelope?.medias)                           ? envelope.medias
        : Array.isArray(envelope?.data)                             ? envelope.data
        : Array.isArray(envelope?.results)                          ? envelope.results
        : Array.isArray(envelope?.feed_items)                       ? envelope.feed_items
        : Array.isArray(j?.items)                                   ? j.items
        : Array.isArray(j?.medias)                                  ? j.medias
        : Array.isArray(j?.data)                                    ? j.data
        : [];

      if (flatItems.length > 0) {
        const sample = flatItems[0];
        const sampleKeys = sample && typeof sample === "object" ? Object.keys(sample) : [];
        console.log(`[hikerApi] getHashtagUsers #${tag} ${endpointLabel} first item keys: ${JSON.stringify(sampleKeys).slice(0, 200)}`);
        if (sample?.user) console.log(`[hikerApi] getHashtagUsers #${tag} ${endpointLabel} first item.user keys: ${JSON.stringify(Object.keys(sample.user)).slice(0, 100)}`);
      } else {
        console.log(`[hikerApi] getHashtagUsers #${tag} ${endpointLabel} no flat items found — raw sample: ${JSON.stringify(j)?.slice(0, 300)}`);
      }

      const seen = new Set<string>();
      const users: { pk: string; username: string; fullName: string; isVerified?: boolean; isPrivate?: boolean; followerCount?: number }[] = [];

      const pushUser = (u: any) => {
        users.push({
          pk: String(u.pk),
          username: String(u.username),
          fullName: String(u.full_name ?? ""),
          ...(u.is_verified   !== undefined && { isVerified:   Boolean(u.is_verified)   }),
          ...(u.is_private    !== undefined && { isPrivate:    Boolean(u.is_private)    }),
          ...(u.follower_count !== undefined && { followerCount: Number(u.follower_count) }),
        });
      };

      // Shape A: flat items array (HikerAPI v1 format — each item is a media object)
      for (const item of flatItems) {
        if (users.length >= max) break;
        const media = item?.media ?? item;
        // User can be nested (.user, .owner) or at the top level of the media
        const u = media?.user ?? media?.owner
          ?? (media?.pk && media?.username ? media : null);
        if (!u?.pk || !u?.username) continue;
        if (seen.has(String(u.pk))) continue;
        seen.add(String(u.pk));
        pushUser(u);
      }

      // Shape B: sections / layout_content (Instagram internal / HikerAPI v2 format)
      if (users.length === 0) {
        const sections: any[] = Array.isArray(envelope?.sections) ? envelope.sections : [];
        for (const section of sections) {
          if (users.length >= max) break;
          const lc = section?.layout_content ?? {};
          const medias: any[] = lc.medias ?? lc.fill_items ?? [];
          for (const item of medias) {
            if (users.length >= max) break;
            const media = item?.media ?? item;
            const u = media?.user ?? media?.owner
              ?? (media?.pk && media?.username ? media : null);
            if (!u?.pk || !u?.username) continue;
            if (seen.has(String(u.pk))) continue;
            seen.add(String(u.pk));
            pushUser(u);
          }
        }
      }

      const nextCursor = (envelope?.more_available && envelope?.next_max_id)
        ? String(envelope.next_max_id)
        : (j?.next_max_id ? String(j.next_max_id) : null);
      return { users, nextCursor };
    };

    // Build endpoint list to try in order.
    // v1 recent uses ?name=, v2 recent uses ?hashtag= (HikerAPI v2 param name differs).
    // Also try /top variants — HikerAPI's /recent cache is often empty for niche tags.
    const endpointList: Array<{ path: string; param: string }> = [
      { path: "/v1/hashtag/medias/recent", param: "name" },
      { path: "/v1/hashtag/medias/top",    param: "name" },
      { path: "/v2/hashtag/medias/recent", param: "hashtag" },
      { path: "/v2/hashtag/medias/top",    param: "hashtag" },
    ];

    for (const { path: endpoint, param } of endpointList) {
      try {
        const qs = new URLSearchParams({ [param]: tag, amount: String(amount) });
        if (cursor) qs.set("next_max_id", cursor);
        const j = await hikerGet(`${endpoint}?${qs}`, this.token);

        // Catch all error response shapes:
        // { detail: "..." } | { exc_type: "..." } | { state: false, error: "..." } | { error: "..." }
        if (j && !Array.isArray(j) && typeof j === "object") {
          const hasError = j.detail || j.exc_type || (j.state === false && j.error) || (typeof j.error === "string" && !j.items && !j.medias && !j.data && !j.response);
          if (hasError) {
            const detail: string = j.detail ?? j.exc_type ?? j.error ?? JSON.stringify(j);
            console.warn(`[hikerApi] getHashtagUsers #${tag} ${endpoint}: API error — "${detail}", trying next endpoint`);
            continue;
          }
        }

        const result = extractFromResponse(j, endpoint);
        console.log(`[hikerApi] getHashtagUsers #${tag} (${endpoint}): ${result.users.length} users, nextCursor=${result.nextCursor ?? "none"}`);

        if (result.users.length > 0) {
          return { users: result.users.slice(0, max), nextCursor: result.nextCursor };
        }
        console.warn(`[hikerApi] getHashtagUsers #${tag} ${endpoint}: 0 users, trying next endpoint`);
      } catch (e: any) {
        console.error(`[hikerApi] getHashtagUsers #${tag} ${endpoint} error: ${e?.message}`);
      }
    }

    return { users: [], nextCursor: null };
  }
}
