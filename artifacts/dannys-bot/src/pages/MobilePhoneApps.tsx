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
 *   onOpenTool  — Called when the fingerprint button is clicked
 *
 * Props (MobilePhoneAppsPanel)
 *   onBack — Called when the back button is clicked
 */

import React from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Fingerprint, ChevronLeft } from "lucide-react";

// ── Brand icon SVGs ────────────────────────────────────────────────────────────

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
      <path d="M12 3c-2.35 0-4.35 1.9-4.35 4.6v.9l-.9.2c-.3.05-.5.3-.4.6.05.3.35.5.75.55-.05.2-.2.4-.4.5-.5.35-1.25.5-1.95.55 0 .35 1.05.75 1.25.8.05.35.35 1.65 1.85 1.65.5 0 1-.1 1.45-.2.55.55 1.25.85 2.7.85s2.15-.3 2.7-.85c.45.1.95.2 1.45.2 1.5 0 1.8-1.3 1.85-1.65.2-.05 1.25-.45 1.25-.8-.7-.05-1.45-.2-1.95-.55-.2-.1-.35-.3-.4-.5.4-.05.7-.25.75-.55.1-.3-.1-.55-.4-.6l-.9-.2v-.9C16.35 4.9 14.35 3 12 3z" fill="#FFFC00" stroke="#555" strokeWidth="0.6"/>
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
  onOpenTool:  () => void;
}

export function MobilePhoneApps({ serial: _serial, deviceName, enabled, onOpenTool }: MobilePhoneAppsProps) {
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

          {/* Left: title + fingerprint button + toggle status */}
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider min-w-[13rem]">
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

            {/* Toggle indicator (read-only on the card — edit inside the panel) */}
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <div className={`w-2 h-2 rounded-full shrink-0 ${enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
              <span className={`text-[11px] font-semibold leading-tight whitespace-nowrap ${
                enabled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
              }`}>
                {enabled ? "Active" : "Disabled"}
              </span>
            </div>
          </div>

          {/* Right: brand icons */}
          <div className="flex items-center gap-2 shrink-0">
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
  onBack:      () => void;
  onEnabled:   (v: boolean) => void;
}

const NUM_INPUT_CLASS = "w-16 text-center";

export function MobilePhoneAppsPanel({ onBack, onEnabled }: MobilePhoneAppsPanelProps) {
  const [enabled,     setEnabled]     = React.useState(false);
  const [intervalMin, setIntervalMin] = React.useState(25);
  const [intervalMax, setIntervalMax] = React.useState(99);

  const handleEnabled = (v: boolean) => {
    setEnabled(v);
    onEnabled(v);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — back button */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <Button variant="outline" size="sm" onClick={onBack} className="gap-1 h-7 px-2">
          <ChevronLeft className="w-3.5 h-3.5" />
          Back
        </Button>
        <div className="flex-1" />
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          Mobile Phone Apps
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
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
              onChange={e => setIntervalMin(Math.max(1, Number(e.target.value)))}
            />
            <span className="text-muted-foreground text-sm">to</span>
            <Input
              type="number"
              min={1}
              className={NUM_INPUT_CLASS}
              value={intervalMax}
              onChange={e => setIntervalMax(Math.max(1, Number(e.target.value)))}
            />
            <Label className="text-sm text-muted-foreground whitespace-nowrap">minutes</Label>
          </div>
        </div>
      </div>
    </div>
  );
}
