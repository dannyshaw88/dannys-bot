import { getTrustLevels } from "./TrustScoreBadge";

const LOCAL_STORAGE_PREFIX = "mobile_ts_";
const SLOT_SCORE_CACHE_TTL_MS = 30_000;
const slotScoreCache = new Map<string, { scoreId: string | null; loadedAt: number }>();
const slotScoreRequests = new Map<string, Promise<string | null>>();

function slotScoreCacheKey(serial: string, slotIdx: number): string {
  return `${serial}:${slotIdx}`;
}

export function slotTrustScoreKey(serial: string, slotIdx: number): string {
  return `${LOCAL_STORAGE_PREFIX}${serial}_${slotIdx}`;
}

export function readLocalSlotTrustScore(serial: string, slotIdx: number): string | null {
  // The visible index is not an identity. Never hydrate a badge from an
  // index-keyed browser cache after another account has moved into that row.
  return null;
}

export function writeLocalSlotTrustScore(serial: string, slotIdx: number, scoreId: string | null): void {
  // Kept as a compatibility shim for callers from older components. Stable
  // account identity is resolved by the server from serial + current slotId.
}

export async function loadSlotTrustScore(serial: string, slotIdx: number): Promise<string | null> {
  if (!serial) return null;
  const cacheKey = slotScoreCacheKey(serial, slotIdx);
  const cached = slotScoreCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < SLOT_SCORE_CACHE_TTL_MS) {
    return cached.scoreId;
  }
  const existingRequest = slotScoreRequests.get(cacheKey);
  if (existingRequest) return existingRequest;

  const localScore = readLocalSlotTrustScore(serial, slotIdx);
  const request = (async () => {
    try {
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error(`Trust score request failed (${response.status})`);
      const data = await response.json() as { configured?: boolean; scoreId?: string | null };

      if (data.configured) {
        const scoreId = data.scoreId ?? null;
        writeLocalSlotTrustScore(serial, slotIdx, scoreId);
        slotScoreCache.set(cacheKey, { scoreId, loadedAt: Date.now() });
        return scoreId;
      }

      // Preserve values created by older builds and migrate them to the database.
      if (localScore) {
        await saveSlotTrustScore(serial, slotIdx, localScore);
      }
      slotScoreCache.set(cacheKey, { scoreId: localScore, loadedAt: Date.now() });
      return localScore;
    } catch {
      // Keep the badge usable if the API is temporarily unavailable.
      slotScoreCache.set(cacheKey, { scoreId: localScore, loadedAt: Date.now() });
      return localScore;
    } finally {
      slotScoreRequests.delete(cacheKey);
    }
  })();
  slotScoreRequests.set(cacheKey, request);
  return request;
}

export async function saveSlotTrustScore(
  serial: string,
  slotIdx: number,
  scoreId: string | null,
  hasNextScore = scoreId === null
    ? false
    : getTrustLevels().findIndex(level => level.id === scoreId) < getTrustLevels().length - 1,
): Promise<void> {
  slotScoreCache.set(slotScoreCacheKey(serial, slotIdx), { scoreId, loadedAt: Date.now() });
  writeLocalSlotTrustScore(serial, slotIdx, scoreId);
  const response = await fetch(
    `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scoreId, hasNextScore }),
    },
  );
  if (!response.ok) {
    throw new Error(`Trust score save failed (${response.status})`);
  }
  window.dispatchEvent(new CustomEvent("mobile_trustscore_changed", {
    detail: { serial, slotIdx, scoreId, hasNextScore },
  }));
}