import React from "react";
import { Button } from "@/components/ui/button";
import {
  useAppCloseGestureRecorder,
  type AppCloseGestureSwipe,
} from "./AppCloseGestureRecorder";

type DismissDirection = "auto" | "left" | "up" | "custom";
type DevicePrefsResponse = {
  dismissDirection?: DismissDirection;
  appCloseGestureMacro?: { swipes?: AppCloseGestureSwipe[] };
};

export function AppCloseGestureSettings({ serial }: { serial: string | null }) {
  const recorder = useAppCloseGestureRecorder();
  const [direction, setDirection] = React.useState<DismissDirection>("auto");
  const [macro, setMacro] = React.useState<AppCloseGestureSwipe[]>([]);
  const [savingDirection, setSavingDirection] = React.useState(false);
  const [savingMacro, setSavingMacro] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const lastSavedCaptureRef = React.useRef({ sessionId: 0, swipeCount: 0 });
  const saveQueueRef = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    let active = true;
    setDirection("auto");
    setMacro([]);
    setError(null);
    lastSavedCaptureRef.current = { sessionId: 0, swipeCount: 0 };
    if (!serial) return () => { active = false; };

    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`)
      .then(response => response.json())
      .then((prefs: DevicePrefsResponse) => {
        if (!active) return;
        setDirection(prefs.dismissDirection ?? "auto");
        setMacro(Array.isArray(prefs.appCloseGestureMacro?.swipes)
          ? prefs.appCloseGestureMacro.swipes.slice(0, 2)
          : []);
      })
      .catch(() => {
        if (active) setError("Could not load the saved app-close gesture");
      });

    return () => { active = false; };
  }, [serial]);

  React.useEffect(() => {
    if (recorder?.recording && recorder.serial !== serial) recorder.stop();
  }, [serial, recorder]);

  const saveDirection = async (next: DismissDirection) => {
    if (!serial) return;
    setDirection(next);
    setError(null);
    if (next !== "custom") recorder?.stop();
    setSavingDirection(true);
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissDirection: next }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `Could not save setting (${response.status})`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the app-close setting");
    } finally {
      setSavingDirection(false);
    }
  };

  const saveMacro = React.useCallback(async (swipes: AppCloseGestureSwipe[]) => {
    if (!serial || swipes.length === 0) return;
    setSavingMacro(true);
    setError(null);
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appCloseGestureMacro: { swipes: swipes.slice(0, 2) } }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `Could not save gesture (${response.status})`);
      setMacro(swipes.slice(0, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the recorded gesture");
    } finally {
      setSavingMacro(false);
    }
  }, [serial]);

  React.useEffect(() => {
    if (!serial || !recorder || recorder.serial !== serial || recorder.sessionId === 0) return;
    if (recorder.swipes.length === 0) {
      lastSavedCaptureRef.current = { sessionId: recorder.sessionId, swipeCount: 0 };
      return;
    }
    const previous = lastSavedCaptureRef.current;
    if (previous.sessionId === recorder.sessionId && previous.swipeCount >= recorder.swipes.length) return;
    lastSavedCaptureRef.current = {
      sessionId: recorder.sessionId,
      swipeCount: recorder.swipes.length,
    };
    const capturedSwipes = recorder.swipes.slice(0, 2);
    saveQueueRef.current = saveQueueRef.current
      .catch(() => {})
      .then(() => saveMacro(capturedSwipes));
  }, [serial, recorder, saveMacro]);

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <p className="text-sm font-semibold text-foreground">App Close Gesture</p>
      <p className="text-xs text-muted-foreground">
        How to dismiss an app from the recents screen at the end of an automation cycle.
        A custom macro can record up to two swipes on the live mirror.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={direction}
          onChange={event => {
            const next = event.target.value as DismissDirection;
            void saveDirection(next);
            if (next === "custom" && serial) recorder?.start(serial);
          }}
          disabled={!serial || savingDirection}
          className="text-sm bg-background border border-border rounded px-3 py-1.5 text-foreground disabled:opacity-50"
        >
          <option value="auto">Auto — detect by model</option>
          <option value="left">Swipe left</option>
          <option value="up">Swipe up</option>
          <option value="custom">Record my own gesture</option>
        </select>
        {savingDirection && <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>}
      </div>
      {direction === "custom" && serial && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Turn on the mirror, tap Android Recents, then swipe the app card(s) to record up to two dismiss swipes.
            Taps are not recorded.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-foreground">
              {recorder?.serial === serial && recorder.recording
                ? `Recording ${recorder.swipes.length}/2 — swipe on the mirror`
                : `${macro.length} swipe${macro.length === 1 ? "" : "s"} saved`}
            </span>
            {recorder?.recording && recorder.serial === serial ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => recorder.stop()}
                disabled={recorder.swipes.length === 0}
              >
                Finish recording
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => recorder?.start(serial)}
              >
                Record again
              </Button>
            )}
            {savingMacro && <span className="text-xs text-muted-foreground">Saving gesture…</span>}
            {error && <span className="text-xs text-destructive">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
