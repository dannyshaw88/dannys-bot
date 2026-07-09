/**
 * Mobile Farm — USB Phone Management
 *
 * Isolated from all other parts of the application.
 * Only imports: React, UI primitives, lucide icons.
 * No shared contexts, no profile/proxy queries, no Instagram API calls.
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb, X,
  ChevronLeft, Home, LayoutGrid, Power, Volume2, VolumeX,
  Monitor, Check, UserPlus,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UsbPhone {
  serial:          string;
  state:           "device" | "unauthorized" | "offline" | string;
  model?:          string;
  manufacturer?:   string;
  androidVersion?: string;
  product?:        string;
}

interface PhonesResponse {
  adbFound:   boolean;
  adbPath:    string | null;
  phones:     UsbPhone[];
  rawOutput?: string | null;
  checkedAt:  string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchPhones(): Promise<PhonesResponse> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json() as Promise<PhonesResponse>;
}

// Injected by Vite at build time — declared here so TypeScript doesn't complain
declare const __API_PORT__: string;

// ─── Screen mirror overlay ────────────────────────────────────────────────────

function ScreenMirrorOverlay({ phone, onClose }: { phone: UsbPhone; onClose: () => void }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const phoneSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fpsCountRef  = useRef(0);
  const frameSeenRef = useRef(false);

  const [fps,       setFps]       = useState(0);
  const [connected, setConnected] = useState(false);
  const [hasFrame,  setHasFrame]  = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [phoneSize, setPhoneSize] = useState<{ w: number; h: number } | null>(null);

  // FPS counter
  useEffect(() => {
    const t = setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // WebSocket screen stream — reconnects automatically on drop
  useEffect(() => {
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let noFrameTimer:   ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;

      // Reset per-connection state
      frameSeenRef.current = false;
      setHasFrame(false);
      setError(null);

      // In Electron the app is served from the API server itself, so
      // window.location.host is already the right host. Fallback to
      // the injected build-time API port in case host is empty (file://).
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host  = window.location.host || `127.0.0.1:${typeof __API_PORT__ !== "undefined" ? __API_PORT__ : "8082"}`;
      const ws = new WebSocket(
        `${proto}//${host}/api/mobile/screen/${encodeURIComponent(phone.serial)}`
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) { ws.close(); return; }
        setConnected(true);
        // If no first frame arrives within 10 s the phone's screencap is likely
        // hung (common on locked screens). Surface a clear message.
        noFrameTimer = setTimeout(() => {
          if (!frameSeenRef.current && active) {
            setError(
              "No screen data received. Make sure the phone is unlocked — " +
              "screencap doesn't work on the lock screen on some devices."
            );
          }
        }, 10_000);
      };

      ws.onerror = () => {
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        setError("Couldn't reach the phone stream. Check it's plugged in with USB Debugging enabled.");
      };

      ws.onclose = () => {
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        if (!active) return;
        setConnected(false);
        // Auto-reconnect after 2 s so a brief USB glitch recovers on its own
        reconnectTimer = setTimeout(connect, 2_000);
      };

      ws.onmessage = (ev) => {
        const data = ev.data;
        if (typeof data === "string") {
          try {
            const j = JSON.parse(data);
            if (j.error) setError(j.error);
          } catch { /* ok */ }
          return;
        }
        fpsCountRef.current++;
        if (!frameSeenRef.current) {
          frameSeenRef.current = true;
          if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
          setHasFrame(true);
          setError(null);
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const blob = new Blob([data as ArrayBuffer], { type: "image/png" });
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.onload = () => {
          if (!phoneSizeRef.current) {
            const sz = { w: img.naturalWidth, h: img.naturalHeight };
            phoneSizeRef.current = sz;
            setPhoneSize(sz);
            canvas.width  = sz.w;
            canvas.height = sz.h;
          }
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (noFrameTimer)   clearTimeout(noFrameTimer);
      wsRef.current?.close();
    };
  }, [phone.serial]);

  // Tap handler — maps canvas display coords → native phone coords
  const handleCanvasClick = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!phoneSizeRef.current) return;
    const rect   = canvasRef.current!.getBoundingClientRect();
    const scaleX = phoneSizeRef.current.w / rect.width;
    const scaleY = phoneSizeRef.current.h / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top)  * scaleY);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/input/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
    } catch { /* ignore */ }
  }, [phone.serial]);

  const sendKey = useCallback(async (code: number) => {
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/input/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch { /* ignore */ }
  }, [phone.serial]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const label = phone.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : phone.serial;

  // Status line shown in the header
  const statusText = error
    ? "error"
    : !connected
      ? "connecting…"
      : !hasFrame
        ? "waiting for screen…"
        : `${fps} fps`;
  const statusColor = error
    ? "text-yellow-400"
    : connected && hasFrame
      ? "text-green-400"
      : "text-white/40";

  return (
    /* Dimmed backdrop — click outside the phone to close */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm select-none"
      onClick={onClose}
    >
      {/*
        Phone-shaped panel — ~340 px wide, portrait aspect ratio.
        We stop click propagation so tapping inside doesn't close the overlay.
      */}
      <div
        className="flex flex-col bg-zinc-950 rounded-[2.5rem] shadow-2xl border border-white/10 overflow-hidden"
        style={{ width: 340, maxHeight: "calc(100vh - 48px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Top status bar ── */}
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="text-xs font-semibold text-white truncate">{label}</span>
            {phone.androidVersion && (
              <span className="text-[10px] text-white/40 shrink-0">Android {phone.androidVersion}</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 shrink-0 ml-2">
            <span className={`text-[10px] font-mono ${statusColor}`}>{statusText}</span>
            {phoneSize && (
              <span className="text-[10px] font-mono text-white/25 hidden sm:block">
                {phoneSize.w}×{phoneSize.h}
              </span>
            )}
            <button
              onClick={onClose}
              className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title="Close (Esc)"
            >
              <X className="w-3 h-3 text-white/70" />
            </button>
          </div>
        </div>

        {/* ── Phone screen ── */}
        <div
          className="relative bg-black overflow-hidden"
          style={{
            // Lock to the phone's native aspect ratio once known; default to 9:16
            aspectRatio: phoneSize ? `${phoneSize.w} / ${phoneSize.h}` : "9 / 16",
            width: "100%",
            flexShrink: 0,
          }}
        >
          {/* Error state */}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center">
              <AlertTriangle className="w-7 h-7 text-yellow-400 shrink-0" />
              <p className="text-white/80 text-xs leading-relaxed">{error}</p>
              <button
                onClick={() => {
                  setError(null);
                  // Force a fresh connection attempt
                  wsRef.current?.close();
                }}
                className="mt-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Connecting / waiting for first frame */}
          {!error && (!connected || !hasFrame) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-white/40" />
              <span className="text-white/40 text-xs">
                {!connected ? `Connecting to ${label}…` : "Waiting for screen…"}
              </span>
            </div>
          )}

          {/* Live canvas */}
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{
              display: hasFrame ? "block" : "none",
              width: "100%",
              height: "auto",
              cursor: "crosshair",
            }}
          />
        </div>

        {/* ── Android nav bar ── */}
        <div className="flex items-center justify-center gap-5 py-3 bg-zinc-900 border-t border-white/8 shrink-0">
          <NavBtn icon={<ChevronLeft className="w-4 h-4" />} label="Back"   onClick={() => sendKey(4)}   />
          <NavBtn icon={<Home        className="w-4 h-4" />} label="Home"   onClick={() => sendKey(3)}   />
          <NavBtn icon={<LayoutGrid  className="w-4 h-4" />} label="Recent" onClick={() => sendKey(187)} />
          <div className="w-px h-5 bg-white/10" />
          <NavBtn icon={<Power       className="w-3.5 h-3.5" />} label="Power"  onClick={() => sendKey(26)}  />
          <NavBtn icon={<Volume2     className="w-3.5 h-3.5" />} label="Vol +"  onClick={() => sendKey(24)}  />
          <NavBtn icon={<VolumeX     className="w-3.5 h-3.5" />} label="Vol −"  onClick={() => sendKey(25)}  />
        </div>
      </div>
    </div>
  );
}

function NavBtn({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 text-white/50 hover:text-white transition-colors px-2"
    >
      {icon}
      <span className="text-[9px] font-medium tracking-wide uppercase">{label}</span>
    </button>
  );
}

// ─── State badge ──────────────────────────────────────────────────────────────

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

// ─── Bind account form ────────────────────────────────────────────────────────

function BindAccountForm({ serial }: { serial: string }) {
  const [show,     setShow]     = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [err,      setErr]      = useState<string | null>(null);

  const save = async () => {
    if (!username.trim() || !password.trim()) { setErr("Enter a username and password."); return; }
    setSaving(true); setErr(null);
    try {
      const r = await fetch("/api/mobile/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, serial }),
      });
      const j = await r.json();
      if (!r.ok || j?.error) throw new Error(j?.error ?? "Failed to save account");
      setSaved(true); setUsername(""); setPassword("");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save account");
    } finally {
      setSaving(false);
    }
  };

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      >
        <UserPlus className="w-3.5 h-3.5" />
        Link Instagram account
      </button>
    );
  }

  if (saved) {
    return (
      <div className="flex items-center gap-2 text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
        <Check className="w-3.5 h-3.5" /> Account linked — find it in Accounts.
      </div>
    );
  }

  return (
    <div className="space-y-1.5 bg-muted/30 border border-border rounded-lg p-2.5">
      <input
        value={username}
        onChange={e => setUsername(e.target.value)}
        placeholder="Instagram username"
        className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40"
      />
      <input
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
        type="password"
        className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40"
      />
      {err && <p className="text-[10px] text-destructive leading-snug">{err}</p>}
      <div className="flex gap-1.5">
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Save
        </button>
        <button
          onClick={() => setShow(false)}
          className="px-2 py-1.5 rounded-md border border-border text-xs text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
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
  const [mirroring, setMirroring] = useState(false);
  const label = phone.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : (phone.product ?? phone.serial);

  return (
    <>
      {mirroring && (
        <ScreenMirrorOverlay phone={phone} onClose={() => setMirroring(false)} />
      )}
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

          <div className="text-[10px] font-mono text-muted-foreground truncate" title={phone.serial}>
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

          {phone.state === "device" && (
            <div className="space-y-2 pt-1">
              {/* View screen button */}
              <button
                onClick={() => setMirroring(true)}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
              >
                <Monitor className="w-3.5 h-3.5" />
                View Screen
              </button>
              <BindAccountForm serial={phone.serial} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Setup panels ─────────────────────────────────────────────────────────────

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

function NoAdbPanel({ onSaved }: { onSaved: () => void }) {
  const [folder,  setFolder]  = useState("");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async () => {
    if (!folder.trim()) return;
    setSaving(true); setError(null); setSuccess(null);
    try {
      const r = await fetch("/api/mobile/adb-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: folder.trim() }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) { setError(body.error ?? "Double-check the folder path."); return; }
      setSuccess("Found it! Checking for phones…");
      onSaved();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto mt-16 space-y-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mx-auto">
        <Terminal className="w-8 h-8 text-orange-500" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-foreground">One more thing before phones can connect</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Equinox needs a small free tool from Google called <strong>ADB</strong> to
          talk to Android phones over USB.
        </p>
      </div>

      <div className="text-left bg-card border border-primary/30 rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-foreground">
          Easiest: paste the platform-tools folder path
        </p>
        <p className="text-xs text-muted-foreground">
          Already downloaded and extracted "platform-tools"? Open that folder,
          click once in the address bar to select the full path, copy it (Ctrl+C), paste below.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. E:\Equinox\platform-tools"
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            onClick={submit}
            disabled={saving || !folder.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0"
          >
            {saving ? "Checking…" : "Use this folder"}
          </button>
        </div>
        {error   && <p className="text-xs text-destructive">{error}</p>}
        {success && <p className="text-xs text-green-500">{success}</p>}
      </div>

      <a
        href="https://developer.android.com/tools/releases/platform-tools"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:border-primary/40 transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        Haven't downloaded it? Get "SDK Platform-Tools for Windows"
      </a>

      <details className="text-left bg-card border border-border rounded-xl p-5">
        <summary className="text-sm font-semibold text-foreground cursor-pointer">
          Prefer the traditional Windows PATH method?
        </summary>
        <ol className="mt-4 space-y-3 text-sm text-muted-foreground list-decimal list-inside">
          <li>Right-click the downloaded <code className="text-xs bg-muted px-1 py-0.5 rounded">.zip</code> and choose <strong>"Extract All..."</strong>. Pick a permanent spot, e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">C:\platform-tools</code>.</li>
          <li>Confirm <code className="text-xs bg-muted px-1 py-0.5 rounded">adb.exe</code> is inside, then copy the full folder path.</li>
          <li>Press <strong>Windows key + R</strong>, type <code className="text-xs bg-muted px-1 py-0.5 rounded">rundll32.exe sysdm.cpl,EditEnvironmentVariables</code>, press Enter.</li>
          <li>In the top box, click <strong>Path → Edit... → New</strong>, paste the path, click OK everywhere.</li>
          <li>Fully close Equinox and open it again.</li>
        </ol>
      </details>
    </div>
  );
}

function NoPhonesPanel({ rawOutput }: { rawOutput?: string | null }) {
  return (
    <div className="max-w-xl mx-auto mt-12 space-y-6 px-4">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
          <Usb className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-bold text-foreground">No phones detected</h2>
        <p className="text-sm text-muted-foreground mt-1">Follow these steps to connect your Android phone.</p>
      </div>

      {rawOutput && rawOutput.trim().length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 text-left">
          <p className="text-xs font-semibold text-foreground mb-2">What Equinox sees right now:</p>
          <pre className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {rawOutput}
          </pre>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <SetupStep n={1} title="Enable Developer Mode" body={
          <>On your phone go to <strong>Settings → About Phone</strong> and tap <strong>Build Number</strong> seven times. You'll see "You are now a developer".</>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={2} title="Enable USB Debugging" body={
          <>Go to <strong>Settings → Developer Options</strong> and turn on <strong>USB Debugging</strong>.</>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={3} title="Connect via USB" body={
          <>Plug the phone in with a USB data cable. When the phone asks <strong>"Allow USB Debugging?"</strong> tap <strong>Allow</strong> and tick "Always allow from this computer".</>
        } />
        <div className="border-t border-border/50" />
        <SetupStep n={4} title="Wait for detection" body={
          <>This page checks every 3 seconds. Your phone will appear above once authorised.</>
        } />
      </div>

      <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl p-4 text-sm text-blue-600">
        <strong>Tip:</strong> Make sure the phone uses its own SIM card for mobile data.
        Equinox routes Instagram traffic through the phone's SIM, not your computer's
        network — this gives each account a unique mobile IP address.
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
          {loading && !data && (
            <div className="flex items-center justify-center mt-24 gap-3 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Checking for connected phones…</span>
            </div>
          )}

          {error && (
            <div className="max-w-lg mx-auto mt-12 flex items-start gap-3 bg-destructive/10 border border-destructive/20 rounded-xl p-4">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-destructive">Could not reach server</div>
                <div className="text-xs text-destructive/80 mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {data && !data.adbFound && <NoAdbPanel onSaved={() => refresh(true)} />}

          {data && data.adbFound && data.phones.length === 0 && <NoPhonesPanel rawOutput={data.rawOutput} />}

          {data && data.adbFound && data.phones.length > 0 && (
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="text-sm text-muted-foreground">
                  ADB connected — <span className="text-foreground font-medium">{data.adbPath}</span>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {data.phones.map((phone, i) => (
                  <PhoneCard key={phone.serial} phone={phone} idx={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
