import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import { getTrustLevels } from "./TrustScoreBadge";
import {
  readLocalSlotTrustScore,
  publishSlotTrustScoreChanged,
} from "./slotTrustScoreStorage";
import { writeUiSpeedLog } from "@/lib/uiSpeedLog";

type TimerResponse = {
  scoreId?: string | null;
  running?: boolean;
  paused?: boolean;
  remainingMs?: number | null;
  expiresAt?: number | null;
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
  slotId,
}: {
  serial: string;
  slotIdx: number;
  slotId?: string;
}) {
  const levels = useMemo(() => getTrustLevels(), []);
  const [scoreId, setScoreId] = useState<string | null>(() =>
    readLocalSlotTrustScore(serial, slotIdx),
  );
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const loadRequestRef = useRef(0);

  const currentIndex = levels.findIndex(level => level.id === scoreId);
  const nextScore = currentIndex >= 0 ? levels[currentIndex + 1] : null;

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrentRequest = () => requestId === loadRequestRef.current;
    if (!serial) {
      setRemainingMs(null);
      setExpiresAt(null);
      return;
    }
    const startedAt = performance.now();
    writeUiSpeedLog("trust-score-countdown-start", { serial, slotIdx });
    try {
      const assignment = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score`,
        { credentials: "include", cache: "no-store" },
      );
      const assigned = assignment.ok
        ? await assignment.json() as { scoreId?: string | null }
        : null;
      if (!isCurrentRequest()) return;
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
      if (!isCurrentRequest()) return;
      if (data.scoreId !== liveScoreId || data.paused) {
        setRemainingMs(null);
        setExpiresAt(null);
        return;
      }
      // The server owns the wall-clock expiry. Never replace an expired server
      // timer with an older browser checkpoint: doing that makes the countdown
      // recycle its previous value and delays promotion to the next label.
      const serverRemaining = typeof data.remainingMs === "number" ? data.remainingMs : 0;
      if (serverRemaining <= 0) {
        // Keep a zero-valued state long enough for the interval effect to call
        // advance(). This also promotes an already-expired timer after a page
        // remount instead of waiting for another manual assignment.
        setRemainingMs(0);
        setExpiresAt(Date.now() - 1);
        return;
      }
      setRemainingMs(serverRemaining);
      setExpiresAt(
        typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
          ? data.expiresAt
          : Date.now() + serverRemaining,
      );
      writeUiSpeedLog("trust-score-countdown-ready", {
        serial,
        slotIdx,
        scoreId: liveScoreId,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
    } catch {
      writeUiSpeedLog("trust-score-countdown-failed", {
        serial,
        slotIdx,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      // A transient request failure should not make a persisted timer vanish.
    }
  }, [levels, serial, slotIdx, slotId]);

  useEffect(() => {
    if (!serial) return;
    // Hydrate immediately. Delaying this by 900ms made the countdown the last
    // element to appear in the account slot row after device navigation.
    void load();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serial?: string; slotIdx?: number }>).detail;
      if (detail?.serial === serial && detail.slotIdx === slotIdx) void load();
    };
    window.addEventListener("mobile_trustscore_changed", onChanged);
    return () => {
      window.removeEventListener("mobile_trustscore_changed", onChanged);
    };
  }, [load, serial, slotIdx]);

  const advance = useCallback(async () => {
    if (advancing || !scoreId || !nextScore) return;
    setAdvancing(true);
    // Invalidate an assignment/timer read that began before this promotion.
    // Its response must not restore the old score after the advance succeeds.
    loadRequestRef.current++;
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
        setScoreId(data.scoreId);
        setRemainingMs(null);
        setExpiresAt(null);
        // The advance endpoint already persisted both the new assignment and
        // its next timer. Publish that committed result directly rather than
        // issuing a second assignment write, which could fail/race and leave
        // the account-slot badge stuck on NOOB while the timer has advanced.
        publishSlotTrustScoreChanged(
          serial,
          slotIdx,
          data.scoreId,
          currentIndex + 2 < levels.length,
        );
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
  }, [advance, expiresAt]);

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