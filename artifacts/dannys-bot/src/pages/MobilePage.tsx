/**
 * Mobile Farm — USB Phone Management (4-slot single row, Electron-safe WS)
 */

import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
  ChevronLeft, Home, LayoutGrid, Power, Volume2, VolumeX,
} from "lucide-react";

declare const __API_PORT__: string;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the WebSocket URL for the screen stream.
 *
 * In Electron the Express API server also serves the frontend (same process,
 * same port — preferred 32987).  window.location.host is therefore
 * "127.0.0.1:32987" and IS the right target.  __API_PORT__ (8082) is only
 * correct in the Replit dev environment where there is a Vite proxy; using it
 * inside Electron would point at the wrong port and fail immediately.
 */
function makeWsUrl(serial: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // window.location.host is "127.0.0.1:<port>" in Electron and the correct
  // Replit dev host when going through the Vite proxy.
  const host = window.location.host
    || `127.0.0.1:${typeof __API_PORT__ !== "undefined" ? __API_PORT__ : "8082"}`;
  return `${proto}//${host}/api/mobile/screen/${encodeURIComponent(serial)}`;
}

async function fetchPhones(): Promise<PhonesResponse> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json() as Promise<PhonesResponse>;
}

async function sendKey(serial: string, code: number) {
  try {
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch { /* ignore */ }
}

// ─── Nav button ───────────────────────────────────────────────────────────────

function NavBtn({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex flex-col items-center gap-0.5 text-white/40 hover:text-white/80 transition-colors px-1.5"
    >
      {icon}
      <span className="text-[8px] font-medium tracking-wide uppercase">{label}</span>
    </button>
  );
}

// ─── Live Canvas ──────────────────────────────────────────────────────────────

const LiveCanvas = React.memo(function LiveCanvas({ serial }: { serial: string }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const phoneSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fpsCountRef  = useRef(0);
  const frameSeenRef = useRef(false);

  const [status,   setStatus]   = useState<"connecting" | "waiting" | "live" | "error">("connecting");
  const [fps,      setFps]      = useState(0);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setDebugLog(prev => [...prev.slice(-14), `${ts}  ${msg}`]);
  }, []);

  // FPS ticker
  useEffect(() => {
    const t = setInterval(() => { setFps(fpsCountRef.current); fpsCountRef.current = 0; }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let noFrameTimer:   ReturnType<typeof setTimeout> | null = null;
    let attemptCount = 0;

    const connect = () => {
      if (!active) return;
      frameSeenRef.current = false;
      phoneSizeRef.current = null;
      attemptCount++;
      const url = makeWsUrl(serial);
      addLog(`[${attemptCount}] Connecting → ${url}`);
      setStatus("connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e: any) {
        addLog(`ERROR creating WS: ${e?.message}`);
        setStatus("error");
        if (active) reconnectTimer = setTimeout(connect, 3_000);
        return;
      }

      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) { ws.close(); return; }
        addLog("WS open — waiting for first frame…");
        setStatus("waiting");
        noFrameTimer = setTimeout(() => {
          if (!frameSeenRef.current && active) {
            addLog("10s timeout — no frames received. Unlock screen?");
            setStatus("error");
          }
        }, 10_000);
      };

      ws.onerror = (ev) => {
        addLog(`WS error (readyState=${ws.readyState})`);
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        setStatus("error");
      };

      ws.onclose = (ev) => {
        addLog(`WS closed — code=${ev.code} reason="${ev.reason || "none"}"`);
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        if (!active) return;
        setStatus("connecting");
        reconnectTimer = setTimeout(connect, 2_000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const j = JSON.parse(ev.data as string);
            if (j.error) {
              addLog(`SERVER ERROR: ${j.error}`);
              setStatus("error");
            }
          } catch { /* ok */ }
          return;
        }

        fpsCountRef.current++;
        if (!frameSeenRef.current) {
          frameSeenRef.current = true;
          if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
          addLog(`First frame! (${(ev.data as ArrayBuffer).byteLength} bytes)`);
          setStatus("live");
        }

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const blob = new Blob([ev.data as ArrayBuffer], { type: "image/png" });
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        const revoke = () => URL.revokeObjectURL(url);
        img.onload = () => {
          if (!active) { revoke(); return; }
          if (!phoneSizeRef.current) {
            const sz = { w: img.naturalWidth, h: img.naturalHeight };
            phoneSizeRef.current = sz;
            canvas.width  = sz.w;
            canvas.height = sz.h;
            addLog(`Canvas set ${sz.w}×${sz.h}`);
          }
          ctx.drawImage(img, 0, 0);
          revoke();
        };
        img.onerror = revoke;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!phoneSizeRef.current || status !== "live") return;
    const rect   = canvasRef.current!.getBoundingClientRect();
    const scaleX = phoneSizeRef.current.w / rect.width;
    const scaleY = phoneSizeRef.current.h / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top)  * scaleY);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
    } catch { /* ignore */ }
  }, [serial, status]);

  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      {/* ── Debug log panel — always visible, scrolls inside the slot ── */}
      <div className="absolute bottom-0 left-0 right-0 z-20 bg-black/80 backdrop-blur-sm max-h-[45%] overflow-y-auto p-1.5">
        {debugLog.map((line, i) => (
          <div key={i} className="text-[9px] font-mono text-green-400/80 leading-tight whitespace-pre-wrap break-all">
            {line}
          </div>
        ))}
        {debugLog.length === 0 && (
          <div className="text-[9px] font-mono text-white/20">debug log will appear here…</div>
        )}
      </div>

      {/* ── Overlay states (above canvas, below debug log) ── */}
      {status === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
          <span className="text-[10px] text-white/30 select-none">Connecting…</span>
        </div>
      )}
      {status === "waiting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
          <span className="text-[10px] text-white/30 select-none">Waiting for screen data…</span>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-start justify-start gap-1 p-2 z-10">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
            <span className="text-[10px] text-yellow-400 font-semibold">Stream error — see log below</span>
          </div>
        </div>
      )}

      {/* ── Live canvas ── */}
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{
          display:   status === "live" ? "block" : "none",
          position:  "absolute",
          inset:     0,
          width:     "100%",
          height:    "100%",
          objectFit: "contain",
          cursor:    "crosshair",
          zIndex:    5,
        }}
      />

      {/* FPS */}
      {status === "live" && (
        <span className="absolute top-1 right-1.5 text-[8px] font-mono text-white/30 select-none z-10">
          {fps} fps
        </span>
      )}
    </div>
  );
});

// ─── Empty phone shell ────────────────────────────────────────────────────────

function EmptyShell({ idx }: { idx: number }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 select-none">
      <svg viewBox="0 0 80 160" className="w-14 h-28 text-white/8"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="6" width="68" height="148" rx="10" ry="10" />
        <line x1="28" y1="16" x2="52" y2="16" />
        <circle cx="40" cy="144" r="5" />
      </svg>
      <span className="text-[9px] font-mono text-white/12 uppercase tracking-widest">Slot {idx + 1}</span>
    </div>
  );
}

// ─── Phone slot ───────────────────────────────────────────────────────────────

function PhoneSlot({ phone, idx }: { phone: UsbPhone | null; idx: number }) {
  const label = phone?.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : phone?.product ?? phone?.serial ?? null;

  const isReady        = phone?.state === "device";
  const isUnauthorized = phone?.state === "unauthorized";
  const isOffline      = phone?.state === "offline";
  const isEmpty        = !phone;

  return (
    <div className="flex flex-col bg-zinc-950 rounded-2xl border border-white/8 overflow-hidden shadow-xl w-full">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-white/6 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[9px] font-mono text-white/20 shrink-0">S{idx + 1}</span>
          {label && <span className="text-[10px] font-semibold text-white/70 truncate">{label}</span>}
          {phone?.androidVersion && (
            <span className="text-[9px] text-white/25 shrink-0">A{phone.androidVersion}</span>
          )}
        </div>
        {isReady        && <span className="flex items-center gap-1 text-[9px] font-bold text-green-400 shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Live</span>}
        {isUnauthorized && <span className="text-[9px] font-semibold text-yellow-500 shrink-0">Auth needed</span>}
        {isOffline      && <span className="text-[9px] font-semibold text-red-500 shrink-0">Offline</span>}
        {isEmpty        && <span className="text-[9px] font-mono text-white/15 shrink-0">empty</span>}
      </div>

      {/* Screen area — 9:16 portrait */}
      <div className="relative bg-zinc-900" style={{ width: "100%", aspectRatio: "9 / 16" }}>
        {isEmpty && <EmptyShell idx={idx} />}

        {isUnauthorized && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            <p className="text-[10px] text-yellow-400/80 leading-relaxed">
              Tap <strong>"Allow USB Debugging"</strong> on the phone screen
            </p>
          </div>
        )}
        {isOffline && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <WifiOff className="w-5 h-5 text-red-500" />
            <p className="text-[10px] text-red-400/80 leading-relaxed">Unplug and reconnect</p>
          </div>
        )}

        {/* Auto-stream — always mounts when phone is ready */}
        {isReady && phone && <LiveCanvas serial={phone.serial} />}
      </div>

      {/* Nav bar */}
      {isReady && phone && (
        <div className="flex items-center justify-center gap-2 py-2 bg-zinc-900 border-t border-white/6 shrink-0">
          <NavBtn icon={<ChevronLeft className="w-3.5 h-3.5" />} label="Back"   onClick={() => sendKey(phone.serial, 4)}   />
          <NavBtn icon={<Home        className="w-3.5 h-3.5" />} label="Home"   onClick={() => sendKey(phone.serial, 3)}   />
          <NavBtn icon={<LayoutGrid  className="w-3.5 h-3.5" />} label="Recent" onClick={() => sendKey(phone.serial, 187)} />
          <div className="w-px h-4 bg-white/10" />
          <NavBtn icon={<Power       className="w-3 h-3" />}     label="Power"  onClick={() => sendKey(phone.serial, 26)}  />
          <NavBtn icon={<Volume2     className="w-3 h-3" />}     label="Vol +"  onClick={() => sendKey(phone.serial, 24)}  />
          <NavBtn icon={<VolumeX     className="w-3 h-3" />}     label="Vol −"  onClick={() => sendKey(phone.serial, 25)}  />
        </div>
      )}
    </div>
  );
}

// ─── Setup panels ─────────────────────────────────────────────────────────────

function SetupStep({ n, title, body }: { n: number; title: string; body: ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-7 h-7 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0 mt-0.5">{n}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-foreground mb-0.5">{title}</div>
        <div className="text-sm text-muted-foreground leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

function NoAdbPanel({ onSaved }: { onSaved: () => void }) {
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [ok,     setOk]     = useState<string | null>(null);

  const submit = async () => {
    if (!folder.trim()) return;
    setSaving(true); setError(null); setOk(null);
    try {
      const r    = await fetch("/api/mobile/adb-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: folder.trim() }) });
      const body = await r.json();
      if (!r.ok || !body.ok) { setError(body.error ?? "Double-check the folder path."); return; }
      setOk("Found it! Checking for phones…");
      onSaved();
    } catch { setError("Couldn't reach the server. Try again."); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-xl mx-auto mt-16 space-y-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mx-auto">
        <Terminal className="w-8 h-8 text-orange-500" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-foreground">ADB not found</h2>
        <p className="text-sm text-muted-foreground mt-1">Paste the path to your platform-tools folder to get started.</p>
      </div>
      <div className="text-left bg-card border border-primary/30 rounded-xl p-5 space-y-3">
        <div className="flex gap-2">
          <input type="text" value={folder} onChange={e => setFolder(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder="e.g. C:\platform-tools"
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40" />
          <button onClick={submit} disabled={saving || !folder.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0">
            {saving ? "Checking…" : "Use folder"}
          </button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {ok    && <p className="text-xs text-green-500">{ok}</p>}
      </div>
      <a href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:border-primary/40 transition-colors">
        <ExternalLink className="w-4 h-4" />Download SDK Platform-Tools for Windows
      </a>
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
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs font-semibold text-foreground mb-2">What ADB sees right now:</p>
          <pre className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{rawOutput}</pre>
        </div>
      )}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <SetupStep n={1} title="Enable Developer Mode" body={<>Go to <strong>Settings → About Phone</strong>, tap <strong>Build Number</strong> 7 times.</>} />
        <div className="border-t border-border/50" />
        <SetupStep n={2} title="Enable USB Debugging" body={<>Go to <strong>Settings → Developer Options</strong> and turn on <strong>USB Debugging</strong>.</>} />
        <div className="border-t border-border/50" />
        <SetupStep n={3} title="Connect via USB & Allow" body={<>Plug in the phone. When it asks <strong>"Allow USB Debugging?"</strong>, tap <strong>Allow</strong> and tick "Always allow".</>} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TOTAL_SLOTS = 1;

export function MobilePage() {
  const [data,    setData]    = useState<PhonesResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try { setData(await fetchPhones()); }
    catch (e: any) { setError(e?.message ?? "Failed to check devices"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(false), 3_000);
    return () => clearInterval(id);
  }, [refresh]);

  const phones = data?.phones ?? [];
  const slots: (UsbPhone | null)[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => phones[i] ?? null);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="ml-[133px] flex-1 overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Smartphone className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold text-foreground">Mobile Farm</h1>
            {data && (
              <span className="text-xs text-muted-foreground">
                {phones.length === 0 ? "No phones connected" : `${phones.length} / ${TOTAL_SLOTS} connected`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {data?.adbFound && data.adbPath && (
              <div className="hidden sm:flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                <span className="text-xs text-muted-foreground font-mono truncate max-w-[280px]">{data.adbPath}</span>
              </div>
            )}
            <button onClick={() => refresh(true)} disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {error && (
            <div className="max-w-lg mx-auto mt-12 flex items-start gap-3 bg-destructive/10 border border-destructive/20 rounded-xl p-4">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-destructive">Could not reach server</div>
                <div className="text-xs text-destructive/80 mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {data && !data.adbFound && !error && <NoAdbPanel onSaved={() => refresh(true)} />}

          {data && data.adbFound && phones.length === 0 && !loading && (
            <NoPhonesPanel rawOutput={data.rawOutput} />
          )}

          {/* Single slot — left side, vertically centred */}
          {data && data.adbFound && (
            <div className="flex items-center justify-start" style={{ minHeight: "calc(100vh - 120px)" }}>
              <div style={{ width: 280 }}>
                {slots.map((phone, i) => (
                  <PhoneSlot key={phone?.serial ?? `empty-${i}`} phone={phone} idx={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
