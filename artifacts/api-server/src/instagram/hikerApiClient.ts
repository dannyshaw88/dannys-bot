import * as https from "https";

const HIKER_HOST = "api.hikerapi.com";

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
      const j = await hikerGet(`/v1/user/medias/recent?user_id=${encodeURIComponent(userId)}&amount=1`, this.token);
      const items: any[] = Array.isArray(j) ? j : [];
      if (!items.length) return null;
      const item = items[0];
      return String(item.id ?? item.pk ?? "") || null;
    } catch (e: any) {
      console.error(`[hikerApi] getUserRecentMediaId ${userId} error: ${e?.message}`);
      return null;
    }
  }

  async getFollowers(userId: string, max = 50): Promise<{ pk: string; username: string }[]> {
    try {
      const amount = Math.min(Math.max(max, 1), 200);
      const j = await hikerGet(`/v1/user/followers?user_id=${encodeURIComponent(userId)}&amount=${amount}`, this.token);
      const users: any[] = Array.isArray(j) ? j : [];
      return users
        .filter((u: any) => u?.pk && u?.username)
        .map((u: any) => ({ pk: String(u.pk), username: String(u.username) }))
        .slice(0, max);
    } catch (e: any) {
      console.error(`[hikerApi] getFollowers ${userId} error: ${e?.message}`);
      return [];
    }
  }

  async getHashtagUsers(hashtag: string, max = 50): Promise<{ pk: string; username: string }[]> {
    try {
      const tag = hashtag.replace(/^#/, "");
      const amount = Math.min(Math.max(max, 1), 200);
      const j = await hikerGet(`/v1/hashtag/medias/recent?name=${encodeURIComponent(tag)}&amount=${amount}`, this.token);
      const items: any[] = Array.isArray(j) ? j : [];
      const seen = new Set<string>();
      const users: { pk: string; username: string }[] = [];
      for (const item of items) {
        const u = item?.user ?? item?.owner ?? item;
        if (!u?.pk || !u?.username) continue;
        if (seen.has(String(u.pk))) continue;
        seen.add(String(u.pk));
        users.push({ pk: String(u.pk), username: String(u.username) });
        if (users.length >= max) break;
      }
      return users;
    } catch (e: any) {
      console.error(`[hikerApi] getHashtagUsers #${hashtag} error: ${e?.message}`);
      return [];
    }
  }
}
