/**
 * MobilePhoneApps — "Mobile Phone Apps" card + tool panel.
 *
 * Two exports:
 *   MobilePhoneApps      — the card shown in the slot list
 *   MobilePhoneAppsPanel — the full tool panel (shown when fingerprint is clicked)
 *
 * Both are kept here so all Mobile Phone Apps code lives in one place and is
 * never touched by changes to the surrounding Accounts / Settings UI.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Fingerprint, LockKeyhole, Loader2 } from "lucide-react";

// Collision preventer slot index reserved for phone apps (outside Instagram slot range 0..N).
const PHONE_APPS_SLOT_IDX = 99;

// Module-level nextRunAt mirror — survives panel remount (same pattern as useAutomationSettings).
const _nextRunAtBySerial = new Map<string, number>();

// ── Brand icon SVGs ────────────────────────────────────────────────────────────

function ChromeIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="#fff"/>
      <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" fill="#1A73E8"/>
      <path d="M12 8h10.39A10 10 0 0 0 2.06 9.22L7.22 18A4 4 0 0 1 8 12 4.01 4.01 0 0 1 12 8z" fill="#EA4335"/>
      <path d="M12 16a4 4 0 0 1-3.78-2.67L2.06 9.22A10 10 0 0 0 12 22a9.94 9.94 0 0 0 5-1.34L12.07 16z" fill="#34A853"/>
      <path d="M22 12a10 10 0 0 1-5 8.66L12.07 16A4 4 0 0 0 16 12z" fill="#FBBC05"/>
    </svg>
  );
}

function GooglePlayIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.18 23.76c.37.21.79.24 1.18.1l12.29-7.1-2.76-2.76-10.71 9.76z" fill="#EA4335"/>
      <path d="M22.47 10.22 18.9 8.15 15.77 11l3.13 3.13 3.6-2.08a1.55 1.55 0 0 0 0-2.69-.24-.14z" fill="#FBBC04"/>
      <path d="M2.36.24A1.55 1.55 0 0 0 2 1.22v21.56a1.55 1.55 0 0 0 .36.98l.12.11L14.89 11v-.29L2.48.13z" fill="#4285F4"/>
      <path d="M16.65 14.85 4.36 21.96c-.36.22-.77.23-1.14.06l-.12.11.12.11c.37.17.78.16 1.14-.06l12.29-7.1z" fill="#34A853"/>
    </svg>
  );
}

function SnapchatIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 1C8.13 1 5 4.13 5 8v5.5l-1.78.59c-.35.12-.52.5-.38.84.13.32.52.53 1.04.58-.13.35-.38.65-.73.84-.68.4-1.7.6-2.65.68.07.62 1.56 1.23 1.8 1.3.1.56.53 2.47 2.7 2.47.74 0 1.52-.17 2.25-.34C8.2 21.5 9.5 22.04 12 22.04c2.5 0 3.8-.54 4.75-1.58.73.17 1.51.34 2.25.34 2.17 0 2.6-1.91 2.7-2.47.24-.07 1.73-.68 1.8-1.3-.95-.08-1.97-.28-2.65-.68-.35-.19-.6-.49-.73-.84.52-.05.91-.26 1.04-.58.14-.34-.03-.72-.38-.84L19 13.5V8c0-3.87-3.13-7-7-7z" fill="#FFFC00" stroke="#888" strokeWidth="0.4"/>
    </svg>
  );
}

function YouTubeIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M23 7s-.3-2-1.2-2.8c-1.1-1.2-2.4-1.2-3-1.3C16.6 2.8 12 2.8 12 2.8s-4.6 0-6.8.1c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.3.7 11.5v2.1C.7 15.8 1 18 1 18s.3 2 1.2 2.8c1.1 1.2 2.6 1.1 3.3 1.2C7.6 22.2 12 22.2 12 22.2s4.6 0 6.8-.2c.6-.1 1.9-.1 3-1.3.9-.8 1.2-2.8 1.2-2.8s.3-2.2.3-4.5v-2.1C23.3 9.3 23 7 23 7z" fill="#FF0000"/>
      <path d="M9.7 15.5V8.5l6.6 3.5-6.6 3.5z" fill="#fff"/>
    </svg>
  );
}

function WhatsAppIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 5L2 22l5.2-1.4C8.6 21.5 10.3 22 12 22c5.5 0 10-4.5 10-10S17.5 2 12 2z" fill="#25D366"/>
      <path d="M17.5 14.4c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.6c.1-.2.2-.3.2-.5 0-.2-.1-1.1-.5-1.5-.3-.4-.7-.4-.9-.4h-.7c-.2 0-.6.1-.9.4-.3.3-1.1 1.1-1.1 2.6s1.1 3 1.3 3.2c.2.2 2.2 3.4 5.4 4.7.8.3 1.4.5 1.8.6.8.2 1.5.2 2 .1.6-.1 1.9-.8 2.1-1.5.3-.7.3-1.4.2-1.5-.1-.1-.3-.1-.6-.2z" fill="#fff"/>
    </svg>
  );
}

// ── Shared style helpers ───────────────────────────────────────────────────────

const PCT_INPUT = "w-14 text-center h-7 text-sm px-1";

// ── App tool slot config type ─────────────────────────────────────────────────

interface AppSlotSettings {
  activatePctMin: number;
  activatePctMax: number;
  /** Number-of-scrolls range — used by Chrome and YouTube. */
  scrollMin?: number;
  scrollMax?: number;
  /** Number-of-story-taps range — only used by Chrome. */
  storyTapMin?: number;
  storyTapMax?: number;
  /** Scrolls to do inside each tapped story page before pressing Back — only used by Chrome. */
  tappedStoryScrollMin?: number;
  tappedStoryScrollMax?: number;
  /** Per-article chance (0–100%) to tap an internal link before pressing Back — only used by Chrome. */
  internalLinkPctMin?: number;
  internalLinkPctMax?: number;
  /** Chance (0–100%) to perform an ordinary Google search after Chrome activity. */
  manualSearchPctMin?: number;
  manualSearchPctMax?: number;
  /** Number of fresh Google queries to run when Manual Searches activates. */
  manualSearchCountMin?: number;
  manualSearchCountMax?: number;
  /** Scrolls to perform on each Google results page. */
  manualSearchScrollMin?: number;
  manualSearchScrollMax?: number;
  /** Chance (0–100%) to open one confirmed result on each results page. */
  manualSearchLinkPctMin?: number;
  manualSearchLinkPctMax?: number;
  /** Seconds to dwell on a manually opened Google result. */
  manualSearchDwellMin?: number;
  manualSearchDwellMax?: number;
  /** Number of trending stories to tap on the Google homepage. */
  tapTrendingStoryMin?: number;
  tapTrendingStoryMax?: number;
  /** Chance (0–100%) to tap a video item after scrolling — only used by YouTube. */
  clickPctMin?: number;
  clickPctMax?: number;
  /** Seconds to spend watching a tapped video — only used by YouTube. */
  watchTimeMin?: number;
  watchTimeMax?: number;
  /** Chance (0–100%) to tap the Shorts tab after the video section — only used by YouTube. */
  clickShortsPctMin?: number;
  clickShortsPctMax?: number;
  /** Number of swipe-ups in the Shorts feed — only used by YouTube. */
  shortsScrollMin?: number;
  shortsScrollMax?: number;
  /** Seconds to spend on each Short — only used by YouTube. */
  shortsWatchTimeMin?: number;
  shortsWatchTimeMax?: number;
  /** Chance (0–100%) to like each Short viewed — only used by YouTube. */
  shortsLikePctMin?: number;
  shortsLikePctMax?: number;
}

interface PhoneAppsSettings {
  enabled:      boolean;
  intervalMin:  number;
  intervalMax:  number;
  chrome:       AppSlotSettings;
  googlePlay:   AppSlotSettings;
  snapchat:     AppSlotSettings;
  youtube:      AppSlotSettings;
  whatsapp:     AppSlotSettings;
}

type PhoneAppsCompletionStatus = "idle" | "running" | "locking" | "locked" | "error";

const DEFAULT_APP_SLOT: AppSlotSettings = { activatePctMin: 0, activatePctMax: 0 };

const DEFAULT_SETTINGS: PhoneAppsSettings = {
  enabled: false, intervalMin: 25, intervalMax: 99,
  chrome:     { ...DEFAULT_APP_SLOT, scrollMin: 1, scrollMax: 5, storyTapMin: 0, storyTapMax: 0, tappedStoryScrollMin: 0, tappedStoryScrollMax: 0, internalLinkPctMin: 0, internalLinkPctMax: 0, manualSearchPctMin: 0, manualSearchPctMax: 0, manualSearchCountMin: 1, manualSearchCountMax: 1, manualSearchScrollMin: 0, manualSearchScrollMax: 0, manualSearchLinkPctMin: 0, manualSearchLinkPctMax: 0, manualSearchDwellMin: 3, manualSearchDwellMax: 8, tapTrendingStoryMin: 0, tapTrendingStoryMax: 0 },
  googlePlay: { ...DEFAULT_APP_SLOT },
  snapchat:   { ...DEFAULT_APP_SLOT },
  youtube:    { ...DEFAULT_APP_SLOT, scrollMin: 1, scrollMax: 5, clickPctMin: 0, clickPctMax: 0, watchTimeMin: 3, watchTimeMax: 8, clickShortsPctMin: 0, clickShortsPctMax: 0, shortsScrollMin: 0, shortsScrollMax: 0, shortsWatchTimeMin: 3, shortsWatchTimeMax: 8, shortsLikePctMin: 0, shortsLikePctMax: 0 },
  whatsapp:   { ...DEFAULT_APP_SLOT },
};

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
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider min-w-[200px] shrink-0">
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

            {/* Switch toggle — reflects enabled state, saves immediately when clicked */}
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <Switch checked={enabled} onCheckedChange={onToggle} className="shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className={`text-[11px] font-semibold leading-tight whitespace-nowrap ${
                  enabled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
                }`}>
                  {enabled ? "Active" : "Disabled"}
                </span>
                {enabled && nextRunAt && (
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    Next run at {new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} on {new Date(nextRunAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}
                  </span>
                )}
              </div>
            </div>
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

// ── App slot row ───────────────────────────────────────────────────────────────

interface AppSlotRowProps {
  icon:       React.ReactNode;
  label:      string;
  className?: string;
  min:        number;
  max:        number;
  onMin:      (v: number) => void;
  onMax:      (v: number) => void;
  rowExtras?: React.ReactNode; // optional inline fields rendered after the % label on row 1
  row2?:      React.ReactNode; // optional second row rendered below row 1, full width
  row3?:      React.ReactNode; // optional third row rendered below row 2, full width
  row4?:      React.ReactNode; // optional fourth row rendered below row 3, full width
}

function AppSlotRow({ icon, label, className, min, max, onMin, onMax, rowExtras, row2, row3, row4 }: AppSlotRowProps) {
  return (
    <div className={`p-4 ${className ?? ""}`}>
      {/* First visual row: icon, activation, and the app's primary fields. */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Icon + label — anchors the left of the first visual row */}
        <div className="flex items-center gap-2 min-w-[9rem]">
          {icon}
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>

        {/* Activation % */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Activation %</span>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={100}
              className={PCT_INPUT}
              value={min}
              onChange={e => onMin(Math.min(100, Math.max(0, Number(e.target.value))))}
            />
            <span className="text-muted-foreground text-sm">to</span>
            <Input
              type="number"
              min={0}
              max={100}
              className={PCT_INPUT}
              value={max}
              onChange={e => onMax(Math.min(100, Math.max(0, Number(e.target.value))))}
            />
            <span className="text-muted-foreground text-sm">%</span>
          </div>
        </div>

        {/* Fields that belong to the first visual row. */}
        {rowExtras}

        {/* Explicit full-width rows. These must not depend on available width
            or happenstance flex wrapping to appear as separate rows. */}
        {row2 && (
          <div className="basis-full w-full grid grid-cols-5 items-center gap-4 [&>*:not(:first-child)]:-translate-x-[6px]">
            {row2}
          </div>
        )}
        {row3 && (
          <div className="basis-full w-full flex items-center gap-4 flex-wrap">
            {row3}
          </div>
        )}
        {row4 && (
          <div className="basis-full w-full flex items-center gap-4 flex-wrap">
            {row4}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Panel component ────────────────────────────────────────────────────────────

interface MobilePhoneAppsPanelProps {
  serial:            string | null | undefined;
  onBack:            () => void;  // no visible button; parent uses this to close
  onEnabled:         (v: boolean) => void;
  onNextRunAt:       (ts: number | null) => void;
  onRunning?:        (running: boolean) => void;
  onLog?:            (msg: string) => void;
  requestSlot?:      (idx: number, readyAt: number, onQueued?: () => void) => Promise<boolean>;
  releaseSlot?:      (idx: number, skipRest?: boolean) => void;
  cancelQueuedSlot?: (idx: number) => void;
}

const NUM_INPUT_CLASS = "w-16 text-center";

export function MobilePhoneAppsPanel({
  serial, onEnabled, onNextRunAt, onRunning, onLog, requestSlot, releaseSlot, cancelQueuedSlot,
}: MobilePhoneAppsPanelProps) {
  const [settings,    setSettings]    = useState<PhoneAppsSettings>(DEFAULT_SETTINGS);
  const [nextRunAt,   setNextRunAt]   = useState<number | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [completionStatus, setCompletionStatus] = useState<PhoneAppsCompletionStatus>("idle");

  // Always-current refs for use inside scheduler closures.
  const settingsRef        = useRef<PhoneAppsSettings>(settings);
  const nextRunAtRef       = useRef<number | null>(null);
  const timerRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef         = useRef(false);
  const stopRef            = useRef(false);
  const serialRef          = useRef(serial);
  const onRunningRef       = useRef(onRunning);
  const onLogRef           = useRef(onLog);
  // Set to true when the user explicitly toggles the tool on — causes the
  // scheduler to fire immediately (delay 0) rather than wait a random interval.
  const manualToggleOnRef  = useRef(false);

  useEffect(() => { settingsRef.current  = settings;  }, [settings]);
  useEffect(() => { serialRef.current    = serial;    }, [serial]);
  useEffect(() => { onRunningRef.current = onRunning; }, [onRunning]);
  useEffect(() => { onLogRef.current     = onLog;     }, [onLog]);

  // ── nextRunAt helper ──────────────────────────────────────────────────────
  const updateNextRunAt = useCallback((ts: number | null) => {
    nextRunAtRef.current = ts;
    setNextRunAt(ts);
    onNextRunAt(ts);
    if (ts !== null && serial) _nextRunAtBySerial.set(serial, ts);
  }, [onNextRunAt, serial]);

  // ── Load settings from API ────────────────────────────────────────────────
  useEffect(() => {
    if (!serial) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/phone-apps-settings`)
      .then(r => r.json())
      .then((d: any) => {
        if (!active) return;
        const merged: PhoneAppsSettings = {
          enabled:     Boolean(d.enabled ?? false),
          intervalMin: Number(d.intervalMin ?? 25),
          intervalMax: Number(d.intervalMax ?? 99),
           chrome:      { activatePctMin: d.chrome?.activatePctMin ?? 0,      activatePctMax: d.chrome?.activatePctMax ?? 0,      scrollMin: d.chrome?.scrollMin ?? 1, scrollMax: d.chrome?.scrollMax ?? 5, storyTapMin: d.chrome?.storyTapMin ?? 0, storyTapMax: d.chrome?.storyTapMax ?? 0, tappedStoryScrollMin: d.chrome?.tappedStoryScrollMin ?? 0, tappedStoryScrollMax: d.chrome?.tappedStoryScrollMax ?? 0, internalLinkPctMin: d.chrome?.internalLinkPctMin ?? 0, internalLinkPctMax: d.chrome?.internalLinkPctMax ?? 0, manualSearchPctMin: d.chrome?.manualSearchPctMin ?? 0, manualSearchPctMax: d.chrome?.manualSearchPctMax ?? 0, manualSearchCountMin: d.chrome?.manualSearchCountMin ?? 1, manualSearchCountMax: d.chrome?.manualSearchCountMax ?? 1, manualSearchScrollMin: d.chrome?.manualSearchScrollMin ?? 0, manualSearchScrollMax: d.chrome?.manualSearchScrollMax ?? 0, manualSearchLinkPctMin: d.chrome?.manualSearchLinkPctMin ?? 0, manualSearchLinkPctMax: d.chrome?.manualSearchLinkPctMax ?? 0, manualSearchDwellMin: d.chrome?.manualSearchDwellMin ?? 3, manualSearchDwellMax: d.chrome?.manualSearchDwellMax ?? 8, tapTrendingStoryMin: d.chrome?.tapTrendingStoryMin ?? 0, tapTrendingStoryMax: d.chrome?.tapTrendingStoryMax ?? 0 },
          googlePlay:  { activatePctMin: d.googlePlay?.activatePctMin ?? 0,  activatePctMax: d.googlePlay?.activatePctMax ?? 0 },
          snapchat:    { activatePctMin: d.snapchat?.activatePctMin ?? 0,     activatePctMax: d.snapchat?.activatePctMax ?? 0 },
          youtube:     { activatePctMin: d.youtube?.activatePctMin ?? 0, activatePctMax: d.youtube?.activatePctMax ?? 0, scrollMin: d.youtube?.scrollMin ?? 1, scrollMax: d.youtube?.scrollMax ?? 5, clickPctMin: d.youtube?.clickPctMin ?? 0, clickPctMax: d.youtube?.clickPctMax ?? 0, watchTimeMin: d.youtube?.watchTimeMin ?? 3, watchTimeMax: d.youtube?.watchTimeMax ?? 8, clickShortsPctMin: d.youtube?.clickShortsPctMin ?? 0, clickShortsPctMax: d.youtube?.clickShortsPctMax ?? 0, shortsScrollMin: d.youtube?.shortsScrollMin ?? 0, shortsScrollMax: d.youtube?.shortsScrollMax ?? 0, shortsWatchTimeMin: d.youtube?.shortsWatchTimeMin ?? 3, shortsWatchTimeMax: d.youtube?.shortsWatchTimeMax ?? 8, shortsLikePctMin: d.youtube?.shortsLikePctMin ?? 0, shortsLikePctMax: d.youtube?.shortsLikePctMax ?? 0 },
          whatsapp:    { activatePctMin: d.whatsapp?.activatePctMin ?? 0,     activatePctMax: d.whatsapp?.activatePctMax ?? 0 },
        };
        setSettings(merged);
        settingsRef.current = merged;
        onEnabled(merged.enabled);

        // Restore nextRunAt from module mirror (survives remount).
        const savedTs = serial ? _nextRunAtBySerial.get(serial) : undefined;
        if (merged.enabled && savedTs && savedTs > Date.now()) {
          updateNextRunAt(savedTs);
        } else if (merged.enabled) {
          updateNextRunAt(Date.now() + randomInterval(merged.intervalMin, merged.intervalMax));
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  // ── Save settings to API (debounced 600 ms) ───────────────────────────────
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSettings = useCallback((s: PhoneAppsSettings) => {
    if (!serialRef.current) return;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serialRef.current!)}/phone-apps-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      })
        .then(r => r.json())
        .then(d => { setSaveError(d.ok ? null : "Save failed"); })
        .catch(() => setSaveError("Save failed"));
    }, 600);
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const randomInterval = (min: number, max: number) =>
    Math.round((min + Math.random() * Math.max(0, max - min)) * 60_000);

  // ── Scheduler ─────────────────────────────────────────────────────────────
  const scheduleNext = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    updateNextRunAt(Date.now() + delayMs);
    timerRef.current = setTimeout(runCycle, delayMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateNextRunAt]);

  const runCycle = useCallback(async () => {
    if (!settingsRef.current.enabled || runningRef.current || stopRef.current) return;
    runningRef.current = true;
    onRunningRef.current?.(true);
    setCompletionStatus("running");
    updateNextRunAt(null);

    const hstTurnAt = nextRunAtRef.current ?? Date.now();
    let slotAcquired = false;
    try {
      if (requestSlot) {
        await requestSlot(PHONE_APPS_SLOT_IDX, hstTurnAt, () => {
          onLogRef.current?.("Phone Apps — collision detected; device busy, waiting for rest window");
        });
        slotAcquired = true;
        if (stopRef.current) return;
      }

      // ── Execute app tools — each rolls its own activation % ────────────────
      if (serialRef.current) {
        const s = settingsRef.current;
        const serial = serialRef.current;

        // Roll: pick a uniform random % in [min, max]; activate if that beats
        // a second random draw. Both must be > 0 to have any chance.
        const shouldActivate = (min: number, max: number): boolean => {
          if (min === 0 && max === 0) return false;
          const pct = min + Math.random() * Math.max(0, max - min);
          return Math.random() * 100 < pct;
        };

        const runApp = async (appId: string, extra?: Record<string, unknown>) => {
          try {
            const res = await fetch(
              `/api/mobile/devices/${encodeURIComponent(serial)}/run-phone-app`,
              { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ app: appId, ...extra }) },
            );
            // Log each step the server recorded so the Action Log tab shows
            // exactly what happened during the run (cookie banners, scrolls, etc.)
            try {
              const data: { ok?: boolean; steps?: string[]; error?: string } = await res.json();
              const log = onLogRef.current;
              if (log) {
                if (Array.isArray(data.steps)) {
                  for (const step of data.steps) log(`Phone Apps [${appId}]: ${step}`);
                }
                if (!data.ok) {
                  log(`Phone Apps [${appId}]: ⚠ ${data.error ?? "unknown error"}`);
                }
              }
            } catch { /* JSON parse error — response body unreadable, ignore */ }
          } catch (e: any) {
            onLogRef.current?.(`Phone Apps [${appId}]: ⚠ ${e?.message ?? "network error"}`);
          }
        };

        // Keep the execution order aligned with the Step 2 UI. Chrome is
        // intentionally first so the first visible app is also the first run.
        if (shouldActivate(s.chrome.activatePctMin, s.chrome.activatePctMax)) {
           await runApp("chrome", { scrollMin: s.chrome.scrollMin ?? 1, scrollMax: s.chrome.scrollMax ?? 5, storyTapMin: s.chrome.storyTapMin ?? 0, storyTapMax: s.chrome.storyTapMax ?? 0, tappedStoryScrollMin: s.chrome.tappedStoryScrollMin ?? 0, tappedStoryScrollMax: s.chrome.tappedStoryScrollMax ?? 0, internalLinkPctMin: s.chrome.internalLinkPctMin ?? 0, internalLinkPctMax: s.chrome.internalLinkPctMax ?? 0, manualSearchPctMin: s.chrome.manualSearchPctMin ?? 0, manualSearchPctMax: s.chrome.manualSearchPctMax ?? 0, manualSearchCountMin: s.chrome.manualSearchCountMin ?? 1, manualSearchCountMax: s.chrome.manualSearchCountMax ?? 1, manualSearchScrollMin: s.chrome.manualSearchScrollMin ?? 0, manualSearchScrollMax: s.chrome.manualSearchScrollMax ?? 0, manualSearchLinkPctMin: s.chrome.manualSearchLinkPctMin ?? 0, manualSearchLinkPctMax: s.chrome.manualSearchLinkPctMax ?? 0, manualSearchDwellMin: s.chrome.manualSearchDwellMin ?? 3, manualSearchDwellMax: s.chrome.manualSearchDwellMax ?? 8, tapTrendingStoryMin: s.chrome.tapTrendingStoryMin ?? 0, tapTrendingStoryMax: s.chrome.tapTrendingStoryMax ?? 0 });
        }
        if (shouldActivate(s.googlePlay.activatePctMin, s.googlePlay.activatePctMax)) await runApp("googlePlay");
        if (shouldActivate(s.snapchat.activatePctMin, s.snapchat.activatePctMax))   await runApp("snapchat");
        if (shouldActivate(s.youtube.activatePctMin, s.youtube.activatePctMax))    await runApp("youtube", { scrollMin: s.youtube.scrollMin ?? 1, scrollMax: s.youtube.scrollMax ?? 5, clickPctMin: s.youtube.clickPctMin ?? 0, clickPctMax: s.youtube.clickPctMax ?? 0, watchTimeMin: s.youtube.watchTimeMin ?? 3, watchTimeMax: s.youtube.watchTimeMax ?? 8, clickShortsPctMin: s.youtube.clickShortsPctMin ?? 0, clickShortsPctMax: s.youtube.clickShortsPctMax ?? 0, shortsScrollMin: s.youtube.shortsScrollMin ?? 0, shortsScrollMax: s.youtube.shortsScrollMax ?? 0, shortsWatchTimeMin: s.youtube.shortsWatchTimeMin ?? 3, shortsWatchTimeMax: s.youtube.shortsWatchTimeMax ?? 8, shortsLikePctMin: s.youtube.shortsLikePctMin ?? 0, shortsLikePctMax: s.youtube.shortsLikePctMax ?? 0 });
        if (shouldActivate(s.whatsapp.activatePctMin, s.whatsapp.activatePctMax))   await runApp("whatsapp");

        // This is deliberately outside the activation branches: a completed
        // cycle must lock even when every app roll misses.
        setCompletionStatus("locking");
        onLogRef.current?.("Phone Apps — app steps complete; locking phone");
        try {
          const lockRes = await fetch(
            `/api/mobile/devices/${encodeURIComponent(serial)}/phone-apps-complete`,
            { method: "POST", headers: { "Content-Type": "application/json" } },
          );
          const lockData: { ok?: boolean; error?: string } = await lockRes.json();
          if (!lockRes.ok || !lockData.ok) {
            throw new Error(lockData.error ?? `lock request failed (${lockRes.status})`);
          }
          setCompletionStatus("locked");
          onLogRef.current?.("Phone Apps — phone locked ✓");
        } catch (e: any) {
          setCompletionStatus("error");
          onLogRef.current?.(`Phone Apps — ⚠ phone lock failed: ${e?.message ?? "unknown error"}`);
        }
      }
    } catch (e: any) {
      setCompletionStatus("error");
      onLogRef.current?.(`Phone Apps — cycle failed: ${e?.message ?? "unknown error"}`);
    } finally {
      if (slotAcquired) releaseSlot?.(PHONE_APPS_SLOT_IDX);
      runningRef.current = false;
      onRunningRef.current?.(false);
    }

    if (!stopRef.current && settingsRef.current.enabled) {
      const s = settingsRef.current;
      scheduleNext(randomInterval(s.intervalMin, s.intervalMax));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSlot, releaseSlot, scheduleNext, updateNextRunAt]);

  // Start/stop scheduler when enabled changes or loading finishes.
  useEffect(() => {
    if (loading) return;
    if (settings.enabled) {
      stopRef.current = false;
      // Manual toggle-on → fire immediately (user asked for it right now).
      // Remount / app-restart with toggle already on → restore the remaining
      // wait from the module-level mirror, or schedule a fresh random interval.
      const wasManualToggleOn = manualToggleOnRef.current;
      manualToggleOnRef.current = false;
      if (wasManualToggleOn) {
        scheduleNext(0);
      } else {
        const existing = nextRunAtRef.current;
        if (existing && existing > Date.now()) {
          scheduleNext(existing - Date.now());
        } else {
          scheduleNext(randomInterval(settings.intervalMin, settings.intervalMax));
        }
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
  }, [settings.enabled, loading]);

  // ── Change handlers ───────────────────────────────────────────────────────
  const patch = (partial: Partial<PhoneAppsSettings>) => {
    const next = { ...settingsRef.current, ...partial };
    setSettings(next);
    settingsRef.current = next;
    saveSettings(next);
    return next;
  };

  const patchApp = (app: keyof Pick<PhoneAppsSettings, 'chrome'|'googlePlay'|'snapchat'|'youtube'|'whatsapp'>, partial: Partial<AppSlotSettings>) => {
    const next: PhoneAppsSettings = {
      ...settingsRef.current,
      [app]: { ...settingsRef.current[app], ...partial },
    };
    setSettings(next);
    settingsRef.current = next;
    saveSettings(next);
  };

  const handleEnabled = (v: boolean) => {
    if (v) manualToggleOnRef.current = true;
    const next = patch({ enabled: v });
    if (!v) setCompletionStatus("idle");
    onEnabled(next.enabled);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      {/* Top bar — min-h matches Instagram slot panel */}
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
            {/* ── (STEP 1) Enable + interval ─────────────────────────────── */}
            <div className="inline-flex self-start bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  (STEP 1)
                </span>
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={handleEnabled}
                  className="shrink-0"
                />
                <div className="flex flex-col min-w-0">
                  <span className={`text-sm font-semibold whitespace-nowrap ${
                    settings.enabled ? "text-green-600 dark:text-green-400" : "text-foreground"
                  }`}>
                    {settings.enabled ? "Active" : "Disabled"}
                  </span>
                  {settings.enabled && nextRunAt && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      Next run at {new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} on {new Date(nextRunAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}
                    </span>
                  )}
                </div>
                <div className="w-px self-stretch bg-border mx-1" />
                <Label className="text-sm text-muted-foreground whitespace-nowrap">Run every</Label>
                <Input
                  type="number" min={1}
                  className={NUM_INPUT_CLASS}
                  value={settings.intervalMin}
                  onChange={e => patch({ intervalMin: Math.max(1, Number(e.target.value)) })}
                />
                <span className="text-muted-foreground text-sm">to</span>
                <Input
                  type="number" min={1}
                  className={NUM_INPUT_CLASS}
                  value={settings.intervalMax}
                  onChange={e => patch({ intervalMax: Math.max(1, Number(e.target.value)) })}
                />
                <Label className="text-sm text-muted-foreground whitespace-nowrap">minutes</Label>
              </div>
            </div>

            {/* ── (STEP 2) App tool slots ─────────────────────────────────── */}
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  (STEP 2)
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">Choose phone apps to run</p>
                  <p className="text-xs text-muted-foreground">
                    Apps run one at a time after Step 1. Google Chrome is first.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-xl divide-y divide-border flex flex-col">
              <AppSlotRow
                icon={<ChromeIcon size={22} />}
                label="Google Chrome"
                className="order-1"
                min={settings.chrome.activatePctMin}
                max={settings.chrome.activatePctMax}
                onMin={v => patchApp("chrome", { activatePctMin: v })}
                onMax={v => patchApp("chrome", { activatePctMax: v })}
                rowExtras={<>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Scrolls</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.scrollMin ?? 1}
                        onChange={e => patchApp("chrome", { scrollMin: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.scrollMax ?? 5}
                        onChange={e => patchApp("chrome", { scrollMax: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Story Taps</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.storyTapMin ?? 0}
                        onChange={e => patchApp("chrome", { storyTapMin: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.storyTapMax ?? 0}
                        onChange={e => patchApp("chrome", { storyTapMax: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Tapped Story Scrolls</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.tappedStoryScrollMin ?? 0}
                        onChange={e => patchApp("chrome", { tappedStoryScrollMin: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.chrome.tappedStoryScrollMax ?? 0}
                        onChange={e => patchApp("chrome", { tappedStoryScrollMax: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                </>}
                row2={<>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Searches Per Run</span>
                    <div className="flex items-center gap-1">
                      <Input type="number" min={1} max={50} className={PCT_INPUT} value={settings.chrome.manualSearchCountMin ?? 1} onChange={e => patchApp("chrome", { manualSearchCountMin: Math.min(50, Math.max(1, Number(e.target.value))) })} />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input type="number" min={1} max={50} className={PCT_INPUT} value={settings.chrome.manualSearchCountMax ?? 1} onChange={e => patchApp("chrome", { manualSearchCountMax: Math.min(50, Math.max(1, Number(e.target.value))) })} />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Search Result Scrolls</span>
                    <div className="flex items-center gap-1">
                      <Input type="number" min={0} max={50} className={PCT_INPUT} value={settings.chrome.manualSearchScrollMin ?? 0} onChange={e => patchApp("chrome", { manualSearchScrollMin: Math.min(50, Math.max(0, Number(e.target.value))) })} />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input type="number" min={0} max={50} className={PCT_INPUT} value={settings.chrome.manualSearchScrollMax ?? 0} onChange={e => patchApp("chrome", { manualSearchScrollMax: Math.min(50, Math.max(0, Number(e.target.value))) })} />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Internal Links Clicked %</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.chrome.internalLinkPctMin ?? 0}
                        onChange={e => patchApp("chrome", { internalLinkPctMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.chrome.internalLinkPctMax ?? 0}
                        onChange={e => patchApp("chrome", { internalLinkPctMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Manual Searches Activation %</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.chrome.manualSearchPctMin ?? 0}
                        onChange={e => patchApp("chrome", { manualSearchPctMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.chrome.manualSearchPctMax ?? 0}
                        onChange={e => patchApp("chrome", { manualSearchPctMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Search Result Link %</span>
                    <div className="flex items-center gap-1">
                      <Input type="number" min={0} max={100} className={PCT_INPUT} value={settings.chrome.manualSearchLinkPctMin ?? 0} onChange={e => patchApp("chrome", { manualSearchLinkPctMin: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input type="number" min={0} max={100} className={PCT_INPUT} value={settings.chrome.manualSearchLinkPctMax ?? 0} onChange={e => patchApp("chrome", { manualSearchLinkPctMax: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                      <span className="text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                </>}
                 row3={
                   <div className="basis-full w-full flex flex-wrap items-start justify-start gap-x-8 gap-y-3 pt-2">
                     <div className="flex shrink-0 flex-col items-start gap-1">
                       <span className="text-xs text-muted-foreground whitespace-nowrap">Result Dwell Seconds</span>
                       <div className="flex items-center gap-1">
                          <Input type="number" min={1} max={10} className={PCT_INPUT} value={settings.chrome.manualSearchDwellMin ?? 3} onChange={e => patchApp("chrome", { manualSearchDwellMin: Math.min(10, Math.max(1, Number(e.target.value))) })} />
                         <span className="text-muted-foreground text-sm">to</span>
                          <Input type="number" min={1} max={10} className={PCT_INPUT} value={settings.chrome.manualSearchDwellMax ?? 8} onChange={e => patchApp("chrome", { manualSearchDwellMax: Math.min(10, Math.max(1, Number(e.target.value))) })} />
                         <span className="text-muted-foreground text-sm">sec</span>
                       </div>
                     </div>
                      <div className="flex shrink-0 flex-col items-start gap-1">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Tap Trending Storys</span>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            max={50}
                            className={PCT_INPUT}
                            value={settings.chrome.tapTrendingStoryMin ?? 0}
                            onChange={e => patchApp("chrome", { tapTrendingStoryMin: Math.min(50, Math.max(0, Math.round(Number(e.target.value)))) })}
                          />
                          <span className="text-muted-foreground text-sm">to</span>
                          <Input
                            type="number"
                            min={0}
                            max={50}
                            className={PCT_INPUT}
                            value={settings.chrome.tapTrendingStoryMax ?? 0}
                            onChange={e => patchApp("chrome", { tapTrendingStoryMax: Math.min(50, Math.max(0, Math.round(Number(e.target.value)))) })}
                          />
                        </div>
                      </div>
                   </div>
                 }
              />
              <AppSlotRow
                icon={<GooglePlayIcon size={22} />}
                label="Google Play"
                className="order-3"
                min={settings.googlePlay.activatePctMin}
                max={settings.googlePlay.activatePctMax}
                onMin={v => patchApp("googlePlay", { activatePctMin: v })}
                onMax={v => patchApp("googlePlay", { activatePctMax: v })}
              />
              <AppSlotRow
                icon={<SnapchatIcon size={22} />}
                label="Snapchat"
                className="order-4"
                min={settings.snapchat.activatePctMin}
                max={settings.snapchat.activatePctMax}
                onMin={v => patchApp("snapchat", { activatePctMin: v })}
                onMax={v => patchApp("snapchat", { activatePctMax: v })}
              />
              <AppSlotRow
                icon={<YouTubeIcon size={22} />}
                label="YouTube"
                className="order-2"
                min={settings.youtube.activatePctMin}
                max={settings.youtube.activatePctMax}
                onMin={v => patchApp("youtube", { activatePctMin: v })}
                onMax={v => patchApp("youtube", { activatePctMax: v })}
                rowExtras={<>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Scrolls</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.youtube.scrollMin ?? 1}
                        onChange={e => patchApp("youtube", { scrollMin: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.youtube.scrollMax ?? 5}
                        onChange={e => patchApp("youtube", { scrollMax: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Tap video %</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.clickPctMin ?? 0}
                        onChange={e => patchApp("youtube", { clickPctMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.clickPctMax ?? 0}
                        onChange={e => patchApp("youtube", { clickPctMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Watch Time</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={600}
                        className={PCT_INPUT}
                        value={settings.youtube.watchTimeMin ?? 3}
                        onChange={e => patchApp("youtube", { watchTimeMin: Math.min(600, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={600}
                        className={PCT_INPUT}
                        value={settings.youtube.watchTimeMax ?? 8}
                        onChange={e => patchApp("youtube", { watchTimeMax: Math.min(600, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-xs">sec</span>
                    </div>
                  </div>
                </>}
                row2={<>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Click Shorts %</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.clickShortsPctMin ?? 0}
                        onChange={e => patchApp("youtube", { clickShortsPctMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.clickShortsPctMax ?? 0}
                        onChange={e => patchApp("youtube", { clickShortsPctMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Shorts Scrolls</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsScrollMin ?? 0}
                        onChange={e => patchApp("youtube", { shortsScrollMin: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsScrollMax ?? 0}
                        onChange={e => patchApp("youtube", { shortsScrollMax: Math.min(50, Math.max(0, Number(e.target.value))) })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Shorts Like %</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsLikePctMin ?? 0}
                        onChange={e => patchApp("youtube", { shortsLikePctMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsLikePctMax ?? 0}
                        onChange={e => patchApp("youtube", { shortsLikePctMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Shorts Watch Time</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={600}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsWatchTimeMin ?? 3}
                        onChange={e => patchApp("youtube", { shortsWatchTimeMin: Math.min(600, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number"
                        min={0}
                        max={600}
                        className={PCT_INPUT}
                        value={settings.youtube.shortsWatchTimeMax ?? 8}
                        onChange={e => patchApp("youtube", { shortsWatchTimeMax: Math.min(600, Math.max(0, Number(e.target.value))) })}
                      />
                      <span className="text-muted-foreground text-xs">sec</span>
                    </div>
                  </div>
                </>}
              />
              <AppSlotRow
                icon={<WhatsAppIcon size={22} />}
                label="WhatsApp"
                className="order-5"
                min={settings.whatsapp.activatePctMin}
                max={settings.whatsapp.activatePctMax}
                onMin={v => patchApp("whatsapp", { activatePctMin: v })}
                onMax={v => patchApp("whatsapp", { activatePctMax: v })}
              />
            </div>

            {/* ── (STEP 3) Close apps + lock phone ───────────────────────── */}
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  (STEP 3)
                </span>
                <LockKeyhole className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-semibold text-foreground">Close apps and lock phone</span>
                  <span className="text-xs text-muted-foreground">
                    Runs after the selected apps finish their close gesture. The phone is locked with the explicit sleep command.
                  </span>
                </div>
                <div className="ml-auto flex items-center gap-2 text-xs font-semibold whitespace-nowrap">
                  {completionStatus === "running" && <><Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-500" /><span className="text-cyan-600 dark:text-cyan-400">Running Step 2</span></>}
                  {completionStatus === "locking" && <><Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" /><span className="text-amber-600 dark:text-amber-400">Locking…</span></>}
                  {completionStatus === "locked" && <><CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /><span className="text-green-600 dark:text-green-400">Phone locked</span></>}
                  {completionStatus === "error" && <span className="text-red-500">Lock failed</span>}
                  {completionStatus === "idle" && <span className="text-muted-foreground">Runs automatically</span>}
                </div>
              </div>
            </div>

            {saveError && (
              <p className="text-xs text-red-500">{saveError}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
