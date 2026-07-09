/**
 * Mobile Farm — USB Phone Management
 *
 * Isolated from all other parts of the application.
 * Only imports: React, UI primitives, lucide icons.
 * No shared contexts, no profile/proxy queries, no Instagram API calls.
 *
 * This page detects real Android phones connected via USB cable using ADB.
 */

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
} from "lucide-react";

// ─── Isolated API helper (no shared queryClient) ──────────────────────────────

interface UsbPhone {
  serial:          string;
  state:           "device" | "unauthorized" | "offline" | string;
  model?:          string;
  manufacturer?:   string;
  androidVersion?: string;
  product?:        string;
}

interface PhonesResponse {
  adbFound:  boolean;
  adbPath:   string | null;
  phones:    UsbPhone[];
  checkedAt: string;
}

async function fetchPhones(): Promise<PhonesResponse> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json() as Promise<PhonesResponse>;
}

// ─── State badge ─────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  if (state === "device") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-500/15 text-green-500 border border-green-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        Ready
      </span>
    );
  }
  if (state === "unauthorized") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-yellow-500/15 text-yellow-500 border border-yellow-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
        Needs approval
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-500/15 text-red-500 border border-red-500/30">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      {state}
    </span>
  );
}

// ─── Phone card ───────────────────────────────────────────────────────────────

const CARD_COLORS = [
  "from-blue-600  to-blue-800",
  "from-violet-600 to-violet-800",
  "from-teal-600  to-teal-800",
  "from-orange-500 to-orange-700",
  "from-pink-600  to-pink-800",
  "from-green-600 to-green-800",
];

function PhoneCard({ phone, idx }: { phone: UsbPhone; idx: number }) {
  const color = CARD_COLORS[idx % CARD_COLORS.length];
  const label = phone.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : (phone.product ?? phone.serial);

  return (
    <div className="rounded-xl border border-border overflow-hidden flex flex-col shadow-sm">
      {/* Gradient header */}
      <div className={`bg-gradient-to-br ${color} px-4 py-4 flex items-center gap-3`}>
        <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
          <Smartphone className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white text-sm truncate">{label}</div>
          {phone.androidVersion && (
            <div className="text-xs text-white/70 mt-0.5">Android {phone.androidVersion}</div>
          )}
        </div>
      </div>

      {/* Details */}
      <div className="bg-card px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <StateBadge state={phone.state} />
        </div>

        <div className="text-[10px] font-mono text-muted-foreground truncate"
          title={phone.serial}>
          {phone.serial}
        </div>

        {phone.state === "unauthorized" && (
          <div className="flex items-start gap-2 bg-yellow-500/8 border border-yellow-500/20 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-yellow-600 leading-relaxed">
              Check your phone screen and tap <strong>"Allow USB Debugging"</strong>,
              then tick <em>"Always allow from this computer"</em>.
            </p>
          </div>
        )}

        {phone.state === "offline" && (
          <div className="flex items-start gap-2 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
            <WifiOff className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-red-500 leading-relaxed">
              Phone is offline. Try unplugging and reconnecting the USB cable.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Setup instructions ───────────────────────────────────────────────────────

function SetupStep({ n, title, body }: { n: number; title: string; body: ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-7 h-7 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0 mt-0.5">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-foreground mb-0.5">{title}</div>
        <div className="text-sm text-muted-foreground leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

function NoAdbPanel() {
  return (
    <div className="max-w-xl mx-auto mt-16 space-y-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mx-auto">
        <Terminal className="w-8 h-8 text-orange-500" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-foreground">One more thing before phones can connect</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Equinox needs a small free tool from Google called <strong>ADB</strong> to
          talk to Android phones over USB. It's not installed yet — here's exactly
          how to set it up (takes about 2 minutes).
        </p>
      </div>
      <a
        href="https://developer.android.com/tools/releases/platform-tools"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
      >
        <ExternalLink className="w-4 h-4" />
        1. Download "SDK Platform-Tools for Windows"
      </a>
      <div className="text-left bg-card border border-border rounded-xl p-5 space-y-4">
        <p className="text-sm font-semibold text-foreground">
          2. If you already downloaded it, do this next:
        </p>
        <ol className="space-y-3 text-sm text-muted-foreground list-decimal list-inside">
          <li>
            Right-click the downloaded <code className="text-xs bg-muted px-1 py-0.5 rounded">.zip</code> file
            and choose <strong>"Extract All..."</strong>. Pick a simple, permanent
            spot like your <strong>C: drive</strong> (not a temp folder, not a USB
            stick) — for example <code className="text-xs bg-muted px-1 py-0.5 rounded">C:\platform-tools</code>.
            Do not delete this folder later — Equinox needs it to stay there.
          </li>
          <li>
            Open that folder and confirm you see a file named{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">adb.exe</code> inside
            it. If you only see another folder (sometimes it extracts one level
            deep), open that one until you find <code className="text-xs bg-muted px-1 py-0.5 rounded">adb.exe</code>. Click once on the address bar at the top of that window and copy the full path shown (e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">C:\platform-tools</code>).
          </li>
          <li>
            Press the <strong>Windows key</strong>, type{" "}
            <strong>env</strong>, and open <strong>"Edit the system environment
            variables"</strong>.
          </li>
          <li>
            Click the <strong>"Environment Variables..."</strong> button. In the
            top box ("User variables"), click on <strong>Path</strong> then
            click <strong>Edit... → New</strong>, and paste the folder path you
            copied in step 2. Click <strong>OK</strong> on every window to save.
          </li>
          <li>
            Fully close Equinox (not just minimize) and open it again.
          </li>
        </ol>
        <div className="flex items-start gap-2 bg-blue-500/8 border border-blue-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
          <p className="text-[11px] text-blue-600 leading-relaxed">
            Still says "ADB not found" after restarting? You most likely pasted
            the wrong folder in step 4 — go back and double-check it's the exact
            folder that contains <code className="bg-muted px-1 rounded">adb.exe</code>, not a parent
            or subfolder.
          </p>
        </div>
      </div>
    </div>
  );
}

function NoPhonesPanel() {
  return (
    <div className="max-w-xl mx-auto mt-12 space-y-6 px-4">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
          <Usb className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-bold text-foreground">No phones detected</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Follow these steps to connect your Android phone.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <SetupStep n={1} title="Enable Developer Mode" body={
          <>
            On your phone, go to <strong>Settings → About Phone</strong> and tap
            <strong> Build Number</strong> seven times in a row. You'll see a message
            saying "You are now a developer".
          </>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={2} title="Enable USB Debugging" body={
          <>
            Go back to <strong>Settings → Developer Options</strong> (sometimes under
            "Additional Settings") and turn on <strong>USB Debugging</strong>.
          </>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={3} title="Connect via USB" body={
          <>
            Plug the phone into your computer with a USB data cable — not just a
            charging cable. When your phone asks <strong>"Allow USB Debugging?"</strong>,
            tap <strong>Allow</strong> and tick "Always allow from this computer".
          </>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={4} title="Wait for detection" body={
          <>
            This page checks for devices every 3 seconds automatically. Your phone
            should appear above once it's authorised.
          </>
        } />
      </div>

      <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl p-4 text-sm text-blue-600">
        <strong>Tip:</strong> Make sure the phone uses its own SIM card for mobile data.
        Equinox routes Instagram traffic through the phone's SIM, not your computer's
        network — this is what gives each account a unique, mobile IP address.
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function MobilePage() {
  const [data,    setData]    = useState<PhonesResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      setData(await fetchPhones());
    } catch (e: any) {
      setError(e?.message ?? "Failed to check devices");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-poll every 3 s
  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(false), 3_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="ml-[133px] flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Smartphone className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold text-foreground">Mobile Farm</h1>
            {data && (
              <span className="text-xs text-muted-foreground">
                {data.phones.length === 0
                  ? "No phones connected"
                  : `${data.phones.length} phone${data.phones.length !== 1 ? "s" : ""} connected`}
              </span>
            )}
          </div>

          <button
            onClick={() => refresh(true)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {/* Initial loading */}
          {loading && !data && (
            <div className="flex items-center justify-center mt-24 gap-3 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Checking for connected phones…</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="max-w-lg mx-auto mt-12 flex items-start gap-3 bg-destructive/10 border border-destructive/20 rounded-xl p-4">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-destructive">Could not reach server</div>
                <div className="text-xs text-destructive/80 mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {/* ADB not installed */}
          {data && !data.adbFound && <NoAdbPanel />}

          {/* ADB found, no phones */}
          {data && data.adbFound && data.phones.length === 0 && <NoPhonesPanel />}

          {/* Phones list */}
          {data && data.adbFound && data.phones.length > 0 && (
            <div className="space-y-6">
              {/* Status row */}
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="text-sm text-muted-foreground">
                  ADB connected — <span className="text-foreground font-medium">{data.adbPath}</span>
                </span>
              </div>

              {/* Phone cards grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {data.phones.map((phone, i) => (
                  <PhoneCard key={phone.serial} phone={phone} idx={i} />
                ))}
              </div>

              {/* Next steps hint */}
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-sm text-muted-foreground max-w-2xl">
                <strong className="text-foreground">Phone connected ✓</strong> — Full automation
                features (Instagram account binding, SIM traffic routing, proxy per device) will
                appear here once connection is stable. Keep the USB cable plugged in.
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
