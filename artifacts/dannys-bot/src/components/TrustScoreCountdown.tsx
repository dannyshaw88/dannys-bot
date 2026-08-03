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
};

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
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const currentIndex = levels.findIndex(level => level.id === scoreId);
  const nextScore = currentIndex >= 0 ? levels[currentIndex + 1] : null;

  const load = useCallback(async () => {
    if (!serial) {
      setRemainingMs(null);
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
        return;
      }
      const response = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score-timer`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Timer request failed");
      const data = await response.json() as TimerResponse;
      if (data.scoreId !== liveScoreId || data.paused || !data.running || !data.remainingMs) {
        setRemainingMs(null);
        return;
      }
      setRemainingMs(data.remainingMs);
      setReceivedAt(Date.now());
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
        setReceivedAt(null);
      } else {
        await load();
      }
    } finally {
      setAdvancing(false);
    }
  }, [advancing, currentIndex, levels.length, load, nextScore, scoreId, serial, slotIdx]);

  useEffect(() => {
    if (remainingMs === null || receivedAt === null) return;
    const interval = window.setInterval(() => {
      const left = Math.max(0, remainingMs - (Date.now() - receivedAt));
      setRemainingMs(left);
      if (left === 0) void advance();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [advance, receivedAt, remainingMs]);

  if (remainingMs === null || !scoreId || !nextScore) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 h-7 text-[11px] font-semibold text-muted-foreground whitespace-nowrap"
      title={`Time remaining on ${levels[currentIndex]?.label ?? "TrustScore"}`}
    >
      <Clock3 className="w-3 h-3 shrink-0" />
      {formatRemaining(remainingMs)}
    </span>
  );
}