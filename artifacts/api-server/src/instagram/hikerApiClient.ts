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
    try {
      const j = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(username)}`, this.token);
      if (!j?.pk) return null;
      return { pk: String(j.pk), username: String(j.username) };
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
    try {
      const amount = Math.min(Math.max(max, 1), 200);
      const j = await hikerGet(`/v2/user/followers?user_id=${encodeURIComponent(userId)}&amount=${amount}`, this.token);
      if (j && !Array.isArray(j) && (j.detail || j.exc_type)) {
        const detail: string = j.detail ?? j.exc_type ?? JSON.stringify(j);
        const msg = `HikerAPI getFollowers error: ${detail}`;
        console.error(`[hikerApi] ${msg}`);
        throw new Error(msg);
      }
      const users: any[] = Array.isArray(j) ? j
        : Array.isArray(j?.users) ? j.users
        : Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.data) ? j.data
        : Array.isArray(j?.response?.users) ? j.response.users
        : [];
      console.error(`[hikerApi] getFollowers userId=${userId} → ${users.length} users (raw keys: ${JSON.stringify(Object.keys(j ?? {}))})`);
      return users
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({ pk: String(u.pk), username: String(u.username), fullName: String(u.full_name ?? "") }))
        .slice(0, max);
    } catch (e: any) {
      console.error(`[hikerApi] getFollowers ${userId} error: ${e?.message}`);
      throw e;
    }
  }

  async getFollowings(userId: string, max = 50): Promise<{ pk: string; username: string; fullName: string }[]> {
    try {
      const amount = Math.min(Math.max(max, 1), 200);
      const j = await hikerGet(`/v1/user/following?user_id=${encodeURIComponent(userId)}&amount=${amount}`, this.token);
      const users: any[] = Array.isArray(j) ? j
        : Array.isArray(j?.users) ? j.users
        : Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.data) ? j.data
        : [];
      return users
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({ pk: String(u.pk), username: String(u.username), fullName: String(u.full_name ?? "") }))
        .slice(0, max);
    } catch (e: any) {
      console.error(`[hikerApi] getFollowings ${userId} error: ${e?.message}`);
      return [];
    }
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
