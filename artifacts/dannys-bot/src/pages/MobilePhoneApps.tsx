/**
 * MobilePhoneApps — "Mobile Phone Apps" card + tool panel.
 *
 * Two exports:
 *   MobilePhoneApps      — the card shown in the slot list
 *   MobilePhoneAppsPanel — the full tool panel (shown when fingerprint is clicked)
 *
 * Both are kept here so all Mobile Phone Apps code lives in one place and is
 * never touched by changes to the surrounding Accounts / Settings UI.
 *
 * Props (MobilePhoneApps)
 *   serial      — ADB serial of the current device (null = no device)
 *   deviceName  — Human-readable display name shown in the section heading
 *   enabled     — current enabled state (reported by the panel via onEnabled)
 *   nextRunAt   — timestamp (ms) of next scheduled run, or null
 *   onOpenTool  — Called when the fingerprint button is clicked
 *   onToggle    — Called when the card-level toggle is changed; saves to API
 *
 * Props (MobilePhoneAppsPanel)
 *   serial             — ADB serial (needed for API calls)
 *   onBack             — Called to close the panel (no visible button, used by parent)
 *   onEnabled          — Reports enabled state up to parent
 *   onNextRunAt        — Reports nextRunAt up to parent (for card display)
 *   requestSlot        — Collision preventer: request a run slot
 *   releaseSlot        — Collision preventer: release the run slot
 *   cancelQueuedSlot   — Collision preventer: cancel a queued slot
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Fingerprint } from "lucide-react";

// Phone apps slot index used with the collision preventer — must not overlap
// with real Instagram account slot indices (0..N). 99 is safely out of range.
const PHONE_APPS_SLOT_IDX = 99;

// Module-level nextRunAt mirror so the panel can restore the countdown after a
// remount (same pattern as useAutomationSettings in MobilePage.tsx).
const _nextRunAtBySerial = new Map<string, number>();

// ── Brand icon SVGs ────────────────────────────────────────────────────────────

function ChromeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="#fff"/>
      <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" fill="#1A73E8"/>
      <path d="M12 8h10.39A10 10 0 0 0 2.06 9.22L7.22 18A4 4 0 0 1 8 12 4.01 4.01 0 0 1 12 8z" fill="#EA4335"/>
      <path d="M12 16a4 4 0 0 1-3.78-2.67L2.06 9.22A10 10 0 0 0 12 22a9.94 9.94 0 0 0 5-1.34L12.07 16z" fill="#34A853"/>
      <path d="M22 12a10 10 0 0 1-5 8.66L12.07 16A4 4 0 0 0 16 12z" fill="#FBBC05"/>
    </svg>
  );
}

function GooglePlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.18 23.76c.37.21.79.24 1.18.1l12.29-7.1-2.76-2.76-10.71 9.76z" fill="#EA4335"/>
      <path d="M22.47 10.22 18.9 8.15 15.77 11l3.13 3.13 3.6-2.08a1.55 1.55 0 0 0 0-2.69-.24-.14z" fill="#FBBC04"/>
      <path d="M2.36.24A1.55 1.55 0 0 0 2 1.22v21.56a1.55 1.55 0 0 0 .36.98l.12.11L14.89 11v-.29L2.48.13z" fill="#4285F4"/>
      <path d="M16.65 14.85 4.36 21.96c-.36.22-.77.23-1.14.06l-.12.11.12.11c.37.17.78.16 1.14-.06l12.29-7.1z" fill="#34A853"/>
    </svg>
  );
}

function SnapchatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2.4c-2.65 0-5.25 1.76-5.25 5.6v1.07l-1.06.22c-.36.07-.6.36-.48.72.07.35.42.59.9.66-.07.24-.24.47-.48.6-.6.42-1.5.6-2.34.66 0 .42 1.26.9 1.5.96.06.42.42 1.98 2.22 1.98.6 0 1.2-.12 1.74-.24.66.66 1.5 1.02 3.24 1.02s2.58-.36 3.24-1.02c.54.12 1.14.24 1.74.24 1.8 0 2.16-1.56 2.22-1.98.24-.06 1.5-.54 1.5-.96-.84-.06-1.74-.24-2.34-.66-.24-.13-.41-.36-.48-.6.48-.07.83-.31.9-.66.12-.36-.12-.65-.48-.72l-1.06-.22V8c0-3.84-2.6-5.6-5.25-5.6z" fill="#FFFC00" stroke="#555" strokeWidth="0.5"/>
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M23 7s-.3-2-1.2-2.8c-1.1-1.2-2.4-1.2-3-1.3C16.6 2.8 12 2.8 12 2.8s-4.6 0-6.8.1c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.3.7 11.5v2.1C.7 15.8 1 18 1 18s.3 2 1.2 2.8c1.1 1.2 2.6 1.1 3.3 1.2C7.6 22.2 12 22.2 12 22.2s4.6 0 6.8-.2c.6-.1 1.9-.1 3-1.3.9-.8 1.2-2.8 1.2-2.8s.3-2.2.3-4.5v-2.1C23.3 9.3 23 7 23 7z" fill="#FF0000"/>
      <path d="M9.7 15.5V8.5l6.6 3.5-6.6 3.5z" fill="#fff"/>
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 5L2 22l5.2-1.4C8.6 21.5 10.3 22 12 22c5.5 0 10-4.5 10-10S17.5 2 12 2z" fill="#25D366"/>
      <path d="M17.5 14.4c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.6c.1-.2.2-.3.2-.5 0-.2-.1-1.1-.5-1.5-.3-.4-.7-.4-.9-.4h-.7c-.2 0-.6.1-.9.4-.3.3-1.1 1.1-1.1 2.6s1.1 3 1.3 3.2c.2.2 2.2 3.4 5.4 4.7.8.3 1.4.5 1.8.6.8.2 1.5.2 2 .1.6-.1 1.9-.8 2.1-1.5.3-.7.3-1.4.2-1.5-.1-.1-.3-.1-.6-.2z" fill="#fff"/>
    </svg>
  );
}

// ── Card component ─────────────────────────────────────────────────────────────

interface MobilePhoneAppsProps {
  serial:      string | null | undefined;
  deviceName:  string;
  enabled:     boolean;
  nextRunAt:   number | null;
  onOpenTool:  () => void;
  onToggle:    (v: boolean) => void;
}

export function MobilePhoneApps({
  serial: _serial, deviceName, enabled, nextRunAt, onOpenTool, onToggle,
}: MobilePhoneAppsProps) {
  return (
    <>
      {/* Section heading */}
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-bold text-foreground">Mobile Phone Apps</h2>
        <span className="text-xs text-muted-foreground text-right shrink-0 pt-1">{deviceName}</span>
      </div>

      {/* Card */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">

          {/* Left: title + fingerprint button + toggle */}
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider min-w-[14rem]">
              Mobile Phone Apps
            </p>

            {/* Fingerprint / tool button */}
            <Button
              type="button"
              size="sm"
              className="px-2 text-[11px] gap-1.5 text-white hover:brightness-95 transition-all"
              style={{ background: "#1AD2F2", border: "none", height: 28, width: 28, padding: 0 }}
              onClick={onOpenTool}
            >
              <Fingerprint className="w-3.5 h-3.5 text-white" />
            </Button>

            {/* Live Switch toggle (mirrors the panel toggle; click saves immediately) */}
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <Switch
                checked={enabled}
                onCheckedChange={onToggle}
                className="shrink-0"
              />
              <span className={`text-[11px] font-semibold leading-tight whitespace-nowrap ${
                enabled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
              }`}>
                {enabled ? "Active" : "Disabled"}
              </span>
            </div>

            {/* Next run timestamp */}
            {enabled && nextRunAt && (
              <span className="text-[11px] text-muted-foreground whitespace-nowrap pl-2">
                Next run {new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>

          {/* Right: brand icons */}
          <div className="flex items-center gap-2 shrink-0">
            <ChromeIcon />
            <GooglePlayIcon />
            <SnapchatIcon />
            <YouTubeIcon />
            <WhatsAppIcon />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Panel component ────────────────────────────────────────────────────────────

interface MobilePhoneAppsPanelProps {
  serial:            string | null | undefined;
  onBack:            () => void;  // still needed by parent for navigation; no visible button
  onEnabled:         (v: boolean) => void;
  onNextRunAt:       (ts: number | null) => void;
  requestSlot?:      (idx: number, readyAt: number) => Promise<boolean>;
  releaseSlot?:      (idx: number, skipRest?: boolean) => void;
  cancelQueuedSlot?: (idx: number) => void;
}

const NUM_INPUT_CLASS = "w-16 text-center";

export function MobilePhoneAppsPanel({
  serial, onEnabled, onNextRunAt, requestSlot, releaseSlot, cancelQueuedSlot,
}: MobilePhoneAppsPanelProps) {
  const [enabled,     setEnabled]     = useState(false);
  const [intervalMin, setIntervalMin] = useState(25);
  const [intervalMax, setIntervalMax] = useState(99);
  const [nextRunAt,   setNextRunAt]   = useState<number | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [saveError,   setSaveError]   = useState<string | null>(null);

  // Always-current refs so the scheduler closure reads live values.
  const enabledRef     = useRef(enabled);
  const intervalMinRef = useRef(intervalMin);
  const intervalMaxRef = useRef(intervalMax);
  const nextRunAtRef   = useRef<number | null>(nextRunAt);
  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef     = useRef(false);
  const stopRef        = useRef(false);
  const serialRef      = useRef(serial);

  useEffect(() => { enabledRef.current     = enabled;     }, [enabled]);
  useEffect(() => { intervalMinRef.current = intervalMin; }, [intervalMin]);
  useEffect(() => { intervalMaxRef.current = intervalMax; }, [intervalMax]);
  useEffect(() => { serialRef.current      = serial;      }, [serial]);

  const updateNextRunAt = useCallback((ts: number | null) => {
    nextRunAtRef.current = ts;
    setNextRunAt(ts);
    onNextRunAt(ts);
    if (ts !== null && serial) _nextRunAtBySerial.set(serial, ts);
  }, [onNextRunAt, serial]);

  // ── Load settings from API ─────────────────────────────────────────────────
  useEffect(() => {
    if (!serial) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/phone-apps-settings`)
      .then(r => r.json())
      .then((d: any) => {
        if (!active) return;
        const en  = Boolean(d.enabled ?? false);
        const min = Number(d.intervalMin ?? 25);
        const max = Number(d.intervalMax ?? 99);
        setEnabled(en);
        setIntervalMin(min);
        setIntervalMax(max);
        enabledRef.current     = en;
        intervalMinRef.current = min;
        intervalMaxRef.current = max;
        onEnabled(en);

        // Restore nextRunAt from module-level mirror (survives remount).
        const savedTs = serial ? _nextRunAtBySerial.get(serial) : undefined;
        if (en && savedTs && savedTs > Date.now()) {
          updateNextRunAt(savedTs);
        } else if (en) {
          // First-time enable: schedule fresh.
          const delayMs = randomInterval(min, max);
          updateNextRunAt(Date.now() + delayMs);
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  // ── Save settings to API (debounced) ──────────────────────────────────────
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSettings = useCallback((en: boolean, min: number, max: number) => {
    if (!serialRef.current) return;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serialRef.current!)}/phone-apps-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: en, intervalMin: min, intervalMax: max }),
      })
        .then(r => r.json())
        .then(d => { if (!d.ok) setSaveError("Save failed"); else setSaveError(null); })
        .catch(() => setSaveError("Save failed"));
    }, 600);
  }, []);

  // ── Scheduler ─────────────────────────────────────────────────────────────
  const randomInterval = (min: number, max: number) =>
    Math.round((min + Math.random() * Math.max(0, max - min)) * 60_000);

  const scheduleNext = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const fireAt = Date.now() + delayMs;
    updateNextRunAt(fireAt);
    timerRef.current = setTimeout(runCycle, delayMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateNextRunAt]);

  const runCycle = useCallback(async () => {
    if (!enabledRef.current || runningRef.current || stopRef.current) return;
    runningRef.current = true;
    updateNextRunAt(null);

    const slotIdx = PHONE_APPS_SLOT_IDX;
    const hstTurnAt = nextRunAtRef.current ?? Date.now();

    // Acquire collision preventer slot.
    if (requestSlot) {
      const prevented = await requestSlot(slotIdx, hstTurnAt);
      if (stopRef.current) {
        releaseSlot?.(slotIdx, true);
        runningRef.current = false;
        return;
      }
      if (prevented) {
        // Was queued — slot already ran behind another; just skip and reschedule.
        void 0;
      }
    }

    // ── Execute phone apps tools here when implemented ─────────────────────
    // No tools yet — this is the scheduling framework only.
    // When tools are added they fire here.
    // ──────────────────────────────────────────────────────────────────────

    releaseSlot?.(slotIdx);
    runningRef.current = false;

    if (!stopRef.current && enabledRef.current) {
      const delayMs = randomInterval(intervalMinRef.current, intervalMaxRef.current);
      scheduleNext(delayMs);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSlot, releaseSlot, scheduleNext, updateNextRunAt]);

  // Start / stop the scheduler whenever enabled changes.
  useEffect(() => {
    if (loading) return; // don't schedule until settings have loaded
    if (enabled) {
      stopRef.current = false;
      // If we already have a nextRunAt (from API load / module mirror), honour it.
      const existing = nextRunAtRef.current;
      if (existing && existing > Date.now()) {
        scheduleNext(existing - Date.now());
      } else {
        const delayMs = randomInterval(intervalMin, intervalMax);
        scheduleNext(delayMs);
      }
    } else {
      stopRef.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      cancelQueuedSlot?.(PHONE_APPS_SLOT_IDX);
      updateNextRunAt(null);
    }
    return () => {
      stopRef.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleEnabled = (v: boolean) => {
    setEnabled(v);
    onEnabled(v);
    saveSettings(v, intervalMin, intervalMax);
  };

  const handleIntervalMin = (v: number) => {
    const clamped = Math.max(1, v);
    setIntervalMin(clamped);
    saveSettings(enabled, clamped, intervalMax);
  };

  const handleIntervalMax = (v: number) => {
    const clamped = Math.max(1, v);
    setIntervalMax(clamped);
    saveSettings(enabled, intervalMin, clamped);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — matches Instagram slot panel height; no back button */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30 min-h-[48px]">
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          Mobile Phone Apps
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* (STEP 1) Toggle + Run every X to Y minutes */}
            <div className="inline-flex self-start bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  (STEP1)
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={handleEnabled}
                  className="shrink-0"
                />
                <div className="flex flex-col min-w-0">
                  <span className={`text-sm font-semibold text-foreground whitespace-nowrap ${
                    enabled ? "text-green-600 dark:text-green-400" : ""
                  }`}>
                    {enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <div className="w-px self-stretch bg-border mx-1" />
                <Label className="text-sm text-muted-foreground whitespace-nowrap">Run every</Label>
                <Input
                  type="number"
                  min={1}
                  className={NUM_INPUT_CLASS}
                  value={intervalMin}
                  onChange={e => handleIntervalMin(Number(e.target.value))}
                />
                <span className="text-muted-foreground text-sm">to</span>
                <Input
                  type="number"
                  min={1}
                  className={NUM_INPUT_CLASS}
                  value={intervalMax}
                  onChange={e => handleIntervalMax(Number(e.target.value))}
                />
                <Label className="text-sm text-muted-foreground whitespace-nowrap">minutes</Label>
              </div>
            </div>

            {/* Next run timestamp */}
            {enabled && nextRunAt && (
              <p className="text-sm text-muted-foreground">
                Next run at{" "}
                <span className="font-semibold text-foreground">
                  {new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>{" "}
                on{" "}
                <span className="font-semibold text-foreground">
                  {new Date(nextRunAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}
                </span>
              </p>
            )}

            {saveError && (
              <p className="text-xs text-red-500">{saveError}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
