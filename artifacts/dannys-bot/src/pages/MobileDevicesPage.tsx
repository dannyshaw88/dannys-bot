/**
 * Mobile Devices — upper-level device selection screen.
 * Shows all configured devices. Clicking a device card navigates
 * to the full Mobile Farm management page for that device.
 */

import { useLocation } from "wouter";
import { Sidebar } from "@/components/layout/Sidebar";

function PhoneFarmIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <rect x="0.5" y="8.5" width="4" height="1.6" rx="0.8"/>
      <rect x="0.5" y="11.5" width="3" height="1.6" rx="0.8"/>
      <rect x="5" y="1" width="11" height="19" rx="2"/>
      <rect x="6.5" y="3" width="8" height="13" rx="1" fill="var(--background,#0f172a)"/>
      <circle cx="10.5" cy="18" r="1" fill="var(--background,#0f172a)"/>
      <path d="M17,10.5 L17.8,11.61 L19.17,11.75 L18.6,13 L19.17,14.25 L17.8,14.39 L17,15.5 L16.2,14.39 L14.84,14.25 L15.4,13 L14.84,11.75 L16.2,11.61Z"/>
      <circle cx="17" cy="13" r="1.1" fill="var(--background,#0f172a)"/>
    </svg>
  );
}

// ─── Xiaomi 23076RN8DY phone shell SVG ───────────────────────────────────────

function XiaomiPhoneShell({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 220 440"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
    >
      {/* Body */}
      <rect x="2" y="2" width="216" height="436" rx="34" fill="#1c1c1e" stroke="#3a3a3c" strokeWidth="2"/>
      {/* Glossy inner frame */}
      <rect x="8" y="8" width="204" height="424" rx="29" fill="#111113" stroke="#2c2c2e" strokeWidth="1"/>
      {/* Screen */}
      <rect x="12" y="14" width="196" height="412" rx="26" fill="#0a0a0f"/>
      {/* Gradient glass sheen */}
      <rect x="12" y="14" width="196" height="120" rx="26" fill="url(#sheen)" opacity="0.07"/>
      {/* Punch-hole camera */}
      <circle cx="110" cy="36" r="5.5" fill="#000005"/>
      <circle cx="110" cy="36" r="3.5" fill="#0d1117"/>
      <circle cx="108.5" cy="34.5" r="1" fill="#1a2030" opacity="0.7"/>
      {/* Status bar dots */}
      <rect x="24" y="32" width="18" height="2" rx="1" fill="#2a2a35" opacity="0.6"/>
      <rect x="174" y="32" width="22" height="2" rx="1" fill="#2a2a35" opacity="0.6"/>
      {/* Home indicator */}
      <rect x="80" y="412" width="60" height="4" rx="2" fill="#3a3a45" opacity="0.7"/>
      {/* Camera island (rear) — represented as a subtle inset top-left of the back,
          we show it symbolically on the top of the screen area as a module */}
      {/* Power button — right side */}
      <rect x="216" y="148" width="6" height="42" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
      {/* Volume up — left side */}
      <rect x="-2" y="138" width="6" height="32" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
      {/* Volume down — left side */}
      <rect x="-2" y="178" width="6" height="32" rx="3" fill="#2a2a30" stroke="#3a3a3c" strokeWidth="0.5"/>
      {/* Screen content: Xiaomi MIUI-style wallpaper gradient */}
      <defs>
        <linearGradient id="wallpaper" x1="12" y1="14" x2="208" y2="426" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0f1824"/>
          <stop offset="50%" stopColor="#0a1020"/>
          <stop offset="100%" stopColor="#071218"/>
        </linearGradient>
        <linearGradient id="sheen" x1="12" y1="14" x2="208" y2="134" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="xiaomiRed" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#f8341b"/>
          <stop offset="100%" stopColor="#e11d48"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#1AD2F2" stopOpacity="0.12"/>
          <stop offset="100%" stopColor="#1AD2F2" stopOpacity="0"/>
        </radialGradient>
      </defs>
      {/* Wallpaper fill */}
      <rect x="12" y="14" width="196" height="412" rx="26" fill="url(#wallpaper)"/>
      {/* Subtle glow */}
      <ellipse cx="110" cy="220" rx="90" ry="130" fill="url(#glow)"/>
      {/* Xiaomi logo on screen (centred, stylised) */}
      <text
        x="110"
        y="228"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontWeight="700"
        fontSize="22"
        letterSpacing="2"
        fill="#ffffff"
        opacity="0.85"
      >xiaomi</text>
      {/* Model label */}
      <text
        x="110"
        y="256"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontWeight="400"
        fontSize="11"
        letterSpacing="1"
        fill="#8888a0"
      >Redmi Note 12</text>
      {/* Equinox cyan accent line */}
      <rect x="90" y="272" width="40" height="2" rx="1" fill="#1AD2F2" opacity="0.5"/>
    </svg>
  );
}

// ─── Static device registry ───────────────────────────────────────────────────

interface DeviceEntry {
  serial: string;
  displayName: string;
  model: string;
}

const DEVICES: DeviceEntry[] = [
  { serial: "23076RN8DY", displayName: "Xiaomi 23076RN8DY", model: "Redmi Note 12" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export function MobileDevicesPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="ml-[133px] flex-1 h-screen flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 flex items-center gap-3">
          <PhoneFarmIcon className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Phone Farm</h1>
        </div>

        {/* Device grid — fixed 3 cols × 2 rows = 6 slots, fills the screen */}
        <div className="flex-1 overflow-hidden p-6">
          <div className="grid grid-cols-3 gap-4 h-full" style={{ gridTemplateRows: "repeat(2, 1fr)" }}>
            {Array.from({ length: 6 }).map((_, i) => {
              const device = DEVICES[i];
              if (device) {
                return (
                  <button
                    key={device.serial}
                    onClick={() => setLocation("/mobile/farm")}
                    className="group h-full flex flex-col items-center gap-2 py-4 px-3 rounded-2xl border border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <XiaomiPhoneShell className="flex-1 min-h-0 w-auto max-w-[120px] drop-shadow-lg group-hover:scale-[1.03] transition-transform duration-200" />
                    <div className="shrink-0 text-center space-y-0.5">
                      <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors leading-tight">
                        {device.displayName}
                      </p>
                      <p className="text-xs text-muted-foreground">{device.model}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                        <span className="text-[10px] text-muted-foreground">Ready</span>
                      </div>
                    </div>
                  </button>
                );
              }
              return (
                <div
                  key={i}
                  className="flex flex-col items-center justify-center gap-3 p-5 rounded-2xl border border-dashed border-border/40 bg-card/30 opacity-40"
                >
                  <div className="w-[100px] aspect-[220/440] rounded-2xl bg-muted/30 flex items-center justify-center">
                    <PhoneFarmIcon className="w-8 h-8 text-muted-foreground/30" />
                  </div>
                  <p className="text-xs text-muted-foreground/50">Empty slot</p>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
