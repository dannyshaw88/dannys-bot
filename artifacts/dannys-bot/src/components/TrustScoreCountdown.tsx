import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import { getTrustLevels } from "./TrustScoreBadge";
import {
  readLocalSlotTrustScore,
  saveSlotTrustScore,
} from "./slotTrustScoreStorage";

type TimerResponse = {
  scoreId?: string | null;
  running?: boolean;
  paused?: boolean;
  remainingMs?: number | null;
  expiresAt?: number | null;
};

type TimerCheckpoint = { scoreId: string; remainingMs: number };

function checkpointKey(serial: string, slotIdx: number): string {
  return `mobile_ts_timer_${serial}_${slotIdx}`;
}

function readCheckpoint(serial: string, slotIdx: number, scoreId: string): number | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(checkpointKey(serial, slotIdx)) ?? "null") as Partial<TimerCheckpoint> | null;
    return parsed?.scoreId === scoreId && typeof parsed.remainingMs === "number" && parsed.remainingMs > 0
      ? parsed.remainingMs
      : null;
  } catch {
    return null;
  }
}

function writeCheckpoint(serial: string, slotIdx: number, scoreId: string, remainingMs: number): void {
  try {
    localStorage.setItem(
      checkpointKey(serial, slotIdx),
      JSON.stringify({ scoreId, remainingMs: Math.max(0, Math.round(remainingMs)) }),
    );
  } catch {
    // The server remains authoritative when browser storage is unavailable.
  }
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Slot-owned TrustScore countdown. The server owns the start/pause/expiry
 * timestamps; this component only renders a smooth local countdown and asks
 * the server to promote the slot when the countdown reaches zero.
 */
export function TrustScoreCountdown({
  serial,
  slotIdx,
}: {
  serial: string;
  slotIdx: number;
}) {
  const levels = useMemo(() => getTrustLevels(), []);
  const [scoreId, setScoreId] = useState<string | null>(() =>
    readLocalSlotTrustScore(serial, slotIdx),
  );
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const currentIndex = levels.findIndex(level => level.id === scoreId);
  const nextScore = currentIndex >= 0 ? levels[currentIndex + 1] : null;

  const load = useCallback(async () => {
    if (!serial) {
      setRemainingMs(null);
      setExpiresAt(null);
      return;
    }
    try {
      const assignment = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score`,
        { credentials: "include", cache: "no-store" },
      );
      const assigned = assignment.ok
        ? await assignment.json() as { scoreId?: string | null }
        : null;
      const liveScoreId = assigned?.scoreId ?? null;
      setScoreId(liveScoreId);
      const liveIndex = levels.findIndex(level => level.id === liveScoreId);
      const liveNextScore = liveIndex >= 0 ? levels[liveIndex + 1] : null;
      if (!liveScoreId || !liveNextScore) {
        setRemainingMs(null);
        setExpiresAt(null);
        return;
      }
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score-timer`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Timer request failed");
      const data = await response.json() as TimerResponse;
      if (data.scoreId !== liveScoreId || data.paused) {
        setRemainingMs(null);
        setExpiresAt(null);
        return;
      }
      // A device can disappear from the Accounts list and later reappear.
      // Preserve the last displayed value across that unmount/remount instead
      // of allowing the server's wall-clock expiry to consume the timer while
      // the phone is disconnected.
      const checkpoint = readCheckpoint(serial, slotIdx, liveScoreId);
      const serverRemaining = typeof data.remainingMs === "number" ? data.remainingMs : 0;
      const effectiveRemaining = Math.max(serverRemaining, checkpoint ?? 0);
      if (!effectiveRemaining) {
        setRemainingMs(null);
        setExpiresAt(null);
        return;
      }
      setRemainingMs(effectiveRemaining);
      setExpiresAt(
        checkpoint && checkpoint > serverRemaining
          ? Date.now() + effectiveRemaining
          : typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
          ? data.expiresAt
          : Date.now() + effectiveRemaining,
      );
    } catch {
      // A transient request failure should not make a persisted timer vanish.
    }
  }, [levels, serial, slotIdx]);

  useEffect(() => {
    void load();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serial?: string; slotIdx?: number }>).detail;
      if (detail?.serial === serial && detail.slotIdx === slotIdx) void load();
    };
    window.addEventListener("mobile_trustscore_changed", onChanged);
    return () => window.removeEventListener("mobile_trustscore_changed", onChanged);
  }, [load, serial, slotIdx]);

  const advance = useCallback(async () => {
    if (advancing || !scoreId || !nextScore) return;
    setAdvancing(true);
    try {
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score-timer/advance`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedScoreId: scoreId,
            nextScoreId: nextScore.id,
            hasNextScore: currentIndex + 2 < levels.length,
          }),
        },
      );
      const data = response.ok
        ? await response.json() as { ok?: boolean; scoreId?: string | null }
        : null;
      if (data?.ok && data.scoreId) {
        await saveSlotTrustScore(
          serial,
          slotIdx,
          data.scoreId,
          currentIndex + 2 < levels.length,
        );
        setScoreId(data.scoreId);
        setRemainingMs(null);
        setExpiresAt(null);
      } else {
        await load();
      }
    } finally {
      setAdvancing(false);
    }
  }, [advancing, currentIndex, levels.length, load, nextScore, scoreId, serial, slotIdx]);

  useEffect(() => {
    if (remainingMs === null || expiresAt === null) return;
    const interval = window.setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemainingMs(left);
      if (left === 0) void advance();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [advance, expiresAt, remainingMs]);

  useEffect(() => {
    if (remainingMs === null || !scoreId) return;
    writeCheckpoint(serial, slotIdx, scoreId, remainingMs);
  }, [remainingMs, scoreId, serial, slotIdx]);

  if (remainingMs === null || !scoreId || !nextScore) return null;

  return (
    <span
      className="relative top-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 h-7 text-[11px] font-semibold text-muted-foreground whitespace-nowrap"
      title={`Time remaining on ${levels[currentIndex]?.label ?? "TrustScore"}`}
    >
      <Clock3 className="w-3 h-3 shrink-0" />
      {formatRemaining(remainingMs)}
    </span>
  );
}