/**
 * MobilePhoneApps — "Mobile Phone Apps" section rendered inside AccountSettingsPanel.
 *
 * Owns all state, load, and save logic for device-level app credentials
 * (Google Play account, etc.).  Kept in its own file so it is never
 * accidentally touched by changes to the surrounding Accounts/Settings UI.
 *
 * Props
 *   serial     — ADB serial of the currently-selected device (null = no device)
 *   deviceName — Human-readable display name shown in the section header
 */

import React from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

interface MobilePhoneAppsProps {
  serial:     string | null | undefined;
  deviceName: string;
}

export function MobilePhoneApps({ serial, deviceName }: MobilePhoneAppsProps) {
  const [gpEmail,    setGpEmail]    = React.useState("");
  const [gpPassword, setGpPassword] = React.useState("");

  // ── Load ──────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-settings`)
      .then(r => r.json())
      .then(d => {
        setGpEmail(d.googlePlayEmail ?? "");
        setGpPassword(d.googlePlayPassword ?? "");
      })
      .catch(() => {});
  }, [serial]);

  // ── Auto-save (debounced 800 ms) ──────────────────────────────────────────
  const gpSaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpInitRef = React.useRef(false);
  React.useEffect(() => {
    if (!serial) return;
    if (!gpInitRef.current) { gpInitRef.current = true; return; }
    if (gpSaveRef.current) clearTimeout(gpSaveRef.current);
    gpSaveRef.current = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-settings`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ googlePlayEmail: gpEmail, googlePlayPassword: gpPassword }),
      }).catch(() => {});
    }, 800);
    return () => { if (gpSaveRef.current) clearTimeout(gpSaveRef.current); };
  }, [serial, gpEmail, gpPassword]);

  // Reset init-guard whenever the serial changes so the first hydration load
  // doesn't immediately trigger an overwrite save on a different device.
  React.useEffect(() => {
    gpInitRef.current = false;
    setGpEmail("");
    setGpPassword("");
  }, [serial]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Section heading */}
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-bold text-foreground">Mobile Phone Apps</h2>
        <span className="text-xs text-muted-foreground text-right shrink-0 pt-1">{deviceName}</span>
      </div>

      {/* Google Play Account card */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M3.18 23.76c.37.21.79.24 1.18.1l12.29-7.1-2.76-2.76-10.71 9.76z" fill="#EA4335"/>
            <path d="M22.47 10.22 18.9 8.15 15.77 11l3.13 3.13 3.6-2.08a1.55 1.55 0 0 0 0-2.69-.24-.14z" fill="#FBBC04"/>
            <path d="M2.36.24A1.55 1.55 0 0 0 2 1.22v21.56a1.55 1.55 0 0 0 .36.98l.12.11L14.89 11v-.29L2.48.13z" fill="#4285F4"/>
            <path d="M16.65 14.85 4.36 21.96c-.36.22-.77.23-1.14.06l-.12.11.12.11c.37.17.78.16 1.14-.06l12.29-7.1z" fill="#34A853"/>
          </svg>
          <p className="text-sm font-semibold text-foreground">Google Play Account</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1.5 flex-1 min-w-[180px]">
            <Label className="text-xs text-muted-foreground block text-center">Email Address</Label>
            <Input
              value={gpEmail}
              onChange={e => setGpEmail(e.target.value)}
              placeholder="example@gmail.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 flex-1 min-w-[180px]">
            <Label className="text-xs text-muted-foreground block text-center">Password</Label>
            <Input
              type="password"
              value={gpPassword}
              onChange={e => setGpPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>
        </div>
      </div>
    </>
  );
}
