/**
 * Mobile Farm — USB Phone Management (4-slot single row, Electron-safe WS)
 */

import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, useMemo, type ReactNode } from "react";
import { useParams, useSearch } from "wouter";
import { _hstTimers, _hstStop, _hstNextRunAt } from "@/lib/hstRunner";
import { BrowserPanel } from "@/components/BrowserPanel";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { Sidebar, FilledFarmIcon } from "@/components/layout/Sidebar";
import { LiveActivityTicker } from "@/components/layout/LiveActivityTicker";
import { useDeviceLog } from "@/contexts/DeviceLogContext";
import { Label } from "@/components/ui/label";
import { Input as BaseInput } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
  ChevronLeft, ChevronRight, ChevronDown, Home, Power, Trash2,
  FolderOpen, Upload, Download, Fingerprint, ArrowLeft, Copy, CardSim,
  Palette, Plus, X, RotateCcw, Sun, Keyboard,
  Users, Globe, BarChart2, ClipboardList, Bug, ImagePlus, Tablet,
} from "lucide-react";

import { AnnexBDemuxer, spsToCodecString } from "@/lib/h264Stream";
import { ImageSettingsDialog, type ImageFilterSettings } from "@/components/tools/ImageSettingsDialog";
import { TrustScoreCountdown } from "@/components/TrustScoreCountdown";
import { getTrustLevels, getTrustScore, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import { MobilePhoneApps, MobilePhoneAppsPanel, type MobilePhoneAppsPanelHandle } from "@/pages/MobilePhoneApps";
import {
  loadSlotTrustScore,
  readLocalSlotTrustScore,
  saveSlotTrustScore,
  slotTrustScoreKey,
} from "@/components/slotTrustScoreStorage";
import {
  UsbPhone,
  AutomationSettingsData,
  AUTOMATION_DEFAULTS,
  CopySubSetting,
  CopySection,
  COPY_SECTIONS,
  TRUST_SCORE_SLOT_OWNED_FIELDS,
  COPYABLE_ACCOUNT_SPECIFIC_FIELDS,
  pickLocalWallpaper,
} from "@/pages/mobileShared";

declare const __API_PORT__: string;

// ─── Types ────────────────────────────────────────────────────────────────────

// UsbPhone is imported from mobileShared

interface PhonesResponse {
  adbFound:   boolean;
  adbPath:    string | null;
  phones:     UsbPhone[];
  rawOutput?: string | null;
  checkedAt:  string;
}

// ─── Slot customization types ─────────────────────────────────────────────────

const SLOT_FONTS = [
  { id: 'inter',    label: 'Inter',        family: "'Inter', system-ui, sans-serif" },
  { id: 'oswald',   label: 'Oswald',       family: "'Oswald', sans-serif" },
  { id: 'bebas',    label: 'Bebas Neue',   family: "'Bebas Neue', cursive" },
  { id: 'playfair', label: 'Playfair',     family: "'Playfair Display', serif" },
  { id: 'pacifico', label: 'Pacifico',     family: "'Pacifico', cursive" },
  { id: 'mono',     label: 'Mono',         family: "'Courier New', monospace" },
  { id: 'impact',   label: 'Impact',       family: "Impact, fantasy" },
  { id: 'serif',    label: 'Serif',        family: "Georgia, serif" },
] as const;

const SLOT_WALLPAPERS = [
  { id: 'wp-galaxy.jpg',    label: 'Galaxy' },
  { id: 'wp-abstract.jpg',  label: 'Abstract' },
  { id: 'wp-forest.jpg',    label: 'Forest' },
  { id: 'wp-ocean.jpg',     label: 'Ocean' },
  { id: 'wp-mountains.jpg', label: 'Mountains' },
  { id: 'wp-city.jpg',      label: 'City' },
  { id: 'wp-purple.jpg',    label: 'Purple' },
  { id: 'wp-minimal.jpg',   label: 'Minimal' },
  { id: 'wp-blossom.jpg',   label: 'Blossom' },
  { id: 'wp-aurora.jpg',    label: 'Aurora' },
  { id: 'wp-neon.jpg',      label: 'Neon' },
  { id: 'wp-water.jpg',     label: 'Water' },
];

interface TextLayer {
  id: string;
  text: string;
  font: string;
  size: number;
  color: string;
  x: number;
  y: number;
  bold: boolean;
  italic: boolean;
  shadow: boolean;
}

interface SlotCustomization {
  wallpaper: string | null;
  texts: TextLayer[];
}

const DEFAULT_SLOT_CUSTOM: SlotCustomization = { wallpaper: null, texts: [] };

function makeTextLayer(): TextLayer {
  return {
    id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text: 'Label',
    font: 'inter',
    size: 20,
    color: '#ffffff',
    x: 50,
    y: 50,
    bold: false,
    italic: false,
    shadow: true,
  };
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

function makeVideoWsUrl(serial: string): string {
  return makeWsUrl(serial).replace("/api/mobile/screen/", "/api/mobile/video/");
}

async function fetchPhones(): Promise<PhonesResponse> {
  const r = await fetch("/api/mobile/usb-phones");
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json() as Promise<PhonesResponse>;
}

async function sendKey(serial: string, code: number, label: string, onLog?: (msg: string) => void) {
  onLog?.(`Key → ${label} (${code})`);
  try {
    const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      onLog?.(`Key ${label} FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
    }
  } catch (err: any) {
    onLog?.(`Key ${label} FAILED — ${err?.message ?? "network error"}`);
  }
}

// ─── Nav button ───────────────────────────────────────────────────────────────

function NavBtn({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      title={label}
      className="flex flex-col items-center gap-0.5 text-white/40 hover:text-white/80 transition-colors px-1.5 focus:outline-none"
    >
      {icon}
      <span className="text-[8px] font-medium tracking-wide uppercase">{label}</span>
    </button>
  );
}

// ─── Live Canvas ──────────────────────────────────────────────────────────────

const WEBCODECS_SUPPORTED = typeof window !== "undefined" && "VideoDecoder" in window;

type LiveCanvasHandle = {
  clearToBlack: () => void;
  getVideoSize: () => { w: number; h: number } | null;
  /** Panel-driven highlight: show the blue overlay at these phone-coord bounds.
   *  Pass null to hand control back to the mirror-hover hit-test. */
  setForcedHighlight: (bounds: [number,number,number,number] | null) => void;
};

/** A single marker placed on the mirror overlay during Log Record mode. */
type LogMarker = {
  /** Phone-coordinate space (matches what the bot sends / what mapToPhone returns). */
  x: number; y: number;
  /** Unix-ms timestamp. */
  t: number;
  /**
   * "expected" = user left-clicked on mirror (cyan) — exact expected tap.
   * "vicinity" = user right-clicked on mirror (yellow) — approximate / multi-choice area.
   * "bot"      = automation tapped (orange) — what the bot actually sent.
   */
  type: "expected" | "vicinity" | "bot";
  /** Short label drawn next to the dot (e.g. the trimmed log line for bot taps). */
  label?: string;
};

type InspectNode = {
  index?: number;
  cls: string; resourceId: string; contentDesc: string; text: string;
  bounds: string; boundsRaw: [number,number,number,number];
  center: { x: number; y: number }; clickable: boolean; area: number;
};
type InspectResult = {
  ok: boolean; nodes: InspectNode[]; screenW: number; screenH: number;
  tappedAt: { x: number; y: number }; error?: string;
  _cssX?: number; _cssY?: number;
};

/** A user-placed pin on the Scan screenshot for an element UIAutomator can't see. */
type CustomPin = {
  id: string;
  name: string;
  phoneX: number;
  phoneY: number;
  /** Smallest containing UIAutomator node, used to anchor the coordinate. */
  parentNode: InspectNode | null;
};
/** Transient state while the user is typing the name for a new pin. */
type PendingPin = {
  /** Position on the rendered scan image (CSS px) for the floating name input. */
  cssX: number; cssY: number;
  phoneX: number; phoneY: number;
  parentNode: InspectNode | null;
};

const LiveCanvas = React.memo(React.forwardRef<LiveCanvasHandle, { serial: string; live: boolean; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; inspectMode?: boolean; inspectNodes?: InspectNode[] | null; onInspectResult?: (r: InspectResult) => void; onHoverNode?: (n: InspectNode | null) => void; clickTestMode?: boolean; logRecMode?: boolean; logMarkers?: LogMarker[]; onExpectedTap?: (x: number, y: number, kind?: "expected" | "vicinity") => void; onStatusChange?: (status: "connecting" | "waiting" | "live" | "asleep" | "error") => void }>(function LiveCanvas({ serial, live, onLog, onDimensions, inspectMode, inspectNodes, onInspectResult, onHoverNode, clickTestMode, logRecMode, logMarkers, onExpectedTap, onStatusChange }, ref) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  // Cache the 2D context so we don't re-call getContext() every frame.
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const phoneSizeRef = useRef<{ w: number; h: number } | null>(null);
  // Where the phone image is actually drawn inside the canvas, in canvas-pixel
  // (= CSS-pixel) coords. Set by drawFrame() on every frame so mapToPhone()
  // reads from the exact same numbers used to paint — no CSS inference at all.
  const drawRectRef  = useRef<{ dx: number; dy: number; dw: number; dh: number } | null>(null);
  // Tap indicator: shows where the mouse clicked (red) vs where the system
  // sent the tap (blue). In Click Test mode a second click adds a yellow dot
  // (user marking where the tap *should* have landed). All in canvas-CSS-pixel space.
  const [tapDots, setTapDots] = useState<{ rawX: number; rawY: number; mapX: number; mapY: number; yellowX?: number; yellowY?: number } | null>(null);
  const tapDotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "idle" = waiting for first click, "target" = waiting for user's yellow correction dot
  const clickTestPhaseRef = useRef<"idle" | "target">("idle");
  const clickTestModeRef  = useRef(false);
  // Log Record mode — mirrored into refs so handlePointerUp's stable
  // useCallback closure can read the current values without going stale
  // (logRecMode and onExpectedTap are NOT in handlePointerUp's dep array).
  const logRecModeRef2    = useRef(logRecMode);
  const onExpectedTapRef  = useRef(onExpectedTap);
  useEffect(() => { logRecModeRef2.current   = logRecMode;    }, [logRecMode]);
  useEffect(() => { onExpectedTapRef.current = onExpectedTap; }, [onExpectedTap]);
  const fpsCountRef  = useRef(0);
  const frameSeenRef = useRef(false);
  // Video mode: true H.264 stream decoded with WebCodecs (near-instant).
  // Falls back to the legacy PNG-polling endpoint if screenrecord/WebCodecs
  // isn't available on this machine/device.
  const useVideoRef  = useRef(WEBCODECS_SUPPORTED);
  const demuxerRef   = useRef<AnnexBDemuxer | null>(null);
  const decoderRef   = useRef<VideoDecoder | null>(null);
  const configuredRef = useRef(false);
  // Kept in a ref (not state) so the pointer-event handlers always see the
  // latest value without needing to be recreated on every toggle.
  const inspectModeRef = useRef(false);
  useEffect(() => {
    inspectModeRef.current = !!inspectMode;
    if (!inspectMode) {
      hoverNodeRef.current = null;
      forcedHighlightActiveRef.current = false;
      const el = inspectOverlayRef.current;
      if (el) el.style.display = "none";
    }
  }, [inspectMode]);
  useEffect(() => {
    clickTestModeRef.current = !!clickTestMode;
    if (!clickTestMode) { clickTestPhaseRef.current = "idle"; setTapDots(null); }
  }, [clickTestMode]);
  const onInspectResultRef = useRef(onInspectResult);
  useEffect(() => { onInspectResultRef.current = onInspectResult; }, [onInspectResult]);
  const inspectNodesRef = useRef<InspectNode[] | null>(null);
  useEffect(() => { inspectNodesRef.current = inspectNodes ?? null; }, [inspectNodes]);
  const onHoverNodeRef = useRef(onHoverNode);
  useEffect(() => { onHoverNodeRef.current = onHoverNode; }, [onHoverNode]);
  const hoverNodeRef = useRef<InspectNode | null>(null);
  // Direct DOM ref for the inspect hover overlay — bypasses React state so
  // every pointer move updates the highlight instantly (no render cycle),
  // exactly like Chrome DevTools which draws highlights synchronously.
  const inspectOverlayRef = useRef<HTMLDivElement>(null);
  const inspectLabelRef   = useRef<HTMLDivElement>(null);
  const inspectSizeRef    = useRef<HTMLDivElement>(null);
  // When the tree panel is driving the highlight (user hovered a row), this
  // flag prevents handlePointerMove from overwriting it with the mirror-hover node.
  const forcedHighlightActiveRef = useRef(false);

  const [status, setStatus] = useState<"connecting" | "waiting" | "live" | "asleep" | "error">("connecting");
  const [fps,    setFps]    = useState(0);

  // Bubble stream status up to PhoneSlot so the wallpaper/text overlay can
  // be shown whenever frames aren't actually flowing (even if live=true).
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => { onStatusChangeRef.current?.(status); }, [status]);

  // Keep canvas.width/height = CSS client size so canvas-pixel coords are
  // identical to CSS-pixel coords. This is the key invariant the letterbox
  // drawing and mapToPhone() both rely on. A ResizeObserver fires whenever
  // the container is resized (panel open/close, window resize, etc.) so the
  // mapping stays correct without any manual refresh.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width  = w;
        canvas.height = h;
        ctxRef.current = null; // resize invalidates cached context
        drawRectRef.current = null; // next frame will recompute
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Expose clearToBlack() so PhoneSlot can immediately black out the canvas
  // when the user presses Power — before the server has a chance to report
  // the screen as asleep (which takes a second or two).
  useImperativeHandle(ref, () => ({
    clearToBlack() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
    getVideoSize() {
      return phoneSizeRef.current;
    },
    // Called by the tree panel when the user hovers a node row — shows the
    // highlight at those phone-coord bounds, overriding mirror-hover hit-test.
    // Pass null to relinquish control back to the mirror-hover path.
    setForcedHighlight(bounds) {
      const el = inspectOverlayRef.current;
      if (!el) return;
      if (!bounds) {
        forcedHighlightActiveRef.current = false;
        // If nothing is hover-hit on the mirror either, hide the overlay.
        if (!hoverNodeRef.current) el.style.display = "none";
        return;
      }
      forcedHighlightActiveRef.current = true;
      const dr = drawRectRef.current;
      const ps = phoneSizeRef.current;
      if (!dr || !ps) return;
      const [x1, y1, x2, y2] = bounds;
      el.style.display = "block";
      el.style.left    = `${dr.dx + (x1 / ps.w) * dr.dw}px`;
      el.style.top     = `${dr.dy + (y1 / ps.h) * dr.dh}px`;
      el.style.width   = `${((x2 - x1) / ps.w) * dr.dw}px`;
      el.style.height  = `${((y2 - y1) / ps.h) * dr.dh}px`;
      if (inspectLabelRef.current) inspectLabelRef.current.textContent = "";
      if (inspectSizeRef.current)  inspectSizeRef.current.textContent  = `${x2 - x1}×${y2 - y1}`;
    },
  }), []);

  // Also clear the canvas automatically whenever the status transitions to
  // "asleep" — this covers automation-triggered sleeps (airplane-mode cycle,
  // etc.) where the Power button wasn't pressed by the user directly.
  useEffect(() => {
    if (status !== "asleep") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [status]);

  // The debug log panel was moved off the phone screen itself — this just
  // forwards messages up to the parent, which renders them in a panel below
  // the automation settings on the right.
  const addLog = useCallback((msg: string) => { onLog?.(msg); }, [onLog]);

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
    // Reset per mount (i.e. per device serial — LiveCanvas is keyed by
    // serial in the parent) so a fallback on one phone never sticks around
    // and silently skips the video path for a different phone reusing this
    // component instance.
    useVideoRef.current = WEBCODECS_SUPPORTED;

    const closeDecoder = (clearCanvas = false) => {
      try { decoderRef.current?.close(); } catch { /* ignore */ }
      decoderRef.current = null;
      configuredRef.current = false;
      demuxerRef.current = null;
      if (clearCanvas) {
        const canvas = canvasRef.current;
        const ctx = ctxRef.current;
        if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    const getCtx = (): CanvasRenderingContext2D | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      if (!ctxRef.current) {
        // No colorSpace option. Forcing "srgb" makes the browser apply a chroma
        // conversion from the frame's implied colour space (BT.601, since the
        // Baseline H.264 stream has no VUI colour info) to sRGB — that
        // conversion inverts chroma signs and produces a strong pink/red tint.
        // Leaving it as the default lets the browser pass YCbCr values through
        // unchanged, which looks correct on screen.
        ctxRef.current = canvas.getContext("2d") ?? null;
      }
      return ctxRef.current;
    };

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) { frame.close(); return; }
      // Track phone dimensions (used by mapToPhone for the final scale step).
      if (!phoneSizeRef.current || phoneSizeRef.current.w !== frame.displayWidth || phoneSizeRef.current.h !== frame.displayHeight) {
        const sz = { w: frame.displayWidth, h: frame.displayHeight };
        phoneSizeRef.current = sz;
        addLog(`Frame ${sz.w}×${sz.h}`);
        onDimensions?.(sz.w, sz.h);
      }
      // Draw the frame letterboxed to fill the canvas while preserving the
      // phone's aspect ratio. Store the exact draw rect so mapToPhone() uses
      // the same coordinates — no CSS inference, no object-fit, no DPR math.
      const cw = canvas.width;
      const ch = canvas.height;
      if (cw > 0 && ch > 0) {
        const phoneRatio = frame.displayWidth / frame.displayHeight;
        const canvasRatio = cw / ch;
        let dw: number, dh: number, dx: number, dy: number;
        if (canvasRatio > phoneRatio) {
          dh = ch; dw = Math.round(dh * phoneRatio); dx = Math.round((cw - dw) / 2); dy = 0;
        } else {
          dw = cw; dh = Math.round(dw / phoneRatio); dx = 0; dy = Math.round((ch - dh) / 2);
        }
        drawRectRef.current = { dx, dy, dw, dh };
        const ctx = getCtx();
        if (ctx) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(frame, dx, dy, dw, dh);
        }
      }
      frame.close();
      fpsCountRef.current++;
      setStatus("live");
    };

    const ensureDecoder = () => {
      if (decoderRef.current) return decoderRef.current;
      demuxerRef.current = new AnnexBDemuxer();
      const decoder = new VideoDecoder({
        output: drawFrame,
        error: (e) => { addLog(`Decoder error: ${e.message} — falling back to screenshot stream`); useVideoRef.current = false; if (active) { closeDecoder(); wsRef.current?.close(); } },
      });
      decoderRef.current = decoder;
      return decoder;
    };

    const connect = () => {
      if (!active) return;
      frameSeenRef.current = false;
      phoneSizeRef.current = null;
      closeDecoder();
      attemptCount++;
      const url = useVideoRef.current ? makeVideoWsUrl(serial) : makeWsUrl(serial);
      addLog(`[${attemptCount}] Connecting (${useVideoRef.current ? "video" : "screenshot"}) → ${url}`);
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
            addLog("10s timeout — no frames received. Reconnecting…");
            setStatus("error");
            // Force a fresh connection — the WS is live but sending nothing
            // (phone screen off, scrcpy not ready, etc.).  Close it so the
            // onclose handler fires and schedules the normal 2 s reconnect.
            ws.close();
          }
        }, 10_000);
      };

      ws.onerror = () => {
        addLog(`WS error (readyState=${ws.readyState})`);
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        setStatus("error");
      };

      ws.onclose = (ev) => {
        addLog(`WS closed — code=${ev.code} reason="${ev.reason || "none"}"`);
        if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
        closeDecoder();
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
              if (j.fatal && useVideoRef.current) {
                // Video path unsupported on this device — drop to screenshot mode.
                addLog("Video stream unavailable on this device — falling back to screenshot mirroring.");
                useVideoRef.current = false;
              }
              setStatus(/screen is off|locked/i.test(j.error) ? "asleep" : "error");
            } else if (j.info) {
              addLog(j.info);
              // Server restarted screenrecord (either its own watchdog or in
              // response to our clientLag signal). Flush decoder + clear canvas
              // immediately so we don't keep playing back the old queued frames.
              if (/resync|fell behind/i.test(j.info)) {
                closeDecoder(true /* clearCanvas */);
              }
            }
          } catch { /* ok */ }
          return;
        }

        if (!frameSeenRef.current) {
          frameSeenRef.current = true;
          if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; }
          addLog(`First frame! (${(ev.data as ArrayBuffer).byteLength} bytes)`);
        }

        if (!useVideoRef.current) {
          // Legacy PNG-per-frame path.
          fpsCountRef.current++;
          setStatus("live");
          const canvas = canvasRef.current;
          if (!canvas) return;
          const blob = new Blob([ev.data as ArrayBuffer], { type: "image/png" });
          const url  = URL.createObjectURL(blob);
          const img  = new Image();
          const revoke = () => URL.revokeObjectURL(url);
          img.onload = () => {
            if (!active) { revoke(); return; }
            if (!phoneSizeRef.current) {
              const sz = { w: img.naturalWidth, h: img.naturalHeight };
              phoneSizeRef.current = sz;
              addLog(`Frame ${sz.w}×${sz.h}`);
              onDimensions?.(sz.w, sz.h);
            }
            // Same letterbox-draw as the H.264 path so mapToPhone() works
            // identically regardless of which stream mode is active.
            const cw = canvas.width;
            const ch = canvas.height;
            if (cw > 0 && ch > 0 && phoneSizeRef.current) {
              const { w: phoneW, h: phoneH } = phoneSizeRef.current;
              const phoneRatio  = phoneW / phoneH;
              const canvasRatio = cw / ch;
              let dw: number, dh: number, dx: number, dy: number;
              if (canvasRatio > phoneRatio) {
                dh = ch; dw = Math.round(dh * phoneRatio); dx = Math.round((cw - dw) / 2); dy = 0;
              } else {
                dw = cw; dh = Math.round(dw / phoneRatio); dx = 0; dy = Math.round((ch - dh) / 2);
              }
              drawRectRef.current = { dx, dy, dw, dh };
              const ctx = getCtx();
              if (ctx) {
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, cw, ch);
                ctx.drawImage(img, dx, dy, dw, dh);
              }
            }
            revoke();
          };
          img.onerror = revoke;
          img.src = url;
          return;
        }

        // Real H.264 stream: demux Annex-B bytes into access units and feed
        // WebCodecs. Decode every frame — no client-side dropping or lag
        // signals. The server-side bufferedAmount watchdog handles genuine
        // TCP backlog; letting WebCodecs drain its own queue at GPU speed is
        // always faster than dropping frames and triggering restarts.
        const decoder = ensureDecoder();
        const demuxer = demuxerRef.current!;
        const units = demuxer.push(new Uint8Array(ev.data as ArrayBuffer));
        for (const unit of units) {
          if (!configuredRef.current) {
            const sps = demuxer.getSps();
            if (!sps) continue; // wait for an SPS before configuring
            try {
              decoder.configure({ codec: spsToCodecString(sps), optimizeForLatency: true });
              configuredRef.current = true;
            } catch (e: any) {
              addLog(`Decoder configure failed: ${e?.message} — falling back to screenshot stream`);
              useVideoRef.current = false;
              closeDecoder();
              ws.close();
              return;
            }
          }
          if (!configuredRef.current) continue;
          try {
            decoder.decode(new EncodedVideoChunk({
              type: unit.keyFrame ? "key" : "delta",
              timestamp: performance.now() * 1000,
              data: unit.data,
            }));
          } catch (e: any) {
            // A stray non-key chunk before the first keyframe, or a decoder
            // hiccup after a stream restart — safe to drop and keep going.
            addLog(`Decode chunk dropped: ${e?.message}`);
          }
        }
      };
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (noFrameTimer)   clearTimeout(noFrameTimer);
      wsRef.current?.close();
      closeDecoder();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  // ── Mirror-live signal ───────────────────────────────────────────────────
  // When `live` goes true (Power pressed or cycle starts) tell the server so
  // the farm grid can show a thumbnail overlay on this device's card.
  // When `live` goes false, clear it. Do not clear it on unmount: navigating
  // from the device detail page back to Account Farm must preserve the active
  // mirror marker so the Farm card can show the live device thumbnail.
  //
  // The Farm card independently validates each screenshot before displaying
  // it, so preserving this active marker cannot make a blank/black capture
  // cover the configured wallpaper and text.
  useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/mirror-live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: live }),
    }).catch(() => {});
  }, [serial, live]);

  // Sends an immediate wake keyevent — used when the phone is asleep so the
  // very first tap doesn't have to wait for the backend's own poll loop
  // (which was the "clicks don't register, feedback is slow" bug: the
  // canvas was unmounted whenever the screen wasn't live, so clicks on a
  // black/asleep screen never reached the server at all).
  const wake = useCallback(async () => {
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: 224 /* KEYCODE_WAKEUP */ }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        addLog(`Wake FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
      }
    } catch (err: any) {
      addLog(`Wake FAILED — ${err?.message ?? "network error"}`);
    }
  }, [serial, addLog]);

  // Maps a client (viewport) point to phone-panel coordinates.
  //
  // The canvas fills the container (absolute inset-0 100%×100%). Its
  // canvas.width/height are kept equal to its CSS clientWidth/clientHeight by
  // a ResizeObserver, so canvas pixels = CSS pixels (no DPR math needed).
  // Every frame is drawn letterboxed at an explicit drawRectRef position
  // using the same coordinate system. We read that exact draw rect here so
  // the click mapping and the renderer are mathematically identical.
  const mapToPhone = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!canvasRef.current || !phoneSizeRef.current || !drawRectRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { w: phoneW, h: phoneH } = phoneSizeRef.current;
    const { dx, dy, dw, dh } = drawRectRef.current;

    // Convert viewport click → canvas-pixel position (1:1 since canvas.width = clientWidth)
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;

    // Reject clicks in the letterbox bars outside the image
    if (cx < dx || cy < dy || cx > dx + dw || cy > dy + dh) return null;

    const x = Math.min(phoneW - 1, Math.max(0, Math.round(((cx - dx) / dw) * phoneW)));
    const y = Math.min(phoneH - 1, Math.max(0, Math.round(((cy - dy) / dh) * phoneH)));
    return { x, y };
  }, []);

  // Tracks an in-progress pointer gesture so we can tell a tap from a swipe:
  // mouse/touch down records the start point, move accumulates distance,
  // and up decides whether to send a tap or a swipe based on how far the
  // pointer traveled. A drag that never crosses the threshold still fires
  // as a tap (this preserves all prior click-to-tap behavior exactly).
  // `startClientX/Y` track raw viewport pixels (used for the tap/swipe
  // threshold, so it behaves consistently regardless of mirror scale).
  // `lastX/Y` track the last point that successfully mapped onto the phone
  // image, updated on every pointermove — this is what we actually send to
  // the device, so a pointerup that drifts into the letterbox padding still
  // resolves to a real on-screen endpoint instead of collapsing to the tap.
  const dragRef = useRef<{
    pointerId: number;
    startX: number; startY: number;
    startClientX: number; startClientY: number;
    lastX: number; lastY: number;
    startedAt: number;
  } | null>(null);
  const DRAG_THRESHOLD_PX = 10; // in viewport (client) pixels
  // Tracks the previous tap so a second tap landing soon after, near the
  // same spot, is sent as a single combined double-tap gesture instead of
  // two independent `/input/tap` requests. Two separate requests each pay
  // their own adb round-trip, which was pushing the real on-device gap
  // past Instagram's double-tap recognition window (same root cause as the
  // automated Check Feed like bug — see androidManager.doubleTap).
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  // A lone tap isn't sent immediately — it's held for DOUBLE_TAP_MS in case
  // a second tap follows nearby, so a genuine double-tap gesture always
  // resolves to exactly one combined double-tap request (not a single tap
  // followed by a double-tap, which would land 3 taps on the device).
  const pendingSingleTapRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_PX = 40; // phone-coordinate pixels
  // A stationary hold longer than this fires as a long-press (zero-distance
  // 2000ms swipe) rather than a regular tap.  600ms is well above the longest
  // intentional fast-tap (~200ms) and well below an accidental hold.
  const LONG_PRESS_MS = 600;

  useEffect(() => {
    return () => { if (pendingSingleTapRef.current) clearTimeout(pendingSingleTapRef.current.timer); };
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // A desktop right-click is only the mirror's clipboard/context-menu
    // gesture. Do not start a phone drag for it: otherwise the later
    // pointerup is also interpreted as a normal tap, which can move
    // Instagram away from the editable field before Paste is chosen.
    if (e.button !== 0) return;

    if (status !== "live" || !phoneSizeRef.current) {
      // Asleep / not-yet-live: pressing wakes the phone instead of tapping
      // a coordinate we can't map yet.
      addLog(`Pointer down while status="${status}" — sending wake instead of tap`);
      wake();
      return;
    }

    // ── Inspect mode gate ───────────────────────────────────────────────────
    // When inspect mode is active, mirror clicks must NEVER reach the phone.
    // Block here (before drag tracking starts) so that neither taps nor
    // swipes slip through, regardless of how the pointer-up path classifies
    // the gesture.  Hover/element highlighting continues to work because that
    // logic lives in handlePointerMove and does not depend on drag state.
    if (inspectModeRef.current) return;

    const p = mapToPhone(e.clientX, e.clientY);
    if (!p) {
      addLog(`Pointer down ignored — outside displayed phone image`);
      return;
    }

    // Visual tap indicator / Click Test logic
    if (canvasRef.current && drawRectRef.current && phoneSizeRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const rawX = e.clientX - rect.left;
      const rawY = e.clientY - rect.top;
      const { dx, dy, dw, dh } = drawRectRef.current;
      const { w: phoneW, h: phoneH } = phoneSizeRef.current;
      const mapX = dx + (p.x / phoneW) * dw;
      const mapY = dy + (p.y / phoneH) * dh;

      if (clickTestModeRef.current) {
        if (clickTestPhaseRef.current === "target") {
          // Second click: user marks where the tap SHOULD have landed — yellow dot.
          // Don't send a tap to the phone, just update the dots and go back to idle.
          clickTestPhaseRef.current = "idle";
          setTapDots(prev => prev ? { ...prev, yellowX: rawX, yellowY: rawY } : null);
          return; // skip the drag/tap entirely
        } else {
          // First click: show bullseye (send tap normally), wait for yellow correction.
          clickTestPhaseRef.current = "target";
          if (tapDotTimerRef.current) clearTimeout(tapDotTimerRef.current);
          setTapDots({ rawX, rawY, mapX, mapY }); // persists — no timer in click test mode
        }
      }
      // Normal mode: no dots — dots only appear in Click Test mode
    }

    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: p.x, startY: p.y,
      startClientX: e.clientX, startClientY: e.clientY,
      lastX: p.x, lastY: p.y,
      startedAt: Date.now(),
    };
  }, [status, wake, addLog, mapToPhone]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // ── Inspect hover — runs without an active drag ──────────────────────────
    // Hit-test against the cached node list client-side (no server round-trip).
    // Chrome DevTools does the same: the DOM is already in memory, so hover is
    // instant. Here we dump once on inspect-mode entry and do all hover logic
    // against that snapshot.
    if (inspectModeRef.current) {
      const nodes = inspectNodesRef.current;
      const p = mapToPhone(e.clientX, e.clientY);
      if (p && nodes?.length) {
        const hits = nodes
          .filter(n => p.x >= n.boundsRaw[0] && p.x <= n.boundsRaw[2] && p.y >= n.boundsRaw[1] && p.y <= n.boundsRaw[3])
          .sort((a, b) => a.area - b.area);
        const hit = hits[0] ?? null;
        if (hit !== hoverNodeRef.current) {
          hoverNodeRef.current = hit;
          // Always notify the tree panel so it can scroll the row into view.
          onHoverNodeRef.current?.(hit);
          // Only update the overlay when the panel isn't forcing its own highlight.
          if (!forcedHighlightActiveRef.current) {
            const dr = drawRectRef.current;
            const ps = phoneSizeRef.current;
            const el = inspectOverlayRef.current;
            if (hit && dr && ps && el) {
              const [x1, y1, x2, y2] = hit.boundsRaw;
              el.style.display = "block";
              el.style.left    = `${dr.dx + (x1 / ps.w) * dr.dw}px`;
              el.style.top     = `${dr.dy + (y1 / ps.h) * dr.dh}px`;
              el.style.width   = `${((x2 - x1) / ps.w) * dr.dw}px`;
              el.style.height  = `${((y2 - y1) / ps.h) * dr.dh}px`;
              const label = hit.resourceId || hit.contentDesc || hit.text || hit.cls || "";
              if (inspectLabelRef.current) inspectLabelRef.current.textContent = label;
              if (inspectSizeRef.current)  inspectSizeRef.current.textContent  = `${x2 - x1}×${y2 - y1}`;
            } else if (el) {
              el.style.display = "none";
            }
          }
        }
      } else if (hoverNodeRef.current !== null) {
        hoverNodeRef.current = null;
        if (!forcedHighlightActiveRef.current) {
          const el = inspectOverlayRef.current;
          if (el) el.style.display = "none";
        }
        onHoverNodeRef.current?.(null);
      }
    } else if (hoverNodeRef.current !== null) {
      hoverNodeRef.current = null;
      const el = inspectOverlayRef.current;
      if (el) el.style.display = "none";
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const mp = mapToPhone(e.clientX, e.clientY);
    if (mp) { drag.lastX = mp.x; drag.lastY = mp.y; }
    // If the pointer is currently over the letterbox padding, keep the last
    // known-good mapped point rather than overwriting it — the phone-side
    // gesture should track the edge of the screen it last touched.
  }, [mapToPhone]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    endDrag(e);
    const phoneSize = phoneSizeRef.current;
    if (!phoneSize) return;

    // Pick up any final move this same event carries (some browsers fire
    // pointerup without a preceding pointermove at the exact release point).
    const finalP = mapToPhone(e.clientX, e.clientY);
    const endX = finalP?.x ?? drag.lastX;
    const endY = finalP?.y ?? drag.lastY;

    // Classify tap vs. swipe using viewport pixels, so the threshold behaves
    // the same regardless of how much the mirror image is scaled down.
    const clientDist = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
    const durationMs = Math.max(1, Date.now() - drag.startedAt);

    if (clientDist < DRAG_THRESHOLD_PX) {
      // ── Inspect mode — identify element at this point instead of tapping ──
      // Works exactly like Chrome DevTools F12: click anything on the mirror,
      // get back every accessibility node whose bounds contain that point.
      // Inspect mode — block taps from reaching the phone; the tree panel
      // is the primary interaction surface in this mode.
      if (inspectModeRef.current) return;

      // ── Log Record mode — place an "expected" marker instead of tapping ──
      // While Log Record is active the mirror is read-only for navigation:
      // clicks place a cyan "expected" dot rather than being forwarded to
      // the phone.  The user marks the taps they expect the bot to make;
      // the bot's actual automated taps are added as orange dots via addLog
      // parsing.  Normal interaction resumes once recording stops.
      if (logRecModeRef2.current) {
        onExpectedTapRef.current?.(drag.startX, drag.startY, "expected");
        return;
      }

      // ── Long-press — stationary hold ≥ 600ms ────────────────────────────
      // A zero-distance swipe with a 2000ms duration is the standard ADB
      // idiom for a long-press (the same as switchToInstagramAccount uses to
      // open the account switcher).  Without this path, holding on the mirror
      // always resolved to a regular tap, which opened the profile tab instead
      // of triggering the account switcher, context menus, etc.
      if (durationMs >= LONG_PRESS_MS) {
        // Clean up any pending single-tap (shouldn't exist, but be safe).
        if (pendingSingleTapRef.current) {
          clearTimeout(pendingSingleTapRef.current.timer);
          pendingSingleTapRef.current = null;
        }
        addLog(`[manual] Account-switcher hold recognized [held ${durationMs}ms] — resolving Profile tab before dispatch`);
        try {
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/profile-tab-longpress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Long-press FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
          } else {
            const body = await r.json().catch(() => null);
            if (body?.node) addLog(`Long-press dispatched to resolved Profile tab at (${body.node.x},${body.node.y})`);
          }
        } catch (err: any) {
          addLog(`Long-press FAILED — ${err?.message ?? "network error"}`);
        }
        return;
      }

      // Short/no movement — treat as a tap at the press point (matches the
      // previous click-to-tap behavior exactly). A lone tap is held for
      // DOUBLE_TAP_MS instead of firing right away: if a second tap lands
      // nearby within that window, the pending single tap is cancelled and
      // the pair is sent as one combined double-tap request instead — so a
      // genuine double-tap gesture always resolves to exactly one
      // double-tap on the device, never a single tap plus a double-tap.
      const pending = pendingSingleTapRef.current;
      const now = Date.now();
      const isDoubleTap = !!pending
        && (now - lastTapRef.current!.at) <= DOUBLE_TAP_MS
        && Math.hypot(drag.startX - pending.x, drag.startY - pending.y) <= DOUBLE_TAP_PX;

      if (isDoubleTap) {
        clearTimeout(pending!.timer);
        pendingSingleTapRef.current = null;
        lastTapRef.current = null;
        addLog(`Double-tap → (${drag.startX}, ${drag.startY})`);
        try {
          const phoneSize = phoneSizeRef.current;
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/double-tap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: drag.startX, y: drag.startY, videoW: phoneSize?.w, videoH: phoneSize?.h }),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Double-tap FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
          } else {
            const body = await r.json().catch(() => null);
            if (body?.rescaled) addLog(`Rescale: video ${body.video[0]}×${body.video[1]} → device ${body.device[0]}×${body.device[1]}, tap (${body.from[0]},${body.from[1]}) → (${body.to[0]},${body.to[1]})`);
          }
        } catch (err: any) {
          addLog(`Double-tap FAILED — ${err?.message ?? "network error"}`);
        }
        return;
      }

      // No pending partner tap in range — hold this one in case a second
      // tap arrives shortly, otherwise send it as a plain single tap.
      lastTapRef.current = { x: drag.startX, y: drag.startY, at: now };
      const tapX = drag.startX, tapY = drag.startY;
      const timer = setTimeout(async () => {
        pendingSingleTapRef.current = null;
        addLog(`[manual] Tap → (${tapX}, ${tapY})`);
        try {
          const phoneSize = phoneSizeRef.current;
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/tap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: tapX, y: tapY, videoW: phoneSize?.w, videoH: phoneSize?.h }),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Tap FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
          } else {
            const body = await r.json().catch(() => null);
            if (body?.rescaled) addLog(`Rescale: video ${body.video[0]}×${body.video[1]} → device ${body.device[0]}×${body.device[1]}, tap (${body.from[0]},${body.from[1]}) → (${body.to[0]},${body.to[1]})`);
          }
        } catch (err: any) {
          addLog(`Tap FAILED — ${err?.message ?? "network error"}`);
        }
      }, DOUBLE_TAP_MS);
      pendingSingleTapRef.current = { timer, x: tapX, y: tapY };
      return;
    }

    addLog(`Swipe → (${drag.startX}, ${drag.startY}) → (${endX}, ${endY}) over ${durationMs}ms`);
    try {
      // Same rescale-input requirement as tap/double-tap: without videoW/videoH
      // the server has nothing to rescale from and silently sends the raw
      // video-pixel coordinates straight through. This was previously omitted
      // here, so every drag gesture (including press-and-drag to close a
      // floating window) went out unscaled while plain taps were correct —
      // exactly the "some clicks are pinpoint, some functions don't work"
      // symptom reported for drag-based interactions.
      const phoneSize = phoneSizeRef.current;
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x1: drag.startX, y1: drag.startY, x2: endX, y2: endY,
          durationMs, videoW: phoneSize?.w, videoH: phoneSize?.h,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        addLog(`Swipe FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
      }
    } catch (err: any) {
      addLog(`Swipe FAILED — ${err?.message ?? "network error"}`);
    }
  }, [serial, addLog, mapToPhone, endDrag]);

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // Gesture was interrupted (e.g. browser took over for scroll/multitouch)
    // — discard it rather than guessing at intent.
    dragRef.current = null;
    endDrag(e);
    addLog(`Gesture cancelled`);
  }, [addLog, endDrag]);

  const clickable = status === "live" || status === "asleep" || status === "error";

  // ── Clipboard context menu ───────────────────────────────────────────────
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number } | null>(null);
  const clipMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clipMenu) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent) { if (e.key === "Escape") setClipMenu(null); return; }
      if (clipMenuRef.current && !clipMenuRef.current.contains(e.target as Node)) setClipMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismiss); };
  }, [clipMenu]);

  const doClipAction = useCallback(async (action: "selectAll" | "copy" | "paste") => {
    setClipMenu(null);
    const base = `/api/mobile/devices/${encodeURIComponent(serial)}`;
    try {
      if (action === "selectAll") {
        await fetch(`${base}/input/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "KEYCODE_SELECT_ALL" }) });
      } else if (action === "copy") {
        await fetch(`${base}/input/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "KEYCODE_COPY" }) });
      } else if (action === "paste") {
        const electronClipboard = (window as any).electronAPI?.readClipboardText;
        const text = electronClipboard
          ? await electronClipboard().catch(() => "")
          : await navigator.clipboard.readText().catch(() => "");
        if (text) {
          // Mirror Paste types the desktop clipboard value through real taps
          // on the phone's saved Android keyboard calibration map.
          const r = await fetch(`${base}/input/clipboard-paste`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Paste FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
          }
        } else {
          addLog("Paste skipped — desktop clipboard is empty or unavailable");
        }
      }
    } catch (err: any) {
      addLog(`Clipboard action FAILED — ${err?.message ?? "network error"}`);
    }
  }, [serial, addLog]);

  return (
    <div className="absolute inset-0 bg-black">
      {status === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
          <span className="text-[10px] text-white/30 select-none">Connecting…</span>
        </div>
      )}
      {status === "waiting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
          <span className="text-[10px] text-white/30 select-none">Waiting for screen data…</span>
        </div>
      )}
      {status === "asleep" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
          <span className="text-[10px] text-white/40 select-none">Screen is asleep — tap to wake</span>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2 z-10 pointer-events-none">
          <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />
          <span className="text-[10px] text-yellow-400 font-semibold text-center">Stream error — tap to retry waking the phone</span>
        </div>
      )}

      {/* ── Screen canvas — stays mounted (not display:none) in every state
             once we've reached "waiting" or later, so a tap on a black/asleep
             screen is still captured by the click handler instead of being
             swallowed by an overlay with no listener. ── */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => {
          e.preventDefault();
          if (logRecModeRef2.current) {
            const p = mapToPhone(e.clientX, e.clientY);
            if (p) onExpectedTapRef.current?.(p.x, p.y, "vicinity");
            return;
          }
          if (clickable) setClipMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display:       status === "connecting" ? "none" : "block",
          position:      "absolute",
          inset:         0,
          width:         "100%",
          height:        "100%",
          cursor:        inspectMode ? "crosshair" : clickTestMode ? "cell" : clickable ? "pointer" : "default",
          pointerEvents: clickable ? "auto" : "none",
          zIndex:        5,
        }}
      />

      {/* Inspect hover highlight ─────────────────────────────────────────────
           Chrome DevTools-style blue border drawn over the innermost
           accessibility node under the cursor. Always rendered but hidden
           (display:none) — direct DOM ref updates bypass React state so the
           highlight moves instantly on every pointermove, with zero render lag.
           No transition, no state batching delay.                             */}
      <div
        ref={inspectOverlayRef}
        className="pointer-events-none"
        style={{
          display:    "none",
          position:   "absolute",
          border:     "2px solid #1a73e8",
          background: "rgba(26,115,232,0.08)",
          zIndex:     30,
        }}
      >
        {/* Chrome-style tooltip: "ClassName · resource-id  WxH px" */}
        <div style={{
          position: "absolute", bottom: "calc(100% + 3px)", left: 0,
          display: "flex", alignItems: "center", gap: 4,
          background: "#1a73e8", color: "#fff",
          fontSize: 9, fontWeight: 600, fontFamily: "monospace",
          padding: "2px 6px", borderRadius: 3,
          whiteSpace: "nowrap", maxWidth: 300,
          overflow: "hidden", textOverflow: "ellipsis",
          pointerEvents: "none", zIndex: 31,
          boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
        }}>
          <span ref={inspectLabelRef} style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} />
          <span style={{ opacity: 0.7, flexShrink: 0 }}>·</span>
          <span ref={inspectSizeRef} style={{ opacity: 0.85, flexShrink: 0 }} />
          <span style={{ opacity: 0.6, flexShrink: 0 }}>px</span>
        </div>
      </div>

      {/* Tap indicator dots — red = where mouse clicked, blue = where tap was sent.
           If they don't overlap, mapToPhone() has an offset bug. */}
      {tapDots && (
        <>
          {/* Blue outer ring: reverse-mapped from phone coords — where tap was sent */}
          <div style={{
            position: "absolute",
            left: tapDots.mapX,
            top: tapDots.mapY,
            width: 20,
            height: 20,
            marginLeft: -10,
            marginTop: -10,
            borderRadius: "50%",
            background: "rgba(40,120,255,0.7)",
            border: "2px solid white",
            zIndex: 20,
            pointerEvents: "none",
          }} />
          {/* Red inner dot: raw mouse click position — rendered last so it's on top */}
          <div style={{
            position: "absolute",
            left: tapDots.rawX,
            top: tapDots.rawY,
            width: 10,
            height: 10,
            marginLeft: -5,
            marginTop: -5,
            borderRadius: "50%",
            background: "rgba(255,40,40,0.95)",
            border: "1.5px solid white",
            zIndex: 21,
            pointerEvents: "none",
          }} />
          {/* Yellow dot: user's correction — where the tap SHOULD have landed */}
          {tapDots.yellowX != null && tapDots.yellowY != null && (
            <div style={{
              position: "absolute",
              left: tapDots.yellowX,
              top: tapDots.yellowY,
              width: 16,
              height: 16,
              marginLeft: -8,
              marginTop: -8,
              borderRadius: "50%",
              background: "rgba(255,210,0,0.95)",
              border: "2px solid white",
              zIndex: 22,
              pointerEvents: "none",
            }} />
          )}
        </>
      )}

      {/* ── Log Record marker overlay ──────────────────────────────────────
           Cyan  = user-placed "expected" tap (what you thought would happen)
           Orange = bot-placed tap (what automation actually sent)
           Markers are in phone-coordinate space; we reverse-map them to
           canvas-pixel CSS positions using the same drawRectRef as mapToPhone
           so they always land on the correct pixel even after resize.       */}
      {logRecMode && logMarkers && logMarkers.length > 0 && (() => {
        const ps  = phoneSizeRef.current;
        const dr  = drawRectRef.current;
        if (!ps || !dr) return null;
        const { w: phoneW, h: phoneH } = ps;
        const { dx, dy, dw, dh } = dr;
        return (
          <>
            {logMarkers.map((m, i) => {
              const cssX = dx + (m.x / phoneW) * dw;
              const cssY = dy + (m.y / phoneH) * dh;
              const isBot      = m.type === "bot";
              const isVicinity = m.type === "vicinity";
              // cyan = exact expected (left-click), yellow = vicinity/multi-choice (right-click), orange = bot actual
              const size   = isBot ? 16 : 22;
              const half   = size / 2;
              const bg     = isBot      ? "rgba(255,120,20,0.85)"
                           : isVicinity ? "rgba(220,190,0,0.75)"
                           :              "rgba(0,210,210,0.85)";
              const shadow = isBot      ? "0 0 6px rgba(255,120,20,0.7)"
                           : isVicinity ? "0 0 8px rgba(220,190,0,0.8)"
                           :              "0 0 6px rgba(0,210,210,0.7)";
              const labelBg = isBot      ? "rgba(180,70,0,0.9)"
                            : isVicinity ? "rgba(160,130,0,0.9)"
                            :              "rgba(0,140,140,0.9)";
              return (
                <React.Fragment key={i}>
                  <div style={{
                    position: "absolute",
                    left: cssX, top: cssY,
                    width: size, height: size,
                    marginLeft: -half, marginTop: -half,
                    borderRadius: "50%",
                    background: bg,
                    border: isVicinity ? "2px dashed white" : "2px solid white",
                    zIndex: 25,
                    pointerEvents: "none",
                    boxShadow: shadow,
                  }} />
                  {/* Sequence number label */}
                  <div style={{
                    position: "absolute",
                    left: cssX + half, top: cssY - half,
                    fontSize: 8, lineHeight: 1, fontWeight: 700, color: "white",
                    background: labelBg,
                    borderRadius: 3, padding: "1px 2px",
                    zIndex: 26, pointerEvents: "none",
                    whiteSpace: "nowrap",
                  }}>
                    {i + 1}
                  </div>
                </React.Fragment>
              );
            })}
          </>
        );
      })()}

      {/* Log Record mode banner */}
      {logRecMode && (
        <div style={{ position: "absolute", top: 6, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 30, pointerEvents: "none" }}>
          <span style={{ background: "rgba(0,180,180,0.92)", color: "white", fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10, letterSpacing: 1 }}>
            📍 LOG RECORD — left-click: exact cyan marker · right-click: approximate yellow marker
          </span>
        </div>
      )}

      {/* FPS */}
      {status === "live" && (
        <span className="absolute top-1 right-1.5 text-[8px] font-mono text-white/30 select-none z-10">
          {fps} fps
        </span>
      )}

      {/* ── Clipboard context menu ─────────────────────────────────────── */}
      {clipMenu && (
        <div
          ref={clipMenuRef}
          onPointerDown={e => e.stopPropagation()}
          style={{
            position: "fixed", left: clipMenu.x, top: clipMenu.y, zIndex: 200,
            background: "#1e1e1e", border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            padding: "4px 0", minWidth: 140, userSelect: "none",
          }}
        >
          {([ ["Select All", "selectAll"], ["Copy", "copy"], ["Paste", "paste"] ] as const).map(([label, action]) => (
            <button
              key={action}
              onPointerDown={e => { e.stopPropagation(); doClipAction(action); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                background: "none", border: "none", color: "#e0e0e0",
                fontSize: 12, padding: "6px 14px", cursor: "pointer",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}));

// ─── Slot Customize Dialog ────────────────────────────────────────────────────

function CustomizePanel({
  open, onOpenChange, custom, onChange, slotIdx,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  custom: SlotCustomization;
  onChange: (c: SlotCustomization) => void;
  slotIdx: number;
}) {
  const [tab, setTab] = useState<'wallpaper' | 'text'>('wallpaper');
  const [editId, setEditId] = useState<string | null>(null);
  const [pickingWallpaper, setPickingWallpaper] = useState(false);

  const updateLayer = (id: string, patch: Partial<TextLayer>) =>
    onChange({ ...custom, texts: custom.texts.map(t => t.id === id ? { ...t, ...patch } : t) });

  const addLayer = () => {
    const layer = makeTextLayer();
    onChange({ ...custom, texts: [...custom.texts, layer] });
    setEditId(layer.id);
    setTab('text');
  };

  const removeLayer = (id: string) => {
    onChange({ ...custom, texts: custom.texts.filter(t => t.id !== id) });
    if (editId === id) setEditId(null);
  };

  const browseWallpaper = async () => {
    setPickingWallpaper(true);
    try {
      const wallpaper = await pickLocalWallpaper();
      if (wallpaper) onChange({ ...custom, wallpaper });
    } finally {
      setPickingWallpaper(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customise Slot {slotIdx + 1}</DialogTitle>
        </DialogHeader>

        {/* Tab strip */}
        <div className="flex border-b border-border -mt-1 mb-3">
          {(['wallpaper', 'text'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >{t === 'text' ? 'Text Layers' : 'Wallpaper'}</button>
          ))}
        </div>

        {/* ── Wallpaper tab ── */}
        {tab === 'wallpaper' && (
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={browseWallpaper}
              disabled={pickingWallpaper}
              className={`relative aspect-[9/16] rounded-lg border-2 overflow-hidden transition-all ${
                custom.wallpaper?.startsWith('data:image/') ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
              }`}
            >
              {custom.wallpaper?.startsWith('data:image/') ? (
                <img src={custom.wallpaper} className="w-full h-full object-cover" draggable={false} />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 bg-muted/30">
                  {pickingWallpaper ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <ImagePlus className="w-4 h-4 text-primary" />}
                  <span className="text-[9px] text-muted-foreground font-medium px-1">Browse from PC</span>
                </div>
              )}
              <div className="absolute bottom-0 inset-x-0 bg-black/60 py-0.5 px-1 text-left">
                <span className="text-[8px] text-white/80 leading-none">From PC</span>
              </div>
              {custom.wallpaper?.startsWith('data:image/') && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />
              )}
            </button>
            {/* None option */}
            <button
              type="button"
              onClick={() => onChange({ ...custom, wallpaper: null })}
              className={`relative aspect-[9/16] rounded-lg border-2 flex items-center justify-center bg-zinc-900 transition-all ${
                !custom.wallpaper ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
              }`}
            >
              <span className="text-[10px] text-muted-foreground font-medium">None</span>
              {!custom.wallpaper && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />}
            </button>
            {SLOT_WALLPAPERS.map(wp => (
              <button
                key={wp.id}
                type="button"
                onClick={() => onChange({ ...custom, wallpaper: wp.id })}
                className={`relative aspect-[9/16] rounded-lg border-2 overflow-hidden transition-all ${
                  custom.wallpaper === wp.id ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground'
                }`}
              >
                <img src={`/wallpapers/${wp.id}`} className="w-full h-full object-cover" draggable={false} />
                <div className="absolute bottom-0 inset-x-0 bg-black/60 py-0.5 px-1 text-left">
                  <span className="text-[8px] text-white/80 leading-none">{wp.label}</span>
                </div>
                {custom.wallpaper === wp.id && (
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Text tab ── */}
        {tab === 'text' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{custom.texts.length} layer{custom.texts.length !== 1 ? 's' : ''}</span>
              <Button size="sm" variant="outline" onClick={addLayer} className="gap-1.5 h-7 text-xs">
                <Plus className="w-3 h-3" />Add Text
              </Button>
            </div>

            {custom.texts.length === 0 && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No text layers yet — click <strong>Add Text</strong> to get started.
              </div>
            )}

            {custom.texts.map(layer => (
              <div key={layer.id} className={`rounded-lg border transition-colors ${editId === layer.id ? 'border-primary/50 bg-muted/20' : 'border-border'}`}>
                {/* Layer row */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    className="flex-1 text-sm truncate cursor-pointer select-none"
                    style={{
                      fontFamily: SLOT_FONTS.find(f => f.id === layer.font)?.family,
                      color: layer.color,
                      fontWeight: layer.bold ? 'bold' : 'normal',
                      fontStyle: layer.italic ? 'italic' : 'normal',
                      textShadow: layer.shadow ? '0 1px 3px rgba(0,0,0,0.6)' : 'none',
                    }}
                    onClick={() => setEditId(editId === layer.id ? null : layer.id)}
                  >{layer.text || <span className="text-muted-foreground italic text-xs">empty</span>}</span>
                  <button
                    onClick={() => setEditId(editId === layer.id ? null : layer.id)}
                    className="text-xs text-muted-foreground hover:text-foreground px-1 transition-colors"
                  >{editId === layer.id ? 'Done' : 'Edit'}</button>
                  <button
                    onClick={() => removeLayer(layer.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                  ><X className="w-3.5 h-3.5" /></button>
                </div>

                {/* Expanded editor */}
                {editId === layer.id && (
                  <div className="px-3 pb-3 space-y-3 border-t border-border/50 pt-3">
                    {/* Text content */}
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Text</label>
                      <input
                        className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        value={layer.text}
                        onChange={e => updateLayer(layer.id, { text: e.target.value })}
                        placeholder="Enter text…"
                        autoFocus
                      />
                    </div>

                    {/* Font + size */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Font</label>
                        <select
                          className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          value={layer.font}
                          onChange={e => updateLayer(layer.id, { font: e.target.value })}
                        >
                          {SLOT_FONTS.map(f => (
                            <option key={f.id} value={f.id}>{f.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Size — {layer.size}px</label>
                        <input
                          type="range" min={8} max={72} value={layer.size}
                          onChange={e => updateLayer(layer.id, { size: Number(e.target.value) })}
                          className="w-full mt-2 accent-primary"
                        />
                      </div>
                    </div>

                    {/* Colour + style toggles */}
                    <div className="flex items-end gap-5">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Colour</label>
                        <input
                          type="color" value={layer.color}
                          onChange={e => updateLayer(layer.id, { color: e.target.value })}
                          className="w-10 h-8 rounded border border-border cursor-pointer bg-background block"
                        />
                      </div>
                      {(['bold', 'italic', 'shadow'] as const).map(key => (
                        <label key={key} className="flex flex-col items-center gap-1 cursor-pointer">
                          <span className="text-xs text-muted-foreground capitalize">{key}</span>
                          <input
                            type="checkbox"
                            checked={layer[key]}
                            onChange={e => updateLayer(layer.id, { [key]: e.target.checked })}
                            className="accent-primary w-4 h-4"
                          />
                        </label>
                      ))}
                    </div>

                    {/* Position */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">X — {layer.x}%</label>
                        <input type="range" min={0} max={100} value={layer.x}
                          onChange={e => updateLayer(layer.id, { x: Number(e.target.value) })}
                          className="w-full accent-primary" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Y — {layer.y}%</label>
                        <input type="range" min={0} max={100} value={layer.y}
                          onChange={e => updateLayer(layer.id, { y: Number(e.target.value) })}
                          className="w-full accent-primary" />
                      </div>
                    </div>

                    {/* Mini preview */}
                    <div className="rounded bg-zinc-950 h-20 relative overflow-hidden border border-border/30">
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] text-white/10 select-none">preview</span>
                      <div
                        className="absolute pointer-events-none"
                        style={{
                          left: `${layer.x}%`,
                          top: `${layer.y}%`,
                          transform: 'translate(-50%, -50%)',
                          fontFamily: SLOT_FONTS.find(f => f.id === layer.font)?.family,
                          fontSize: `${Math.min(layer.size, 28)}px`,
                          color: layer.color,
                          fontWeight: layer.bold ? 'bold' : 'normal',
                          fontStyle: layer.italic ? 'italic' : 'normal',
                          textShadow: layer.shadow ? '0 1px 6px rgba(0,0,0,0.9)' : 'none',
                          whiteSpace: 'pre',
                          lineHeight: 1.2,
                        }}
                      >{layer.text || 'preview'}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

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

// ─── Keyboard Calibration Dialog ─────────────────────────────────────────────
//
// One-time per-device calibration: walks through each keyboard key, waits for
// the user to physically tap it, captures the raw screen coordinate via
// `adb shell getevent`, and stores label → {x,y} for that device.
// The API server then uses these stored positions to fire real `input tap`
// events when the bot needs to type — indistinguishable from a human tap.

const CALIB_GROUPS: Array<{
  name: string;
  instructions: string;
  keys: Array<{ label: string; display: string; mapKey?: string }>;
}> = [
  {
    name: "Letters (ABC layer)",
    instructions: "Keep the keyboard on the ABC / qwerty layer. This includes the bottom-row controls used to open emoji and symbols.",
    keys: [
      { label: "q", display: "Q" }, { label: "w", display: "W" }, { label: "e", display: "E" },
      { label: "r", display: "R" }, { label: "t", display: "T" }, { label: "y", display: "Y" },
      { label: "u", display: "U" }, { label: "i", display: "I" }, { label: "o", display: "O" },
      { label: "p", display: "P" }, { label: "a", display: "A" }, { label: "s", display: "S" },
      { label: "d", display: "D" }, { label: "f", display: "F" }, { label: "g", display: "G" },
      { label: "h", display: "H" }, { label: "j", display: "J" }, { label: "k", display: "K" },
      { label: "l", display: "L" }, { label: "z", display: "Z" }, { label: "x", display: "X" },
      { label: "c", display: "C" }, { label: "v", display: "V" }, { label: "b", display: "B" },
      { label: "n", display: "N" }, { label: "m", display: "M" },
      { label: "shift",      display: "⇧ Shift", mapKey: "shift" },
      { label: "comma",      display: ",", mapKey: "," },
      { label: "space",      display: "Space" },
      { label: "period",     display: ".", mapKey: "." },
      { label: "backspace", display: "⌫ Backspace", mapKey: "backspace" },
      { label: "enter",      display: "↵ Enter" },
      // This is intentionally the final key on the ABC layer: tapping it
      // changes the phone to the symbols layer for the next group.
      { label: "symbols",    display: "?123 Symbols", mapKey: "symbols" },
    ],
  },
  {
    name: "Numbers & Symbols (?123 layer)",
    instructions: "Tap the ?123 / Symbols key on your phone now. Stay on this layer while you capture every key below.",
    keys: [
      { label: "1", display: "1" }, { label: "2", display: "2" }, { label: "3", display: "3" },
      { label: "4", display: "4" }, { label: "5", display: "5" }, { label: "6", display: "6" },
      { label: "7", display: "7" }, { label: "8", display: "8" }, { label: "9", display: "9" },
      { label: "0", display: "0" }, { label: "@", display: "@" }, { label: "#", display: "#" },
      { label: "$", display: "$" }, { label: "_", display: "_" }, { label: "&", display: "&" },
      { label: "-", display: "-" }, { label: "+", display: "+" }, { label: "(", display: "(" },
      { label: ")", display: ")" }, { label: "/", display: "/" }, { label: "*", display: "*" },
      { label: "\"", display: "\"" }, { label: "'", display: "'" }, { label: ":", display: ":" },
      { label: ";", display: ";" }, { label: "!", display: "!" }, { label: "?", display: "?" },
      { label: "%", display: "%" }, { label: "=", display: "=" },
      // This is intentionally the final key on the first symbols layer:
      // tapping it changes the phone to the extended symbols layer.
      { label: "more-symbols", display: "=\\< More", mapKey: "moreSymbols" },
    ],
  },
  {
    name: "More symbols (=\\< layer)",
    instructions: "Tap the =\\< / More symbols key on your phone now. Capture this extra punctuation layer too, then return to ABC when finished.",
    keys: [
      { label: "~", display: "~" }, { label: "`", display: "`" }, { label: "|", display: "|" },
      { label: "•", display: "•" }, { label: "√", display: "√" }, { label: "π", display: "π" },
      { label: "÷", display: "÷" }, { label: "×", display: "×" }, { label: "§", display: "§" },
      { label: "∆", display: "∆" }, { label: "£", display: "£" }, { label: "€", display: "€" },
      { label: "¥", display: "¥" }, { label: "^", display: "^" }, { label: "°", display: "°" },
      { label: "{", display: "{" }, { label: "}", display: "}" }, { label: "[", display: "[" },
      { label: "]", display: "]" }, { label: "\\", display: "\\" }, { label: "<", display: "<" },
      { label: ">", display: ">" },
      // The ABC key returns to the letter layer so the final emoji capture is
      // performed from the normal keyboard, where the picker button is stable.
      { label: "letters", display: "ABC Letters", mapKey: "abc" },
      // Emoji opens a picker rather than changing the keyboard layer. It is
      // deliberately the final capture so the run never asks for another
      // keyboard key while the picker is open.
      { label: "emoji", display: "😊 Emoji", mapKey: "emoji" },
    ],
  },
];

interface CalibKey { label: string; display: string; mapKey?: string; groupIdx: number; groupName: string; instructions: string; }
const CALIB_KEYS: CalibKey[] = CALIB_GROUPS.flatMap((g, gi) =>
  g.keys.map(k => ({ ...k, groupIdx: gi, groupName: g.name, instructions: g.instructions }))
);

function CalibrationDialog({
  serial,
  open,
  onOpenChange,
  onLog,
}: {
  serial: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLog?: (msg: string) => void;
}) {
  const [step, setStep] = useState(0);
  // Starts pre-populated with the saved map so the wizard merges into it rather
  // than wiping previously captured keys when you redo calibration partially.
  const [map, setMap] = useState<Record<string, { x: number; y: number }>>({});
  const [capturing, setCapturing] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // "intro" → start screen | "wizard" → full step-through | "editMap" → view/fix individual keys
  const [mode, setMode] = useState<"intro" | "wizard" | "editMap">("intro");
  // editMap: which key is currently being re-captured (null = none active)
  const [editTarget, setEditTarget] = useState<CalibKey | null>(null);
  const [editResult, setEditResult] = useState<string | null>(null);
  // editMap: tracking row-level capturing state (by mapKey)
  const [editCapturing, setEditCapturing] = useState<string | null>(null);
  const [testText, setTestText] = useState("");
  const [testingText, setTestingText] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  // The calibration panel starts in its existing top-right position. Once the
  // title bar is dragged, keep the panel at an explicit viewport position.
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const panelDragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // Reset state and load existing map whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setMap({});
    setCapturing(false);
    setLastResult(null);
    setSaved(false);
    setMode("intro");
    setEditTarget(null);
    setEditResult(null);
    setEditCapturing(null);
    setTestText("");
    setTestingText(false);
    setTestResult(null);
    setPanelPosition(null);

    // Load full existing map so the wizard can merge into it and editMap can
    // display current coords without wiping anything.
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration`)
      .then(r => r.json())
      .then(body => { if (body.ok && body.map) setMap(body.map); })
      .catch(() => {});

    // Pre-warm device-info + screen-size caches so the first capture is fast.
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration/prefetch`, { method: "POST" })
      .catch(() => {});
  }, [open, serial]);

  const existingCount = Object.keys(map).length;

  const currentKey = step < CALIB_KEYS.length ? CALIB_KEYS[step] : null;
  const prevGroupIdx = step > 0 ? CALIB_KEYS[step - 1].groupIdx : -1;
  const showGroupHeader = currentKey && (step === 0 || currentKey.groupIdx !== prevGroupIdx);
  const isDone = step >= CALIB_KEYS.length;
  const progress = Math.round((step / CALIB_KEYS.length) * 100);

  const captureKey = async () => {
    if (!currentKey || capturing) return;
    setCapturing(true);
    setLastResult(null);
    try {
      const resp = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration/capture`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeoutMs: 12000 }) }
      );
      const body = await resp.json();
      if (body.ok && body.x != null && body.y != null) {
        const mapKey = currentKey.mapKey ?? currentKey.label;
        const newMap = { ...map, [mapKey]: { x: body.x, y: body.y } };
        setMap(newMap);
        setLastResult(`✓ Captured at (${body.x}, ${body.y})`);
        onLog?.(`[calibration] '${currentKey.display}' → (${body.x}, ${body.y})`);
        setTimeout(() => { setLastResult(null); setStep(s => s + 1); }, 700);
      } else {
        setLastResult(`✗ ${body.error ?? "No tap detected — try again"}`);
      }
    } catch {
      setLastResult("✗ Request failed — check server logs");
    } finally {
      setCapturing(false);
    }
  };

  const skipKey = () => { setLastResult(null); setStep(s => s + 1); };

  const saveMap = async (mapToSave = map) => {
    try {
      const resp = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration/save`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map: mapToSave }) }
      );
      const body = await resp.json();
      if (body.ok) {
        setSaved(true);
        onLog?.(`[calibration] Saved ${Object.keys(mapToSave).length} keys for ${serial}`);
      }
    } catch { /**/ }
  };

  const testCalibratedText = async () => {
    const text = testText;
    if (!text.trim() || testingText) return;
    setTestingText(true);
    setTestResult(null);
    try {
      const resp = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      const body = await resp.json();
      if (body.ok) {
        setTestResult(`✓ Typed ${text.length} character${text.length === 1 ? "" : "s"} using calibrated taps`);
        onLog?.(`[calibration] TEST TEXT typed ${text.length} character${text.length === 1 ? "" : "s"}`);
      } else {
        const missing = Array.isArray(body.missing) && body.missing.length > 0
          ? ` Missing: ${body.missing.join(", ")}`
          : "";
        setTestResult(`✗ Calibration test incomplete.${missing}`);
        onLog?.(`[calibration] TEST TEXT missing mapped keys: ${body.missing?.join(", ") || "unknown"}`);
      }
    } catch {
      setTestResult("✗ Test request failed — check server logs");
    } finally {
      setTestingText(false);
    }
  };

  const clearExisting = async () => {
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration`, { method: "DELETE" });
      setMap({});
      onLog?.("[calibration] Existing map cleared");
    } catch { /**/ }
  };

  // Re-capture a single key from the Edit Map view and immediately save.
  const captureEditKey = async (key: CalibKey) => {
    if (editCapturing) return;
    const mapKey = key.mapKey ?? key.label;
    setEditCapturing(mapKey);
    setEditTarget(key);
    setEditResult(null);
    try {
      const resp = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/keyboard-calibration/capture`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeoutMs: 12000 }) }
      );
      const body = await resp.json();
      if (body.ok && body.x != null && body.y != null) {
        const newMap = { ...map, [mapKey]: { x: body.x, y: body.y } };
        setMap(newMap);
        setEditResult(`✓ ${key.display} → (${body.x}, ${body.y})`);
        onLog?.(`[calibration] re-captured '${key.display}' → (${body.x}, ${body.y})`);
        // Auto-save so existing keys for other letters are never lost.
        await saveMap(newMap);
      } else {
        setEditResult(`✗ ${body.error ?? "No tap detected — try again"}`);
      }
    } catch {
      setEditResult("✗ Request failed — check server logs");
    } finally {
      setEditCapturing(null);
      setEditTarget(null);
    }
  };

  const handlePanelDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    panelDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    };
    setPanelPosition({ left: bounds.left, top: bounds.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePanelDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, event.clientX - drag.offsetX),
      Math.max(margin, window.innerWidth - bounds.width - margin),
    );
    const top = Math.min(
      Math.max(margin, event.clientY - drag.offsetY),
      Math.max(margin, window.innerHeight - bounds.height - margin),
    );
    setPanelPosition({ left, top });
  };

  const handlePanelDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panelDragRef.current?.pointerId !== event.pointerId) return;
    panelDragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  return (
    <Dialog open={open} modal={false} onOpenChange={v => { if (!capturing && !editCapturing) onOpenChange(v); }}>
      <DialogContent
        hideOverlay
        className="fixed right-4 top-4 left-auto max-h-[calc(100vh-2rem)] max-w-md translate-x-0 translate-y-0 overflow-y-auto border-slate-700 bg-slate-950 text-slate-100"
        style={panelPosition ? { left: panelPosition.left, top: panelPosition.top, right: "auto" } : undefined}
      >
        <DialogHeader
          className="cursor-move select-none"
          onPointerDown={handlePanelDragStart}
          onPointerMove={handlePanelDragMove}
          onPointerUp={handlePanelDragEnd}
          onPointerCancel={handlePanelDragEnd}
        >
          <DialogTitle className="text-sm">
            {mode === "editMap" ? "Edit Calibration Map" : "Keyboard Calibration"}
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-cyan-700/60 bg-cyan-950/40 px-3 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-cyan-200">TEST TEXT</p>
          <p className="mt-1 text-[11px] leading-4 text-cyan-100/80">
            Type a word while the phone keyboard is already open. TEST presses every character using only this device&apos;s saved mapped coordinates.
          </p>
          <div className="mt-2 flex gap-2">
            <BaseInput
              value={testText}
              onChange={e => { setTestText(e.target.value); setTestResult(null); }}
              onKeyDown={e => { if (e.key === "Enter") void testCalibratedText(); }}
              placeholder="Enter test text"
              aria-label="Test text"
              disabled={testingText}
              className="h-8 border-cyan-800 bg-slate-900 text-xs text-slate-100 placeholder:text-slate-500"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void testCalibratedText()}
              disabled={!testText.trim() || testingText || !!capturing || !!editCapturing}
              className="h-8 shrink-0 bg-cyan-700 text-xs hover:bg-cyan-600"
            >
              {testingText ? <Loader2 className="h-3 w-3 animate-spin" /> : "TEST"}
            </Button>
          </div>
          {testResult && (
            <p className={`mt-2 text-[11px] font-mono ${testResult.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>
              {testResult}
            </p>
          )}
        </div>

        {/* ── Edit Map view ── */}
        {mode === "editMap" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {existingCount} / {CALIB_KEYS.length} keys mapped — click Re-tap to fix any wrong one
              </p>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-slate-300 hover:bg-slate-800"
                onClick={() => { setMode("intro"); setEditResult(null); }} disabled={!!editCapturing}>
                ← Back
              </Button>
            </div>
            {editResult && (
              <p className={`text-xs font-mono px-2 ${editResult.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>
                {editResult}
              </p>
            )}
            {editCapturing && (
              <div className="flex items-center gap-2 rounded-lg border border-blue-700/60 bg-blue-950/60 px-3 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300 flex-shrink-0" />
                <p className="text-xs text-blue-200">
                  Listening for tap on <strong>{editTarget?.display}</strong> — tap the key on the phone now…
                </p>
              </div>
            )}
            <div className="max-h-[52vh] overflow-y-auto space-y-4 pr-1">
              {CALIB_GROUPS.map(group => (
                <div key={group.name}>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{group.name}</p>
                  <div className="space-y-1">
                    {group.keys.map(k => {
                      const mk = k.mapKey ?? k.label;
                      const coord = map[mk];
                      const isActive = editCapturing === mk;
                      return (
                        <div key={mk}
                          className={`flex items-center justify-between rounded-md px-2.5 py-1.5 ${isActive ? "bg-blue-950/70 border border-blue-700/60" : "bg-slate-900 border border-slate-800"}`}>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`text-[10px] font-bold flex-shrink-0 ${coord ? "text-green-400" : "text-slate-600"}`}>
                              {coord ? "✓" : "✗"}
                            </span>
                            <span className="text-xs text-slate-200 truncate">{k.display}</span>
                            {coord && (
                              <span className="text-[10px] text-slate-500 font-mono flex-shrink-0">
                                ({coord.x}, {coord.y})
                              </span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-6 px-2 text-[10px] flex-shrink-0 ml-2 ${isActive ? "text-blue-300" : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"}`}
                            onClick={() => captureEditKey({ ...k, groupIdx: CALIB_GROUPS.indexOf(group), groupName: group.name, instructions: group.instructions })}
                            disabled={!!editCapturing}
                          >
                            {isActive ? <Loader2 className="w-3 h-3 animate-spin" /> : "Re-tap"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <Button variant="outline" className="w-full border-slate-600 text-slate-200 hover:bg-slate-800"
              onClick={() => onOpenChange(false)} disabled={!!editCapturing}>
              Done
            </Button>
          </div>

        ) : mode === "intro" ? (
        /* ── Intro / start screen ── */
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-amber-200">Do this first</p>
              <p className="mt-1 text-sm leading-5 text-amber-100">
                Open Instagram on the phone, tap a text field, and make sure the keyboard is fully visible before starting.
              </p>
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-slate-300">
              <li>Open a DM composer, comment box, or search field.</li>
              <li>Leave the keyboard on the ABC / letters layer.</li>
              <li>Keep the phone screen awake while calibration runs.</li>
              <li>After each prompt, tap the matching key on the phone.</li>
            </ol>
            {existingCount > 0 && (
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300">
                    Saved map: <span className="text-green-400 font-semibold">{existingCount}</span> / {CALIB_KEYS.length} keys
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-400 hover:bg-red-950/50 hover:text-red-300"
                    onClick={clearExisting}
                  >
                    Clear all
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-7 text-xs border-slate-600 text-slate-200 hover:bg-slate-800"
                  onClick={() => { setSaved(false); setMode("editMap"); }}
                >
                  View & fix individual keys →
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setMode("wizard")}>
                {existingCount > 0 ? "Re-run full calibration" : "Keyboard is open — Start"}
              </Button>
              <Button variant="outline" className="border-slate-600 text-slate-200 hover:bg-slate-800" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </div>

        ) : isDone ? (
          /* ── Done ── */
          <div className="space-y-3">
            <p className="text-sm text-green-400 font-semibold">
              ✓ All {CALIB_KEYS.length} keys walked — {Object.keys(map).length} captured
            </p>
            <p className="text-xs text-slate-300">
              {Object.keys(map).length > 0
                ? "Close the emoji picker and return the phone keyboard to ABC, then save so the bot can use the real tap coordinates."
                : "No keys were captured. Try again — make sure the keyboard is open before capturing."}
            </p>
            {saved ? (
              <div className="space-y-2">
                <p className="text-xs text-green-400">Saved ✓  The bot will use calibrated taps automatically.</p>
                <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>Close</Button>
              </div>
            ) : (
              <div className="flex gap-2">
                {Object.keys(map).length > 0 && (
                  <Button className="flex-1" onClick={() => saveMap()}>Save calibration</Button>
                )}
                <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Discard</Button>
              </div>
            )}
          </div>
        ) : (
          /* ── Step-through wizard ── */
          <div className="space-y-3">
            {/* Layer instructions */}
            {showGroupHeader && (
              <div className="rounded-lg border border-blue-700/60 bg-blue-950/60 px-3 py-2">
                <p className="text-xs font-semibold text-blue-200">{currentKey!.groupName}</p>
                <p className="mt-0.5 text-xs text-blue-100">{currentKey!.instructions}</p>
              </div>
            )}

            {/* Progress bar */}
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{step} / {CALIB_KEYS.length} keys</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-slate-700">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {/* Current key display */}
            <div className="flex flex-col items-center gap-2 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Tap this key in the live phone mirror</p>
              <div className="flex min-h-16 min-w-16 max-w-full items-center justify-center rounded-xl border-2 border-slate-500 bg-slate-800 px-3 shadow-lg">
                <span className="text-center text-2xl font-bold leading-tight text-white">{currentKey!.display}</span>
              </div>
              {lastResult && (
                <p className={`text-xs font-mono ${lastResult.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>
                  {lastResult}
                </p>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={captureKey} disabled={capturing}>
                {capturing
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Listening… (12 s)</>
                  : "Capture tap"}
              </Button>
              <Button variant="outline" className="border-slate-600 text-slate-200 hover:bg-slate-800" onClick={skipKey} disabled={capturing}>Skip</Button>
            </div>
            <p className="text-center text-[9px] text-slate-400">
              Click "Capture tap", then tap the matching key on this device's live mirror
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type PhoneSlotHandle = { getVideoSize: () => { w: number; h: number } | null };

function ManualPhoneMediaPanel({ serial, onLog, open, onClose }: { serial: string; onLog?: (msg: string) => void; open: boolean; onClose: () => void }) {
  const storageKey = `mobile-manual-media:${serial}`;
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [devicePath, setDevicePath] = useState("");
  const [loadedFileName, setLoadedFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const browserFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved?.devicePath) {
        setDevicePath(String(saved.devicePath));
        setLoadedFileName(String(saved.fileName ?? "image"));
      }
    } catch {}
  }, [storageKey]);

  const rememberLoaded = (nextDevicePath: string, fileName: string) => {
    setDevicePath(nextDevicePath);
    setLoadedFileName(fileName);
    try { localStorage.setItem(storageKey, JSON.stringify({ devicePath: nextDevicePath, fileName })); } catch {}
  };

  const selectFromPc = async () => {
    setMessage(null);
    const api = (window as any).electronAPI;
    if (api?.openMediaFileDialog) {
      const result = await api.openMediaFileDialog().catch((e: any) => ({ error: e?.message ?? "Picker failed" }));
      if (result?.error) { setMessage(result.error); return; }
      if (result?.canceled || !result?.filePath) return;
      setSelectedPath(String(result.filePath));
      setSelectedFileName(String(result.fileName ?? result.filePath.split(/[\\/]/).pop() ?? "image"));
      onLog?.(`Manual media: selected ${result.fileName ?? result.filePath}`);
      return;
    }
    browserFileRef.current?.click();
  };

  const onBrowserFile = (file: File | undefined) => {
    if (!file) return;
    setSelectedPath("");
    setSelectedFileName(file.name);
    setMessage(null);
    onLog?.(`Manual media: selected ${file.name}`);
  };

  const loadToPhone = async () => {
    if (!selectedFileName || devicePath) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, string> = { fileName: selectedFileName };
      if (selectedPath) {
        body.localPath = selectedPath;
      } else {
        const file = browserFileRef.current?.files?.[0];
        if (!file) throw new Error("Choose an image first");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read the selected image"));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        body.fileData = data;
      }
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/manual-media/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await r.json().catch(() => null);
      if (!r.ok || !result?.ok) throw new Error(result?.error ?? `Load failed (${r.status})`);
      rememberLoaded(result.devicePath, result.fileName ?? selectedFileName);
      setSelectedPath("");
      setSelectedFileName("");
      setMessage("Loaded onto phone. Finish the post manually in Instagram, then delete it here.");
      onLog?.(`Manual media: loaded ${result.fileName ?? selectedFileName} → ${result.devicePath}`);
    } catch (e: any) {
      setMessage(e?.message ?? "Could not load image onto phone");
      onLog?.(`Manual media: load failed — ${e?.message ?? "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteFromPhone = async () => {
    if (!devicePath) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/manual-media`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devicePath }),
      });
      const result = await r.json().catch(() => null);
      if (!r.ok || !result?.ok) throw new Error(result?.error ?? `Delete failed (${r.status})`);
      onLog?.(`Manual media: deleted ${loadedFileName} from phone`);
      setDevicePath("");
      setLoadedFileName("");
      setSelectedPath("");
      setSelectedFileName("");
      if (browserFileRef.current) browserFileRef.current.value = "";
      try { localStorage.removeItem(storageKey); } catch {}
      setMessage("Deleted from phone.");
    } catch (e: any) {
      setMessage(e?.message ?? "Could not delete image from phone");
      onLog?.(`Manual media: delete failed — ${e?.message ?? "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`absolute bottom-10 left-2 z-40 w-[min(620px,calc(100%-1rem))] rounded-lg border border-cyan-400/25 bg-zinc-900/95 px-3 py-2 shadow-2xl backdrop-blur-sm ${open ? "" : "hidden"}`}>
      <input
        ref={browserFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => onBrowserFile(e.target.files?.[0])}
      />
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-white/70 flex items-center gap-1.5">
          <ImagePlus className="w-3.5 h-3.5 text-cyan-300" /> Manual post image
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-white/45 hover:bg-white/10 hover:text-white/80"
          aria-label="Close manual post image options"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={selectFromPc}
          disabled={busy || !!devicePath}
          className="inline-flex items-center gap-1.5 rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
          title={devicePath ? "Delete the current phone copy before selecting another image" : "Choose one image from the Windows PC"}
        >
          <FolderOpen className="w-3 h-3" /> Select from PC
        </button>
        <button
          type="button"
          onClick={loadToPhone}
          disabled={busy || !selectedFileName || !!devicePath}
          className="inline-flex items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && !devicePath ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          Load to phone
        </button>
        <button
          type="button"
          onClick={deleteFromPhone}
          disabled={busy || !devicePath}
          className="inline-flex items-center gap-1.5 rounded border border-red-400/30 bg-red-400/10 px-2 py-1 text-[10px] font-semibold text-red-200 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && devicePath ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Delete from phone
        </button>
        {selectedFileName && !devicePath && (
          <span className="text-[10px] text-white/55 truncate max-w-[260px]" title={selectedPath || selectedFileName}>
            Selected: {selectedFileName}
          </span>
        )}
        {devicePath && (
          <span className="text-[10px] text-emerald-300/80 truncate max-w-[330px]" title={devicePath}>
            On phone: {loadedFileName}
          </span>
        )}
      </div>
      <p className="mt-1 text-[9px] text-white/35">
        Select one image, load it into Instagram’s gallery, post manually, then delete the phone copy here.
      </p>
      {message && <p className={`mt-1 text-[9px] ${message.startsWith("Deleted") || message.startsWith("Loaded") ? "text-emerald-300" : "text-red-300"}`}>{message}</p>}
    </div>
  );
}

const PhoneSlot = React.forwardRef<PhoneSlotHandle, { phone: UsbPhone | null; idx: number; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; live: boolean; onPower: () => void; phoneDims: { w: number; h: number } | null; paneSize: { w: number; h: number } | null; inspectMode?: boolean; logRecMode?: boolean; logMarkers?: LogMarker[]; onExpectedTap?: (x: number, y: number, kind?: "expected" | "vicinity") => void; custom: SlotCustomization; onCustomChange: (c: SlotCustomization) => void }>(function PhoneSlot({ phone, idx, onLog, onDimensions, live, onPower, phoneDims, paneSize, inspectMode = false, logRecMode, logMarkers, onExpectedTap, custom, onCustomChange }, ref) {
  const liveCanvasRef = useRef<LiveCanvasHandle>(null);
  // Re-exposes LiveCanvas's own handle so the page-level Log tab (rendered
  // as a sibling, not a child, of this slot) can read the mirror's live
  // decoded video frame size for Check Screen Info — see the matching
  // comment on LiveCanvas's `getVideoSize`.
  useImperativeHandle(ref, () => ({
    getVideoSize() {
      return liveCanvasRef.current?.getVideoSize() ?? null;
    },
  }), []);

  // True only while LiveCanvas is actively painting decoded frames.
  // Used to show the wallpaper/text overlay even when live=true — the canvas
  // root div has bg-black (opaque) so without this check, the wallpaper is
  // hidden by the black canvas background whenever the phone screen is off
  // (locked between automation cycles, awaiting connection, etc.).
  const [canvasStreaming, setCanvasStreaming] = useState(false);
  // Reset to false the moment we stop asking for a live mirror so the
  // wallpaper reappears immediately rather than waiting for the next status
  // transition inside LiveCanvas (which is unmounted when live turns off).
  useEffect(() => { if (!live) setCanvasStreaming(false); }, [live]);

  const [clickTestMode, setClickTestMode] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showManualMedia, setShowManualMedia] = useState(false);

  // ── Element tree inspector ─────────────────────────────────────────────────
  // Full UIAutomator node tree shown below the mirror when inspect mode is on.
  // "Tree" tab: hover a row to highlight its bounds on the mirror; hover the
  // mirror to scroll the matching row into view.
  // "Scan" tab: full screenshot with UIAutomator bounds overlaid as rectangles,
  // plus click-to-pin for custom-drawn elements UIAutomator can't see.
  const [inspectTab,     setInspectTab]     = useState<'tree' | 'scan'>('tree');
  const [inspectNodes,   setInspectNodes]   = useState<InspectNode[] | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [imeIncluded,    setImeIncluded]    = useState<boolean | null>(null);
  const [mirrorHoveredIdx, setMirrorHoveredIdx] = useState<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Scan tab state
  const [scanImage,   setScanImage]   = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [customPins,  setCustomPins]  = useState<CustomPin[]>([]);
  const [pendingPin,  setPendingPin]  = useState<PendingPin | null>(null);
  const [imgNatural,  setImgNatural]  = useState<{ w: number; h: number } | null>(null);
  const scanImgRef  = useRef<HTMLImageElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Auto-fetch the full accessibility tree whenever inspect mode is entered.
  useEffect(() => {
    if (!inspectMode || !phone) {
      setInspectNodes(null);
      setMirrorHoveredIdx(null);
      setScanImage(null);
      setCustomPins([]);
      setPendingPin(null);
      setInspectTab('tree');
      return;
    }
    let cancelled = false;
    setInspectLoading(true);
    setInspectNodes(null);
    setImeIncluded(null);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/inspect-all-nodes`)
      .then(r => r.json())
      .then(body => {
        if (!cancelled) {
          setInspectNodes(body.ok ? body.nodes : []);
          setImeIncluded(body.ok ? (body.imeIncluded ?? false) : null);
        }
      })
      .catch(() => { if (!cancelled) { setInspectNodes([]); setImeIncluded(null); } })
      .finally(() => { if (!cancelled) setInspectLoading(false); });
    return () => { cancelled = true; };
  }, [inspectMode, phone?.serial]);

  const refreshInspectNodes = () => {
    if (!phone) return;
    setInspectLoading(true);
    setInspectNodes(null);
    setMirrorHoveredIdx(null);
    setImeIncluded(null);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/inspect-all-nodes`)
      .then(r => r.json())
      .then(body => {
        setInspectNodes(body.ok ? body.nodes : []);
        setImeIncluded(body.ok ? (body.imeIncluded ?? false) : null);
      })
      .catch(() => { setInspectNodes([]); setImeIncluded(null); })
      .finally(() => setInspectLoading(false));
  };

  // Scan tab — take a screenshot and display it.
  const runScan = async () => {
    if (!phone) return;
    setScanLoading(true);
    setScanImage(null);
    setImgNatural(null);
    setPendingPin(null);
    try {
      const r    = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/screencap-base64`);
      const body = await r.json();
      if (body.ok) setScanImage(body.image);
    } finally { setScanLoading(false); }
  };

  // Click anywhere on the scan screenshot — find the nearest UIAutomator node
  // (for context/anchoring) then either highlight it or prompt for a custom pin name.
  const handleScanClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = scanImgRef.current;
    if (!img || !imgNatural) return;
    const rect = img.getBoundingClientRect();
    const cssX  = e.clientX - rect.left;
    const cssY  = e.clientY - rect.top;
    const scaleX = rect.width  / imgNatural.w;
    const scaleY = rect.height / imgNatural.h;
    const phoneX = Math.round(cssX / scaleX);
    const phoneY = Math.round(cssY / scaleY);

    // Find the smallest UIAutomator node that contains this point (may be null).
    const nodes = inspectNodes ?? [];
    const hits  = nodes
      .filter(n => phoneX >= n.boundsRaw[0] && phoneX <= n.boundsRaw[2] && phoneY >= n.boundsRaw[1] && phoneY <= n.boundsRaw[3])
      .sort((a, b) => a.area - b.area);
    const parentNode = hits[0] ?? null;

    setPendingPin({ cssX, cssY, phoneX, phoneY, parentNode });
    setTimeout(() => pinInputRef.current?.focus(), 0);
  };

  // Confirm the pending pin with the typed name.
  const confirmPendingPin = (name: string) => {
    if (!pendingPin) return;
    if (name.trim()) {
      setCustomPins(prev => [...prev, {
        id: `pin_${Date.now()}`,
        name: name.trim(),
        phoneX: pendingPin.phoneX,
        phoneY: pendingPin.phoneY,
        parentNode: pendingPin.parentNode,
      }]);
    }
    setPendingPin(null);
  };

  // Called by LiveCanvas on every mirror pointermove.
  const handleMirrorHoverNode = useCallback((n: InspectNode | null) => {
    const idx = n?.index ?? null;
    setMirrorHoveredIdx(idx);
    if (idx !== null && treeRef.current) {
      const row = treeRef.current.querySelector(`[data-node-idx="${idx}"]`);
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, []);

  // Dump the entire tree + custom pins as a copyable text block.
  const dumpTree = async () => {
    const lines: string[] = [];
    if (inspectNodes?.length) {
      lines.push(`── UIAutomator Tree — ${inspectNodes.length} nodes ──`);
      inspectNodes.forEach(n =>
        lines.push(`[${n.index ?? "?"}] ${n.clickable ? "● TAP" : "○ view"} ${n.cls}${n.resourceId ? `  id="${n.resourceId}"` : ""}${n.contentDesc ? `  desc="${n.contentDesc}"` : ""}${n.text ? `  text="${n.text}"` : ""}  ${n.bounds}  center=(${n.center.x},${n.center.y})`)
      );
    }
    if (customPins.length) {
      lines.push("");
      lines.push(`── Custom Elements (user-tagged) — ${customPins.length} pins ──`);
      customPins.forEach(pin => {
        const parent = pin.parentNode;
        const anchor = parent
          ? `inside ${parent.cls}${parent.resourceId ? ` id="${parent.resourceId}"` : ""} ${parent.bounds}  offset=(${pin.phoneX - parent.center.x},${pin.phoneY - parent.center.y}) from node center`
          : "⚠ no UIAutomator parent — custom-drawn view with no accessibility node";
        lines.push(`[${pin.name}]  phone=(${pin.phoneX},${pin.phoneY})  ${anchor}`);
      });
    }
    if (!lines.length) return;
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `equinox-inspect-dump-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Exact shell sizing ──────────────────────────────────────────────────
  // The shell must hug the phone's real aspect ratio *without* including
  // the header/nav-bar chrome in that ratio math (they have fixed pixel
  // heights, not proportional to the phone's screen). Applying the ratio
  // to the whole shell (chrome + screen combined) makes the resolved
  // screen box shorter than it should be for its width, so LiveCanvas's
  // own contain-fit drawing then pillarboxes to compensate — that's the
  // "dead space" bug, and when it pushes the shell taller than the pane,
  // it's also why the nav bar can get clipped/unreachable by an ancestor's
  // overflow-hidden. See .agents/memory/mobile-mirror-shell-pillarbox.md.
  //
  // Fix: measure the header/nav chrome height for real (it's fixed, but
  // measuring beats guessing pixel values), subtract it from the pane's
  // available height, then size the shell so the *screen* area alone gets
  // the phone's exact ratio — the shell shrink-wraps to that resolved
  // width instead of stretching the video area.
  const headerRef = useRef<HTMLDivElement>(null);
  const navRef    = useRef<HTMLDivElement>(null);
  const [chromeH, setChromeH] = useState(0);

  const isReady        = phone?.state === "device";
  const showNav         = isReady && !!phone;

  useEffect(() => {
    const headerEl = headerRef.current;
    if (!headerEl) return;
    const measure = () => {
      const h = headerEl.getBoundingClientRect().height;
      const n = showNav ? (navRef.current?.getBoundingClientRect().height ?? 0) : 0;
      setChromeH(h + n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(headerEl);
    if (showNav && navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [showNav]);

  const ratio = phoneDims ? phoneDims.w / phoneDims.h : 9 / 16;
  let shellStyle: React.CSSProperties | undefined;
  let shellClassExtra = "w-full h-full";
  if (isReady && live && paneSize && paneSize.w > 0 && paneSize.h > 0 && chromeH > 0) {
    const screenHFromHeight = Math.max(0, paneSize.h - chromeH);
    const widthFromHeight   = screenHFromHeight * ratio;
    const finalWidth        = Math.min(widthFromHeight, paneSize.w);
    const finalScreenH      = finalWidth / ratio;
    shellStyle = { width: `${finalWidth}px`, height: `${finalScreenH + chromeH}px` };
    shellClassExtra = "";
  }

  const label = phone?.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : phone?.product ?? phone?.serial ?? null;

  const isUnauthorized = phone?.state === "unauthorized";
  const isOffline      = phone?.state === "offline";
  const isEmpty        = !phone;

  return (
    <div
      className={`flex flex-col bg-zinc-950 rounded-2xl border border-white/8 overflow-hidden shadow-xl ${shellClassExtra}`}
      style={shellStyle}
    >

      {/* Header */}
      <div ref={headerRef} className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-white/6 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[9px] font-mono text-white/20 shrink-0">S{idx + 1}</span>
          {label && <span className="text-[10px] font-semibold text-white/70 truncate">{label}</span>}
          {phone?.androidVersion && (
            <span className="text-[9px] text-white/25 shrink-0">A{phone.androidVersion}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCustomize(true)}
            title="Customise slot appearance"
            className="text-white/20 hover:text-white/60 transition-colors shrink-0"
          >
            <Palette className="w-3 h-3" />
          </button>
          {isReady        && <span className="flex items-center gap-1 text-[9px] font-bold text-green-400 shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Live</span>}
          {isUnauthorized && <span className="text-[9px] font-semibold text-yellow-500 shrink-0">Auth needed</span>}
          {isOffline      && <span className="text-[9px] font-semibold text-red-500 shrink-0">Offline</span>}
          {isEmpty        && <span className="text-[9px] font-mono text-white/15 shrink-0">empty</span>}
        </div>
      </div>

      {/* Screen area — shrinks to 50 % of shell when inspect panel is open */}
      <div className={`relative bg-zinc-900 min-h-0 ${inspectMode ? "flex-none" : "flex-1"}`}
           style={inspectMode ? { flexBasis: "50%", flexShrink: 1 } : undefined}>
        {isEmpty && <EmptyShell idx={idx} />}

        {/* Wallpaper + text overlay — shown whenever frames aren't flowing.
             This includes the obvious !live case (mirror off) AND the case
             where live=true but the canvas is not yet painting frames —
             e.g. phone screen is locked between automation cycles, scrcpy is
             connecting, or the phone screen is off.  LiveCanvas has an opaque
             bg-black root div, so without this check the black canvas covers
             the wallpaper every time the screen goes dark between cycles. */}
        {(!live || !canvasStreaming) && (custom.wallpaper || custom.texts.length > 0) && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {custom.wallpaper && (
              <img
                src={custom.wallpaper.startsWith('data:image/') ? custom.wallpaper : `/wallpapers/${custom.wallpaper}`}
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
              />
            )}
            {custom.texts.map(layer => (
              <div
                key={layer.id}
                className="absolute"
                style={{
                  left: `${layer.x}%`,
                  top: `${layer.y}%`,
                  transform: 'translate(-50%, -50%)',
                  fontFamily: SLOT_FONTS.find(f => f.id === layer.font)?.family,
                  fontSize: `${layer.size}px`,
                  color: layer.color,
                  fontWeight: layer.bold ? 'bold' : 'normal',
                  fontStyle: layer.italic ? 'italic' : 'normal',
                  textShadow: layer.shadow
                    ? '0 1px 8px rgba(0,0,0,0.95), 0 0 20px rgba(0,0,0,0.6)'
                    : 'none',
                  whiteSpace: 'pre-wrap',
                  textAlign: 'center',
                  maxWidth: '90%',
                  lineHeight: 1.2,
                }}
              >
                {layer.text}
              </div>
            ))}
          </div>
        )}
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

        {isReady && phone && live && (
          <LiveCanvas
            ref={liveCanvasRef}
            serial={phone.serial}
            live={live}
            onLog={onLog}
            onDimensions={onDimensions}
            inspectMode={inspectMode}
            inspectNodes={inspectNodes}
            onHoverNode={handleMirrorHoverNode}
            clickTestMode={clickTestMode}
            logRecMode={logRecMode}
            logMarkers={logMarkers}
            onExpectedTap={onExpectedTap}
            onStatusChange={s => setCanvasStreaming(s === "live")}
          />
        )}
        {isReady && phone && !live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <Power className="w-5 h-5 text-white/25" />
            <p className="text-[10px] text-white/40 leading-relaxed">Press Power to view this phone's screen</p>
          </div>
        )}
      </div>

      {/* ── Element Inspector Panel ─────────────────────────────────────────────
           Two tabs below the mirror:
           TREE — Full UIAutomator accessibility node list. Hover row → bounds
                  highlight on mirror. Hover mirror → row scrolls into view.
           SCAN — Full screenshot with UIAutomator bounds overlaid as outlines.
                  Click any area to drop a named pin. Bare screen areas with no
                  blue outline have NO accessibility node (custom-drawn views) —
                  pin them here so the developer has a named index entry.
           ─────────────────────────────────────────────────────────────────── */}
      {inspectMode && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-blue-400/20 bg-zinc-950 font-mono text-[9px]">

          {/* Tab bar + context actions */}
          <div className="flex items-center gap-0 px-1 py-1 bg-zinc-900/80 border-b border-white/6 shrink-0">
            {/* Tabs */}
            <button
              onClick={() => setInspectTab('tree')}
              className={`text-[8px] font-bold px-2 py-0.5 rounded transition-colors ${inspectTab === 'tree' ? "bg-blue-500/25 text-blue-300 border border-blue-400/40" : "text-white/30 hover:text-white/60"}`}>
              Tree {inspectNodes ? `(${inspectNodes.length})` : ""}
            </button>
            <button
              onClick={() => { setInspectTab('scan'); if (!scanImage && !scanLoading) runScan(); }}
              className={`text-[8px] font-bold px-2 py-0.5 rounded transition-colors ml-0.5 ${inspectTab === 'scan' ? "bg-orange-500/25 text-orange-300 border border-orange-400/40" : "text-white/30 hover:text-white/60"}`}>
              Scan {customPins.length > 0 ? `(${customPins.length} pins)` : ""}
            </button>

            {/* IME / keyboard indicator — shown while tree tab is active and a dump has been taken */}
            {inspectTab === 'tree' && imeIncluded !== null && (
              <span
                title={imeIncluded ? "Keyboard (IME) window was included in this dump — keyboard keys are visible as nodes" : "Keyboard (IME) not detected or not supported on this device — keyboard keys will not appear as nodes"}
                className={`ml-1.5 px-1.5 py-0.5 rounded text-[7px] font-bold border select-none ${imeIncluded ? "bg-emerald-500/20 text-emerald-300 border-emerald-400/40" : "bg-white/5 text-white/25 border-white/10"}`}>
                ⌨ {imeIncluded ? "kbd" : "no kbd"}
              </span>
            )}

            {/* Context actions */}
            <div className="flex gap-1 ml-auto shrink-0">
              {inspectTab === 'tree' && <>
                <button onClick={refreshInspectNodes}
                  className="text-[8px] text-white/40 hover:text-white px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors">
                  ↻ Re-dump
                </button>
                <button onClick={dumpTree}
                  title="Copy the full tree + any custom pins to clipboard"
                  className="text-[8px] text-blue-300 hover:text-white px-1.5 py-0.5 rounded bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 transition-colors">
                  📋 Dump All
                </button>
              </>}
              {inspectTab === 'scan' && <>
                <button onClick={runScan} disabled={scanLoading}
                  className="text-[8px] text-white/40 hover:text-white px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40">
                  {scanLoading ? "…" : "📸 Re-scan"}
                </button>
                <button onClick={dumpTree} disabled={!customPins.length && !inspectNodes?.length}
                  title="Copy UIAutomator tree + all named pins to clipboard"
                  className="text-[8px] text-orange-300 hover:text-white px-1.5 py-0.5 rounded bg-orange-500/15 hover:bg-orange-500/25 border border-orange-400/30 transition-colors disabled:opacity-30">
                  📋 Dump Pins
                </button>
              </>}
            </div>
          </div>

          {/* ── TREE TAB ── */}
          {inspectTab === 'tree' && <>
            {inspectLoading && (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-white/40 text-[9px]">Scanning accessibility tree…</span>
              </div>
            )}
            {!inspectLoading && !inspectNodes && (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-red-400/70 text-[9px]">Dump failed — phone must be awake &amp; unlocked</span>
              </div>
            )}
            {!inspectLoading && inspectNodes && inspectNodes.length === 0 && (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-white/30 text-[9px]">No accessibility nodes returned</span>
              </div>
            )}
            {!inspectLoading && inspectNodes && inspectNodes.length > 0 && (
              <div ref={treeRef} className="flex-1 overflow-y-auto">
                {inspectNodes.map(n => {
                  const isHovered = n.index === mirrorHoveredIdx;
                  return (
                    <div
                      key={n.index}
                      data-node-idx={n.index}
                      className={`px-2 py-1 border-b border-white/4 cursor-default select-none transition-colors ${isHovered ? "bg-blue-500/20 border-l-2 border-l-blue-400" : "hover:bg-white/5"}`}
                      onMouseEnter={() => liveCanvasRef.current?.setForcedHighlight(n.boundsRaw)}
                      onMouseLeave={() => liveCanvasRef.current?.setForcedHighlight(null)}
                    >
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="text-white/25 text-[7px] shrink-0 w-6 text-right">[{n.index}]</span>
                        <span className={`text-[7px] shrink-0 ${n.clickable ? "text-green-400" : "text-white/20"}`}>{n.clickable ? "●" : "○"}</span>
                        <span className={`font-semibold truncate ${isHovered ? "text-blue-200" : "text-white/70"}`}>{n.cls}</span>
                        {n.resourceId  && <span className="text-orange-300/80 truncate shrink-0 max-w-[45%]">id="{n.resourceId}"</span>}
                        {!n.resourceId && n.contentDesc && <span className="text-lime-300/80 truncate shrink-0 max-w-[45%]">"{n.contentDesc}"</span>}
                        {!n.resourceId && !n.contentDesc && n.text && <span className="text-sky-300/80 truncate shrink-0 max-w-[45%]">"{n.text}"</span>}
                      </div>
                      {isHovered && (
                        <div className="text-white/30 text-[7px] mt-0.5 pl-8">
                          {n.bounds}
                          {n.contentDesc && n.resourceId && <span className="ml-2 text-lime-300/60">desc="{n.contentDesc}"</span>}
                          {n.text        && n.resourceId && <span className="ml-2 text-sky-300/60">text="{n.text}"</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="px-2 py-0.5 border-t border-white/4 shrink-0">
              <span className="text-[7px] text-white/15">Hover row → highlight on mirror · Hover mirror → row scrolls here · ● tappable · ○ view-only</span>
            </div>
          </>}

          {/* ── SCAN TAB ── */}
          {inspectTab === 'scan' && (
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">

              {/* No scan yet */}
              {!scanImage && !scanLoading && (
                <div className="flex-1 flex flex-col items-center justify-center gap-2">
                  <span className="text-white/30 text-[9px]">Click "📸 Re-scan" to capture the screen</span>
                  <span className="text-white/15 text-[8px] text-center px-4">
                    UIAutomator nodes shown as blue outlines. Bare areas with no outline = custom-drawn, no accessibility node. Click anywhere to name and pin elements.
                  </span>
                </div>
              )}
              {scanLoading && (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-white/40 text-[9px]">Taking screenshot…</span>
                </div>
              )}

              {/* Screenshot + overlays */}
              {scanImage && !scanLoading && (
                <div
                  className="relative w-full cursor-crosshair shrink-0"
                  onClick={handleScanClick}
                >
                  <img
                    ref={scanImgRef}
                    src={scanImage}
                    className="w-full h-auto block select-none"
                    draggable={false}
                    onLoad={e => {
                      const img = e.currentTarget;
                      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
                    }}
                  />

                  {/* SVG overlay — UIAutomator node bounds + custom pins */}
                  {imgNatural && (
                    <svg
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      viewBox={`0 0 ${imgNatural.w} ${imgNatural.h}`}
                      preserveAspectRatio="none"
                    >
                      {/* UIAutomator node outlines
                          - Named nodes (have id/desc/text): blue, slightly opaque
                          - Container nodes (no identity attrs): very faint grey
                          Blue outlines = accessibility node exists. Bare areas = invisible to UIAutomator. */}
                      {inspectNodes?.map(n => {
                        const hasId = !!(n.resourceId || n.contentDesc || n.text);
                        return (
                          <rect
                            key={n.index}
                            x={n.boundsRaw[0]} y={n.boundsRaw[1]}
                            width={n.boundsRaw[2] - n.boundsRaw[0]}
                            height={n.boundsRaw[3] - n.boundsRaw[1]}
                            fill="none"
                            stroke={hasId ? "rgba(30,144,255,0.55)" : "rgba(255,255,255,0.07)"}
                            strokeWidth={hasId ? 5 : 2}
                          />
                        );
                      })}

                      {/* Custom pin dots */}
                      {customPins.map(pin => (
                        <g key={pin.id}>
                          <circle cx={pin.phoneX} cy={pin.phoneY} r={18} fill="rgba(251,146,60,0.85)" stroke="white" strokeWidth={4} />
                          <text
                            x={pin.phoneX + 24} y={pin.phoneY + 10}
                            fill="#fb923c" fontSize={32} fontWeight="bold"
                            fontFamily="monospace"
                            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.9))" }}
                          >{pin.name}</text>
                        </g>
                      ))}

                      {/* Pending pin crosshair */}
                      {pendingPin && imgNatural && (
                        <g>
                          <line
                            x1={pendingPin.phoneX - 30} y1={pendingPin.phoneY}
                            x2={pendingPin.phoneX + 30} y2={pendingPin.phoneY}
                            stroke="rgba(251,146,60,0.9)" strokeWidth={4} />
                          <line
                            x1={pendingPin.phoneX} y1={pendingPin.phoneY - 30}
                            x2={pendingPin.phoneX} y2={pendingPin.phoneY + 30}
                            stroke="rgba(251,146,60,0.9)" strokeWidth={4} />
                        </g>
                      )}
                    </svg>
                  )}

                  {/* Floating name input for pending pin */}
                  {pendingPin && imgNatural && scanImgRef.current && (() => {
                    const img = scanImgRef.current;
                    // Convert phone coords → % position on the rendered image
                    const leftPct = (pendingPin.phoneX / imgNatural.w) * 100;
                    const topPct  = (pendingPin.phoneY / imgNatural.h) * 100;
                    return (
                      <div
                        className="absolute z-50"
                        style={{ left: `${leftPct}%`, top: `${topPct}%`, transform: "translate(8px, -50%)" }}
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          ref={pinInputRef}
                          className="text-[10px] font-mono bg-zinc-900 border-2 border-orange-400 text-orange-200 placeholder-white/25 px-2 py-0.5 rounded shadow-2xl outline-none w-36"
                          placeholder="name this element"
                          onKeyDown={e => {
                            if (e.key === "Enter")  confirmPendingPin((e.target as HTMLInputElement).value);
                            if (e.key === "Escape") setPendingPin(null);
                          }}
                        />
                        <div className="text-[7px] text-white/30 mt-0.5">
                          {pendingPin.parentNode
                            ? <span className="text-blue-300/60">inside {pendingPin.parentNode.resourceId || pendingPin.parentNode.cls}</span>
                            : <span className="text-orange-400/70">⚠ no UIAutomator node here</span>}
                          {" · Enter to save · Esc cancel"}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Custom pins list */}
              {customPins.length > 0 && (
                <div className="shrink-0 border-t border-orange-400/20 bg-zinc-900/50 p-1.5 space-y-0.5">
                  <div className="text-[8px] text-orange-300/60 font-bold mb-1 uppercase tracking-wider">
                    Custom Elements ({customPins.length})
                  </div>
                  {customPins.map(pin => (
                    <div key={pin.id} className="flex items-start gap-1.5 text-[8px] font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0 mt-1" />
                      <div className="min-w-0 flex-1">
                        <span className="text-orange-200 font-bold">{pin.name}</span>
                        <span className="text-white/30 ml-1.5">({pin.phoneX},{pin.phoneY})</span>
                        <div className="text-white/20 text-[7px] truncate">
                          {pin.parentNode
                            ? <>inside <span className="text-blue-300/60">{pin.parentNode.resourceId || pin.parentNode.cls}</span> {pin.parentNode.bounds}</>
                            : <span className="text-red-400/50">⚠ no UIAutomator parent — pure custom-drawn view</span>}
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); setCustomPins(p => p.filter(x => x.id !== pin.id)); }}
                        className="text-white/20 hover:text-red-400 transition-colors shrink-0 text-[9px] mt-0.5">
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="text-[7px] text-white/15 pt-0.5">
                    Click "📋 Dump Pins" to copy the full index (UIAutomator tree + all pins) to clipboard
                  </div>
                </div>
              )}

              {/* Scan hint (no pins yet, image loaded) */}
              {scanImage && !scanLoading && customPins.length === 0 && (
                <div className="shrink-0 px-2 py-1 border-t border-white/4">
                  <span className="text-[7px] text-white/15">
                    Blue outlines = UIAutomator can see this element · Bare areas = custom-drawn, no accessibility node · Click anywhere to name &amp; pin
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Nav bar */}
      {isReady && phone && (
        <div ref={navRef} className="relative flex items-center justify-center gap-2 px-2 py-2 bg-zinc-900 border-t border-white/6 shrink-0">
          <NavBtn icon={<ChevronLeft className="w-3.5 h-3.5" />} label="Back"   onClick={() => sendKey(phone.serial, 4,   "Back",   onLog)} />
          <NavBtn icon={<ImagePlus className="w-3.5 h-3.5" />} label="Image" onClick={() => setShowManualMedia(v => !v)} />
          <NavBtn icon={<Home        className="w-3.5 h-3.5" />} label="Home"   onClick={() => sendKey(phone.serial, 3,   "Home",   onLog)} />
          <div className="w-px h-4 bg-white/10" />
          <NavBtn icon={<Power       className="w-3 h-3" />}     label="Power"  onClick={() => { liveCanvasRef.current?.clearToBlack(); onPower(); sendKey(phone.serial, 26, "Power", onLog); }} />
          <div className="w-px h-4 bg-white/10" />
          <NavBtn icon={<Keyboard    className="w-3 h-3" />}     label="Keyboard" onClick={() => setShowCalibration(true)} />
        </div>
      )}

      {isReady && phone && (
        <ManualPhoneMediaPanel
          serial={phone.serial}
          onLog={onLog}
          open={showManualMedia}
          onClose={() => setShowManualMedia(false)}
        />
      )}

      {phone && (
        <CalibrationDialog
          serial={phone.serial}
          open={showCalibration}
          onOpenChange={setShowCalibration}
          onLog={onLog}
        />
      )}

      <CustomizePanel
        open={showCustomize}
        onOpenChange={setShowCustomize}
        custom={custom}
        onChange={onCustomChange}
        slotIdx={idx}
      />
    </div>
  );
});

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
  const [autoInstalling, setAutoInstalling] = useState(false);
  const [showManual, setShowManual] = useState(false);

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

  const autoInstall = async () => {
    setAutoInstalling(true); setError(null); setOk(null);
    try {
      const r    = await fetch("/api/mobile/adb-auto-install", { method: "POST" });
      const body = await r.json();
      if (!r.ok || !body.ok) { setError(body.error ?? "Auto-install failed — try the manual option below."); return; }
      setOk("ADB installed! Checking for phones…");
      onSaved();
    } catch { setError("Couldn't reach the server. Try again."); }
    finally { setAutoInstalling(false); }
  };

  return (
    <div className="max-w-xl mx-auto mt-16 space-y-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mx-auto">
        <Terminal className="w-8 h-8 text-orange-500" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-foreground">ADB not found</h2>
        <p className="text-sm text-muted-foreground mt-1">Aura Farming can download and set it up for you — no manual install needed.</p>
      </div>
      <div className="text-left bg-card border border-primary/30 rounded-xl p-5 space-y-3">
        <button onClick={autoInstall} disabled={autoInstalling}
          className="w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
          {autoInstalling ? "Downloading & setting up ADB…" : "Set up ADB automatically"}
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {ok    && <p className="text-xs text-green-500">{ok}</p>}
        <button onClick={() => setShowManual(v => !v)} className="text-xs text-muted-foreground hover:text-foreground underline">
          {showManual ? "Hide manual option" : "I'd rather point at a folder myself"}
        </button>
        {showManual && (
          <div className="flex gap-2 pt-1">
            <input type="text" value={folder} onChange={e => setFolder(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. C:\platform-tools"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40" />
            <button onClick={submit} disabled={saving || !folder.trim()}
              className="px-4 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0">
              {saving ? "Checking…" : "Use folder"}
            </button>
          </div>
        )}
      </div>
      <a href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:border-primary/40 transition-colors">
        <ExternalLink className="w-4 h-4" />Download SDK Platform-Tools manually
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
        <div className="border-t border-border/50" />
        <SetupStep n={4} title="Enable the SECOND USB debugging toggle (MIUI/Xiaomi)" body={<>In <strong>Settings → Developer Options</strong>, also turn on <strong>"USB debugging (Security settings)"</strong> — a separate toggle from step 2. It requires signing into a Mi account and a reboot. Without it, taps/keys silently fail and the phone mirror can't stream real video (it falls back to slow screenshots).</>} />
      </div>
    </div>
  );
}

// ─── Automation settings panel (right column, per device) ────────────────────

// AutomationSettingsData and AUTOMATION_DEFAULTS are imported from mobileShared

// 4-digit-wide number inputs, shared by every field in this panel.
const NUM_INPUT_CLASS = "w-16 text-center";

const Input = BaseInput;

/** Resolve Jarvee-style spin syntax: {a|b|c} groups are each replaced with a
 *  randomly chosen variant. Multiple groups in the same string are each rolled
 *  independently, so "Hi {there|you} — {love|hate} it!" produces one of four
 *  possible sentences. Nested braces are not supported. */
function resolveSpinSyntax(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    const parts = inner.split("|");
    return parts[Math.floor(Math.random() * parts.length)];
  });
}
// HTML `maxLength` isn't reliably enforced on type="number" inputs, so clamp
// values to 4 digits (0-9999) in code as well.
const clamp4 = (n: number) => Math.min(9999, Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0)));

// ── Module-level HST timer registry ─────────────────────────────────────────
// Timers live here, OUTSIDE React, so component cleanup, dep changes, and
// USB-poll flickers cannot cancel them. Keyed by `${serial}:${slotIdx}`.
//
// Why module-level and not useRef?
//   useRef lives inside the component instance. React cleanup runs whenever
//   declared deps change — even for spurious dep changes caused by USB poll
//   oscillation. A `clearTimeout(timerRef.current)` in cleanup then kills the
//   25-99 min wait every 3 seconds. Moving the timer here makes it completely
//   invisible to React's lifecycle machinery.
// _hstTimers, _hstStop, _hstNextRunAt are imported from hstRunner.ts above so
// App.tsx's always-mounted HstToggleListener shares the same map instances.

// Owns settings load/autosave and the continuous run-loop. Called once from
// `MobilePage` (not from the tab-conditional panel) so switching away from
// the Human Session Tool tab never unmounts this and interrupts an
// in-progress automation cycle — the loop must keep running in the
// background regardless of which tab is currently visible.
function useAutomationSettings(phone: UsbPhone | null, onLog?: (msg: string) => void, slotIdx?: number, slotUsername?: string, requestSlot?: (idx: number, readyAt: number, onQueued?: () => void) => Promise<boolean>, releaseSlot?: (idx: number, skipRest?: boolean) => void, cancelQueuedSlot?: (idx: number) => void, refreshKey?: number, collisionPreventerConfig?: CollisionPreventerConfig) {
  const [settings, setSettings] = useState<AutomationSettingsData>(AUTOMATION_DEFAULTS);
  const [loading,  setLoading]  = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [running,  setRunning]  = useState(false);
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);
  const nextRunAtRef = useRef<number | null>(null);
  nextRunAtRef.current = nextRunAt;
  // Populated by the run-loop effect; the clamp effect calls this directly to
  // clear the module-level timer and restart with a corrected delay, without
  // needing a React state update or dep-array change.
  const rescheduleFnRef = useRef<((delayMs: number) => void) | null>(null);
  // Reflects server-side cycle state independently of the client fetch.
  // Keeps running=true even right after remount, before runCycle() fires.
  const [serverCycleRunning, setServerCycleRunning] = useState(false);

  // True once the first server settings fetch for the current phone has
  // resolved.  The run-loop is gated on this so it never starts a timer with
  // AUTOMATION_DEFAULTS (which would immediately be reschedule-clamped when
  // the real server settings arrive and have different cycleInterval values).
  const [hydrated, setHydrated] = useState(false);

  // Loaded settings (including `enabled`) come from the server per phone —
  // used to detect real user edits vs. the initial load, so autosave never
  // fires before the fetch resolves.
  const hydratedRef = useRef(false);
  // Always tracks the current phone prop — updated every render.  Used inside
  // the async runCycle callback so the timer reads the *actual* current phone
  // at fire-time (25-99 min later) rather than the stale closure value
  // captured when the run-loop effect was last set up.
  const phoneRef = useRef<UsbPhone | null>(phone);
  phoneRef.current = phone;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Always-current ref to the collision preventer config so runCycle can read
  // it without capturing a stale closure value.
  const collisionConfigRef = useRef(collisionPreventerConfig);
  collisionConfigRef.current = collisionPreventerConfig;
  // Abort controller for the currently in-flight automation-cycle fetch.
  // When the master toggle is flipped off, this is aborted immediately so
  // the running cycle also receives a stop signal server-side.
  const cycleAbortRef = useRef<AbortController | null>(null);
  // Tracks the cycleId of the currently in-flight cycle so the cleanup can
  // pass it to the server-side abort endpoint (prevents stale abort POSTs
  // from killing the *next* cycle after a rapid toggle-off / toggle-on).
  const cycleIdRef = useRef<string | null>(null);
  // Snapshot of what's actually persisted server-side — lets autosave skip
  // firing a no-op POST right after hydration (when `settings` merely
  // mirrors what was just loaded) and only save on real user edits.
  const lastSavedRef = useRef<string>(JSON.stringify(AUTOMATION_DEFAULTS));
  // Distinguishes "user just flipped the master toggle on" from "the
  // effect re-ran because settings loaded from the server with enabled
  // already true" (e.g. on app restart). Only the former should run the
  // first cycle immediately — the latter must still wait the configured
  // Run-every interval, same as every cycle after it. Set by
  // `setEnabledByUser` below, consumed once by the run-loop effect.
  const manualToggleOnRef = useRef(false);
  // Tracks whether the NEXT cleanup should abort the server-side cycle.
  // Only set when the user explicitly toggles the master switch off — NOT on
  // component unmount (user navigating to another page).  This prevents the
  // running cycle from being killed just because the user switched tabs.
  const explicitToggleOffRef = useRef(false);

  // ── USB-reorder guard ────────────────────────────────────────────────────
  // The scheduling effect must NOT restart when the /usb-phones poll returns
  // phones in a different order (which happens every ~2 s, especially during
  // airplane-mode recycling).  If we used `phone?.serial` directly in the
  // effect dep array, every reorder would cancel the pending 25-99 min timer
  // and reset it — so it could never fire.
  //
  // Solution: track connect vs. reorder separately.
  //   • null → serial  : genuine connect  → increment connectedKey so the
  //                       scheduling effect starts fresh for the new phone.
  //   • serial → null  : genuine disconnect → setRunning(false) immediately.
  //   • serialA → serialB : USB list reorder → do nothing; let the existing
  //                          timer keep running for the phone it was set up for.
  const prevSerialRef        = useRef<string | null>(phone?.serial ?? null);
  // Tracks the last NON-NULL serial seen — used to distinguish a same-device
  // reconnect (null → serialA after serialA was last seen) from a genuinely
  // new device appearing (null → serialB after serialA was last seen).
  const prevNonNullSerialRef = useRef<string | null>(phone?.serial ?? null);
  const [connectedKey, setConnectedKey] = useState(0);

  // A phone can remain in the USB list while ADB reports it as offline.
  // Treat that as unavailable for automation, but do not clear the saved
  // Human Session Tool toggle: the scheduler will resume after the same serial
  // returns to the ready "device" state.
  const deviceUnavailable = !phone || phone.state !== "device";

  const setEnabledByUser = useCallback((enabled: boolean) => {
    if (enabled) {
      manualToggleOnRef.current = true;
    } else {
      explicitToggleOffRef.current = true; // explicit user action — cleanup should abort
    }
    setSettings(s => ({ ...s, enabled }));
  }, [phone?.serial, slotIdx]);

  // A TrustScore badge can be changed from the slot list while this HST
  // remains mounted in the background. Re-hydrate the effective settings
  // immediately so the open editor and the next cycle use the new tier.
  useEffect(() => {
    const serial = phone?.serial;
    if (!serial || slotIdx === undefined) return;
    const onTrustScoreChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serial?: string; slotIdx?: number }>).detail;
      if (detail?.serial === serial && detail.slotIdx === slotIdx) {
        setConnectedKey(value => value + 1);
      }
    };
    window.addEventListener("mobile_trustscore_changed", onTrustScoreChanged);
    return () => window.removeEventListener("mobile_trustscore_changed", onTrustScoreChanged);
  }, [phone?.serial, slotIdx]);

  // Listen for toggle signals broadcast by the Statistics page
  // (MobileSlotSessionToggle).  When the user presses the toggle on the Stats
  // page it persists the change to the DB via the API, then broadcasts here so
  // the in-memory settings state AND the run-loop refs are updated exactly as if
  // the user had pressed the toggle directly on this slot's panel.
  useEffect(() => {
    const serial = phone?.serial;
    if (!serial) return;
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("aura-slot-toggle");
      bc.onmessage = (ev: MessageEvent) => {
        const { serial: evSerial, slotIdx: evSlot, enabled } = ev.data ?? {};
        if (evSerial === serial && evSlot === (slotIdx ?? 0)) {
          // Guard: if the slot is already in the requested state, skip the
          // call entirely.  Without this, a Stats-page broadcast of
          // enabled:true to an already-enabled slot sets manualToggleOnRef
          // without the run-loop effect firing (settings.enabled didn't
          // change), leaving the flag permanently true and causing the next
          // incidental effect re-run to call scheduleNext(0) — resetting the
          // 25-99min timer to fire immediately.
          if (enabled !== settingsRef.current.enabled) {
            setEnabledByUser(enabled);
          }
        }
      };
    } catch { /* BroadcastChannel unavailable */ }
    return () => { try { bc?.close(); } catch {} };
  }, [phone?.serial, slotIdx, setEnabledByUser]);

  useEffect(() => {
    // Re-fetch settings only when a genuinely new device connects (connectedKey
    // increments via the serial-watcher) or the user forces a refresh
    // (refreshKey increments).
    //
    // phone?.serial is intentionally NOT in this dep array.  The USB poll on a
    // multi-phone farm returns phones in varying order every 2–4 s, which
    // previously caused phone?.serial to oscillate between two real serials
    // (e.g. e38a197f3d22 ↔ 863d0058) continuously.  With phone?.serial as a
    // dep, every oscillation triggered this effect → setHydrated(false) → the
    // run-loop dep changed → CLEANUP → new random timer → the timer never fired.
    //
    // connectedKey only increments when a GENUINELY new device appears (the
    // serial-watcher takes the null→serialX path with a new serial).  USB
    // reorders go through the serialA→serialB else-branch and leave connectedKey
    // unchanged, so this effect does not run, hydrated stays true, and the
    // run-loop timer keeps counting uninterrupted through any number of reorders.
    //
    // hydrated is a ONE-WAY LATCH: it starts false, goes true after the first
    // successful settings fetch, and is NEVER reset to false again.
    //
    // Why one-way?  Every connectedKey increment used to call setHydrated(false),
    // which is a dep of the run-loop effect.  That dep change caused a CLEANUP →
    // new random timer → new connectedKey could cancel the in-flight fetch before
    // setHydrated(true) fired → hydrated permanently stuck false → run-loop
    // silently dead forever.  On a 2-phone farm with USB enumeration oscillating
    // every 2 s the cascade happened within 4 s of every launch.
    //
    // The run-loop already re-runs on connectedKey changes (connectedKey is in its
    // own dep array), so hydrated does NOT need to flip back to false to gate
    // subsequent reconnects.  Its only job is to block the very first run until
    // the initial settings load completes.  After that it stays true permanently.
    //
    // null-phone guard: if phone is null, leave hydrated alone.  The run-loop
    // guards on !phone independently.  When the real device reconnects
    // (null→newSerial), connectedKey increments, this effect re-runs with a
    // non-null phone, and the normal fetch → setHydrated(true) path executes.
    if (!phone) { return; }
    let active = true;
    setLoading(true);
    const serial = phone.serial; // capture at effect-run time
    const settingsUrl = slotIdx !== undefined
      ? `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`
      : `/api/mobile/devices/${encodeURIComponent(serial)}/automation-settings`;
    fetch(settingsUrl)
      .then(r => r.json())
      .then(d => {
        if (!active) return;
        const merged = { ...AUTOMATION_DEFAULTS, ...d, makePostLocalFolderEnabled: true };
        lastSavedRef.current = JSON.stringify(merged);
        // Set settings AND hydrated in the same React batch so the run-loop
        // fires exactly once with the correct loaded values.  Doing this in
        // .then() (not .finally()) ensures setHydrated(true) is never called
        // without the real settings also being in place.
        setSettings(merged);
        setHydrated(true);
        hydratedRef.current = true;
        // Do NOT set manualToggleOnRef here. On restart the toggle is already
        // on, but accounts must NOT fire immediately — each slot schedules its
        // own random first-run delay within the configured interval instead.
        // manualToggleOnRef is only set by explicit user action (setEnabledByUser).
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => { if (active) { setLoading(false); } });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedKey, slotIdx, refreshKey]);

  // Pause every slot immediately when the live ADB state becomes offline (or
  // unauthorized). This is separate from the scheduling effect because that
  // effect intentionally preserves timers through harmless React/USB reruns.
  // Here the timer and any in-flight/queued cycle must be stopped explicitly.
  useEffect(() => {
    const serial = phone?.serial;
    if (!serial || !deviceUnavailable) return;
    const key = `${serial}:${slotIdx ?? 0}`;

    const timer = _hstTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      _hstTimers.delete(key);
    }
    _hstStop.add(key);
    cancelQueuedSlot?.(slotIdx ?? 0);
    setRunning(false);
    setNextRunAt(null);
    _hstNextRunAt.delete(key);

    const ctrl = cycleAbortRef.current;
    const abortingId = cycleIdRef.current;
    cycleAbortRef.current = null;
    cycleIdRef.current = null;
    ctrl?.abort();
    if (abortingId) {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycleId: abortingId }),
      }).catch(() => {});
    }
    onLog?.(`[HST] ${slotUsername ? `@${slotUsername}` : `slot${slotIdx ?? 0}`} paused — device is ${phone?.state ?? "unavailable"}`);
  }, [phone?.serial, phone?.state, deviceUnavailable, slotIdx, slotUsername, cancelQueuedSlot, onLog]);

  // Poll /api/mobile/cycle-active every 2 s while the toggle is on.
  // This keeps `serverCycleRunning` accurate so:
  //   • the mirror stays live even right after remount (before runCycle fires)
  //   • a 409-deferred cycle is still visible as "running" in the UI
  //
  // IMPORTANT: match by (serial, slotIdx) — not just serial.  A device can
  // only run one slot at a time (server-side 409 guard), but the response
  // includes which specific slot is executing.  Without this, every slot on
  // the same phone shows "Running" when any single slot is active.
  useEffect(() => {
    if (!phone || !settings.enabled) { setServerCycleRunning(false); return; }
    const serial = phone.serial;
    const mySlotIdx = slotIdx ?? 0;
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const r = await fetch('/api/mobile/cycle-active');
        if (!active) return;
        const body: { serials?: string[]; slots?: { serial: string; slotIdx: number }[] } =
          await r.json().catch(() => ({ serials: [], slots: [] }));
        // Use slot-level info when available (new API); fall back to serial-only
        // for any older server that hasn't deployed this fix yet.
        if (body.slots) {
          setServerCycleRunning(body.slots.some(s => s.serial === serial && s.slotIdx === mySlotIdx));
        } else {
          setServerCycleRunning((body.serials ?? []).includes(serial));
        }
      } catch { /* ignore transient errors */ }
      if (active) setTimeout(poll, 2_000);
    };
    poll();
    return () => { active = false; setServerCycleRunning(false); };
  }, [phone?.serial, slotIdx, settings.enabled]);

  // Serial-watcher: translates raw phone?.serial changes into the four
  // meaningful cases above so the scheduling effect can ignore reorders.
  useEffect(() => {
    const prev = prevSerialRef.current;
    const curr = phone?.serial ?? null;
    if (curr === prev) return;
    prevSerialRef.current = curr;
    if (!curr) {
      // Phone disconnected — stop scheduling immediately.
      setRunning(false);
    } else if (!prev) {
      // Phone appeared after a null gap.
      // Only restart the scheduling loop if it's a DIFFERENT device than the
      // one that was connected before the null gap — i.e. a genuine new phone,
      // not the same phone briefly dropping off the USB list (flicker).
      if (curr !== prevNonNullSerialRef.current) {
        setConnectedKey(k => k + 1);
      }
      // Always update so the next gap comparison is against the current serial.
      prevNonNullSerialRef.current = curr;
    } else {
      // serialA → serialB (USB list reorder) — do nothing; update prevNonNull.
      prevNonNullSerialRef.current = curr;
    }
  }, [phone?.serial]);

  // Save on the fly: every settings change (including the master toggle)
  // is persisted automatically, debounced so rapid typing doesn't fire a
  // request per keystroke. No manual "Save" step required.
  useEffect(() => {
    if (!phone || !hydratedRef.current) return;
    const serial = phone.serial;
    const toSave = settings;
    const toSaveStr = JSON.stringify(toSave);
    if (toSaveStr === lastSavedRef.current) return; // nothing actually changed
    const t = setTimeout(() => {
      const saveUrl = slotIdx !== undefined
        ? `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`
        : `/api/mobile/devices/${encodeURIComponent(serial)}/automation-settings`;
      fetch(saveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: toSaveStr,
      })
        .then(async r => {
          const body = await r.json().catch(() => null);
          if (!r.ok || !body?.ok) { setSaveError(body?.error ?? `Server rejected the settings (${r.status})`); return; }
          lastSavedRef.current = toSaveStr;
          setSaveError(null);
        })
        .catch((e: any) => setSaveError(e?.message ?? "Couldn't reach the server"));
    }, 500);
    return () => clearTimeout(t);
  }, [settings, phone?.serial]);

  // While the master toggle is on, repeatedly run the full automation
  // cycle (power on → open Instagram → scroll/like with the configured
  // settings → close Instagram → recycle airplane mode → power off)
  // back-to-back until the toggle is switched off or the phone disconnects.
  //
  // ── Architectural note ────────────────────────────────────────────────────
  // Previous versions stored the setTimeout handle in a local `let timer`
  // variable and cleared it in the effect cleanup function. React's cleanup
  // fires whenever ANY declared dependency changes — including spurious dep
  // changes caused by USB-poll oscillation (~every 3 s on a multi-phone farm).
  // Every cleanup cancelled the 25-99 min wait timer, so it could never fire.
  //
  // Fix: the timer handle lives in the module-level `_hstTimers` Map (defined
  // above this hook) so React's cleanup cannot reach it. The cleanup function
  // only touches the timer when the user EXPLICITLY turned the toggle off
  // (explicitToggleOffRef.current = true). USB flickers, dep oscillations, and
  // any other spurious re-runs are harmless — the timer keeps ticking.
  useEffect(() => {
    // Do not start the timer until server settings have been loaded for this
    // phone. Without this gate the run-loop fires immediately on mount with
    // AUTOMATION_DEFAULTS, sets a timer using the default cycleInterval values,
    // and then the clamp effect fires seconds later when real settings arrive —
    // causing a spurious reschedule on every app launch.
    const _phone = phoneRef.current;
    if (deviceUnavailable || !settings.enabled || !hydrated) { setRunning(false); return; }
    const serial = _phone.serial;
    const key = `${serial}:${slotIdx ?? 0}`;

    // ── Safety: never double-schedule / remount recovery ─────────────────────
    // There are two cases where _hstTimers already has this key:
    //   A) Spurious dep re-run on the SAME component instance (USB poll, etc.)
    //      → the timer's closures are still valid; bail out untouched.
    //   B) Component REMOUNTED for the same phone (e.g. user switched phones
    //      and switched back). The old timer's closures point at the dead
    //      component's state setters — nextRunAt will never update on screen.
    //      → cancel the stale timer, restore nextRunAt, fall through to
    //        reschedule under fresh closures with the remaining time.
    //
    // We distinguish A from B by checking whether this is a fresh mount: on a
    // fresh mount rescheduleFnRef.current is null (cleanup nulled it).
    let recoveredFireAt: number | null = null;
    if (_hstTimers.has(key)) {
      if (rescheduleFnRef.current !== null) {
        // Case A — same instance, valid closures, leave the timer alone.
        return;
      }
      // Case B — remount. Cancel the stale timer.
      const staleHandle = _hstTimers.get(key)!;
      clearTimeout(staleHandle);
      _hstTimers.delete(key);
      // Restore nextRunAt from the module-level mirror so the timestamp
      // reappears immediately on screen.
      const savedFireAt = _hstNextRunAt.get(key);
      if (savedFireAt && savedFireAt > Date.now()) {
        setNextRunAt(savedFireAt);
        recoveredFireAt = savedFireAt;
      }
      // Fall through — the rest of the effect sets up fresh closures and
      // reschedules with the remaining time (or a fresh delay if expired).
    }

    // Clear any stale stop flag left from a previous disable cycle.
    _hstStop.delete(key);

    // ── Server-side diagnostic log ────────────────────────────────────────
    const srvLog = (msg: string) => {
      fetch('/api/hst-dbg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg }),
      }).catch(() => {});
    };

    // Stores the next timer handle in the module-level map and returns it.
    const scheduleNext = (delayMs: number) => {
      const t = setTimeout(runCycle, Math.round(delayMs));
      _hstTimers.set(key, t);
      return t;
    };

    const runCycle = async () => {
      // Timer fired — remove ourselves from the registry so a re-run of the
      // effect (if it happens) can start a fresh timer rather than bailing out.
      _hstTimers.delete(key);

      const _dbgTag = slotUsername ? `@${slotUsername}` : `slot${slotIdx ?? 0}`;
      srvLog(`${_dbgTag} — timer fired (stopped=${_hstStop.has(key)})`);
      onLog?.(`[HST-DBG] ${_dbgTag} — timer fired (stopped=${_hstStop.has(key)})`);

      // User turned off the toggle while the timer was waiting — exit cleanly.
      if (_hstStop.has(key)) {
        _hstStop.delete(key);
        setRunning(false);
        _hstNextRunAt.delete(key);
        setNextRunAt(null);
        return;
      }
      // Guard: if the phone changed or disconnected while the timer was waiting,
      // skip this cycle entirely.  Do NOT reschedule — if the phone is gone the
      // loop self-terminates here; when it reconnects the effect restarts via
      // settings.enabled or the user toggling on again.
      if (!phoneRef.current || phoneRef.current.serial !== serial) {
        onLog?.(`[HST-DBG] ${_dbgTag} — phone changed/disconnected mid-wait; skipping cycle`);
        srvLog(`${_dbgTag} — phone changed/disconnected mid-wait; skipping cycle`);
        return;
      }
      // Preserve the scheduled HST turn before clearing the display state.
      // Collision Preventer uses this original timestamp to order overdue
      // slots fairly when multiple timers become eligible together.
      const hstTurnAt = _hstNextRunAt.get(key) ?? Date.now();
      _hstNextRunAt.delete(key);
      setNextRunAt(null);
      // Collision preventer: wait for device to be free before running.
      // Hoisted so post-cycle scheduling can use it as a CP-active fallback.
      let collisionPrevented = false;
      if (requestSlot && slotIdx !== undefined) {
        onLog?.(`[HST-DBG] ${_dbgTag} — awaiting collision-preventer slot…`);
        // onQueued fires immediately when the device is busy so the dashboard
        // "COLLISION PREVENTED" timestamp reflects the moment of the collision,
        // not the moment the rest period ends and the slot finally gets its turn.
        const onQueued = () => {
          if (phoneRef.current?.serial && slotUsername) {
            fetch(`/api/mobile/devices/${encodeURIComponent(phoneRef.current.serial)}/log-event`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slotUsername, slotIdx, action: 'collision_prevented', detail: 'Collision Prevented' }),
            }).catch(() => {});
          }
          onLog?.(`[HST-DBG] ${_dbgTag} — collision detected; queued, waiting for rest window`);
        };
        collisionPrevented = await requestSlot(slotIdx, hstTurnAt, onQueued);
        if (_hstStop.has(key)) {
          onLog?.(`[HST-DBG] ${_dbgTag} — stopped while waiting for collision-preventer; releasing slot`);
          releaseSlot?.(slotIdx, true); return;
        }
        onLog?.(`[HST-DBG] ${_dbgTag} — slot acquired (collisionPrevented=${collisionPrevented})`);
      }
      const s = settingsRef.current;
      const min = Math.max(1, Math.min(s.feedScrollMin, s.feedScrollMax));
      const max = Math.max(s.feedScrollMin, s.feedScrollMax);
      const count = Math.floor(Math.random() * (max - min + 1)) + min;
      setRunning(true);
      onLog?.(`Cycle starting → power on, open Instagram, ${count} downward scrolls`);
      // Generate a unique ID for this cycle.  Both the cycle POST and the abort
      // POST carry it so the server can ignore stale aborts from a previous
      // cycle that race with the start of this new one.
      const cycleId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const ctrl = new AbortController();
      cycleAbortRef.current = ctrl;
      cycleIdRef.current = cycleId;
      onLog?.(`[HST-DBG] ${_dbgTag} — sending cycle to server (serial=${serial}, count=${count})`);
      srvLog(`${_dbgTag} — sending POST /automation-cycle (serial=${serial}, count=${count})`);
      try {
        const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            cycleId,
            count,
            feedEnabled: s.feedEnabled,
            storiesEnabled: s.storiesEnabled,
            delayMinSec: s.actionDelayMin,
            delayMaxSec: s.actionDelayMax,
            likePercentMin: s.likePercentMin,
            likePercentMax: s.likePercentMax,
            shareFeedPercentMin: s.shareFeedPercentMin,
            shareFeedPercentMax: s.shareFeedPercentMax,
            shareDmPercentMin: s.shareDmPercentMin,
            shareDmPercentMax: s.shareDmPercentMax,
            savePercentMin: s.savePercentMin,
            savePercentMax: s.savePercentMax,
            expandCaptionPercentMin: s.expandCaptionPercentMin,
            expandCaptionPercentMax: s.expandCaptionPercentMax,
            tapAudioPercentMin: s.tapAudioPercentMin,
            tapAudioPercentMax: s.tapAudioPercentMax,
            clickHashtagPercentMin: s.clickHashtagPercentMin,
            clickHashtagPercentMax: s.clickHashtagPercentMax,
            clickAuthorPercentMin: s.clickAuthorPercentMin,
            clickAuthorPercentMax: s.clickAuthorPercentMax,
            feedSuggestionsPercentMin: s.feedSuggestionsPercentMin,
            feedSuggestionsPercentMax: s.feedSuggestionsPercentMax,
            viewStoriesSlidesMin: s.viewStoriesSlidesMin,
            viewStoriesSlidesMax: s.viewStoriesSlidesMax,
            viewStoriesSlideWatchPctMin: s.viewStoriesSlideWatchPctMin,
            viewStoriesSlideWatchPctMax: s.viewStoriesSlideWatchPctMax,
            viewStoriesLikePercentMin: s.viewStoriesLikePercentMin,
            viewStoriesLikePercentMax: s.viewStoriesLikePercentMax,
            viewStoriesShareDmPercentMin: s.viewStoriesShareDmPercentMin,
            viewStoriesShareDmPercentMax: s.viewStoriesShareDmPercentMax,
            viewStoriesCommentPercentMin: s.viewStoriesCommentPercentMin,
            viewStoriesCommentPercentMax: s.viewStoriesCommentPercentMax,
            viewStoriesClickAuthorPercentMin: s.viewStoriesClickAuthorPercentMin,
            viewStoriesClickAuthorPercentMax: s.viewStoriesClickAuthorPercentMax,
            viewExploreEnabled: s.viewExploreEnabled,
            viewExploreActivatePctMin: s.viewExploreActivatePctMin,
            viewExploreActivatePctMax: s.viewExploreActivatePctMax,
            viewExploreScrollMin: s.viewExploreScrollMin,
            viewExploreScrollMax: s.viewExploreScrollMax,
            viewExploreActionDelayMin: s.viewExploreActionDelayMin,
            viewExploreActionDelayMax: s.viewExploreActionDelayMax,
            viewExploreClickPostPctMin: s.viewExploreClickPostPctMin,
            viewExploreClickPostPctMax: s.viewExploreClickPostPctMax,
            viewExploreLikePercentMin: s.viewExploreLikePercentMin,
            viewExploreLikePercentMax: s.viewExploreLikePercentMax,
            viewExploreShareFeedPercentMin: s.viewExploreShareFeedPercentMin,
            viewExploreShareFeedPercentMax: s.viewExploreShareFeedPercentMax,
            viewExploreShareDmPercentMin: s.viewExploreShareDmPercentMin,
            viewExploreShareDmPercentMax: s.viewExploreShareDmPercentMax,
            viewExploreSavePercentMin: s.viewExploreSavePercentMin,
            viewExploreSavePercentMax: s.viewExploreSavePercentMax,
            viewExploreClickAuthorPercentMin: s.viewExploreClickAuthorPercentMin,
            viewExploreClickAuthorPercentMax: s.viewExploreClickAuthorPercentMax,
            viewReelsEnabled: s.viewReelsEnabled,
            viewReelsScrollMin: s.viewReelsScrollMin,
            viewReelsScrollMax: s.viewReelsScrollMax,
            viewReelsLikePercentMin: s.viewReelsLikePercentMin,
            viewReelsLikePercentMax: s.viewReelsLikePercentMax,
            viewReelsShareFeedPercentMin: s.viewReelsShareFeedPercentMin,
            viewReelsShareFeedPercentMax: s.viewReelsShareFeedPercentMax,
            viewReelsShareDmPercentMin: s.viewReelsShareDmPercentMin,
            viewReelsShareDmPercentMax: s.viewReelsShareDmPercentMax,
            viewReelsSavePercentMin: s.viewReelsSavePercentMin,
            viewReelsSavePercentMax: s.viewReelsSavePercentMax,
            viewReelsClickAuthorPercentMin: s.viewReelsClickAuthorPercentMin,
            viewReelsClickAuthorPercentMax: s.viewReelsClickAuthorPercentMax,
            viewReelsActivatePctMin: s.viewReelsActivatePctMin,
            viewReelsActivatePctMax: s.viewReelsActivatePctMax,
            viewReelsWatchPctMin: s.viewReelsWatchPctMin,
            viewReelsWatchPctMax: s.viewReelsWatchPctMax,
            checkDmEnabled: s.checkDmEnabled,
            checkDmActivatePctMin: s.checkDmActivatePctMin,
            checkDmActivatePctMax: s.checkDmActivatePctMax,
            checkDmScrollMin: s.checkDmScrollMin,
            checkDmScrollMax: s.checkDmScrollMax,
            checkDmClickPctMin: s.checkDmClickPctMin,
            checkDmClickPctMax: s.checkDmClickPctMax,
            followEnabled: s.followEnabled,
            followUsersMin: s.followUsersMin,
            followUsersMax: s.followUsersMax,
            followSpreadFollows: s.followSpreadFollows,
            followSources: s.followSources,
            injectBrowsingEnabled: s.injectBrowsingEnabled,
            injectBrowsingActivatePctMin: s.injectBrowsingActivatePctMin,
            injectBrowsingActivatePctMax: s.injectBrowsingActivatePctMax,
            injectBrowsingBeforeFollowPctMin: s.injectBrowsingBeforeFollowPctMin,
            injectBrowsingBeforeFollowPctMax: s.injectBrowsingBeforeFollowPctMax,
            injectBrowsingFeedMin: s.injectBrowsingFeedMin,
            injectBrowsingFeedMax: s.injectBrowsingFeedMax,
            injectBrowsingClickPostPctMin: s.injectBrowsingClickPostPctMin,
            injectBrowsingClickPostPctMax: s.injectBrowsingClickPostPctMax,
            injectBrowsingLikePctMin: s.injectBrowsingLikePctMin,
            injectBrowsingLikePctMax: s.injectBrowsingLikePctMax,
            injectBrowsingShareFeedPctMin: s.injectBrowsingShareFeedPctMin,
            injectBrowsingShareFeedPctMax: s.injectBrowsingShareFeedPctMax,
            injectBrowsingShareDmPctMin: s.injectBrowsingShareDmPctMin,
            injectBrowsingShareDmPctMax: s.injectBrowsingShareDmPctMax,
            injectBrowsingSavePostPctMin: s.injectBrowsingSavePostPctMin,
            injectBrowsingSavePostPctMax: s.injectBrowsingSavePostPctMax,
            injectBrowsingAbandonFollowPctMin: s.injectBrowsingAbandonFollowPctMin,
            injectBrowsingAbandonFollowPctMax: s.injectBrowsingAbandonFollowPctMax,
            injectBrowsingTapHighlightsPctMin: s.injectBrowsingTapHighlightsPctMin,
            injectBrowsingTapHighlightsPctMax: s.injectBrowsingTapHighlightsPctMax,
            followFiltersEnabled: s.followFiltersEnabled,
            followFilterPrivateUsers: s.followFilterPrivateUsers,
            followFilterEnglishSpeaking: s.followFilterEnglishSpeaking,
            followFilterMinFollowers50: s.followFilterMinFollowers50,
            followFilterVerifiedUsers: s.followFilterVerifiedUsers,
            followFilterMaxFollowers25k: s.followFilterMaxFollowers25k,
            followFilterMalesOnly: s.followFilterMalesOnly,
            followFilterMaleNames: s.followFilterMaleNames,
            feedActivatePctMin: s.feedActivatePctMin,
            feedActivatePctMax: s.feedActivatePctMax,
            viewStoriesActivatePctMin: s.viewStoriesActivatePctMin,
            viewStoriesActivatePctMax: s.viewStoriesActivatePctMax,
            followActivatePctMin: s.followActivatePctMin,
            followActivatePctMax: s.followActivatePctMax,
            randomJitterEnabled: s.randomJitterEnabled,
            randomJitterActivatePctMin: s.randomJitterActivatePctMin,
            randomJitterActivatePctMax: s.randomJitterActivatePctMax,
            checkNotificationsPctMin: s.checkNotificationsPctMin,
            checkNotificationsPctMax: s.checkNotificationsPctMax,
            checkNotificationsScrollsMin: s.checkNotificationsScrollsMin,
            checkNotificationsScrollsMax: s.checkNotificationsScrollsMax,
            checkNotificationsClickPctMin: s.checkNotificationsClickPctMin,
            checkNotificationsClickPctMax: s.checkNotificationsClickPctMax,
            visitProfilePctMin: s.visitProfilePctMin,
            visitProfilePctMax: s.visitProfilePctMax,
            visitSavedPctMin: s.visitSavedPctMin,
            visitSavedPctMax: s.visitSavedPctMax,
            visitSettingsPctMin: s.visitSettingsPctMin,
            visitSettingsPctMax: s.visitSettingsPctMax,
            appSwitchPctMin: s.appSwitchPctMin,
            appSwitchPctMax: s.appSwitchPctMax,
            makePostEnabled: s.makePostEnabled,
            makePostActivatePctMin: s.makePostActivatePctMin,
            makePostActivatePctMax: s.makePostActivatePctMax,
            makePostPerSessionMin: s.makePostPerSessionMin,
            makePostPerSessionMax: s.makePostPerSessionMax,
            makePostAlterationEnabled: s.makePostAlterationEnabled,
            makePostAlterationLevel: s.makePostAlterationLevel,
            makePostImageSettingsEnabled: s.makePostImageSettingsEnabled,
            makePostDisableWhenExhausted: s.makePostDisableWhenExhausted,
            makePostLocalFolderEnabled: s.makePostLocalFolderEnabled,
            makePostLocalFolderPath: s.makePostLocalFolderPath,
            makePostLocalFolderNoRepeat: s.makePostLocalFolderNoRepeat,
            makePostLocalFolderRandom: s.makePostLocalFolderRandom,
            makePostAddLocation: s.makePostAddLocation,
            updateProfilePicActivatePctMin: s.updateProfilePicActivatePctMin,
            updateProfilePicActivatePctMax: s.updateProfilePicActivatePctMax,
            updateProfilePicFolderPath: s.updateProfilePicFolderPath,
            updateProfilePicDisableAfterUsed: s.updateProfilePicDisableAfterUsed,
            updateBioActivatePctMin: s.updateBioActivatePctMin,
            updateBioActivatePctMax: s.updateBioActivatePctMax,
            updateBioText: s.updateBioText,
            updateBioDisableAfterUsed: s.updateBioDisableAfterUsed,
            makePostUseChatGpt: s.makePostUseChatGpt,
            makePostFixAiSlop: s.makePostFixAiSlop,
            makePostCaptionText: s.makePostCaptionText,
            makePostImageSettings: s.makePostImageSettings,
            postStoryEnabled: s.postStoryEnabled,
            postStoryActivatePctMin: s.postStoryActivatePctMin,
            postStoryActivatePctMax: s.postStoryActivatePctMax,
            postStoryLocalFolderPath: s.postStoryLocalFolderPath,
            postStoryLocalFolderNoRepeat: s.postStoryLocalFolderNoRepeat,
            postStoryLocalFolderRandom: s.postStoryLocalFolderRandom,
            postStoryAlterationEnabled: s.postStoryAlterationEnabled,
            postStoryAlterationLevel: s.postStoryAlterationLevel,
            postStoryImageSettingsEnabled: s.postStoryImageSettingsEnabled,
            postStoryImageSettings: s.postStoryImageSettings,
            postStoryFixAiSlop: s.postStoryFixAiSlop,
            postStoryAddLink: s.postStoryAddLink,
            postStoryLinkUrl: s.postStoryLinkUrl,
            shuffleToolOrder: s.shuffleToolOrder,
            dismissDirection: s.dismissDirection,
            slotUsername: slotUsername ?? "",
            slotIdx: slotIdx ?? 0,
          }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body?.ok) {
          if (r.status === 409) {
            // Server already has a cycle running (e.g. we just remounted while
            // one was in progress). Not an error — just wait the interval and
            // retry; serverCycleRunning polling will keep the mirror live.
            onLog?.("Cycle deferred — server cycle already in progress, will retry after interval");
          } else {
            const acctTag = slotUsername ? `@${slotUsername} — ` : "";
            onLog?.(`${acctTag}Cycle failed — ${body?.error ?? r.status}${body?.steps?.length ? ` (reached: ${body.steps.join(", ")})` : ""}`);
          }
        } else {
          {
            const acctTag = slotUsername ? `@${slotUsername} — ` : "";
            const parts: string[] = [];
            if (body.likes)          parts.push(`${body.likes} liked`);
            if (body.storiesWatched) parts.push(`${body.storiesWatched} stories`);
            if (body.followedCount)  parts.push(`${body.followedCount} followed`);
            if (body.sharesDm)       parts.push(`${body.sharesDm} DM'd`);
            if (body.sharesFeed)     parts.push(`${body.sharesFeed} feed-shared`);
            if (body.postsUploaded)  parts.push(`${body.postsUploaded} post${body.postsUploaded === 1 ? "" : "s"} uploaded`);
            const reelsStep = (body.steps as string[] | undefined)?.find((s: string) => s.startsWith("reels("));
            const reelsViewed = reelsStep ? parseInt(reelsStep.match(/(\d+)\s+viewed/)?.[1] ?? "0", 10) : 0;
            if (reelsViewed)         parts.push(`${reelsViewed} reels`);
            onLog?.(`${acctTag}Cycle complete — ${parts.length ? parts.join("  ·  ") : "no actions taken"}`);
          }
        }
      } catch (e: any) {
        if ((e as any)?.name === "AbortError") {
          const acctTag = slotUsername ? `@${slotUsername} — ` : "";
          onLog?.(`${acctTag}Cycle aborted — toggle turned off`);
          return;
        }
        const acctTag = slotUsername ? `@${slotUsername} — ` : "";
        onLog?.(`[HST-DBG] ${_dbgTag} — fetch/cycle threw: name=${(e as any)?.name} message=${e?.message}`);
        onLog?.(`${acctTag}Cycle failed — ${e?.message ?? "network error"}`);
      } finally {
        cycleAbortRef.current = null;
        cycleIdRef.current = null;
        // Release the collision scheduler slot regardless of outcome.
        if (releaseSlot && slotIdx !== undefined) releaseSlot(slotIdx);
      }

      // Post-cycle: check stop flag, then reschedule.
      if (_hstStop.has(key)) { _hstStop.delete(key); setRunning(false); _hstNextRunAt.delete(key); setNextRunAt(null); return; }
      setRunning(false);
      const s2 = settingsRef.current;
      const cp2 = collisionConfigRef.current;
      // When the Collision Preventer is enabled use its X–Y mins as the
      // inter-cycle interval for this profile.  The CP was designed to control
      // how long the device rests before the NEXT slot fires, but for a single
      // profile on My Device its rest window IS the profile's scheduling
      // interval.  Using the HST "Run every" value here (the old behaviour)
      // caused the CP min/max to be ignored entirely for scheduling purposes.
      // collisionPrevented=true means CP was provably active when this cycle
      // was queued — use CP interval even if the ref hasn't resolved yet
      // (2-second poll race on first startup).
      const useCP = (cp2?.enabled && cp2.restMinMin > 0) || collisionPrevented;
      const safeMin = useCP
        ? Math.max(1, Math.min(cp2!.restMinMin, cp2!.restMinMax))
        : Math.max(1, Math.min(s2.cycleIntervalMin, s2.cycleIntervalMax));
      const safeMax = useCP
        ? Math.max(1, Math.max(cp2!.restMinMin, cp2!.restMinMax))
        : Math.max(1, Math.max(s2.cycleIntervalMin, s2.cycleIntervalMax));
      const gapMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
      const nextFireAt2 = Date.now() + Math.round(gapMs);
      _hstNextRunAt.set(key, nextFireAt2);
      setNextRunAt(nextFireAt2);
      scheduleNext(gapMs);
    };

    // Expose a reschedule function for the clamp effect below — it can clear
    // the existing module-level timer and start a corrected one directly,
    // without needing to touch React state or trigger a dep-array re-run.
    rescheduleFnRef.current = (newDelayMs: number) => {
      const t = _hstTimers.get(key);
      if (t !== undefined) { clearTimeout(t); _hstTimers.delete(key); }
      const nextFireAtR = Date.now() + Math.round(newDelayMs);
      _hstNextRunAt.set(key, nextFireAtR);
      setNextRunAt(nextFireAtR);
      scheduleNext(newDelayMs);
    };

    // Manual toggle-on → fire immediately (user asked for it right now).
    // App restart with toggle already on → spread the first run across a
    // random delay within the configured Run-every interval so all accounts
    // don't fire simultaneously the moment the software restarts.
    const wasManualToggleOn = manualToggleOnRef.current;
    manualToggleOnRef.current = false;
    const _startTag = slotUsername ? `@${slotUsername}` : `slot${slotIdx ?? 0}`;
    if (wasManualToggleOn) {
      srvLog(`${_startTag} — effect started, firing immediately (manual toggle-on)`);
      scheduleNext(0);
    } else if (recoveredFireAt !== null) {
      // Remount recovery: reuse the remaining time under fresh closures.
      // nextRunAt was already restored above; just schedule the timer.
      const remainingMs = Math.max(1000, recoveredFireAt - Date.now());
      scheduleNext(remainingMs);
      srvLog(`${_startTag} — remounted, recovering timer (${(remainingMs / 60_000).toFixed(1)}min remaining)`);
    } else {
      const s0 = settingsRef.current;
      const cp0 = collisionConfigRef.current;
      // Use CP interval for the initial delay when CP is enabled — same logic
      // as post-cycle so startup scheduling is consistent with cycle scheduling.
      const useCP0 = cp0?.enabled && cp0.restMinMin > 0;
      const safeMin = useCP0
        ? Math.max(1, Math.min(cp0!.restMinMin, cp0!.restMinMax))
        : Math.max(1, Math.min(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const safeMax = useCP0
        ? Math.max(1, Math.max(cp0!.restMinMin, cp0!.restMinMax))
        : Math.max(1, Math.max(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const startDelayMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
      const nextFireAt0 = Date.now() + Math.round(startDelayMs);
      _hstNextRunAt.set(key, nextFireAt0);
      setNextRunAt(nextFireAt0);
      scheduleNext(startDelayMs);
      srvLog(`${_startTag} — effect started, timer set for ${(startDelayMs / 60_000).toFixed(1)}min (interval ${safeMin}-${safeMax}min${useCP0 ? " [CP]" : ""})`);
    }

    return () => {
      // ── DIAGNOSTIC ─────────────────────────────────────────────────────────
      const _cleanTag = slotUsername ? `@${slotUsername}` : `slot${slotIdx ?? 0}`;
      const shouldStop = explicitToggleOffRef.current;
      explicitToggleOffRef.current = false;
      srvLog(`${_cleanTag} — effect cleanup (serial=${serial}, enabled=${settings.enabled}, explicit=${shouldStop})`);
      onLog?.(`[HST-DBG] ${_cleanTag} — effect cleanup (serial=${serial}, enabled=${settings.enabled}, explicit=${shouldStop})`);

      if (shouldStop) {
        // User explicitly turned the toggle off — kill the timer NOW.
        const t = _hstTimers.get(key);
        if (t !== undefined) { clearTimeout(t); _hstTimers.delete(key); }
        // Belt-and-suspenders: if runCycle is mid-flight, the stop flag will
        // prevent it from rescheduling when the cycle completes.
        _hstStop.add(key);
        // If this slot is queued but has not been granted yet, wake the
        // pending request so runCycle can exit without waiting for the
        // collision-rest timer. An already-running slot is left alone; its
        // abort/finally path owns the normal release and rest window.
        if (slotIdx !== undefined) cancelQueuedSlot?.(slotIdx);
        // Abort any in-flight cycle fetch.
        const ctrl = cycleAbortRef.current;
        const abortingId = cycleIdRef.current;
        cycleAbortRef.current = null;
        cycleIdRef.current = null;
        ctrl?.abort();
        // Only send the server-side abort POST when we have a real cycleId.
        // If abortingId is null the client had no cycle in-flight.
        if (abortingId) {
          fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle/abort`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cycleId: abortingId }),
          }).catch(() => {});
        }
        setRunning(false);
        _hstNextRunAt.delete(key);
        setNextRunAt(null);
      }
      // If NOT an explicit user stop: leave the timer in _hstTimers untouched.
      // This is the key invariant: React cleanup fires on every dep change
      // (including spurious USB-poll oscillations every 3 s), but the module-
      // level timer keeps ticking regardless. The next effect run will see
      // _hstTimers.has(key) = true and bail out without starting a second timer.
      rescheduleFnRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enabled, hydrated, phone?.serial, phone?.state, deviceUnavailable]);

  // Clamp: if the existing timer no longer fits within the new [min, max]
  // bounds, directly reschedule the module-level timer with a corrected delay.
  //
  // Two cases that need a reschedule:
  //   1. Max was reduced  — remaining > new max  → timer would fire too late.
  //   2. Min was increased — remaining < new min  → timer would fire too early.
  //
  // IMPORTANT: debounced 800 ms.  Without the debounce the clamp fires on
  // every single keystroke while the user is editing the "Run every" fields.
  // Mid-type intermediate values (e.g. clearing "99" before typing "50" leaves
  // cycleIntervalMax = 1 for one render) can satisfy the "remaining > max"
  // condition and reschedule the timer to fire in ≈ 1 minute instead of the
  // intended 25-99 min window — causing the cycle to run immediately and
  // setNextRunAt(null), which blanks every timestamp display for that slot.
  // The debounce ensures the clamp only evaluates after the user has finished
  // editing (i.e. the value has settled), not on transient intermediate states.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!settings.enabled || running || !nextRunAtRef.current) return;
      const safeMin = Math.max(1, Math.min(settings.cycleIntervalMin, settings.cycleIntervalMax));
      const safeMax = Math.max(1, Math.max(settings.cycleIntervalMin, settings.cycleIntervalMax));
      const remainingMs = nextRunAtRef.current - Date.now();
      if (remainingMs > safeMax * 60_000 || remainingMs < safeMin * 60_000) {
        const newDelay = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
        rescheduleFnRef.current?.(newDelay);
      }
    }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.cycleIntervalMin, settings.cycleIntervalMax]);

  // Expose the union: client fetch in-flight OR server confirmed active.
  // This keeps the mirror live immediately on remount without waiting for
  // runCycle() to start its own fetch.
  return { settings, setSettings, setEnabledByUser, loading, saveError, running: running || serverCycleRunning, nextRunAt };
}

// ── Per-device collision preventer ────────────────────────────────────────────
// Ensures only one account slot on a device runs at a time. When a second slot
// becomes ready while one is running, it queues itself (sorted by readyAt so
// the slot that has been waiting longest goes next). After each slot finishes,
// the device rests for restMinMin–restMinMax minutes before the next slot runs.
interface CollisionPreventerConfig { enabled: boolean; restMinMin: number; restMinMax: number; }

function useCollisionPreventer(serial: string | null) {
  const [config, setConfig] = useState<CollisionPreventerConfig>({ enabled: false, restMinMin: 1, restMinMax: 3 });
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // Queue entries: slotIdx, the timestamp the slot first became ready, and the
  // resolve callback that grants permission to run. Boolean arg = collisionPrevented.
  // readyAt is the scheduled HST turn, not the time requestSlot happened to run.
  const queueRef = useRef<{ slotIdx: number; readyAt: number; resolve: (collisionPrevented: boolean) => void }[]>([]);
  const busyRef  = useRef(false); // true = a slot is running or resting
  const activeSlotRef = useRef<number | null>(null);
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load saved config on mount / serial change, and refresh it while the
  // Account panel stays mounted behind the other device tabs. The settings
  // panel persists Collision Preventer independently, so a one-time load here
  // would leave the scheduler using an old enabled/rest value after an edit.
  useEffect(() => {
    if (!serial) return;
    let active = true;
    const load = () => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-preventer`)
        .then(r => r.json())
        .then(d => {
          if (active && d.config) setConfig(d.config);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [serial]);

  const processNext = useCallback(() => {
    restTimerRef.current = null;
    if (queueRef.current.length === 0) {
      busyRef.current = false;
      activeSlotRef.current = null;
      return;
    }
    queueRef.current.sort((a, b) => a.readyAt - b.readyAt || a.slotIdx - b.slotIdx);
    const next = queueRef.current.shift()!;
    busyRef.current = true;
    activeSlotRef.current = next.slotIdx;
    next.resolve(true); // true = was queued = collision was prevented
  }, []);

  // Returns true if the slot had to wait (collision was prevented), false if it ran immediately.
  // onQueued fires immediately when the slot is pushed to the wait queue — before the rest
  // period begins — so the dashboard timestamp reflects the moment of the collision, not when
  // the slot eventually gets its turn.
  const requestSlot = useCallback((slotIdx: number, readyAt: number, onQueued?: () => void): Promise<boolean> => {
    if (!configRef.current.enabled) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      if (!busyRef.current) {
        busyRef.current = true;
        activeSlotRef.current = slotIdx;
        resolve(false);
      } else {
        // Preserve the original HST turn so an overdue slot keeps its place in
        // the priority queue while it waits for the configured collision rest.
        queueRef.current.push({ slotIdx, readyAt, resolve });
        // Fire the callback NOW (at collision time) so the dashboard entry
        // timestamp matches when the slot was actually blocked, not when it
        // eventually gets its turn after the rest window.
        onQueued?.();
      }
    });
  }, []);

  const releaseSlot = useCallback((slotIdx: number, skipRest = false) => {
    // If this slot was still queued (for example, its Human Session toggle was
    // turned off while it was waiting), remove only that queued turn. Do not
    // start another rest timer or resolve it after the queue has moved on.
    if (activeSlotRef.current !== slotIdx) {
      queueRef.current = queueRef.current.filter(entry => entry.slotIdx !== slotIdx);
      return;
    }
    // A stale completion from a previous cycle must not release the slot that
    // has already been granted to another account.
    activeSlotRef.current = null;
    if (skipRest) {
      // A queued turn was cancelled after being granted. It never ran, so
      // cancelling it must not impose another device rest window.
      processNext();
      return;
    }
    if (!configRef.current.enabled) {
      // Collision prevention was disabled while this cycle was running.
      // Continue the existing ready queue immediately, without introducing a
      // rest window that the user has just turned off.
      processNext();
      return;
    }
    // The active slot has finished. Hold the device for one configured
    // collision-rest interval, then grant the oldest queued HST turn. The
    // queued runCycle resumes from its existing requestSlot() promise and
    // does not receive a new HST interval until its own cycle completes.
    if (restTimerRef.current !== null) return;
    const cfg = configRef.current;
    const restMs = (cfg.restMinMin + Math.random() * Math.max(0, cfg.restMinMax - cfg.restMinMin)) * 60_000;
    restTimerRef.current = setTimeout(processNext, Math.round(restMs));
  }, [processNext]);

  const cancelQueuedSlot = useCallback((slotIdx: number) => {
    const queued = queueRef.current.filter(entry => entry.slotIdx === slotIdx);
    queueRef.current = queueRef.current.filter(entry => entry.slotIdx !== slotIdx);
    // Resolve cancelled requests so their runCycle callbacks can observe the
    // stop flag and exit. The returned boolean is irrelevant on that branch.
    for (const entry of queued) entry.resolve(false);
  }, []);

  // Turning the preventer off removes the rest window, but must never release
  // an account while another account is still active. If the device is idle
  // (including during a rest timer), grant the oldest queued turn immediately;
  // otherwise releaseSlot will do the same when the active cycle completes.
  useEffect(() => {
    configRef.current = config;
    if (config.enabled) return;
    if (restTimerRef.current !== null) {
      clearTimeout(restTimerRef.current);
      restTimerRef.current = null;
    }
    if (activeSlotRef.current === null) processNext();
  }, [config, processNext]);

  useEffect(() => () => {
    if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
    restTimerRef.current = null;
    queueRef.current = [];
    busyRef.current = false;
    activeSlotRef.current = null;
  }, []);

  return { config, setConfig, requestSlot, releaseSlot, cancelQueuedSlot };
}

// ── Copy Settings dialog ──────────────────────────────────────────────────────
// CopySubSetting, CopySection, and COPY_SECTIONS are imported from mobileShared

type CopyTarget = { serial: string; slotIdx: number };
type DeviceSlots = { phone: UsbPhone; slots: string[] /* username per slot index */ };

function deviceLabel(p: UsbPhone): string {
  return [p.manufacturer, p.marketName || p.model].filter(Boolean).join(" ") || p.serial;
}

function CopySettingsDialog({
  open, onClose, currentSlotIdx, settings, phone, onCopied,
}: {
  open: boolean;
  onClose: () => void;
  currentSlotIdx: number;
  slotUsernames?: string[]; // kept for API compat but no longer used directly
  settings: AutomationSettingsData;
  phone: UsbPhone | null;
  onCopied?: (targetSlotIdxs: number[]) => void;
}) {
  const [selectedTargets, setSelectedTargets] = useState<CopyTarget[]>([]);
  const [deviceSlots, setDeviceSlots] = useState<DeviceSlots[]>([]);
  const [farmSlotMap, setFarmSlotMap] = useState<Map<string, number>>(new Map());
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [selectedSubKeys, setSelectedSubKeys] = useState<Set<string>>(new Set());
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Fetch all devices + their slots whenever the dialog opens.
  // Reads sessionStorage to restore the last selection; defaults to all-unticked.
  // Only a page reload (software restart) or clicking "None" clears the memory.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopying(false);
    setLoadingDevices(true);

    // Read session memory synchronously FIRST — before any setState can overwrite it
    const savedSubKeysRaw = sessionStorage.getItem("copySettings_subKeys");
    const savedTargetsRaw  = sessionStorage.getItem("copySettings_targets");
    const restoredSubKeys = savedSubKeysRaw
      ? new Set<string>((JSON.parse(savedSubKeysRaw) as string[]).filter(key =>
        COPY_SECTIONS.some(section =>
          section.sub.some(sub =>
            sub.key === key &&
            sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)),
          ),
        ),
      ))
      : new Set<string>();
    const restoredTargets: CopyTarget[] | null = savedTargetsRaw ? JSON.parse(savedTargetsRaw) as CopyTarget[] : null;

    setSelectedSubKeys(restoredSubKeys);

    Promise.all([
      fetch("/api/mobile/usb-phones").then(r => r.json()),
      fetch("/api/mobile/farm-devices").then(r => r.json()).catch(() => ({ devices: [] })),
    ])
      .then(async ([phonesData, farmData]: [{ phones?: UsbPhone[] }, { devices?: Array<{ slotIndex: number; serial: string }> }]) => {
        const all: UsbPhone[] = phonesData.phones ?? [];
        const farmDevices = farmData.devices ?? [];

        const withSlots: DeviceSlots[] = await Promise.all(
          all.map(async p => {
            try {
              const r = await fetch(`/api/mobile/devices/${encodeURIComponent(p.serial)}/account`);
              const data = await r.json();
              const slots: string[] = (data?.slots ?? []).map((s: any) => s?.username ?? "");
              return { phone: p, slots };
            } catch {
              return { phone: p, slots: [] };
            }
          })
        );

        // Sort by farm slot index (Device 1 first); unregistered devices go last
        const slotMap = new Map<string, number>(farmDevices.map(d => [d.serial, d.slotIndex]));
        const sorted = [...withSlots].sort((a, b) => {
          const ai = slotMap.get(a.phone.serial) ?? Infinity;
          const bi = slotMap.get(b.phone.serial) ?? Infinity;
          return ai - bi;
        });

        setDeviceSlots(sorted);
        setFarmSlotMap(slotMap);

        // Restore targets from session memory, filtered to currently-present valid slots
        if (restoredTargets) {
          const validSet = new Set(
            sorted.flatMap(ds => ds.slots.map((_, i) => `${ds.phone.serial}:${i}`))
          );
          setSelectedTargets(
            restoredTargets.filter(t =>
              validSet.has(`${t.serial}:${t.slotIdx}`) &&
              !(t.serial === phone?.serial && t.slotIdx === currentSlotIdx)
            )
          );
        } else {
          setSelectedTargets([]);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingDevices(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isSelected = (serial: string, slotIdx: number) =>
    selectedTargets.some(t => t.serial === serial && t.slotIdx === slotIdx);

  const toggleTarget = (serial: string, slotIdx: number, checked: boolean) =>
    setSelectedTargets(prev => {
      const next = checked
        ? [...prev, { serial, slotIdx }]
        : prev.filter(t => !(t.serial === serial && t.slotIdx === slotIdx));
      sessionStorage.setItem("copySettings_targets", JSON.stringify(next));
      return next;
    });

  const toggleDevice = (ds: DeviceSlots, checked: boolean) =>
    setSelectedTargets(prev => {
      const rest = prev.filter(t => t.serial !== ds.phone.serial);
      if (!checked) {
        sessionStorage.setItem("copySettings_targets", JSON.stringify(rest));
        return rest;
      }
      const add: CopyTarget[] = ds.slots
        .map((_, i) => ({ serial: ds.phone.serial, slotIdx: i }))
        .filter(t => !(t.serial === phone?.serial && t.slotIdx === currentSlotIdx));
      const next = [...rest, ...add];
      sessionStorage.setItem("copySettings_targets", JSON.stringify(next));
      return next;
    });

  const deviceCheckedState = (ds: DeviceSlots): "all" | "some" | "none" => {
    const eligible = ds.slots.filter((_, i) => !(ds.phone.serial === phone?.serial && i === currentSlotIdx));
    if (eligible.length === 0) return "none";
    const sel = eligible.filter((_, i) => isSelected(ds.phone.serial, i)).length;
    if (sel === 0) return "none";
    if (sel === eligible.length) return "all";
    return "some";
  };

  const allTargets: CopyTarget[] = deviceSlots.flatMap(ds =>
    ds.slots
      .map((_, i) => ({ serial: ds.phone.serial, slotIdx: i }))
      .filter(t => !(t.serial === phone?.serial && t.slotIdx === currentSlotIdx))
  );

  const toggleSub = (subKey: string, checked: boolean) =>
    setSelectedSubKeys(prev => {
      const sub = COPY_SECTIONS
        .flatMap(section => section.sub)
        .find(candidate => candidate.key === subKey);
      if (!sub || !sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field))) {
        return prev;
      }
      const n = new Set(prev);
      checked ? n.add(subKey) : n.delete(subKey);
      sessionStorage.setItem("copySettings_subKeys", JSON.stringify([...n]));
      return n;
    });

  const toggleSection = (section: CopySection, checked: boolean) =>
    setSelectedSubKeys(prev => {
      const n = new Set(prev);
      section.sub
        .filter(sub => sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)))
        .forEach(sub => checked ? n.add(sub.key) : n.delete(sub.key));
      sessionStorage.setItem("copySettings_subKeys", JSON.stringify([...n]));
      return n;
    });

  const sectionState = (section: CopySection): "all" | "some" | "none" => {
    const copyableSubs = section.sub.filter(sub =>
      sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)),
    );
    const selected = copyableSubs.filter(sub => selectedSubKeys.has(sub.key)).length;
    if (selected === 0) return "none";
    if (selected === copyableSubs.length) return "all";
    return "some";
  };

  const handleCopy = async () => {
    if (selectedTargets.length === 0) return;
    setCopying(true);
    setResult(null);
    const partial: Record<string, unknown> = {};
    for (const section of COPY_SECTIONS) {
      for (const sub of section.sub) {
        if (selectedSubKeys.has(sub.key)) {
          for (const field of sub.fields) {
            if (COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)) {
              partial[field] = (settings as unknown as Record<string, unknown>)[field];
            }
          }
        }
      }
    }
    let ok = 0, fail = 0;
    const localSucceeded: number[] = [];
    for (const target of selectedTargets) {
      try {
        const r = await fetch(
          `/api/mobile/devices/${encodeURIComponent(target.serial)}/slots/${target.slotIdx}/automation-settings`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...partial, trustScoreCopy: true }) },
        );
        if (r.ok) {
          ok++;
          if (target.serial === phone?.serial) localSucceeded.push(target.slotIdx);
        } else fail++;
      } catch { fail++; }
    }
    if (localSucceeded.length > 0) onCopied?.(localSucceeded);
    if (fail === 0) {
      setResult("ok");
      setTimeout(() => { onClose(); }, 500);
    } else {
      setResult(`${fail} slot${fail !== 1 ? "s" : ""} failed`);
      setCopying(false);
      setTimeout(() => { onClose(); }, 1200);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !copying) onClose(); }}>
      <DialogContent className="max-w-[52.8rem] max-h-[65vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Copy Settings to Other Slots</DialogTitle>
        </DialogHeader>
        <div className="flex gap-8 mt-2 flex-1 min-h-0">

          {/* Left: target slots grouped by device */}
          <div className="w-[22rem] shrink-0 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Copy to</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                  onClick={() => { sessionStorage.setItem("copySettings_targets", JSON.stringify(allTargets)); setSelectedTargets(allTargets); }}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                  onClick={() => { sessionStorage.removeItem("copySettings_targets"); setSelectedTargets([]); }}>None</Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-3 pr-1">
              {loadingDevices && (
                <p className="text-xs text-muted-foreground italic pt-1">Loading devices…</p>
              )}
              {!loadingDevices && deviceSlots.length === 0 && (
                <p className="text-xs text-muted-foreground italic pt-1">No devices found.</p>
              )}
              {deviceSlots.map(ds => {
                const devState = deviceCheckedState(ds);
                const isCurrentDevice = ds.phone.serial === phone?.serial;
                const eligibleSlots = ds.slots.filter((_, i) =>
                  !(isCurrentDevice && i === currentSlotIdx)
                );
                if (eligibleSlots.length === 0 && isCurrentDevice && ds.slots.length <= 1) return null;
                return (
                  <div key={ds.phone.serial} className="rounded-md border border-border/50 overflow-hidden">
                    {/* Device header row */}
                    <label className="flex items-center gap-2 px-2.5 py-1.5 bg-muted/40 cursor-pointer select-none hover:bg-muted/60 transition-colors">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-primary shrink-0"
                        checked={devState === "all"}
                        ref={el => { if (el) el.indeterminate = devState === "some"; }}
                        onChange={e => toggleDevice(ds, e.target.checked)}
                        disabled={eligibleSlots.length === 0}
                      />
                      <span className="text-xs font-bold text-foreground truncate min-w-0 flex-1">
                        {farmSlotMap.has(ds.phone.serial) && (
                          <span className="text-muted-foreground font-normal mr-0.5">Device {farmSlotMap.get(ds.phone.serial)} —</span>
                        )}
                        {deviceLabel(ds.phone)}
                      </span>
                      {isCurrentDevice && (
                        <span className="text-[10px] text-muted-foreground shrink-0">(this device)</span>
                      )}
                    </label>
                    {/* Slot rows */}
                    <div className="divide-y divide-border/30">
                      {ds.slots.map((username, i) => {
                        const isSelf = isCurrentDevice && i === currentSlotIdx;
                        return (
                          <label key={i}
                            className={`flex items-center gap-2 px-3 pl-6 py-1 select-none ${isSelf ? "opacity-40 cursor-default" : "cursor-pointer hover:bg-muted/20 transition-colors"}`}>
                            <input
                              type="checkbox"
                              className="w-3 h-3 accent-primary shrink-0"
                              checked={!isSelf && isSelected(ds.phone.serial, i)}
                              disabled={isSelf}
                              onChange={e => toggleTarget(ds.phone.serial, i, e.target.checked)}
                            />
                            <span className="text-xs shrink-0" style={{
                              width: "6.5rem",
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              WebkitMaskImage: "linear-gradient(to right, black 70%, transparent 100%)",
                              maskImage: "linear-gradient(to right, black 70%, transparent 100%)",
                            }}>
                              {username ? `@${username}` : `Slot ${i + 1}`}
                              {isSelf && <span className="text-muted-foreground ml-1">(source)</span>}
                            </span>
                            <SlotTrustScoreBadge serial={ds.phone.serial} slotIdx={i} width={65} hideIcon />
                          </label>
                        );
                      })}
                      {ds.slots.length === 0 && (
                        <p className="text-xs text-muted-foreground italic px-6 py-1">No slots configured</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: settings with sub-items */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settings</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                  onClick={() => {
                    const all = new Set(
                      COPY_SECTIONS.flatMap(section => section.sub)
                        .filter(sub => sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)))
                        .map(sub => sub.key),
                    );
                    sessionStorage.setItem("copySettings_subKeys", JSON.stringify([...all]));
                    setSelectedSubKeys(all);
                  }}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                  onClick={() => { sessionStorage.removeItem("copySettings_subKeys"); setSelectedSubKeys(new Set()); }}>None</Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-1 pr-1">
              {COPY_SECTIONS.map(section => {
                const state = sectionState(section);
                const allSubs = section.sub;
                const copyableSubs = section.sub.filter(sub =>
                  sub.fields.every(field => COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)),
                );
                // A section header is actionable only when every setting in
                // that section is permitted. Mixed sections must stay
                // disabled so "All" cannot imply copying locked settings.
                const sectionCopyable = copyableSubs.length === allSubs.length;
                return (
                  <div key={section.key} className="rounded-md border border-border/50 overflow-hidden">
                    <label className={`flex items-center gap-2 px-2.5 py-1.5 bg-muted/40 select-none transition-colors ${
                      sectionCopyable ? "cursor-pointer hover:bg-muted/60" : "cursor-default opacity-50"
                    }`}>
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-primary shrink-0"
                        checked={state === "all"}
                        ref={el => { if (el) el.indeterminate = state === "some"; }}
                        onChange={e => toggleSection(section, e.target.checked)}
                        disabled={!sectionCopyable}
                      />
                      <span className={`text-xs font-bold ${
                        sectionCopyable ? "text-foreground" : "text-muted-foreground"
                      }`}>{section.label}</span>
                    </label>
                    {allSubs.length > 1 && (
                      <div className="divide-y divide-border/30">
                        {allSubs.map(sub => {
                          const subCopyable = sub.fields.every(field =>
                            COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field),
                          );
                          return (
                          <label key={sub.key} className={`flex items-center gap-2 px-3 pl-6 py-1 select-none transition-colors ${
                            subCopyable ? "cursor-pointer hover:bg-muted/20" : "cursor-default opacity-45"
                          }`}>
                            <input
                              type="checkbox"
                              className="w-3 h-3 accent-primary shrink-0"
                              checked={selectedSubKeys.has(sub.key)}
                              onChange={e => toggleSub(sub.key, e.target.checked)}
                              disabled={!subCopyable}
                            />
                            <span className="text-xs text-muted-foreground">{sub.label}</span>
                          </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border shrink-0">
          {result && result !== "ok" && (
            <span className="text-xs mr-auto text-destructive">{result}</span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={copying}>Cancel</Button>
          <Button onClick={handleCopy}
            disabled={copying || selectedTargets.length === 0 || selectedSubKeys.size === 0}
            style={result === "ok" ? { background: "#16a34a", borderColor: "#16a34a" } : undefined}>
            {result === "ok"
              ? <CheckCircle2 className="w-4 h-4 text-white" />
              : copying ? "Copying…" : "Copy Settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AutomationSettingsPanel({
  phone, settings, setSettings: setSettingsExternal, setEnabledByUser, loading: loadingExternal, saveError, running, nextRunAt,
  slotIdx, slotUsername, slotUsernames, onCopied, showCopyDialog, setShowCopyDialog,
  templateLockedFields, trustScoreAssigned, trustScoreLabel, onOpenBrowserProfile, settingsScrollRef, sharedScrollTopRef, isActive,
}: {
  phone: UsbPhone | null;
  settings: AutomationSettingsData;
  setSettings: React.Dispatch<React.SetStateAction<AutomationSettingsData>>;
  setEnabledByUser: (enabled: boolean) => void;
  loading: boolean;
  saveError: string | null;
  running: boolean;
  nextRunAt: number | null;
  slotIdx?: number;
  slotUsername?: string;
  slotUsernames?: string[];
  onCopied?: (targetSlotIdxs: number[]) => void;
  showCopyDialog?: boolean;
  setShowCopyDialog?: (v: boolean) => void;
  /** Used by the TrustScore editor to lock slot-owned fields in templates. */
  templateLockedFields?: string[];
  /** Explicit Account Slot assignment state; independent of effective settings. */
  trustScoreAssigned?: boolean;
  /** TrustScore badge to display beside the Human Session Tool title in templates. */
  trustScoreLabel?: {
    label: string;
    bg: string;
    border: string;
    text: string;
    icon: React.ComponentType<{ size?: number; color?: string; fill?: string; strokeWidth?: number }>;
  };
  onOpenBrowserProfile?: (username: string) => void;
  settingsScrollRef?: React.MutableRefObject<HTMLDivElement | null>;
  sharedScrollTopRef?: React.MutableRefObject<number>;
  isActive?: boolean;
}) {
  const trustScoreActive = trustScoreAssigned === true || Boolean(settings.trustScoreId);
  const isTrustScoreTemplateEditor = templateLockedFields !== undefined;
  const TRUST_SCORE_FEATURE_FIELDS = new Set([
    "feedEnabled", "storiesEnabled", "viewExploreEnabled", "viewReelsEnabled",
    "checkDmEnabled", "followEnabled", "randomJitterEnabled", "makePostEnabled",
    "postStoryEnabled",
  ]);
  // These are the only settings a physical slot may change while its
  // effective values come from a TrustScore template.  Everything else in
  // the HST form is template-controlled and must stay visibly disabled.
  const TRUST_SCORE_SLOT_EDITABLE_FIELDS = useMemo(
    () => new Set([
      "enabled",
      ...TRUST_SCORE_FEATURE_FIELDS,
      ...TRUST_SCORE_SLOT_OWNED_FIELDS,
    ]),
    [],
  );
  const lockedFields = useMemo(
    () => new Set(
      templateLockedFields ??
      (trustScoreActive
        ? (settings.trustScoreControlledFields ?? []).filter(field => !TRUST_SCORE_FEATURE_FIELDS.has(field))
        : []),
    ),
    [templateLockedFields, trustScoreActive, settings.trustScoreControlledFields],
  );
  const templateDisabledTools = useMemo(
    () => new Set(settings.trustScoreTemplateDisabledTools ?? []),
    [settings.trustScoreTemplateDisabledTools],
  );
  const trustScoreSlotLocked = trustScoreActive && !templateLockedFields;
  const fieldLocked = useCallback(
    (...fields: string[]) => fields.some(field => lockedFields.has(field)),
    [lockedFields],
  );
  const setSettings = useCallback<React.Dispatch<React.SetStateAction<AutomationSettingsData>>>((update) => {
    setSettingsExternal(previous => {
      const proposed = typeof update === "function" ? update(previous) : update;
      const next = { ...proposed };
      for (const field of lockedFields) {
        if (field in previous) (next as unknown as Record<string, unknown>)[field] = (previous as unknown as Record<string, unknown>)[field];
      }
      if (trustScoreActive) {
        const overrides = { ...(previous.trustScoreToolOverrides ?? {}) };
        for (const field of TRUST_SCORE_FEATURE_FIELDS) {
          if (templateDisabledTools.has(field)) continue;
          if ((proposed as unknown as Record<string, unknown>)[field] !== (previous as unknown as Record<string, unknown>)[field]) {
            overrides[field] = Boolean((proposed as unknown as Record<string, unknown>)[field]);
          }
        }
        next.trustScoreToolOverrides = overrides;
      }
      // Account Slot panels must never be able to mutate an inherited
      // TrustScore value, even if a newly added control forgot to use the
      // fieldDisabled(...) helper.  The UI disabled state is the affordance;
      // this allow-list is the actual mutation boundary.
      if (trustScoreSlotLocked) {
        const previousRecord = previous as unknown as Record<string, unknown>;
        const nextRecord = next as unknown as Record<string, unknown>;
        for (const field of Object.keys(previousRecord)) {
          if (!TRUST_SCORE_SLOT_EDITABLE_FIELDS.has(field)) {
            nextRecord[field] = previousRecord[field];
          }
        }
      }
      return next;
    });
  }, [setSettingsExternal, lockedFields, trustScoreActive, trustScoreSlotLocked, TRUST_SCORE_SLOT_EDITABLE_FIELDS, templateDisabledTools]);
  // When a slot has an assigned TrustScore, the displayed values are inherited
  // and must be read-only. The exceptions below intentionally keep the master
  // switch, per-tool switches, and slot-owned source controls editable.
  // A live slot inherits the template values and therefore starts with the
  // whole HST form locked.  The field-level exceptions below reopen only the
  // master switch, individual tool switches, and physical-slot-owned sources.
  // The TrustScore editor passes templateLockedFields, so its normal template
  // values remain editable while excluded slot fields stay locked.
  const loading = loadingExternal || trustScoreSlotLocked;
  const fieldDisabled = (...fields: string[]) =>
    loadingExternal || fields.some(field =>
      trustScoreSlotLocked
        ? !TRUST_SCORE_SLOT_EDITABLE_FIELDS.has(field) || templateDisabledTools.has(field)
        : fieldLocked(field),
    );
  // Follow Users UI local state — hooks must come before any conditional return.
  const [_localShowCopyDialog, _localSetShowCopyDialog] = useState(false);
  const showCopyDialogResolved = showCopyDialog ?? _localShowCopyDialog;
  const setShowCopyDialogResolved = setShowCopyDialog ?? _localSetShowCopyDialog;
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);
  const [showSurplus, setShowSurplus] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [bioSpinEditorOpen, setBioSpinEditorOpen] = useState(false);
  const [bioSpinDraft, setBioSpinDraft] = useState("");
  const [maleNamesEditorOpen, setMaleNamesEditorOpen] = useState(false);
  const [maleNamesDraft, setMaleNamesDraft] = useState("");
  const [spinPreview, setSpinPreview] = useState<string | null>(null);
  const [newFollowSourceType, setNewFollowSourceType] = useState<'hashtag' | 'target_followers'>('hashtag');
  const [newFollowSourceValue, setNewFollowSourceValue] = useState('');
  const importSourceFileRef = useRef<HTMLInputElement>(null);

  const handleImportFollowSources = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let encoding = 'utf-8';
      let offset = 0;
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(buf.slice(offset)); }
      catch { text = new TextDecoder('windows-1252').decode(buf.slice(offset)); }
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      // Skip header row; first column is the hashtag value
      const newSources: { type: 'hashtag' | 'target_followers'; value: string }[] = lines.slice(1)
        .map(line => line.split('\t')[0].trim().replace(/^#/, '').toLowerCase())
        .filter(v => v && !/^\d+$/.test(v))
        .map(value => ({ type: 'hashtag' as const, value }));
      if (!newSources.length) return;
      setSettings(s => ({ ...s, followSources: [...s.followSources, ...newSources] }));
    } finally {
      if (importSourceFileRef.current) importSourceFileRef.current.value = '';
    }
  };

  const handleExportFollowSources = () => {
    const items = settings.followSources;
    if (!items.length) return;
    const lines = ['Hashtag\tType', ...items.map(s => `${s.value}\t${s.type}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'follow-sources.csv'; a.click();
    URL.revokeObjectURL(url);
  };
  const [mobileFollowedList, setMobileFollowedList] = useState<{username:string;source?:string;followedAt:number}[]>([]);
  const [loadingFollowed, setLoadingFollowed] = useState(false);
  const [mobileOverspillList, setMobileOverspillList] = useState<{id:number;instagramUsername:string;sourceValue:string;scrapedAt:string}[]>([]);
  const [loadingOverspill, setLoadingOverspill] = useState(false);
  // Make a Post UI local state
  const [makePostImageSettingsOpen, setMakePostImageSettingsOpen] = useState(false);
  const [postStoryImageSettingsOpen, setPostStoryImageSettingsOpen] = useState(false);
  const [showPostedMedia, setShowPostedMedia] = useState(false);
  const [postedMediaEntries, setPostedMediaEntries] = useState<{
    id: string;
    filename: string;
    username: string;
    slotIdx: number;
    postedAt: string;
    thumbnailUrl?: string;
  }[]>([]);
  const [loadingPostedMedia, setLoadingPostedMedia] = useState(false);

  const loadFollowedUsers = React.useCallback(async () => {
    if (!phone?.serial) return;
    setLoadingFollowed(true);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx ?? 0}/followed-users`);
      const data = await r.json().catch(() => null);
      if (data?.users) setMobileFollowedList(data.users);
    } catch {} finally { setLoadingFollowed(false); }
  }, [phone?.serial]);

  const loadPostedMedia = React.useCallback(async () => {
    if (!phone?.serial || !slotUsername) return;
    setLoadingPostedMedia(true);
    try {
      const params = new URLSearchParams({
        username: slotUsername,
        slotIdx: String(slotIdx ?? 0),
      });
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/posted-profile-media?${params}`);
      const data = await r.json().catch(() => null);
      if (Array.isArray(data?.entries)) setPostedMediaEntries(data.entries);
    } catch {} finally { setLoadingPostedMedia(false); }
  }, [phone?.serial, slotUsername, slotIdx]);

  const loadSurplus = React.useCallback(async () => {
    if (!slotUsername) return;
    setLoadingOverspill(true);
    try {
      // Try phone-slot endpoint first (works without an EB profile).
      // Falls back to the EB-profile endpoint if the slot happens to match.
      const slotKey = slotUsername.replace(/^@/, '').toLowerCase();
      const slotData = await fetch(`/api/mobile/slot-surplus/${encodeURIComponent(slotKey)}`).then(r => r.json()).catch(() => null);
      if (Array.isArray(slotData) && slotData.length > 0) {
        setMobileOverspillList(slotData);
        return;
      }
      // Also check the EB-profile table in case this account has a profile.
      const profiles = await fetch('/api/profiles').then(r => r.json()).catch(() => null);
      const profile = Array.isArray(profiles)
        ? profiles.find((p: any) => p.username === slotUsername || p.accountLabel === slotUsername)
        : null;
      if (profile?.id) {
        const data = await fetch(`/api/profiles/${profile.id}/overspill-users`).then(r => r.json()).catch(() => null);
        if (Array.isArray(data)) { setMobileOverspillList(data); return; }
      }
      setMobileOverspillList(Array.isArray(slotData) ? slotData : []);
    } catch {} finally { setLoadingOverspill(false); }
  }, [slotUsername]);

  // Auto-refresh the followed list every 5 s while the panel is open so
  // users followed during a running cycle appear without manual re-toggle.
  React.useEffect(() => {
    if (!showFollowedUsers) return;
    const id = setInterval(loadFollowedUsers, 5000);
    return () => clearInterval(id);
  }, [showFollowedUsers, loadFollowedUsers]);

  // Auto-refresh surplus every 5 s while the panel is open.
  React.useEffect(() => {
    if (!showSurplus) return;
    loadSurplus();
    const id = setInterval(loadSurplus, 5000);
    return () => clearInterval(id);
  }, [showSurplus, loadSurplus]);

  if (!phone) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-2">
        <Smartphone className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground max-w-xs">
          Connect a phone via USB to configure its automation settings.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={settingsScrollRef}
      onScroll={e => {
        if (sharedScrollTopRef) sharedScrollTopRef.current = e.currentTarget.scrollTop;
      }}
      className="h-full overflow-y-auto p-6 space-y-6"
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Fingerprint className="w-4 h-4 shrink-0" style={{ color: "#1AD2F2" }} />
          <h2 className="text-lg font-bold text-foreground whitespace-nowrap">Human Session Tool</h2>
          {trustScoreLabel && (
            <div
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1"
              style={{ background: trustScoreLabel.bg, border: `1px solid ${trustScoreLabel.border}` }}
            >
              <trustScoreLabel.icon
                size={12}
                color={trustScoreLabel.text}
                fill={trustScoreLabel.text}
                strokeWidth={2}
              />
              <span style={{ fontSize: 11, fontWeight: 700, color: trustScoreLabel.text, letterSpacing: "0.05em" }}>
                {trustScoreLabel.label}
              </span>
            </div>
          )}
          {slotIdx !== undefined && (
            <SlotTrustScoreBadge serial={phone?.serial ?? ""} slotIdx={slotIdx} width={121} />
          )}
          {slotUsername && (
            <span className="text-lg font-bold text-foreground whitespace-nowrap">for @{slotUsername}</span>
          )}
        </div>
      </div>

      {/* Master toggle — turns the whole tool on/off. */}
      <div className="inline-flex self-start bg-card border border-border rounded-xl p-5">
        {/* Single row: (STEP1) toggle status | Run every X to Y minutes */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">(STEP1)</span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={setEnabledByUser}
            disabled={fieldDisabled("enabled")}
            className="shrink-0"
          />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-foreground whitespace-nowrap">
              {settings.enabled ? (running ? "Running" : "Active") : "Disabled"}
            </span>
            {settings.enabled && !running && nextRunAt && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                Next run at {new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} on {new Date(nextRunAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}
              </span>
            )}
          </div>
          <div className="w-px self-stretch bg-border mx-1" />
          <Label className="text-sm text-muted-foreground whitespace-nowrap">Run every</Label>
          <Input
            type="number"
            min={1}
            className={NUM_INPUT_CLASS}
            value={settings.cycleIntervalMin}
            onChange={e => setSettings(s => ({ ...s, cycleIntervalMin: Math.max(1, clamp4(Number(e.target.value))) }))}
            disabled={fieldDisabled("cycleIntervalMin", "cycleIntervalMax")}
          />
          <span className="text-muted-foreground text-sm">to</span>
          <Input
            type="number"
            min={1}
            className={NUM_INPUT_CLASS}
            value={settings.cycleIntervalMax}
            onChange={e => setSettings(s => ({ ...s, cycleIntervalMax: Math.max(1, clamp4(Number(e.target.value))) }))}
            disabled={fieldDisabled("cycleIntervalMin", "cycleIntervalMax")}
          />
          <Label className="text-sm text-muted-foreground whitespace-nowrap">minutes</Label>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">(STEP2)</p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                id={`shuffle-tool-order-${slotIdx ?? 0}`}
                checked={settings.shuffleToolOrder}
                onChange={e => setSettings(s => ({ ...s, shuffleToolOrder: e.target.checked }))}
                disabled={fieldDisabled("shuffleToolOrder")}
                className="w-4 h-4 accent-primary cursor-pointer"
              />
              <span className="text-sm text-muted-foreground">Shuffle tool order</span>
            </label>
          </div>
          <br />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`feed-enabled-${slotIdx ?? 0}`}
              checked={settings.feedEnabled}
              onChange={e => setSettings(s => ({ ...s, feedEnabled: e.target.checked }))}
              disabled={fieldDisabled("feedEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`feed-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">View Feed</label>
          </div>
        </div>
        {settings.feedEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.feedActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, feedActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.feedActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, feedActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Scroll this many times</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={1}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.feedScrollMin}
                onChange={e => setSettings(s => ({ ...s, feedScrollMin: clamp4(Number(e.target.value)) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={1}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.feedScrollMax}
                onChange={e => setSettings(s => ({ ...s, feedScrollMax: clamp4(Number(e.target.value)) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Delay between actions in s</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.actionDelayMin}
                onChange={e => setSettings(s => ({ ...s, actionDelayMin: clamp4(Number(e.target.value)) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.actionDelayMax}
                onChange={e => setSettings(s => ({ ...s, actionDelayMax: clamp4(Number(e.target.value)) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Like % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.likePercentMin}
                onChange={e => setSettings(s => ({ ...s, likePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.likePercentMax}
                onChange={e => setSettings(s => ({ ...s, likePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>
        </div>}

        {/* Share to Feed + Share via DM — second row */}
        {settings.feedEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share to Feed % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.shareFeedPercentMin}
                onChange={e => setSettings(s => ({ ...s, shareFeedPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.shareFeedPercentMax}
                onChange={e => setSettings(s => ({ ...s, shareFeedPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share via DM % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.shareDmPercentMin}
                onChange={e => setSettings(s => ({ ...s, shareDmPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.shareDmPercentMax}
                onChange={e => setSettings(s => ({ ...s, shareDmPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Save % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.savePercentMin}
                onChange={e => setSettings(s => ({ ...s, savePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.savePercentMax}
                onChange={e => setSettings(s => ({ ...s, savePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Expand Caption % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.expandCaptionPercentMin}
                onChange={e => setSettings(s => ({ ...s, expandCaptionPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.expandCaptionPercentMax}
                onChange={e => setSettings(s => ({ ...s, expandCaptionPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Tap Audio % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.tapAudioPercentMin}
                onChange={e => setSettings(s => ({ ...s, tapAudioPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.tapAudioPercentMax}
                onChange={e => setSettings(s => ({ ...s, tapAudioPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Hashtag % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.clickHashtagPercentMin}
                onChange={e => setSettings(s => ({ ...s, clickHashtagPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.clickHashtagPercentMax}
                onChange={e => setSettings(s => ({ ...s, clickHashtagPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Author % of posts</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.clickAuthorPercentMin}
                onChange={e => setSettings(s => ({ ...s, clickAuthorPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.clickAuthorPercentMax}
                onChange={e => setSettings(s => ({ ...s, clickAuthorPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Suggestions % of slots</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.feedSuggestionsPercentMin}
                onChange={e => setSettings(s => ({ ...s, feedSuggestionsPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={100}
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.feedSuggestionsPercentMax}
                onChange={e => setSettings(s => ({ ...s, feedSuggestionsPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading}
              />
            </div>
          </div>
        </div>}

        {saveError && <p className="text-xs text-destructive">{saveError}</p>}

        {/* Border separator between View Feed above and View Explore Page below */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`explore-enabled-${slotIdx ?? 0}`}
              checked={settings.viewExploreEnabled}
              onChange={e => setSettings(s => ({ ...s, viewExploreEnabled: e.target.checked }))}
              disabled={fieldDisabled("viewExploreEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`explore-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">View Explore Page</label>
          </div>
        </div>

        {settings.viewExploreEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Scroll this many times</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreScrollMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreScrollMin: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreScrollMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreScrollMax: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Delay between actions in s</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreActionDelayMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreActionDelayMin: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreActionDelayMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreActionDelayMax: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click posts %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreClickPostPctMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreClickPostPctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreClickPostPctMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreClickPostPctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Author % of posts</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreClickAuthorPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreClickAuthorPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreClickAuthorPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreClickAuthorPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Like % of posts</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreLikePercentMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreLikePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreLikePercentMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreLikePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share to Feed % of posts</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreShareFeedPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreShareFeedPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreShareFeedPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreShareFeedPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share via DM % of posts</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreShareDmPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreShareDmPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreShareDmPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreShareDmPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Save % of posts</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreSavePercentMin}
                onChange={e => setSettings(s => ({ ...s, viewExploreSavePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewExploreSavePercentMax}
                onChange={e => setSettings(s => ({ ...s, viewExploreSavePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>
        </div>}

        {/* Border separator between View Explore Page above and View
            Stories from Feed below — same card/step (STEP2). */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`stories-enabled-${slotIdx ?? 0}`}
              checked={settings.storiesEnabled}
              onChange={e => setSettings(s => ({ ...s, storiesEnabled: e.target.checked }))}
              disabled={fieldDisabled("storiesEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`stories-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">View Stories from Feed</label>
          </div>
        </div>

        {settings.storiesEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Stories to watch</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesSlidesMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesSlidesMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesSlidesMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesSlidesMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">% to watch</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={1} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesSlideWatchPctMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesSlideWatchPctMin: Math.min(100, Math.max(1, clamp4(Number(e.target.value)))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={1} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesSlideWatchPctMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesSlideWatchPctMax: Math.min(100, Math.max(1, clamp4(Number(e.target.value)))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Like %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesLikePercentMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesLikePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesLikePercentMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesLikePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share DM %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesShareDmPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesShareDmPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesShareDmPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesShareDmPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Comment %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesCommentPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesCommentPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesCommentPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesCommentPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Author %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesClickAuthorPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewStoriesClickAuthorPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewStoriesClickAuthorPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewStoriesClickAuthorPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>
        </div>}

        {/* Border separator between View Stories from Feed above and View
            Reels below — same card/step (STEP2), mirrors the divider above
            between View Feed and View Stories from Feed. */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`reels-enabled-${slotIdx ?? 0}`}
              checked={settings.viewReelsEnabled}
              onChange={e => setSettings(s => ({ ...s, viewReelsEnabled: e.target.checked }))}
              disabled={fieldDisabled("viewReelsEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`reels-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">View Reels</label>
          </div>
        </div>

        {settings.viewReelsEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Scroll amount</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsScrollMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsScrollMin: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsScrollMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsScrollMax: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Watch %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={1} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsWatchPctMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsWatchPctMin: Math.min(100, Math.max(1, clamp4(Number(e.target.value)))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={1} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsWatchPctMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsWatchPctMax: Math.min(100, Math.max(1, clamp4(Number(e.target.value)))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Like %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsLikePercentMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsLikePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsLikePercentMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsLikePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share Feed %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsShareFeedPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsShareFeedPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsShareFeedPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsShareFeedPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Save %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsSavePercentMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsSavePercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsSavePercentMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsSavePercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Share DM %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsShareDmPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsShareDmPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsShareDmPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsShareDmPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Author %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsClickAuthorPercentMin}
                onChange={e => setSettings(s => ({ ...s, viewReelsClickAuthorPercentMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.viewReelsClickAuthorPercentMax}
                onChange={e => setSettings(s => ({ ...s, viewReelsClickAuthorPercentMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>
        </div>}

        {/* ── Direct Messaging — between View Reels and Follow Users ── */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`checkdm-enabled-${slotIdx ?? 0}`}
              checked={settings.checkDmEnabled}
              onChange={e => setSettings(s => ({ ...s, checkDmEnabled: e.target.checked }))}
              disabled={fieldDisabled("checkDmEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`checkdm-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">Direct Messaging</label>
          </div>
        </div>

        {settings.checkDmEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, checkDmActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, checkDmActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Scroll amount</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmScrollMin}
                onChange={e => setSettings(s => ({ ...s, checkDmScrollMin: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmScrollMax}
                onChange={e => setSettings(s => ({ ...s, checkDmScrollMax: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Click Thread %</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmClickPctMin}
                onChange={e => setSettings(s => ({ ...s, checkDmClickPctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.checkDmClickPctMax}
                onChange={e => setSettings(s => ({ ...s, checkDmClickPctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
            </div>
          </div>
        </div>}

        {/* Border separator between Direct Messaging above and the Follow Users
            feature below — same card/step (STEP2). */}
        <div className="border-t border-border" />

        {/* ── Follow Users — Sources, Surplus, and Followed expand over this
               tool's settings only, matching the Posted Media pattern. ─── */}
        <div className="space-y-3 relative">
          <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`follow-enabled-${slotIdx ?? 0}`}
            checked={settings.followEnabled}
            onChange={e => setSettings(s => ({ ...s, followEnabled: e.target.checked }))}
            disabled={fieldDisabled("followEnabled")}
            className="w-4 h-4 accent-primary cursor-pointer"
          />
          <label htmlFor={`follow-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">Follow Users</label>
          <Button
            variant="outline" size="sm"
            className="h-7 text-xs px-3 ml-auto"
            onClick={() => setShowSources(v => {
              if (!v) {
                setShowSurplus(false);
                setShowFollowedUsers(false);
              }
              return !v;
            })}
          >{showSources ? 'Hide' : 'Sources'}</Button>
          <Button
            variant="outline" size="sm" className="h-7 text-xs px-3"
            disabled={loadingOverspill}
            onClick={() => {
              setShowSurplus(v => {
                if (!v) {
                  setShowSources(false);
                  setShowFollowedUsers(false);
                }
                return !v;
              });
              if (!showSurplus) loadSurplus();
            }}
          >
            {showSurplus ? 'Hide' : 'Surplus'}
            {mobileOverspillList.length > 0 && !showSurplus && (
              <span className="ml-1 text-[10px] text-muted-foreground">({mobileOverspillList.length})</span>
            )}
          </Button>
          <Button
            variant="outline" size="sm" className="h-7 text-xs px-3"
            disabled={loadingFollowed}
            onClick={() => {
              setShowFollowedUsers(v => {
                if (!v) {
                  setShowSources(false);
                  setShowSurplus(false);
                }
                return !v;
              });
              if (!showFollowedUsers) loadFollowedUsers();
            }}
          >{showFollowedUsers ? 'Hide' : 'Followed'}</Button>
          </div>

        {/* ── Activate Percentage + Users to follow per operation ────── */}
          {settings.followEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.followActivatePctMin}
                onChange={e => setSettings(s => ({ ...s, followActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.followActivatePctMax}
                onChange={e => setSettings(s => ({ ...s, followActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                disabled={loading} />

            </div>
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-3">
              <Label className="text-sm text-muted-foreground block text-center">Users to follow per operation</Label>
              <div className="flex items-center gap-3">
                <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                  value={settings.followUsersMin}
                  onChange={e => setSettings(s => ({ ...s, followUsersMin: clamp4(Number(e.target.value)) }))}
                  disabled={fieldDisabled("followUsersMin")} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                  value={settings.followUsersMax}
                  onChange={e => setSettings(s => ({ ...s, followUsersMax: clamp4(Number(e.target.value)) }))}
                  disabled={fieldDisabled("followUsersMax")} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none pb-1">
              <input
                type="checkbox"
                checked={settings.followSpreadFollows}
                onChange={e => setSettings(s => ({ ...s, followSpreadFollows: e.target.checked }))}
                disabled={fieldDisabled("followSpreadFollows")}
                className="w-4 h-4 accent-primary rounded"
              />
              <span className="text-foreground font-medium">Spread Follows</span>
            </label>
          </div>

        </div>}

        {/* ── Surplus panel (toggled via the Surplus button above) ────── */}
        <div className={showSurplus
          ? "absolute inset-x-0 bottom-0 top-[2.75rem] z-30 overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-xl"
          : "hidden"}>
          {showSurplus && (
            <div className="border border-border rounded-lg overflow-hidden">
              {loadingOverspill && mobileOverspillList.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">Loading…</p>
              ) : mobileOverspillList.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">No surplus candidates yet — leftover HikerAPI candidates will appear here after the first Follow cycle.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Username</th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Source</th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Scraped at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mobileOverspillList.map((u) => (
                        <tr key={u.id} className="border-t border-border">
                          <td className="px-3 py-1.5 text-foreground">@{u.instagramUsername}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{u.sourceValue || '—'}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{new Date(u.scrapedAt).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Followed Users panel (toggled via the Followed button above) */}
        <div className={showFollowedUsers
          ? "absolute inset-x-0 bottom-0 top-[2.75rem] z-30 overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-xl"
          : "hidden"}>
          {showFollowedUsers && (
            <div className="border border-border rounded-lg overflow-hidden">
              {loadingFollowed ? (
                <p className="text-xs text-muted-foreground p-3">Loading…</p>
              ) : mobileFollowedList.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">No users followed in this server session yet.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Username</th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Source</th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Followed at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mobileFollowedList.map((u, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-1.5 text-foreground">
                            <button type="button" className="hover:underline" onClick={() => onOpenBrowserProfile?.(u.username)}>
                              @{u.username}
                            </button>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">{u.source ?? '—'}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{new Date(u.followedAt).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Target Sources panel (toggled via the Sources button above) ─ */}
        <div className={showSources
          ? "absolute inset-x-0 bottom-0 top-[2.75rem] z-30 overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-xl"
          : "hidden"}>
          {showSources && (
            <div className="border border-border rounded-lg p-3 space-y-2">
              {/* Hidden file input for CSV/TSV import */}
              <input
                ref={importSourceFileRef}
                type="file"
                accept=".csv,.tsv,.txt"
                className="hidden"
                onChange={handleImportFollowSources}
              />

              {/* Header row: count + Import / Export / Clear all */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground flex-1">
                  {settings.followSources.length} source{settings.followSources.length !== 1 ? 's' : ''}
                </span>
                <Button
                  variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1 shrink-0"
                  onClick={() => importSourceFileRef.current?.click()}
                  disabled={fieldDisabled("followSources")}
                >
                  <Upload className="w-3 h-3" /> Import
                </Button>
                <Button
                  variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1 shrink-0"
                  onClick={handleExportFollowSources}
                  disabled={fieldDisabled("followSources") || !settings.followSources.length}
                >
                  <Download className="w-3 h-3" /> Export
                </Button>
                {settings.followSources.length > 0 && (
                  <Button
                    variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive shrink-0"
                    disabled={fieldDisabled("followSources")}
                    onClick={() => setSettings(s => ({ ...s, followSources: [] }))}
                  >Clear all</Button>
                )}
              </div>

              {/* Sources list — max 10 rows visible, scrollable */}
              {settings.followSources.length > 0 ? (
                <div className="space-y-1 max-h-[260px] overflow-y-auto pr-0.5">
                  {settings.followSources.map((src, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono shrink-0">
                        {src.type === 'hashtag' ? '#' : '@'}
                      </span>
                      <span className="flex-1 text-foreground truncate">{src.value}</span>
                      <button
                        onClick={() => setSettings(s => ({ ...s, followSources: s.followSources.filter((_, j) => j !== i) }))}
                        disabled={fieldDisabled("followSources")}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      >✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No sources yet. Import a CSV or add manually below.</p>
              )}

              {/* Add new source */}
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={newFollowSourceType}
                  onChange={e => setNewFollowSourceType(e.target.value as 'hashtag' | 'target_followers')}
                  disabled={fieldDisabled("followSources")}
                  className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground cursor-pointer"
                >
                  <option value="hashtag">Hashtag</option>
                  <option value="target_followers">Followers of Account</option>
                </select>
                <Input
                  className="flex-1 min-w-0 text-xs h-8"
                  placeholder={newFollowSourceType === 'hashtag' ? 'e.g. fitness' : 'e.g. @username'}
                  value={newFollowSourceValue}
                  onChange={e => setNewFollowSourceValue(e.target.value)}
                  disabled={fieldDisabled("followSources")}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newFollowSourceValue.trim()) {
                      const val = newFollowSourceValue.trim().replace(/^[@#]/, '');
                      if (val) {
                        setSettings(s => ({ ...s, followSources: [...s.followSources, { type: newFollowSourceType, value: val }] }));
                        setNewFollowSourceValue('');
                      }
                    }
                  }}
                />
                <Button
                  variant="outline" size="sm" className="h-8 text-xs shrink-0"
                  disabled={fieldDisabled("followSources") || !newFollowSourceValue.trim()}
                  onClick={() => {
                    const val = newFollowSourceValue.trim().replace(/^[@#]/, '');
                    if (val) {
                      setSettings(s => ({ ...s, followSources: [...s.followSources, { type: newFollowSourceType, value: val }] }));
                      setNewFollowSourceValue('');
                    }
                  }}
                >Add</Button>
              </div>
            </div>
          )}
        </div>

        {/* ── Inject Browsing — templates can configure it before enabling Follow Users ── */}
        {(settings.followEnabled || isTrustScoreTemplateEditor) && <div className="space-y-3">
          {/* Row 1: title + checkbox only */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id={`inject-browsing-enabled-${slotIdx ?? 0}`}
              checked={settings.injectBrowsingEnabled}
              onChange={e => setSettings(s => ({ ...s, injectBrowsingEnabled: e.target.checked }))}
              disabled={fieldDisabled("injectBrowsingEnabled") || (!settings.followEnabled && !isTrustScoreTemplateEditor)}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`inject-browsing-enabled-${slotIdx ?? 0}`} className={`text-sm font-semibold cursor-pointer select-none ${settings.followEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>Inject Browsing</label>
          </div>

          {settings.injectBrowsingEnabled && (<>
          {/* Row 2: Activate Percentage (first field) / Browse before follow / Feed chance / Feed posts / Click posts % */}
          <div className="flex items-start flex-wrap gap-6">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingActivatePctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingActivatePctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingActivatePctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingActivatePctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Browse before follow %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingBeforeFollowPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingBeforeFollowPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingBeforeFollowPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingBeforeFollowPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Tap Highlights %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingTapHighlightsPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingTapHighlightsPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingTapHighlightsPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingTapHighlightsPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Feed posts</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Click posts %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingClickPostPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingClickPostPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingClickPostPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingClickPostPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Like %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingLikePctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingLikePctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingLikePctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingLikePctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Share feed %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareFeedPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareFeedPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareFeedPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareFeedPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Share to DM %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareDmPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareDmPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareDmPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareDmPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
          </div>
          <div className="flex items-start flex-wrap gap-6 mt-[10px]">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground block text-center">Abandon Follow %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingAbandonFollowPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingAbandonFollowPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingAbandonFollowPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingAbandonFollowPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
          </div>
          </>)}

          {/* ── Filters — profile-quality gates applied before each follow ── */}
          {(settings.followEnabled || isTrustScoreTemplateEditor) && <div className="flex items-center gap-3" style={{ paddingTop: "6px" }}>
            <input
              type="checkbox"
              id={`follow-filters-enabled-${slotIdx ?? 0}`}
              checked={settings.followFiltersEnabled}
              onChange={e => setSettings(s => ({ ...s, followFiltersEnabled: e.target.checked }))}
              disabled={fieldDisabled("followFiltersEnabled") || (!settings.followEnabled && !isTrustScoreTemplateEditor)}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`follow-filters-enabled-${slotIdx ?? 0}`} className={`text-sm font-semibold cursor-pointer select-none ${settings.followEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>Filters</label>
          </div>}

          {settings.followFiltersEnabled && (
            <div className="flex items-center gap-6 flex-wrap" style={{ paddingTop: "5px" }}>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-private-users-${slotIdx ?? 0}`}
                  checked={settings.followFilterPrivateUsers}
                  onChange={e => setSettings(s => ({ ...s, followFilterPrivateUsers: e.target.checked }))}
                  disabled={fieldDisabled("followFilterPrivateUsers")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-private-users-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Private Users</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-english-speaking-${slotIdx ?? 0}`}
                  checked={settings.followFilterEnglishSpeaking}
                  onChange={e => setSettings(s => ({ ...s, followFilterEnglishSpeaking: e.target.checked }))}
                  disabled={fieldDisabled("followFilterEnglishSpeaking")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-english-speaking-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">English Speaking</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-min-followers-250-${slotIdx ?? 0}`}
                  checked={settings.followFilterMinFollowers50}
                  onChange={e => setSettings(s => ({ ...s, followFilterMinFollowers50: e.target.checked }))}
                  disabled={fieldDisabled("followFilterMinFollowers50")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-min-followers-250-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">50 Followers+</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-verified-users-${slotIdx ?? 0}`}
                  checked={settings.followFilterVerifiedUsers}
                  onChange={e => setSettings(s => ({ ...s, followFilterVerifiedUsers: e.target.checked }))}
                  disabled={fieldDisabled("followFilterVerifiedUsers")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-verified-users-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Skip Verified</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-max-followers-25k-${slotIdx ?? 0}`}
                  checked={settings.followFilterMaxFollowers25k}
                  onChange={e => setSettings(s => ({ ...s, followFilterMaxFollowers25k: e.target.checked }))}
                  disabled={fieldDisabled("followFilterMaxFollowers25k")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-max-followers-25k-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">-25K Followers</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`filter-males-only-${slotIdx ?? 0}`}
                  checked={settings.followFilterMalesOnly}
                  onChange={e => setSettings(s => ({ ...s, followFilterMalesOnly: e.target.checked }))}
                  disabled={fieldDisabled("followFilterMalesOnly")}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor={`filter-males-only-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Males Only</label>
                <button
                  type="button"
                  title="Edit allowed names"
                  aria-label="Edit allowed names"
                  className="inline-flex items-center justify-center rounded p-1 text-primary hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
                  disabled={fieldDisabled("followFilterMaleNames")}
                  onClick={() => {
                    setMaleNamesDraft(settings.followFilterMaleNames);
                    setMaleNamesEditorOpen(true);
                  }}
                >
                  <ClipboardList className="h-4 w-4" />
                </button>
              </div>
              <Dialog open={maleNamesEditorOpen} onOpenChange={setMaleNamesEditorOpen}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Allowed male names</DialogTitle>
                  </DialogHeader>
                  <p className="text-xs text-muted-foreground">
                    Enter comma-separated names. A profile passes when a name appears anywhere in its username, name, or bio.
                  </p>
                  <textarea
                    autoFocus
                    rows={5}
                    value={maleNamesDraft}
                    onChange={e => setMaleNamesDraft(e.target.value)}
                    className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="daniel,james,steven"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => setMaleNamesEditorOpen(false)}>Cancel</button>
                    <button
                      type="button"
                      className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                      onClick={() => {
                        setSettings(s => ({ ...s, followFilterMaleNames: maleNamesDraft }));
                        setMaleNamesEditorOpen(false);
                      }}
                    >
                      Save
                    </button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
           )}
         </div>}
         {/* This separator is the stable bottom boundary for the Follow
             Users overlays, even as the settings above change height. */}
         <div className="border-t border-border" />
        </div>

        {/* ── Random Actions — probabilistic human-like actions each cycle ─ */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`random-jitter-enabled-${slotIdx ?? 0}`}
              checked={settings.randomJitterEnabled}
              onChange={e => setSettings(s => ({ ...s, randomJitterEnabled: e.target.checked }))}
              disabled={fieldDisabled("randomJitterEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`random-jitter-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">Random Actions</label>
          </div>

          {settings.randomJitterEnabled && (
            <div className="space-y-3">
            <div className="flex items-start flex-wrap gap-6">

              {/* ── Activate % ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Activate %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.randomJitterActivatePctMin}
                    onChange={e => setSettings(s => ({ ...s, randomJitterActivatePctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.randomJitterActivatePctMax}
                    onChange={e => setSettings(s => ({ ...s, randomJitterActivatePctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Notifications ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Notifications %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsPctMin}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsPctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsPctMax}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsPctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Scrolls ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Scrolls</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsScrollsMin}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsScrollsMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsScrollsMax}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsScrollsMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Click % ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Click %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsClickPctMin}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsClickPctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.checkNotificationsClickPctMax}
                    onChange={e => setSettings(s => ({ ...s, checkNotificationsClickPctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Visit Profile ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Visit Profile %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitProfilePctMin}
                    onChange={e => setSettings(s => ({ ...s, visitProfilePctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitProfilePctMax}
                    onChange={e => setSettings(s => ({ ...s, visitProfilePctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Visit Saved ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Visit Saved %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitSavedPctMin}
                    onChange={e => setSettings(s => ({ ...s, visitSavedPctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitSavedPctMax}
                    onChange={e => setSettings(s => ({ ...s, visitSavedPctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── Visit Random Settings ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">Visit Random Settings %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitSettingsPctMin}
                    onChange={e => setSettings(s => ({ ...s, visitSettingsPctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.visitSettingsPctMax}
                    onChange={e => setSettings(s => ({ ...s, visitSettingsPctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

              {/* ── App Switch ── */}
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground block text-center">App Switch %</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.appSwitchPctMin}
                    onChange={e => setSettings(s => ({ ...s, appSwitchPctMin: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.appSwitchPctMax}
                    onChange={e => setSettings(s => ({ ...s, appSwitchPctMax: clamp4(Number(e.target.value)) }))}
                    disabled={loading} />
                </div>
              </div>

            </div>

            {/* ── Update Avatar + Update Bio ── */}
            <div className="flex items-end gap-2 flex-nowrap" style={{ marginTop: "20px" }}>
              <div className="space-y-1.5 shrink-0">
                <span className="text-sm text-muted-foreground select-none">Update Avatar&nbsp;&nbsp;Activation %</span>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.updateProfilePicActivatePctMin}
                    onChange={e => setSettings(s => ({ ...s, updateProfilePicActivatePctMin: clamp4(Number(e.target.value)) }))}
                    disabled={fieldDisabled("updateProfilePicActivatePctMin")} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.updateProfilePicActivatePctMax}
                    onChange={e => setSettings(s => ({ ...s, updateProfilePicActivatePctMax: clamp4(Number(e.target.value)) }))}
                    disabled={fieldDisabled("updateProfilePicActivatePctMax")} />
                  <button
                    type="button"
                    disabled={fieldDisabled("updateProfilePicFolderPath")}
                    onClick={async () => {
                      const api = (window as any).electronAPI;
                      if (!api?.openFolderDialog) return;
                      const result = await api.openFolderDialog(settings.updateProfilePicFolderPath || undefined);
                      if (result?.canceled || !result?.folder) return;
                      const updatedSettings = { ...settings, updateProfilePicFolderPath: result.folder };
                      setSettings(() => updatedSettings);
                      if (phone && slotIdx !== undefined) {
                        fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/profile-pic-folder-path`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path: result.folder }),
                        }).catch(() => {});
                      } else if (phone) {
                        fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/automation-settings`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(updatedSettings),
                        }).catch(() => {});
                      }
                    }}
                    className="h-7 px-3 text-xs rounded border border-border bg-background hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium text-foreground text-center justify-center"
                    style={{ width: "76px" }}
                  >
                    Assign
                  </button>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      id={`update-profile-pic-disable-after-used-${slotIdx ?? 0}`}
                      checked={settings.updateProfilePicDisableAfterUsed}
                      onChange={e => setSettings(s => ({ ...s, updateProfilePicDisableAfterUsed: e.target.checked }))}
                       disabled={fieldDisabled("updateProfilePicDisableAfterUsed")}
                      className="w-4 h-4 accent-primary cursor-pointer"
                    />
                    <label htmlFor={`update-profile-pic-disable-after-used-${slotIdx ?? 0}`} className="text-xs text-foreground cursor-pointer select-none">Disable After Used</label>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 shrink-0">
                <span className="text-sm text-muted-foreground select-none">Update Bio&nbsp;&nbsp;Activation %</span>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.updateBioActivatePctMin}
                    onChange={e => setSettings(s => ({ ...s, updateBioActivatePctMin: clamp4(Number(e.target.value)) }))}
                     disabled={fieldDisabled("updateBioActivatePctMin")} />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                    value={settings.updateBioActivatePctMax}
                    onChange={e => setSettings(s => ({ ...s, updateBioActivatePctMax: clamp4(Number(e.target.value)) }))}
                     disabled={fieldDisabled("updateBioActivatePctMax")} />
                  <button
                    type="button"
                    onClick={() => {
                      setBioSpinDraft(settings.updateBioText);
                      setBioSpinEditorOpen(true);
                    }}
                    disabled={fieldDisabled("updateBioText")}
                    className="h-7 px-3 text-xs rounded border border-border bg-background hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium text-foreground text-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ width: "76px" }}
                  >
                    Bio Spin
                  </button>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      id={`update-bio-disable-after-used-${slotIdx ?? 0}`}
                      checked={settings.updateBioDisableAfterUsed}
                      onChange={e => setSettings(s => ({ ...s, updateBioDisableAfterUsed: e.target.checked }))}
                       disabled={fieldDisabled("updateBioDisableAfterUsed")}
                      className="w-4 h-4 accent-primary cursor-pointer"
                    />
                    <label htmlFor={`update-bio-disable-after-used-${slotIdx ?? 0}`} className="text-xs text-foreground cursor-pointer select-none">Disable After Used</label>
                  </div>
                </div>
              </div>
            </div>

            </div>
          )}
        </div>

        {/* ── Make a Post — ported from the old browser-automation tool's
             "Make a Post" settings (13 Jul 2026). Config/persistence only:
             there is no phone gallery-picker / IG composer automation wired
             up yet, this just saves the settings for when that's built. ─ */}
        <div className="border-t border-border" />

        <div className="space-y-3 relative">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`make-a-post-enabled-${slotIdx ?? 0}`}
              checked={settings.makePostEnabled}
              onChange={e => setSettings(s => ({ ...s, makePostEnabled: e.target.checked }))}
              disabled={fieldDisabled("makePostEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`make-a-post-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">Make a Post</label>
            <Button
              variant="outline" size="sm"
              className="h-7 text-xs px-3 ml-auto gap-1.5"
              onClick={() => { setShowPostedMedia(v => !v); if (!showPostedMedia) loadPostedMedia(); }}
              disabled={loadingExternal}
            ><ImagePlus className="w-3.5 h-3.5" />{showPostedMedia ? 'Hide' : 'Posted Media'}</Button>
          </div>

          {settings.makePostEnabled && (
            <div className="pl-1 space-y-4">
              {/* Activate Percentage / Order % / Skip Chance % / Posts per session */}
              <div className="flex items-start gap-8 flex-wrap">
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                      value={settings.makePostActivatePctMin}
                      onChange={e => setSettings(s => ({ ...s, makePostActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                      disabled={loading} />
                    <span className="text-muted-foreground text-sm">to</span>
                    <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                      value={settings.makePostActivatePctMax}
                      onChange={e => setSettings(s => ({ ...s, makePostActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                      disabled={loading} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground block text-center">Posts per session</Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" min={1} max={20} maxLength={4} className={NUM_INPUT_CLASS}
                      value={settings.makePostPerSessionMin}
                      onChange={e => setSettings(s => ({ ...s, makePostPerSessionMin: clamp4(Number(e.target.value)) }))}
                      disabled={loading} />
                    <span className="text-muted-foreground text-sm">to</span>
                    <Input type="number" min={1} max={20} maxLength={4} className={NUM_INPUT_CLASS}
                      value={settings.makePostPerSessionMax}
                      onChange={e => setSettings(s => ({ ...s, makePostPerSessionMax: clamp4(Number(e.target.value)) }))}
                      disabled={loading} />
                  </div>
                </div>
              </div>

              {/* My Computer directory — configured independently per slot. */}
              <div className="border border-border/60 rounded-lg p-3 space-y-2">
                <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {!isTrustScoreTemplateEditor && <button
                        type="button"
                        disabled={fieldDisabled("makePostLocalFolderPath")}
                        onClick={async () => {
                          const api = (window as any).electronAPI;
                          if (!api?.openFolderDialog) return;
                          // Pass the currently-assigned path as the defaultPath so
                          // the native dialog opens there instead of Desktop.
                          const result = await api.openFolderDialog(settings.makePostLocalFolderPath || undefined);
                          if (result?.canceled || !result?.folder) return;
                          const updatedSettings = { ...settings, makePostLocalFolderPath: result.folder };
                          setSettings(() => updatedSettings);
                          if (phone && slotIdx !== undefined) {
                            // Primary save: dedicated folder-path endpoint — this is the
                            // authoritative store, immune to Copy Settings and autosave races.
                            // It also patches mobile-instances.json as a secondary backup.
                            fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/folder-path`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ path: result.folder }),
                            }).catch(() => {});
                          } else if (phone) {
                            // Fallback for the rare case where slotIdx is undefined.
                            const saveUrl = `/api/mobile/devices/${encodeURIComponent(phone.serial)}/automation-settings`;
                            fetch(saveUrl, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(updatedSettings),
                            }).catch(() => {});
                          }
                        }}
                        className="h-7 px-3 text-xs rounded border border-border bg-background hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium text-foreground"
                      >
                        {settings.makePostLocalFolderPath ? "Assigned Directory" : "Browse"}
                      </button>}
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id={`make-a-post-local-no-repeat-${slotIdx ?? 0}`}
                          checked={settings.makePostLocalFolderNoRepeat}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderNoRepeat: e.target.checked }))}
                          disabled={fieldDisabled("makePostLocalFolderNoRepeat")}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor={`make-a-post-local-no-repeat-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Don't use same images</label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id={`make-a-post-local-random-${slotIdx ?? 0}`}
                          checked={settings.makePostLocalFolderRandom}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderRandom: e.target.checked }))}
                          disabled={fieldDisabled("makePostLocalFolderRandom")}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor={`make-a-post-local-random-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Pick randomly</label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id={`make-a-post-disable-exhausted-${slotIdx ?? 0}`}
                          checked={settings.makePostDisableWhenExhausted}
                          onChange={e => setSettings(s => ({ ...s, makePostDisableWhenExhausted: e.target.checked }))}
                          disabled={loading}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor={`make-a-post-disable-exhausted-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Stop if folders empty</label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id={`make-a-post-local-delete-after-use-${slotIdx ?? 0}`}
                          checked={settings.makePostLocalFolderDeleteAfterUpload}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderDeleteAfterUpload: e.target.checked }))}
                          disabled={fieldDisabled("makePostLocalFolderDeleteAfterUpload")}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor={`make-a-post-local-delete-after-use-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Delete after use</label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id={`make-a-post-add-location-${slotIdx ?? 0}`}
                          checked={settings.makePostAddLocation}
                          onChange={e => setSettings(s => ({ ...s, makePostAddLocation: e.target.checked }))}
                          disabled={fieldDisabled("makePostAddLocation")}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor={`make-a-post-add-location-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Add location</label>
                      </div>
                    </div>

                </div>
              </div>

              {showPostedMedia && (
                <div className="absolute inset-x-0 bottom-0 top-[2.75rem] z-30 flex min-h-[320px] flex-col rounded-lg border border-border bg-background shadow-xl">
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <ImagePlus className="h-4 w-4 text-primary shrink-0" />
                    <span className="text-sm font-semibold text-foreground">Posted Media</span>
                    <span className="text-xs text-muted-foreground">
                      {postedMediaEntries.length} profile post{postedMediaEntries.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {postedMediaEntries.length > 0 ? (
                      <div className="space-y-2">
                        {postedMediaEntries.map(entry => (
                          <div key={entry.id} className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/20 p-2">
                            <div className="h-[150px] w-[150px] shrink-0 overflow-hidden rounded-md border border-border bg-muted/30">
                              {entry.thumbnailUrl ? (
                                <img
                                  src={entry.thumbnailUrl}
                                  alt={entry.filename}
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center p-2 text-center text-[10px] text-muted-foreground">
                                  Thumbnail unavailable
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 space-y-1">
                              <p className="truncate text-xs font-mono text-foreground" title={entry.filename}>{entry.filename}</p>
                              <p className="text-xs text-muted-foreground">{new Date(entry.postedAt).toLocaleString()}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : loadingPostedMedia ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No profile posts have been made from this account yet.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Caption */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="text-xs text-muted-foreground font-semibold">Post Caption Text</Label>
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" id={`make-a-post-use-chatgpt-${slotIdx ?? 0}`}
                      checked={settings.makePostUseChatGpt}
                      onChange={e => setSettings(s => ({ ...s, makePostUseChatGpt: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor={`make-a-post-use-chatgpt-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Use ChatGPT</label>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  Supports multi-level spin syntax, e.g. {"{hello|hi|hey}"}. Leave blank to use the original post's caption.
                </p>
                <textarea
                  className="w-full text-xs font-mono resize-none h-[72px] leading-relaxed rounded-md border border-input bg-transparent px-3 py-2"
                  rows={3}
                  value={settings.makePostCaptionText}
                  onChange={e => setSettings(s => ({ ...s, makePostCaptionText: e.target.value }))}
                  disabled={loading}
                />
                {/* Image alteration — applies to whichever source produced the image.
                    Each control has its own enable checkbox on the LEFT of its
                    associated controls, all on one row. */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  {/* Alteration level — checkbox left of Small/Medium/High */}
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id={`make-a-post-alteration-enabled-${slotIdx ?? 0}`}
                      checked={settings.makePostAlterationEnabled}
                      onChange={e => setSettings(s => ({ ...s, makePostAlterationEnabled: e.target.checked }))}
                      disabled={fieldDisabled("makePostAlterationEnabled")}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <label htmlFor={`make-a-post-alteration-enabled-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">Alteration level</label>
                    <div className="flex gap-1">
                      {(["small", "medium", "high"] as const).map(lvl => (
                        <button key={lvl} type="button" disabled={fieldDisabled("makePostAlterationLevel") || !settings.makePostAlterationEnabled}
                          onClick={() => setSettings(s => ({ ...s, makePostAlterationLevel: lvl }))}
                          className={`h-8 px-3 text-xs rounded border transition-colors capitalize ${
                            !settings.makePostAlterationEnabled
                              ? "bg-background border-border text-muted-foreground/40 cursor-not-allowed"
                              : settings.makePostAlterationLevel === lvl
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          }`}
                        >{lvl}</button>
                      ))}
                    </div>
                  </div>
                  {/* Image settings — checkbox left of Configure button */}
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id={`make-a-post-image-settings-enabled-${slotIdx ?? 0}`}
                      checked={settings.makePostImageSettingsEnabled}
                      onChange={e => setSettings(s => ({ ...s, makePostImageSettingsEnabled: e.target.checked }))}
                      disabled={fieldDisabled("makePostImageSettingsEnabled")}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <label htmlFor={`make-a-post-image-settings-enabled-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">Image settings</label>
                    <button type="button" disabled={fieldDisabled("makePostImageSettings") || !settings.makePostImageSettingsEnabled}
                      onClick={() => setMakePostImageSettingsOpen(true)}
                      className={`h-8 px-3 text-xs rounded border transition-colors ${
                        settings.makePostImageSettingsEnabled
                          ? "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          : "bg-background border-border text-muted-foreground/40 cursor-not-allowed"
                      }`}
                    >Configure</button>
                  </div>
                  {/* Fix AI Slop */}
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" id={`make-a-post-fix-ai-slop-${slotIdx ?? 0}`}
                      checked={settings.makePostFixAiSlop}
                      onChange={e => setSettings(s => ({ ...s, makePostFixAiSlop: e.target.checked }))}
                      disabled={fieldDisabled("makePostFixAiSlop")}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor={`make-a-post-fix-ai-slop-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">Fix AI Slop</label>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <ImageSettingsDialog
          open={makePostImageSettingsOpen}
          onClose={() => setMakePostImageSettingsOpen(false)}
          settings={settings.makePostImageSettings}
          alterationLevel={settings.makePostAlterationLevel}
          onSave={saved => setSettings(s => ({ ...s, makePostImageSettings: saved }))}
        />

        {/* ── Post a Story — standalone Story publisher. The directory is
             persisted per physical device/account slot; the behavioral
             settings are inherited from and copyable with Trust Scores. ─ */}
        <div className="border-t border-border" />
        <div className="space-y-3 relative">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`post-a-story-enabled-${slotIdx ?? 0}`}
              checked={settings.postStoryEnabled}
              onChange={e => setSettings(s => ({ ...s, postStoryEnabled: e.target.checked }))}
              disabled={fieldDisabled("postStoryEnabled")}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor={`post-a-story-enabled-${slotIdx ?? 0}`} className="text-sm font-semibold text-foreground cursor-pointer select-none">
              Post a Story
            </label>
          </div>

          {settings.postStoryEnabled && (
            <div className="pl-1 space-y-4">
              {/* Keep activation and Story media controls on one shared row in
                  both the live HST and the TrustScore template editor. */}
              <div className="border border-border/60 rounded-lg p-3">
                <div className="flex items-center flex-wrap gap-x-5 gap-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm text-muted-foreground block text-center">Activate Percentage</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                        value={settings.postStoryActivatePctMin}
                        onChange={e => setSettings(s => ({ ...s, postStoryActivatePctMin: Math.min(100, clamp4(Number(e.target.value))) }))}
                        disabled={fieldDisabled("postStoryActivatePctMin")}
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS}
                        value={settings.postStoryActivatePctMax}
                        onChange={e => setSettings(s => ({ ...s, postStoryActivatePctMax: Math.min(100, clamp4(Number(e.target.value))) }))}
                        disabled={fieldDisabled("postStoryActivatePctMax")}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-center">
                    <button
                      type="button"
                      disabled={fieldDisabled("postStoryLocalFolderPath")}
                      onClick={async () => {
                        const api = (window as any).electronAPI;
                        if (!api?.openFolderDialog) return;
                        const result = await api.openFolderDialog(settings.postStoryLocalFolderPath || undefined);
                        if (result?.canceled || !result?.folder) return;
                        const updatedSettings = { ...settings, postStoryLocalFolderPath: result.folder };
                        setSettings(() => updatedSettings);
                        if (phone && slotIdx !== undefined) {
                          fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/post-story-folder-path`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ path: result.folder }),
                          }).catch(() => {});
                        } else if (phone) {
                          fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/automation-settings`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(updatedSettings),
                          }).catch(() => {});
                        }
                      }}
                      className="h-7 px-3 text-xs rounded border border-border bg-background hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {settings.postStoryLocalFolderPath ? "Assigned Directory" : "Browse"}
                    </button>
                    {settings.postStoryLocalFolderPath && (
                      <span className="max-w-[280px] truncate text-xs text-muted-foreground" title={settings.postStoryLocalFolderPath}>
                        {settings.postStoryLocalFolderPath}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`post-a-story-local-no-repeat-${slotIdx ?? 0}`}
                      checked={settings.postStoryLocalFolderNoRepeat}
                      onChange={e => setSettings(s => ({ ...s, postStoryLocalFolderNoRepeat: e.target.checked }))}
                      disabled={fieldDisabled("postStoryLocalFolderNoRepeat")}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor={`post-a-story-local-no-repeat-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">
                      Don't use same images
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`post-a-story-local-random-${slotIdx ?? 0}`}
                      checked={settings.postStoryLocalFolderRandom}
                      onChange={e => setSettings(s => ({ ...s, postStoryLocalFolderRandom: e.target.checked }))}
                      disabled={fieldDisabled("postStoryLocalFolderRandom")}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor={`post-a-story-local-random-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">
                      Pick randomly
                    </label>
                  </div>
                </div>
              </div>

              {/* Link is the only Post a Story setting owned by the physical
                  HST account slot. It is intentionally not part of the
                  TrustScore template settings. */}
              <div className="flex w-full items-center gap-3">
                <input
                  type="checkbox"
                  id={`post-a-story-add-link-${slotIdx ?? 0}`}
                  checked={settings.postStoryAddLink}
                  onChange={e => setSettings(s => ({ ...s, postStoryAddLink: e.target.checked }))}
                  disabled={fieldDisabled("postStoryAddLink")}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                />
                <label htmlFor={`post-a-story-add-link-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">
                  Add Link
                </label>
                <Input
                  type="url"
                  value={settings.postStoryLinkUrl}
                  onChange={e => setSettings(s => ({ ...s, postStoryLinkUrl: e.target.value }))}
                  disabled={fieldDisabled("postStoryLinkUrl") || !settings.postStoryAddLink}
                  placeholder="https://example.com"
                  aria-label="Post a Story link URL"
                  className="h-8 min-w-0 flex-1 w-full"
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`post-a-story-alteration-enabled-${slotIdx ?? 0}`}
                    checked={settings.postStoryAlterationEnabled}
                    onChange={e => setSettings(s => ({ ...s, postStoryAlterationEnabled: e.target.checked }))}
                    disabled={fieldDisabled("postStoryAlterationEnabled")}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor={`post-a-story-alteration-enabled-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">
                    Alteration level
                  </label>
                  <div className="flex gap-1">
                    {(["small", "medium", "high"] as const).map(lvl => (
                      <button
                        key={lvl}
                        type="button"
                        disabled={fieldDisabled("postStoryAlterationLevel") || !settings.postStoryAlterationEnabled}
                        onClick={() => setSettings(s => ({ ...s, postStoryAlterationLevel: lvl }))}
                        className={`h-8 px-3 text-xs rounded border transition-colors capitalize ${
                          !settings.postStoryAlterationEnabled
                            ? "bg-background border-border text-muted-foreground/40 cursor-not-allowed"
                            : settings.postStoryAlterationLevel === lvl
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`post-a-story-image-settings-enabled-${slotIdx ?? 0}`}
                    checked={settings.postStoryImageSettingsEnabled}
                    onChange={e => setSettings(s => ({ ...s, postStoryImageSettingsEnabled: e.target.checked }))}
                    disabled={fieldDisabled("postStoryImageSettingsEnabled")}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor={`post-a-story-image-settings-enabled-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">
                    Image settings
                  </label>
                  <button
                    type="button"
                    disabled={fieldDisabled("postStoryImageSettings") || !settings.postStoryImageSettingsEnabled}
                    onClick={() => setPostStoryImageSettingsOpen(true)}
                    className={`h-8 px-3 text-xs rounded border transition-colors ${
                      settings.postStoryImageSettingsEnabled
                        ? "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        : "bg-background border-border text-muted-foreground/40 cursor-not-allowed"
                    }`}
                  >
                    Configure
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    id={`post-a-story-fix-ai-slop-${slotIdx ?? 0}`}
                    checked={settings.postStoryFixAiSlop}
                    onChange={e => setSettings(s => ({ ...s, postStoryFixAiSlop: e.target.checked }))}
                    disabled={fieldDisabled("postStoryFixAiSlop")}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor={`post-a-story-fix-ai-slop-${slotIdx ?? 0}`} className="text-xs text-muted-foreground cursor-pointer select-none">
                    Fix AI Slop
                  </label>
                </div>

              </div>
            </div>
          )}
        </div>

        <ImageSettingsDialog
          open={postStoryImageSettingsOpen}
          onClose={() => setPostStoryImageSettingsOpen(false)}
          settings={settings.postStoryImageSettings}
          alterationLevel={settings.postStoryAlterationLevel}
          onSave={saved => setSettings(s => ({ ...s, postStoryImageSettings: saved }))}
        />

      </div>

      {/* Final Step */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-2">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">(FINAL STEP)</p>
        <p className="text-sm text-foreground">
          Close the Instagram app and Airplane Mode will be activated for 15–20 seconds, then Airplane Mode will be turned off.
        </p>
      </div>

      {/* Copy Settings dialog — Dialog renders as a portal outside the scroll div */}
      {slotIdx !== undefined && slotUsernames && (
        <CopySettingsDialog
          open={showCopyDialogResolved}
          onClose={() => setShowCopyDialogResolved(false)}
          currentSlotIdx={slotIdx}
          slotUsernames={slotUsernames}
          settings={settings}
          phone={phone}
          onCopied={onCopied}
        />
      )}

      {/* Bio Spin editor — keep the spin text out of the normal Random Actions row. */}
      <Dialog open={bioSpinEditorOpen} onOpenChange={setBioSpinEditorOpen}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-[35rem] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Bio Spin</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Enter bio spin text</Label>
            <textarea
              autoFocus
              rows={5}
              value={bioSpinDraft}
              onChange={e => {
                const value = e.target.value;
                setBioSpinDraft(value);
                setSettings(s => ({ ...s, updateBioText: value }));
              }}
              disabled={fieldDisabled("updateBioText")}
              placeholder="Enter bio text or spin syntax"
              className="box-border min-h-[7.5rem] w-full max-w-full resize-y overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="text-[10px] text-muted-foreground/70">
              Up to 5 lines; each line becomes a line break in the Instagram bio. Supports spin syntax such as {"{hello|hi|hey}"}.
            </p>
          </div>
          {spinPreview !== null && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label className="text-xs font-medium">Randomized version</Label>
                <span className="text-[10px] text-muted-foreground">This is what will be used</span>
              </div>
              <p className="min-h-[3.5rem] whitespace-pre-wrap break-words text-sm leading-relaxed">
                {spinPreview}
              </p>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={fieldDisabled("updateBioText") || !bioSpinDraft.trim()}
              onClick={() => {
                // Spin is always preview-only. The original text remains in
                // the textarea until the user explicitly chooses Use this
                // version.
                setSpinPreview(resolveSpinSyntax(bioSpinDraft));
              }}
              className="h-8 px-4 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Spin
            </button>
            {spinPreview !== null && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(spinPreview).catch(() => {})}
                className="h-8 px-4 text-xs rounded border border-border bg-background hover:bg-accent transition-colors font-medium"
              >
                Copy
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Slot-level Trust Score badge ─────────────────────────────────────────────
// Stored in the local database per device/slot. localStorage remains a small
// compatibility cache for offline rendering and migration from older builds.
const ROW_H = 30; // px per dropdown row
const MAX_VISIBLE_ROWS = 5;

function SlotTrustScoreBadge({ serial, slotIdx, width: badgeWidth = 142, hideIcon = false }: { serial: string; slotIdx: number; width?: number; hideIcon?: boolean }) {
  const lsKey = slotTrustScoreKey(serial, slotIdx);
  const [scoreId, setScoreId] = useState<string | null>(() => {
    return readLocalSlotTrustScore(serial, slotIdx);
  });
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const levels: TrustLevelEntry[] = getTrustLevels();
  const current = levels.find(l => l.id === scoreId) ?? null;

  useEffect(() => {
    let active = true;
    loadSlotTrustScore(serial, slotIdx).then(id => {
      if (active) setScoreId(id);
    });
    return () => { active = false; };
  }, [serial, slotIdx]);

  const save = async (id: string | null) => {
    setScoreId(id);
    setOpen(false);
    try {
      await saveSlotTrustScore(serial, slotIdx, id, levels.findIndex(level => level.id === id) < levels.length - 1);
    } catch {
      // Keep the optimistic UI/cache value. The next hydration will retry the
      // server read and the user can choose the value again if needed.
    }
  };

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === lsKey) setScoreId(e.newValue ?? null);
    };
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ serial?: string; slotIdx?: number; scoreId?: string | null }>).detail;
      if (detail?.serial === serial && detail.slotIdx === slotIdx) setScoreId(detail.scoreId ?? null);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("mobile_trustscore_changed", onChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("mobile_trustscore_changed", onChanged);
    };
  }, [lsKey, serial, slotIdx]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Keep the menu inside this control's positioning context. Rendering it
  // inline avoids document-level focus/scroll reflow when the first option is
  // clicked in the Accounts list.
  const [dropAbove, setDropAbove] = useState(false);
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const rowCount = levels.length + (scoreId ? 1 : 0); // +1 for clear row
    const maxH = Math.min(rowCount, MAX_VISIBLE_ROWS) * ROW_H + 8;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    setDropAbove(spaceBelow < maxH && spaceAbove > spaceBelow);
  }, [open, levels.length, scoreId]);

  return (
    <div className="relative shrink-0" style={{ display: "flex", alignSelf: "stretch" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
         onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition-all hover:brightness-125"
        style={current
          ? { background: current.bg, borderColor: current.border, color: current.text, width: badgeWidth, minWidth: badgeWidth, height: "100%" }
          : { background: "transparent", borderStyle: "dashed", borderColor: "#94a3b8", color: "#94a3b8", width: badgeWidth, minWidth: badgeWidth, height: "100%" }
        }
        title={current ? current.label : "Click to set Trust Score"}
      >
        {current ? (
          <>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1 }}>{current.label}</span>
            {!hideIcon && <current.icon size={10} color={current.text} fill={current.text} strokeWidth={2} style={{ flexShrink: 0 }} />}
          </>
        ) : (
          <span>TrustScore</span>
        )}
      </button>

      {open && (
        <div
          ref={dropRef}
          style={{
            position: "absolute",
            zIndex: 99999,
            ...(dropAbove ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }),
            left: 0,
            width: 200,
            maxHeight: Math.min(levels.length + (scoreId ? 1 : 0), MAX_VISIBLE_ROWS) * ROW_H + 8,
            overflowY: "auto",
            background: "hsl(var(--background, 0 0% 100%))",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
            padding: "4px 0",
          }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        >
          {levels.map(lvl => {
            const Icon = lvl.icon;
            const isActive = scoreId === lvl.id;
            return (
              <button
                key={lvl.id}
                type="button"
                onClick={e => { e.stopPropagation(); void save(lvl.id); }}
                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 12px", height: ROW_H,
                  background: isActive ? lvl.bg : "transparent",
                  border: "none", borderLeft: isActive ? `3px solid ${lvl.border}` : "3px solid transparent",
                  cursor: "pointer", textAlign: "left", outline: "none",
                }}
              >
                <Icon size={12} color={isActive ? lvl.text : "#111827"} fill={isActive ? lvl.text : "none"} strokeWidth={2} />
                <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? lvl.text : "#111827", letterSpacing: "0.05em" }}>{lvl.label}</span>
              </button>
            );
          })}
          {scoreId && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); void save(null); }}
              onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                padding: "5px 12px", height: ROW_H,
                background: "transparent", border: "none",
                borderTop: "1px solid #e5e7eb", borderLeft: "3px solid transparent",
                cursor: "pointer", textAlign: "left", outline: "none", marginTop: 2,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", letterSpacing: "0.05em" }}>Clear score</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ACCT_SLOT_COUNT = 5;
const emptySlot = () => ({ username: "", password: "", totpSecret: "", emailAddress: "", emailPassword: "", phoneNumber: "" });
type AccountSlot = { username: string; password: string; totpSecret: string; emailAddress: string; emailPassword: string; phoneNumber: string };

// ── Per-slot Human Session Tool view ─────────────────────────────────────────
// Always mounted so the automation hook's run-loop persists even when the
// user is viewing the slot list or a different tab.

/** Snapshot of a slot's live automation state, lifted up to AccountSettingsPanel
 *  so the slot-list card can show a mirror toggle without opening the HST. */
type SlotAutomationState = {
  enabled: boolean;
  running: boolean;
  nextRunAt: number | null;
};

// Imperative handle exposed by each SlotHumanSessionView so the parent can
// toggle a specific slot directly without any state plumbing.
type SlotHumanSessionHandle = {
  setEnabled: (v: boolean) => void;
};

const SlotHumanSessionView = React.forwardRef<SlotHumanSessionHandle, {
  phone: UsbPhone | null;
  slotIdx: number;
  slotUsername: string;
  slotUsernames?: string[];
  addLog: (msg: string) => void;
  onBack: () => void;
  onPrevSlot?: () => void;
  onNextSlot?: () => void;
  slotCount?: number;
  requestSlot?: (idx: number, readyAt: number) => Promise<boolean>;
  releaseSlot?: (idx: number, skipRest?: boolean) => void;
  cancelQueuedSlot?: (idx: number) => void;
  refreshKey?: number;
  onCopied?: (targetSlotIdxs: number[]) => void;
  onAutomationState?: (slotIdx: number, state: SlotAutomationState) => void;
  collisionConfig?: CollisionPreventerConfig;
  onOpenBrowserProfile?: (username: string) => void;
  isActive?: boolean;
  sharedScrollTopRef?: React.MutableRefObject<number>;
}>(function SlotHumanSessionView(
  { phone, slotIdx, slotUsername, slotUsernames, addLog, onBack, onPrevSlot, onNextSlot, slotCount, requestSlot, releaseSlot, cancelQueuedSlot, refreshKey, onCopied, onAutomationState, collisionConfig, onOpenBrowserProfile, isActive = false, sharedScrollTopRef },
  ref,
) {
  const automation = useAutomationSettings(phone, addLog, slotIdx, slotUsername, requestSlot, releaseSlot, cancelQueuedSlot, refreshKey, collisionConfig);
  const isFirst = slotIdx === 0;
  const isLast = slotIdx === (slotCount ?? 1) - 1;

  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const preserveScrollAndNavigate = useCallback((navigate?: () => void) => {
    if (settingsScrollRef.current && sharedScrollTopRef) {
      sharedScrollTopRef.current = settingsScrollRef.current.scrollTop;
    }
    navigate?.();
  }, [sharedScrollTopRef]);
  useEffect(() => {
    if (isActive && settingsScrollRef.current && sharedScrollTopRef) {
      settingsScrollRef.current.scrollTop = sharedScrollTopRef.current;
    }
  }, [isActive, sharedScrollTopRef]);
  // Read the Account Slot assignment directly.  The effective automation
  // payload is template-resolved and may be cached, so it must not be the
  // authority for whether this editor is allowed to be changed.
  const [trustScoreAssigned, setTrustScoreAssigned] = useState(
    Boolean(automation.settings.trustScoreId),
  );
  useEffect(() => {
    let active = true;
    if (!phone?.serial) {
      setTrustScoreAssigned(false);
      return () => { active = false; };
    }
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/trust-score`, {
      credentials: "include",
      cache: "no-store",
    })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!active) return;
        setTrustScoreAssigned(Boolean(data?.configured && data?.scoreId));
      })
      .catch(() => {
        if (active) setTrustScoreAssigned(Boolean(automation.settings.trustScoreId));
      });
    return () => { active = false; };
  }, [phone?.serial, slotIdx, refreshKey, automation.settings.trustScoreId]);

  // Expose setEnabled so the parent can toggle THIS slot directly by calling
  // slotHandleRefs.current[i]?.setEnabled(v).  Because the ref is bound to
  // this specific component instance there is zero possibility of calling the
  // wrong slot's setter — no state updates, no effects, no shared refs needed.
  useImperativeHandle(ref, () => ({
    setEnabled: (v: boolean) => { automation.setEnabledByUser(v); },
  }), [automation.setEnabledByUser]);

  // Report live status (enabled / running / nextRunAt) to the parent so the
  // slot-list card can show the current state next to the toggle.
  const onAutomationStateRef = useRef(onAutomationState);
  onAutomationStateRef.current = onAutomationState;
  useEffect(() => {
    onAutomationStateRef.current?.(slotIdx, {
      enabled: automation.settings.enabled,
      running: automation.running,
      nextRunAt: automation.nextRunAt,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation.settings.enabled, automation.running, automation.nextRunAt]);
  // Keep the entry point visible for every slot.  The dialog discovers
  // targets across the farm, so hiding this based on the current device's
  // username count made Copy Settings disappear for single-slot devices.
  const canCopy = slotIdx !== undefined;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <div className="flex-1" />
        {canCopy && (
          <Button variant="outline" size="sm" onClick={() => setShowCopyDialog(true)} className="gap-1 h-7 px-2">
            <Copy className="w-3 h-3" />
            Copy Settings
          </Button>
        )}
         <Button variant="outline" size="sm" onClick={() => preserveScrollAndNavigate(onPrevSlot)} disabled={isFirst} className="gap-1 h-7 px-2">
          <ChevronLeft className="w-3.5 h-3.5" />
          SLOT {slotIdx}
        </Button>
         <Button variant="outline" size="sm" onClick={() => preserveScrollAndNavigate(onNextSlot)} disabled={isLast} className="gap-1 h-7 px-2 flex-row-reverse">
          <ChevronLeft className="w-3.5 h-3.5 rotate-180" />
          SLOT {slotIdx + 2}
        </Button>
      </div>
       <div className="flex-1 min-h-0">
        <AutomationSettingsPanel
          phone={phone}
          {...automation}
          slotIdx={slotIdx}
          slotUsername={slotUsername}
          slotUsernames={slotUsernames}
          onCopied={onCopied}
          showCopyDialog={showCopyDialog}
          setShowCopyDialog={setShowCopyDialog}
          trustScoreAssigned={trustScoreAssigned || Boolean(automation.settings.trustScoreId)}
          onOpenBrowserProfile={onOpenBrowserProfile}
           settingsScrollRef={settingsScrollRef}
           sharedScrollTopRef={sharedScrollTopRef}
           isActive={isActive}
        />
      </div>
    </div>
  );
});

type AccountSettingsPanelHandle = { backToSlots: () => void; backToSlot: (idx: number | null) => void };
type AccountSettingsPanelProps  = { phone: UsbPhone | null; addLog: (msg: string) => void; onSlotChange?: (slotIdx: number | null) => void; initialSlot?: number | null; onAnyEnabled?: (anyEnabled: boolean) => void; onPhoneAppsRunning?: (running: boolean) => void; onOpenBrowserProfile?: (username: string) => void };

/**
 * Connect legacy Account Settings records to the TrustScore inheritance
 * system. TrustScore badges on ProfilesPage are profile-local, while the
 * Human Session Tool resolves assignments by device serial + slot index.
 *
 * Only create the device/slot assignment when that slot has never had one.
 * This keeps an existing slot assignment authoritative and, more
 * importantly, never writes over the slot's saved automation baseline.
 */
async function hydrateAccountTrustScoreAssignments(
  serial: string,
  accountSlots: AccountSlot[],
): Promise<number[]> {
  const refreshedSlotIdxs: number[] = [];
  try {
    const profilesResponse = await fetch("/api/profiles?creatorMode=0&trustScoreHydration=1", {
      credentials: "include",
      cache: "no-store",
    });
    if (!profilesResponse.ok) return refreshedSlotIdxs;
    const profiles = await profilesResponse.json();
    if (!Array.isArray(profiles)) return refreshedSlotIdxs;

    const normalizeUsername = (value: unknown) =>
      String(value ?? "").trim().replace(/^@/, "").toLowerCase();
    const profileByUsername = new Map<string, any>();
    for (const profile of profiles) {
      for (const identity of [profile?.username, profile?.accountLabel]) {
        const username = normalizeUsername(identity);
        if (username && !profileByUsername.has(username)) {
          profileByUsername.set(username, profile);
        }
      }
    }

    await Promise.all(accountSlots.map(async (slot, slotIdx) => {
      const username = normalizeUsername(slot.username);
      if (!username) return;
      const profile = profileByUsername.get(username);
      const profileScoreId = typeof profile?.id === "number"
        ? getTrustScore(profile.id)
        : null;
      const assignmentResponse = await fetch(
        `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/trust-score`,
        { credentials: "include", cache: "no-store" },
      ).catch(() => null);
      if (!assignmentResponse?.ok) return;
      const assignment = await assignmentResponse.json().catch(() => null);

      // configured:true includes an explicit clear (scoreId:null), which
      // must remain manual mode rather than being re-populated from the badge.
      if (assignment?.configured) return;

      // Preserve any older browser-local slot assignment before falling back
      // to the account profile's TrustScore badge.
      const existingLocalScore = readLocalSlotTrustScore(serial, slotIdx);
      const scoreId = existingLocalScore || profileScoreId;
      if (!scoreId) return;
      try {
        await saveSlotTrustScore(serial, slotIdx, scoreId);
        refreshedSlotIdxs.push(slotIdx);
      } catch {
        // Keep the existing saved slot data untouched if persistence fails.
      }
    }));
    return refreshedSlotIdxs;
  } catch {
    // Account settings remain usable if profile or TrustScore hydration is
    // temporarily unavailable. The existing saved slot data is untouched.
    return refreshedSlotIdxs;
  }
}

const AccountSettingsPanel = React.forwardRef<AccountSettingsPanelHandle, AccountSettingsPanelProps>(
function AccountSettingsPanel({ phone, addLog, onSlotChange, initialSlot, onAnyEnabled, onPhoneAppsRunning, onOpenBrowserProfile }, ref) {
  const [slotRefreshKeys, setSlotRefreshKeys] = useState<Record<number, number>>({});
  const phoneAppsPanelRef = useRef<MobilePhoneAppsPanelHandle>(null);
  const handleCopied = useCallback((targetSlotIdxs: number[]) => {
    setSlotRefreshKeys(prev => {
      const next = { ...prev };
      for (const idx of targetSlotIdxs) next[idx] = (next[idx] ?? 0) + 1;
      return next;
    });
  }, []);

  // Mirror of each slot's live automation state (enabled / running / nextRunAt),
  // populated by SlotHumanSessionView via onAutomationState for display only.
  const [slotAutomationStates, setSlotAutomationStates] = useState<Record<number, SlotAutomationState>>({});
  const handleSlotAutomationState = useCallback((slotIdx: number, state: SlotAutomationState) => {
    setSlotAutomationStates(prev => ({ ...prev, [slotIdx]: state }));
  }, []);

  // Notify parent whenever the "any slot enabled" summary changes.
  const onAnyEnabledRef = useRef(onAnyEnabled);
  onAnyEnabledRef.current = onAnyEnabled;
  useEffect(() => {
    // ONLY true while a cycle is actively executing (s.running).
    // s.nextRunAt and s.enabled are intentionally excluded — a scheduled-but-
    // not-yet-started run or a saved-on toggle must NOT wake the mirror.
    // The mirror has exactly two on-conditions: HST actively running, or the
    // manual Power button. Nothing else.
    const anyEnabled = Object.values(slotAutomationStates).some(s => s.running);
    onAnyEnabledRef.current?.(anyEnabled);
  }, [slotAutomationStates]);

  // One ref per slot — each points to that slot's SlotHumanSessionView handle.
  // The mirror toggle calls slotHandleRefs.current[i]?.setEnabled(v) directly,
  // hitting exactly that slot's setEnabledByUser with no indirection.
  const slotHandleRefs = useRef<Record<number, SlotHumanSessionHandle | null>>({});
  const sharedHstScrollTopRef = useRef(0);
  const [slots, setSlots] = useState<AccountSlot[]>(
    Array.from({ length: ACCT_SLOT_COUNT }, emptySlot)
  );
  // A Trust Score template can be edited while this Phone Farm panel remains
  // mounted. Refresh every slot's effective settings after the save; the API
  // decides which slots are assigned to that template, and unassigned slots
  // simply receive the same baseline they already had.
  useEffect(() => {
    const onTemplateChanged = () => {
      setSlotRefreshKeys(prev => {
        const next = { ...prev };
        for (let idx = 0; idx < slots.length; idx++) next[idx] = (next[idx] ?? 0) + 1;
        return next;
      });
    };
    window.addEventListener("mobile_trustscore_template_changed", onTemplateChanged);
    return () => window.removeEventListener("mobile_trustscore_template_changed", onTemplateChanged);
  }, [slots.length]);
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState<boolean[]>(Array(ACCT_SLOT_COUNT).fill(false));
  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState<number | null>(null);
  const [totpCode, setTotpCode] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
  const [totpError, setTotpError] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
  const [showEmailPassword, setShowEmailPassword] = useState<boolean[]>(Array(ACCT_SLOT_COUNT).fill(false));
  // null = show slot list; number = show Human Session Tool for that slot index
  // initialSlot lets the Dashboard (or any deep-link) open a specific slot's
  // Human Session Tool directly on mount (e.g. ?slot=0 in the URL).
  const [openSlotTool,      setOpenSlotTool]      = useState<number | null>(initialSlot ?? null);
  const [openPhoneAppsTool,  setOpenPhoneAppsTool]  = useState(false);
  const [phoneAppsEnabled,   setPhoneAppsEnabled]   = useState(false);
  const [phoneAppsNextRunAt, setPhoneAppsNextRunAt] = useState<number | null>(null);
  const [phoneAppsRunning,   setPhoneAppsRunning]   = useState(false);
  // Bubble Phone Apps running state up to MobilePage so it can activate the
  // mirror. Must live AFTER the phoneAppsRunning declaration to avoid TDZ in
  // the production/Electron minified build.
  const onPhoneAppsRunningRef = useRef(onPhoneAppsRunning);
  onPhoneAppsRunningRef.current = onPhoneAppsRunning;
  useEffect(() => {
    onPhoneAppsRunningRef.current?.(phoneAppsRunning);
  }, [phoneAppsRunning]);
  useEffect(() => { onSlotChange?.(openSlotTool); }, [openSlotTool]);
  useImperativeHandle(ref, () => ({
    backToSlots: () => { setOpenSlotTool(null); setOpenPhoneAppsTool(false); },
    backToSlot:  (idx: number | null) => setOpenSlotTool(idx),
  }));
  const { config: collisionConfig, requestSlot, releaseSlot, cancelQueuedSlot } = useCollisionPreventer(phone?.serial ?? null);
  const deviceOffline = phone?.state === "offline";
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef<string>(JSON.stringify(Array.from({ length: ACCT_SLOT_COUNT }, emptySlot)));
  // Kept outside the effect so clearTimeout on new keystrokes works without
  // tying the timer's lifetime to the component's mount state.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    hydratedRef.current = false;
    if (!phone) { setSlots(Array.from({ length: ACCT_SLOT_COUNT }, emptySlot)); return; }
    let active = true;
    setLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/account`)
      .then(r => r.json())
      .then(async d => {
        if (!active) return;
        // Server returns { slots: [...] }; also handle legacy { username, password }
        let loaded: AccountSlot[];
        if (d && Array.isArray(d.slots) && d.slots.length > 0) {
          // Use the exact count the server stored — do NOT pad to ACCT_SLOT_COUNT.
          // Padding caused deleted slots to reappear every time the panel reloaded.
          loaded = d.slots.map((s: any) => ({
            username: s?.username ?? "",
            password: s?.password ?? "",
            totpSecret: s?.totpSecret ?? "",
            emailAddress: s?.emailAddress ?? "",
            emailPassword: s?.emailPassword ?? "",
            phoneNumber: s?.phoneNumber ?? "",
          }));
        } else if (d && d.username) {
          loaded = [{ username: d.username, password: d.password ?? "", totpSecret: "", emailAddress: "", emailPassword: "", phoneNumber: "" }];
        } else {
          loaded = Array.from({ length: ACCT_SLOT_COUNT }, emptySlot);
        }
        // Existing accounts may already have saved Human Session Tool
        // settings but no device/slot TrustScore assignment. Hydrate that
        // assignment from the account's existing profile badge. This does not
        // modify the saved automation baseline.
        const trustScoreSlots = await hydrateAccountTrustScoreAssignments(phone.serial, loaded);
        if (!active) return;
        if (trustScoreSlots.length > 0) {
          setSlotRefreshKeys(prev => {
            const next = { ...prev };
            for (const idx of trustScoreSlots) next[idx] = (next[idx] ?? 0) + 1;
            return next;
          });
        }
        lastSavedRef.current = JSON.stringify(loaded);
        setSlots(loaded);
        setShowPassword(Array(loaded.length).fill(false));
        setShowEmailPassword(Array(loaded.length).fill(false));
        setTotpCode(Array(loaded.length).fill(null));
        setTotpError(Array(loaded.length).fill(null));
      })
      .catch(() => {})
      .finally(() => { if (active) { setLoading(false); hydratedRef.current = true; } });
    return () => { active = false; };
  }, [phone?.serial]);

  useEffect(() => {
    if (!phone || !hydratedRef.current) return;
    const toSaveStr = JSON.stringify(slots);
    if (toSaveStr === lastSavedRef.current) return;
    const serial = phone.serial;
    // Debounce: cancel a previous pending save for NEW keystrokes, but do NOT
    // clean up on component unmount.  AccountSettingsPanel unmounts whenever
    // the user switches away from the Account tab (conditional render), so the
    // old "return () => clearTimeout(t)" was silently discarding every save
    // that fired within 600 ms of a tab switch — any value the user typed and
    // then navigated away from would be lost on the next page load.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots }),
      })
        .then(async r => {
          const body = await r.json().catch(() => null);
          if (!r.ok || !body?.ok) { setSaveError(body?.error ?? `Server error (${r.status})`); return; }
          lastSavedRef.current = toSaveStr;
          setSaveError(null);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        })
        .catch((e: any) => setSaveError(e?.message ?? "Couldn't reach the server"));
    }, 400);
    // No return cleanup — intentional. Saves survive tab switches.
  }, [slots, phone?.serial]);

  const updateSlot = (i: number, patch: Partial<AccountSlot>) =>
    setSlots(s => s.map((slot, idx) => idx === i ? { ...slot, ...patch } : slot));

  const typeAccountField = async (field: "username" | "password" | "totpSecret", value: string) => {
    const text = value.trim();
    if (!phone?.serial) return;
    if (!text) {
      setSaveError(`${field === "totpSecret" ? "2FA OTP Secret" : field[0].toUpperCase() + field.slice(1)} is empty`);
      return;
    }
    try {
      const response = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/input/clipboard-paste`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) setSaveError(body?.error ?? `Typing failed (${response.status})`);
    } catch (error: any) {
      setSaveError(error?.message ?? "Typing failed");
    }
  };

  const addSlot = () => {
    setSlots(s => [...s, emptySlot()]);
    setShowPassword(s => [...s, false]);
    setShowEmailPassword(s => [...s, false]);
    setTotpCode(c => [...c, null]);
    setTotpError(e => [...e, null]);
  };

  const removeSlot = (i: number) => {
    const serial = phone?.serial;
    if (serial) {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/slots/${i}`, { method: "DELETE" }).catch(() => {});
      localStorage.removeItem(slotTrustScoreKey(serial, i));
    }
    setSlots(s => s.filter((_, idx) => idx !== i));
    setShowPassword(s => s.filter((_, idx) => idx !== i));
    setShowEmailPassword(s => s.filter((_, idx) => idx !== i));
    setTotpCode(c => c.filter((_, idx) => idx !== i));
    setTotpError(e => e.filter((_, idx) => idx !== i));
    // If the tool view for this slot was open, close it
    setOpenSlotTool(prev => prev === i ? null : prev);
  };

  const generateTotp = async (slotIdx: number, secret: string) => {
    setTotpCode(c => c.map((v, i) => i === slotIdx ? null : v));
    setTotpError(e => e.map((v, i) => i === slotIdx ? null : v));
    try {
      const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      const cleaned = secret.toUpperCase().replace(/\s+/g, "").replace(/=/g, "");
      let bits = 0, val = 0;
      const bytes: number[] = [];
      for (const ch of cleaned) {
        const idx = b32.indexOf(ch);
        if (idx < 0) continue;
        val = (val << 5) | idx; bits += 5;
        if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
      }
      if (!bytes.length) { setTotpError(e => e.map((v, i) => i === slotIdx ? "Invalid secret" : v)); return; }
      const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
      const counter = Math.floor(Date.now() / 1000 / 30);
      const buf = new Uint8Array(8);
      let c = counter;
      for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
      const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
      const offset = hmac[19] & 0xf;
      const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1_000_000;
      const codeStr = code.toString().padStart(6, "0");
      setTotpCode(cd => cd.map((v, i) => i === slotIdx ? codeStr : v));
      navigator.clipboard.writeText(codeStr).catch(() => {});
    } catch {
      setTotpError(e => e.map((v, i) => i === slotIdx ? "Failed to generate" : v));
    }
  };

  // IMPORTANT: do NOT early-return when phone is null.  On a multi-phone
  // farm the USB poll may transiently return an empty list for the targeted
  // serial (a brief flicker between two poll responses).  An early return
  // here would unmount every SlotHumanSessionView and destroy its
  // useAutomationSettings hooks — cancelling all in-flight timers.  Instead,
  // always render the hooks and show the "no phone" message inline.
  const deviceName = phone
    ? ([phone.manufacturer, phone.marketName || phone.model].filter(Boolean).join(" ") || phone.serial)
    : "";

  return (
    <div className="h-full flex flex-col">
      {/* Always-mounted slot Human Session Tool views — hidden when phone is
          null or when a different slot's tool is open.  Keeping these mounted
          means automation run-loop timers survive transient USB poll flickers
          where the targeted serial temporarily disappears from the device list. */}
      {slots.map((_, i) => (
        <div key={`hst-${i}`} className={phone && openSlotTool === i ? "h-full" : "hidden"}>
          <SlotHumanSessionView
            ref={el => { slotHandleRefs.current[i] = el; }}
            phone={phone}
            slotIdx={i}
            slotUsername={slots[i]?.username ?? ""}
            slotUsernames={slots.map(s => s.username)}
            addLog={addLog}
            onBack={() => setOpenSlotTool(null)}
            onPrevSlot={i > 0 ? () => setOpenSlotTool(i - 1) : undefined}
            onNextSlot={i < slots.length - 1 ? () => setOpenSlotTool(i + 1) : undefined}
            slotCount={slots.length}
            requestSlot={requestSlot}
            releaseSlot={releaseSlot}
            cancelQueuedSlot={cancelQueuedSlot}
            collisionConfig={collisionConfig}
            refreshKey={slotRefreshKeys[i] ?? 0}
            onCopied={handleCopied}
            onAutomationState={handleSlotAutomationState}
            onOpenBrowserProfile={onOpenBrowserProfile}
            isActive={openSlotTool === i}
            sharedScrollTopRef={sharedHstScrollTopRef}
          />
        </div>
      ))}

      {/* No-phone placeholder — shown while the USB poll hasn't returned the
          targeted serial yet (transient flicker).  Hidden once phone connects. */}
      {!phone && (
        <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-2">
          <Smartphone className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground max-w-xs">
            Connect a phone via USB to link an Instagram account to it.
          </p>
        </div>
      )}

      {/* Mobile Phone Apps tool panel — shown when fingerprint is clicked */}
      <div className={phone && openPhoneAppsTool ? "h-full" : "hidden"}>
        <MobilePhoneAppsPanel
          ref={phoneAppsPanelRef}
          serial={phone?.serial}
          onBack={() => setOpenPhoneAppsTool(false)}
          onEnabled={setPhoneAppsEnabled}
          onNextRunAt={setPhoneAppsNextRunAt}
          onRunning={setPhoneAppsRunning}
          onLog={addLog}
          requestSlot={requestSlot}
          releaseSlot={releaseSlot}
          cancelQueuedSlot={cancelQueuedSlot}
        />
      </div>

      {/* Slot list — hidden when any tool view is open or phone is null */}
      <div className={phone && openSlotTool === null && !openPhoneAppsTool ? "h-full overflow-y-auto p-6 space-y-6" : "hidden"}>

        {/* ── Mobile Phone Apps ─────────────────────────────────────────── */}
        <MobilePhoneApps
          serial={phone?.serial}
          deviceName={deviceName}
          enabled={phoneAppsEnabled}
          nextRunAt={phoneAppsNextRunAt}
          onOpenTool={() => setOpenPhoneAppsTool(true)}
          onToggle={(v) => phoneAppsPanelRef.current?.setEnabled(v)}
        />

        {/* ── Instagram Accounts ────────────────────────────────────────── */}
        <h2 className="text-lg font-bold text-foreground">Instagram Accounts</h2>

        <div className="space-y-4">
          {slots.map((slot, i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
              {/* Slot header: title + Human Session Tool button + mirror toggle + Delete */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-bold text-black uppercase tracking-wider min-w-[200px] shrink-0">Instagram Account Slot {i + 1}</p>
                  <Button
                    type="button"
                    size="sm"
                    className="px-2 text-[11px] gap-1.5 text-white hover:brightness-95 transition-all"
                    style={{ background: "#1AD2F2", border: "none", height: 28, width: 28, padding: 0 }}
                    onClick={() => setOpenSlotTool(i)}
                  >
                    <Fingerprint className="w-3.5 h-3.5 text-white" />
                  </Button>

                  {/* Toggle for this slot's Human Session Tool. Calls setEnabled
                      directly on the slot's imperative handle — only slot i's
                      handle is stored at slotHandleRefs.current[i], so it is
                      physically impossible for this to affect any other slot. */}
                  {slotAutomationStates[i] && (() => {
                    const as = slotAutomationStates[i];
                    return (
                      <div className="flex items-center gap-2 pl-2 border-l border-border">
                        <Switch
                          checked={as.enabled}
                          onCheckedChange={v => { slotHandleRefs.current[i]?.setEnabled(v); }}
                        />
                        <div className="flex flex-col min-w-0">
                          <span className={`text-[11px] font-semibold leading-tight whitespace-nowrap ${
                            deviceOffline && as.enabled
                              ? "text-red-600 dark:text-red-400"
                              : as.running
                              ? "text-blue-500"
                              : as.enabled
                                ? "text-green-600 dark:text-green-400"
                                : "text-muted-foreground"
                          }`}>
                            {deviceOffline && as.enabled ? "Paused — Offline" : as.running ? "Running" : as.enabled ? "Active" : "Disabled"}
                          </span>
                          {as.enabled && !as.running && as.nextRunAt && (
                            <span className="text-[10px] text-muted-foreground whitespace-nowrap leading-tight">
                              Next run {new Date(as.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {new Date(as.nextRunAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading}
                  onClick={() => setConfirmDeleteSlot(i)}
                  className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete Instagram Account Slot ${i + 1}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>

              {/* Row 1: Username + Password + 2FA OTP Secret */}
              <div className="flex items-end gap-3 flex-wrap">
                {/* Username */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">
                    Username
                    <button type="button" title="Type username on the phone keyboard" aria-label="Type username on the phone keyboard"
                      disabled={loading || !phone?.serial} onClick={() => typeAccountField("username", slot.username)}
                      className="inline-flex ml-1 align-[-3px] text-muted-foreground hover:text-primary disabled:opacity-40">
                      <Keyboard className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </Label>
                  <Input
                    value={slot.username}
                    onChange={e => updateSlot(i, { username: e.target.value })}
                    disabled={loading}
                    autoComplete="off"
                    className="w-[20ch]"
                  />
                </div>

                {/* Password */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">
                    Password
                    <button type="button" title="Type password on the phone keyboard" aria-label="Type password on the phone keyboard"
                      disabled={loading || !phone?.serial} onClick={() => typeAccountField("password", slot.password)}
                      className="inline-flex ml-1 align-[-3px] text-muted-foreground hover:text-primary disabled:opacity-40">
                      <Keyboard className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type={showPassword[i] ? "text" : "password"}
                      value={slot.password}
                      onChange={e => updateSlot(i, { password: e.target.value })}
                      disabled={loading}
                      autoComplete="off"
                      className="w-[20ch]"
                    />
                    <Button type="button" variant="secondary" size="sm"
                      onClick={() => setShowPassword(s => s.map((v, idx) => idx === i ? !v : v))}>
                      {showPassword[i] ? "Hide" : "Show"}
                    </Button>
                  </div>
                </div>

                {/* 2FA OTP Secret */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">
                    2FA OTP Secret
                    <button type="button" title="Type 2FA OTP Secret on the phone keyboard" aria-label="Type 2FA OTP Secret on the phone keyboard"
                      disabled={loading || !phone?.serial} onClick={() => typeAccountField("totpSecret", slot.totpSecret)}
                      className="inline-flex ml-1 align-[-3px] text-muted-foreground hover:text-primary disabled:opacity-40">
                      <Keyboard className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={slot.totpSecret}
                      onChange={e => {
                        updateSlot(i, { totpSecret: e.target.value });
                        setTotpCode(c => c.map((v, idx) => idx === i ? null : v));
                        setTotpError(er => er.map((v, idx) => idx === i ? null : v));
                      }}
                      disabled={loading}
                      autoComplete="off"
                      className="w-[22ch] font-mono text-xs"
                    />
                    <Button type="button" variant="secondary" size="sm"
                      disabled={!slot.totpSecret.trim()}
                      onClick={() => generateTotp(i, slot.totpSecret)}>
                      Generate
                    </Button>
                    {totpCode[i] && (
                      <span className="font-mono text-sm font-bold text-green-500 tracking-widest">{totpCode[i]}</span>
                    )}
                    {totpError[i] && (
                      <span className="text-xs text-destructive">{totpError[i]}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Row 2: Email Address + Email Password + Phone Number */}
              <div className="flex items-end gap-3 flex-wrap">
                {/* Email Address */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">Email Address</Label>
                  <Input
                    value={slot.emailAddress}
                    onChange={e => updateSlot(i, { emailAddress: e.target.value })}
                    disabled={loading}
                    autoComplete="off"
                    className="w-[20ch]"
                  />
                </div>

                {/* Email Password */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">Email Password</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type={showEmailPassword[i] ? "text" : "password"}
                      value={slot.emailPassword}
                      onChange={e => updateSlot(i, { emailPassword: e.target.value })}
                      disabled={loading}
                      autoComplete="off"
                      className="w-[20ch]"
                    />
                    <Button type="button" variant="secondary" size="sm"
                      onClick={() => setShowEmailPassword(s => s.map((v, idx) => idx === i ? !v : v))}>
                      {showEmailPassword[i] ? "Hide" : "Show"}
                    </Button>
                  </div>
                </div>

                {/* Phone Number */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground block text-left">Phone Number</Label>
                  <Input
                    value={slot.phoneNumber}
                    onChange={e => updateSlot(i, { phoneNumber: e.target.value })}
                    disabled={loading}
                    autoComplete="off"
                    className="w-[20ch]"
                  />
                </div>

                {/* Trust Score — independent instance (mobile_ts_<serial>_<slotIdx>)
                    so styling changes here don't affect other badge placements */}
                <div style={{ display: "flex", alignSelf: "flex-end", height: "36px", gap: "8px" }}>
                  <SlotTrustScoreBadge serial={phone?.serial ?? ""} slotIdx={i} width={114} />
                  <TrustScoreCountdown serial={phone?.serial ?? ""} slotIdx={i} />
                </div>
              </div>
          </div>
        ))}

          {/* Add slot button */}
          <div className="flex justify-start">
            <Button
              type="button"
              variant="secondary"
              onClick={addSlot}
              disabled={loading}
              className="w-fit"
            >
              + Add Instagram Account Slot
            </Button>
          </div>

          {/* Delete slot confirmation dialog */}
          <AlertDialog open={confirmDeleteSlot !== null} onOpenChange={open => { if (!open) setConfirmDeleteSlot(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this slot?</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete Instagram Account Slot {confirmDeleteSlot !== null ? confirmDeleteSlot + 1 : ""}? This will remove all credentials stored in this slot.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => { if (confirmDeleteSlot !== null) { removeSlot(confirmDeleteSlot); setConfirmDeleteSlot(null); } }}
                >
                  Delete Slot
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {saved && <p className="text-xs text-green-500">Saved</p>}
        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      </div>
    </div>
  );
});

// ─── Phone Settings Panel ──────────────────────────────────────────────────────

function PhoneSettingsPanel({ serial }: { serial: string | null }) {
  interface BatteryScheduleConfig { enabled: boolean; unplugMinutes: number; cycleHours: number; spoofLevel: number; }
  interface BatteryInfo {
    level: number; status: string; plugged: string; temperatureC: number;
    chargingControl: {
      probed: boolean; supported: boolean | null;
      path: string | null; needsRoot: boolean | null; failReason: string | null;
    };
    schedule: { active: boolean; running: boolean; nextAt: number | null; config: BatteryScheduleConfig | null };
  }

  const [battInfo,      setBattInfo]      = React.useState<BatteryInfo | null>(null);
  const [battError,     setBattError]     = React.useState<string | null>(null);
  const [probing,       setProbing]       = React.useState(false);
  const [probeMsg,      setProbeMsg]      = React.useState<string | null>(null);

  // Stop Charging schedule form
  const [enabled,       setEnabled]       = React.useState(false);
  const [unplugMinutes, setUnplugMinutes] = React.useState(30);
  const [cycleHours,    setCycleHours]    = React.useState(4);
  const [spoofLevel,    setSpoofLevel]    = React.useState(72);
  const [saving,        setSaving]        = React.useState(false);
  const [saveMsg,       setSaveMsg]       = React.useState<string | null>(null);
  const [stopping,      setStopping]      = React.useState(false);
  const [resuming,      setResuming]      = React.useState(false);

  // Collision Preventer form
  const [csEnabled,    setCsEnabled]    = React.useState(true);
  const [csMinMin,     setCsMinMin]     = React.useState(5);
  const [csMinMax,     setCsMinMax]     = React.useState(10);
  const csSaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const csHydratedSerialRef = React.useRef<string | null>(null);

  // Google Play credentials
  const [gpEmail,    setGpEmail]    = React.useState("");
  const [gpPassword, setGpPassword] = React.useState("");

  // SIM phone number manual inputs (keyed by slot index)
  const [simPhoneInputs, setSimPhoneInputs] = React.useState<Record<number, string>>({});

  // Device quick-controls (Standby / Restart / Brightness)
  const [screenOn,    setScreenOn]    = React.useState(true);
  // brightStep: 0=0%, 1=50%, 2=100%. Starts at 2 so first press always → 0%.
  // Not synced from device — sync would snap to a mid-value and break the fixed cycle.
  const [brightStep,  setBrightStep]  = React.useState<0 | 1 | 2>(2);
  const [rebooting,   setRebooting]   = React.useState(false);

  const BRIGHT_LEVELS: [0 | 1 | 2, number, string][] = [[0, 0, '0%'], [1, 50, '50%'], [2, 100, '100%']];
  const brightPercent = BRIGHT_LEVELS[brightStep][1];
  const brightLabel   = BRIGHT_LEVELS[brightStep][2];

  const handleStandby = React.useCallback(async () => {
    if (!serial) return;
    const next = !screenOn;
    setScreenOn(next);
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/standby`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: next }),
    }).catch(() => {});
  }, [serial, screenOn]);

  const handleReboot = React.useCallback(async () => {
    if (!serial || rebooting) return;
    setRebooting(true);
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/reboot`, {
      method: "POST",
    }).catch(() => {});
    // Give the device ~15 s to go offline then assume it came back.
    setTimeout(() => { setRebooting(false); setScreenOn(true); }, 15000);
  }, [serial, rebooting]);

  const handleBrightness = React.useCallback(async () => {
    if (!serial) return;
    // Fixed cycle: 100% → 0% → 50% → 100% → …
    // Press 1: 0%  Press 2: 50%  Press 3: 100%  Press 4: 0% …
    const nextStep: 0 | 1 | 2 = brightStep === 2 ? 0 : brightStep === 0 ? 1 : 2;
    setBrightStep(nextStep);
    const percent = BRIGHT_LEVELS[nextStep][1];
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/brightness`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percent }),
    }).catch(() => {});
  }, [serial, brightStep]);

  // App close gesture (dismiss direction)
  const [dismissDir,    setDismissDir]    = React.useState<"auto" | "left" | "up">("auto");
  const [dismissSaving, setDismissSaving] = React.useState(false);
  type SwipeGesture = { x1: number; y1: number; x2: number; y2: number; durationMinMs: number; durationMaxMs: number; jitterX: number; jitterY: number; startJitterMinY: number; startJitterMaxY: number; pauseMinMs: number; pauseMaxMs: number; settleMinMs: number; settleMaxMs: number; accelerationPct: number; decelerationPct: number };
  const [swipeGesture, setSwipeGesture] = React.useState<SwipeGesture>({ x1: 540, y1: 2100, x2: 540, y2: 500, durationMinMs: 400, durationMaxMs: 700, jitterX: 0, jitterY: 0, startJitterMinY: 0, startJitterMaxY: 0, pauseMinMs: 150, pauseMaxMs: 600, settleMinMs: 100, settleMaxMs: 350, accelerationPct: 35, decelerationPct: 35 });
  type TypingSpeedProfile = { minMs: number; maxMs: number; errorPercentMin: number; errorPercentMax: number; dwellMinMs: number; dwellMaxMs: number; hesitationMinMs: number; hesitationMaxMs: number };
  const [typingSpeedProfile, setTypingSpeedProfile] = React.useState<TypingSpeedProfile>({ minMs: 80, maxMs: 220, errorPercentMin: 0, errorPercentMax: 0, dwellMinMs: 40, dwellMaxMs: 80, hesitationMinMs: 250, hesitationMaxMs: 650 });
  const [swipeResolution, setSwipeResolution] = React.useState({ w: 1080, h: 2400 });
  const [swipeSaving, setSwipeSaving] = React.useState(false);
  const [swipeTesting, setSwipeTesting] = React.useState(false);
  const [swipeProgress, setSwipeProgress] = React.useState<number | null>(null);
  const [swipeTestPath, setSwipeTestPath] = React.useState<SwipeGesture | null>(null);
  const [swipeOpen, setSwipeOpen] = React.useState(false);
  const swipeCanvasRef = React.useRef<SVGSVGElement | null>(null);
  const swipeDragRef = React.useRef<{ kind: "start" | "end" | "line"; dx: number; dy: number; base: SwipeGesture } | null>(null);
  const swipeGestureRef = React.useRef(swipeGesture);
  React.useEffect(() => { swipeGestureRef.current = swipeGesture; }, [swipeGesture]);

  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`)
      .then(r => r.json())
      .then(d => {
        setDismissDir(d.dismissDirection ?? "auto");
        if (d.swipeGesture) setSwipeGesture({
          durationMinMs: 500, durationMaxMs: 500, jitterX: 0, jitterY: 0, startJitterMinY: 0, startJitterMaxY: 0, pauseMinMs: 150, pauseMaxMs: 600, settleMinMs: 100, settleMaxMs: 350, accelerationPct: 35, decelerationPct: 35, ...d.swipeGesture,
        });
        if (d.typingSpeedProfile) setTypingSpeedProfile({ minMs: 80, maxMs: 220, errorPercentMin: 0, errorPercentMax: 0, dwellMinMs: 40, dwellMaxMs: 80, hesitationMinMs: 250, hesitationMaxMs: 650, ...d.typingSpeedProfile });
      })
      .catch(() => {});
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-spec`)
      .then(r => r.json())
      .then(d => { if (d.resolution?.w && d.resolution?.h) setSwipeResolution(d.resolution); })
      .catch(() => {});
  }, [serial]);

  const saveSwipeGesture = async (next: SwipeGesture) => {
    if (!serial) return;
    setSwipeGesture(next);
    setSwipeSaving(true);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swipeGesture: next }),
      });
    } finally { setSwipeSaving(false); }
  };
  const saveTypingSpeedProfile = async (next: TypingSpeedProfile) => {
    if (!serial) return;
    setTypingSpeedProfile(next);
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typingSpeedProfile: next }),
    }).catch(() => {});
  };

  const updateSwipeFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = swipeDragRef.current;
    const svg = swipeCanvasRef.current;
    if (!drag || !svg) return;
    const rect = svg.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * swipeResolution.w,
      y: ((event.clientY - rect.top) / rect.height) * swipeResolution.h,
    };
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
    const x = clamp(point.x - drag.dx, swipeResolution.w - 1);
    const y = clamp(point.y - drag.dy, swipeResolution.h - 1);
    const base = drag.base;
    if (drag.kind === "start") setSwipeGesture({ ...base, x1: x, y1: y });
    else if (drag.kind === "end") setSwipeGesture({ ...base, x2: x, y2: y });
    else {
      const deltaX = x - (base.x1 + drag.dx);
      const deltaY = y - (base.y1 + drag.dy);
      setSwipeGesture({
        ...base,
        x1: Math.max(0, Math.min(swipeResolution.w - 1, Math.round(base.x1 + deltaX))),
        y1: Math.max(0, Math.min(swipeResolution.h - 1, Math.round(base.y1 + deltaY))),
        x2: Math.max(0, Math.min(swipeResolution.w - 1, Math.round(base.x2 + deltaX))),
        y2: Math.max(0, Math.min(swipeResolution.h - 1, Math.round(base.y2 + deltaY))),
      });
    }
  };

  const startSwipeDrag = (kind: "start" | "end" | "line", event: React.PointerEvent<SVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = swipeCanvasRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * swipeResolution.w,
      y: ((event.clientY - rect.top) / rect.height) * swipeResolution.h,
    };
    const base = swipeGesture;
    const anchor = kind === "start" ? { x: base.x1, y: base.y1 } : kind === "end" ? { x: base.x2, y: base.y2 } : { x: base.x1, y: base.y1 };
    swipeDragRef.current = { kind, dx: point.x - anchor.x, dy: point.y - anchor.y, base };
    svg.setPointerCapture(event.pointerId);
  };

  const finishSwipeDrag = () => {
    const drag = swipeDragRef.current;
    swipeDragRef.current = null;
    if (drag) saveSwipeGesture(swipeGestureRef.current);
  };

  const testSwipeGesture = async () => {
    if (!serial || swipeTesting) return;
    setSwipeTesting(true);
    const durationMinMs = Math.min(swipeGesture.durationMinMs, swipeGesture.durationMaxMs);
    const durationMaxMs = Math.max(swipeGesture.durationMinMs, swipeGesture.durationMaxMs);
    const durationMs = durationMinMs + Math.round(Math.random() * (durationMaxMs - durationMinMs));
    setSwipeProgress(0);
    const startJitterMinY = Math.max(0, Math.min(swipeGesture.startJitterMinY ?? 0, swipeGesture.startJitterMaxY ?? 0));
    const startJitterMaxY = Math.max(startJitterMinY, swipeGesture.startJitterMaxY ?? startJitterMinY);
    const jitter = {
      x: Math.round((Math.random() * 2 - 1) * swipeGesture.jitterX),
      y: Math.round((Math.random() * 2 - 1) * swipeGesture.jitterY),
      startY: Math.round(startJitterMinY + Math.random() * (startJitterMaxY - startJitterMinY)),
    };
    const testPath = {
      x1: Math.max(0, Math.min(swipeResolution.w - 1, swipeGesture.x1 + jitter.x)),
      y1: Math.max(0, Math.min(swipeResolution.h - 1, swipeGesture.y1 + jitter.startY)),
      x2: Math.max(0, Math.min(swipeResolution.w - 1, swipeGesture.x2 + jitter.x)),
      y2: Math.max(0, Math.min(swipeResolution.h - 1, swipeGesture.y2 + jitter.y)),
    };
    setSwipeTestPath({ ...testPath, durationMinMs: durationMs, durationMaxMs: durationMs });
    const startedAt = performance.now();
    const duration = Math.max(100, durationMs);
    let frame = 0;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      setSwipeProgress(progress);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    try {
      // Send the same jittered path used by the preview. The API accepts the
      // saved profile and applies its own safety clamp; the preview remains
      // an exact visual representation of this test execution.
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/test-swipe-gesture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: testPath }),
      });
      await new Promise<void>(resolve => setTimeout(resolve, duration));
    } finally {
      cancelAnimationFrame(frame);
      setSwipeProgress(null);
      setSwipeTestPath(null);
      setSwipeTesting(false);
    }
  };

  const saveDismissDir = async (val: "auto" | "left" | "up") => {
    if (!serial) return;
    setDismissDir(val);
    setDismissSaving(true);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-prefs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissDirection: val }),
      });
    } finally {
      setDismissSaving(false);
    }
  };

  // Device spec
  interface SimInfo { slot: number; carrier: string | null; phoneNumber: string | null }
  interface DeviceSpec {
    manufacturer: string | null; model: string | null; brand: string | null;
    androidVersion: string | null; sdkInt: string | null; cpuAbi: string | null;
    density: string | null; hardware: string | null; buildFingerprint: string | null;
    buildDate: string | null; resolution: { w: number; h: number } | null;
    ramMb: number | null; storageTotalMb: number | null; kernel: string | null;
    sims: SimInfo[];
  }
  const [deviceSpec,   setDeviceSpec]   = React.useState<DeviceSpec | null>(null);
  const [specLoading,  setSpecLoading]  = React.useState(false);

  const applyConfig = React.useCallback((cfg: BatteryScheduleConfig) => {
    setEnabled(cfg.enabled);
    setUnplugMinutes(cfg.unplugMinutes);
    setCycleHours(cfg.cycleHours);
    setSpoofLevel(cfg.spoofLevel);
  }, []);

  // Load Google Play settings
  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-settings`)
      .then(r => r.json()).then(d => {
        setGpEmail(d.googlePlayEmail ?? "");
        setGpPassword(d.googlePlayPassword ?? "");
      }).catch(() => {});
  }, [serial]);

  // Load device spec
  const loadDeviceSpec = React.useCallback(() => {
    if (!serial) return;
    setSpecLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-spec`)
      .then(r => r.json()).then(d => setDeviceSpec(d))
      .catch(() => {})
      .finally(() => setSpecLoading(false));
  }, [serial]);

  React.useEffect(() => { loadDeviceSpec(); }, [loadDeviceSpec]);

  // Load saved schedule + probe cache on mount
  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/schedule`)
      .then(r => r.json()).then(d => { if (d.config) applyConfig(d.config); })
      .catch(() => {});
  }, [serial, applyConfig]);

  // Load collision preventer settings
  React.useEffect(() => {
    // A PhoneSettingsPanel instance can be reused while the active serial
    // changes. Do not let the autosave effect treat the new device's initial
    // state as a user edit before this device has hydrated.
    csHydratedSerialRef.current = null;
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-preventer`)
      .then(r => r.json()).then(d => {
        if (d.config) {
          setCsEnabled(d.config.enabled);
          setCsMinMin(d.config.restMinMin);
          setCsMinMax(d.config.restMinMax);
        } else {
          // New device — no saved config yet. Persist the defaults immediately so
          // they survive a page reload without the user needing to touch anything.
          fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-preventer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, restMinMin: 5, restMinMax: 10 }),
          }).catch(() => {});
        }
        csHydratedSerialRef.current = serial;
      }).catch(() => {});
  }, [serial]);

  // Poll live battery info every 10 s
  React.useEffect(() => {
    if (!serial) return;
    const poll = async () => {
      try {
        const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery`);
        if (!r.ok) throw new Error(await r.text());
        setBattInfo(await r.json());
        setBattError(null);
      } catch (e: any) { setBattError(e?.message ?? "fetch error"); }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [serial]);

  const handleProbe = async () => {
    if (!serial) return;
    setProbing(true); setProbeMsg(null);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/probe`, { method: "POST" });
      const data = await r.json();
      if (data.supported) {
        setProbeMsg(`✅ Real charging control supported — ${data.path}${data.needsRoot ? " (root)" : " (no root needed)"}`);
      } else {
        setProbeMsg(`❌ Not supported on this device — ${data.reason}`);
      }
      const r2 = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery`);
      if (r2.ok) setBattInfo(await r2.json());
    } catch (e: any) { setProbeMsg(`Error: ${e?.message}`); }
    finally { setProbing(false); }
  };

  const handleSave = async () => {
    if (!serial) return;
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, unplugMinutes, cycleHours, spoofLevel }),
      });
      if (!r.ok) throw new Error((await r.json())?.error ?? r.status);
      setSaveMsg(enabled ? "Schedule saved & started" : "Schedule saved & stopped");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (e: any) { setSaveMsg(`Error: ${e?.message}`); }
    finally { setSaving(false); }
  };

  const handleStopNow = async () => {
    if (!serial) return;
    setStopping(true);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: spoofLevel }),
      });
      const r2 = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery`);
      if (r2.ok) setBattInfo(await r2.json());
    } finally { setStopping(false); }
  };

  const handleResumeNow = async () => {
    if (!serial) return;
    setResuming(true);
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/resume`, { method: "POST" });
      const r2 = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery`);
      if (r2.ok) setBattInfo(await r2.json());
    } finally { setResuming(false); }
  };

  // Auto-save collision preventer whenever any value changes (debounced 600 ms)
  React.useEffect(() => {
    if (!serial) return;
    if (csHydratedSerialRef.current !== serial) return;
    if (csSaveRef.current) clearTimeout(csSaveRef.current);
    csSaveRef.current = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-preventer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: csEnabled, restMinMin: csMinMin, restMinMax: csMinMax }),
      }).catch(() => {});
    }, 600);
    // Do not cancel this timer on unmount. PhoneSettingsPanel is intentionally
    // tab-scoped, so cancelling here loses edits when the user clicks away
    // during the debounce window.
  }, [serial, csEnabled, csMinMin, csMinMax]);
  // Auto-save Google Play credentials (debounced 800 ms)
  const gpSaveRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpInitRef = React.useRef(false);
  React.useEffect(() => {
    if (!serial) return;
    if (!gpInitRef.current) { gpInitRef.current = true; return; }
    if (gpSaveRef.current) clearTimeout(gpSaveRef.current);
    gpSaveRef.current = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/device-settings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ googlePlayEmail: gpEmail, googlePlayPassword: gpPassword }),
      }).catch(() => {});
    }, 800);
    return () => { if (gpSaveRef.current) clearTimeout(gpSaveRef.current); };
  }, [serial, gpEmail, gpPassword]);

  const ctrl     = battInfo?.chargingControl;
  const sched    = battInfo?.schedule;
  const isReal   = ctrl?.supported === true;
  const notReal  = ctrl?.probed && ctrl?.supported === false;
  const isActive = sched?.running ?? false;

  const fmtStorage = (mb: number | null) => {
    if (!mb) return null;
    return mb >= 1024 ? `${(mb / 1024).toFixed(0)} GB` : `${mb} MB`;
  };
  const fmtRam = (mb: number | null) => {
    if (!mb) return null;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">

      {/* ── Device Quick Controls ────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/* Standby */}
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={handleStandby}
            disabled={!serial}
            title={screenOn ? "Put device to sleep" : "Wake device"}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md
              ${screenOn
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-red-500/30 hover:bg-red-500/50 text-red-400 ring-2 ring-red-500/40"}`}
          >
            <Power className="w-5 h-5" />
          </button>
          <span className="text-[10px] text-muted-foreground">{screenOn ? "Standby" : "Wake"}</span>
        </div>

        {/* Restart */}
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={handleReboot}
            disabled={!serial || rebooting}
            title="Restart device"
            className="w-12 h-12 rounded-full flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md bg-green-500 hover:bg-green-600 text-white"
          >
            <RotateCcw className={`w-5 h-5 ${rebooting ? "animate-spin" : ""}`} />
          </button>
          <span className="text-[10px] text-muted-foreground">{rebooting ? "Restarting…" : "Restart"}</span>
        </div>

        {/* Brightness */}
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={handleBrightness}
            disabled={!serial}
            title={`Brightness: ${brightLabel} — click to cycle (0% → 50% → 100% → 0%)`}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md
              ${brightStep === 0
                ? "bg-white/10 border border-white/20 text-white/30 hover:bg-white/15"
                : brightStep === 1
                ? "bg-white/60 text-gray-700 hover:bg-white/70"
                : "bg-white text-gray-900 hover:bg-gray-100"}`}
          >
            <Sun className="w-5 h-5" />
          </button>
          <span className="text-[10px] text-muted-foreground">{brightLabel}</span>
        </div>
      </div>

      {/* ── Typing Speed Profile ─────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Typing Speed Profile</p>
          <p className="text-xs text-muted-foreground">Per-device typing timing and human-error simulation. Values are applied to every calibrated keyboard entry.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {([
            ["minMs", "Typing speed: X min (ms)"],
            ["maxMs", "Typing speed: Y max (ms)"],
            ["errorPercentMin", "Error causality: X min (%)"],
            ["errorPercentMax", "Error causality: Y max (%)"],
            ["dwellMinMs", "Dwell time per tap: X min (ms)"],
            ["dwellMaxMs", "Dwell time per tap: Y max (ms)"],
            ["hesitationMinMs", "Hesitation: X min (ms)"],
            ["hesitationMaxMs", "Hesitation: Y max (ms)"],
          ] as const).map(([key, label]) => (
            <label key={key} className="text-xs text-muted-foreground">{label}
              <input type="number" min={key.startsWith("dwell") ? 1 : 0} max={key.startsWith("error") ? 100 : undefined}
                value={typingSpeedProfile[key]}
                onChange={e => saveTypingSpeedProfile({ ...typingSpeedProfile, [key]: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
            </label>
          ))}
        </div>
      </div>

      {/* ── Swipe Gesture ────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Swipe Gesture</p>
            <p className="text-xs text-muted-foreground">Per-device swipe path. Resolution: {swipeResolution.w} × {swipeResolution.h}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => setSwipeOpen(true)} disabled={!serial}>Configure</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Configure and test the swipe inside a resolution-matched preview. Tests use the saved path on the connected device.
        </p>
      </div>

      {swipeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSwipeOpen(false)}>
          <div className="w-full max-w-[590px] rounded-xl border border-border bg-card p-5 space-y-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div />
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setSwipeOpen(false)}>✕</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] gap-5 items-start">
              <div className="order-2 md:order-1 space-y-4">
                <div className="text-center space-y-1">
                  <p className="text-base font-semibold text-foreground">Swipe Gesture Preview</p>
                  <p className="text-xs text-muted-foreground">{swipeResolution.w} × {swipeResolution.h} logical resolution</p>
                  <p className="pt-2 text-xs text-muted-foreground">Drag either endpoint or the line to set the swipe coordinates automatically.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(["x1", "y1", "x2", "y2", "durationMinMs", "durationMaxMs", "jitterX", "jitterY", "startJitterMinY", "startJitterMaxY", "pauseMinMs", "pauseMaxMs", "settleMinMs", "settleMaxMs", "accelerationPct", "decelerationPct"] as const).map(key => (
                    <label key={key} className="text-center text-xs text-muted-foreground">{key}
                      <input type="number"
                        value={swipeGesture[key]} onChange={e => saveSwipeGesture({ ...swipeGesture, [key]: Number(e.target.value) })}
                        className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-center text-sm text-foreground" />
                    </label>
                  ))}
                </div>
                <div className="flex justify-center gap-2">
                  <Button type="button" variant="outline" onClick={() => setSwipeOpen(false)}>Done</Button>
                  <Button type="button" onClick={testSwipeGesture} disabled={swipeTesting || swipeSaving}>{swipeTesting ? "Testing…" : "Test swipe"}</Button>
                </div>
              </div>
              <div className="order-1 md:order-2 flex justify-center">
                <div className="relative border-2 border-border bg-muted/30 rounded-lg overflow-hidden" style={{ width: 260, height: Math.min(520, 260 * swipeResolution.h / swipeResolution.w) }}>
                  <svg ref={swipeCanvasRef} viewBox={`0 0 ${swipeResolution.w} ${swipeResolution.h}`} className="absolute inset-0 h-full w-full touch-none"
                    onPointerMove={updateSwipeFromPointer} onPointerUp={finishSwipeDrag} onPointerCancel={finishSwipeDrag}>
                    <line x1={swipeGesture.x1} y1={swipeGesture.y1} x2={swipeGesture.x2} y2={swipeGesture.y2}
                      stroke="currentColor" strokeWidth={Math.max(8, swipeResolution.w / 90)} strokeLinecap="round"
                      opacity={swipeProgress === null ? 0.7 : 0.25} className="cursor-move"
                      onPointerDown={e => startSwipeDrag("line", e)} />
                    <circle cx={swipeGesture.x1} cy={swipeGesture.y1} r={swipeResolution.w / 45} fill="hsl(var(--primary))"
                      className="cursor-grab" onPointerDown={e => startSwipeDrag("start", e)} />
                    <circle cx={swipeGesture.x2} cy={swipeGesture.y2} r={swipeResolution.w / 45} fill="hsl(var(--destructive))"
                      className="cursor-grab" onPointerDown={e => startSwipeDrag("end", e)} />
                    {swipeProgress !== null && (
                      <circle
                        cx={(swipeTestPath ?? swipeGesture).x1 + ((swipeTestPath ?? swipeGesture).x2 - (swipeTestPath ?? swipeGesture).x1) * swipeProgress}
                        cy={(swipeTestPath ?? swipeGesture).y1 + ((swipeTestPath ?? swipeGesture).y2 - (swipeTestPath ?? swipeGesture).y1) * swipeProgress}
                        r={swipeResolution.w / 32}
                        fill="hsl(var(--primary))"
                        stroke="white"
                        strokeWidth={Math.max(4, swipeResolution.w / 180)}
                      />
                    )}
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── App Close Gesture ───────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-foreground">App Close Gesture</p>
        <p className="text-xs text-muted-foreground">
          How to dismiss Instagram in the recents screen at the end of each automation cycle.
          Different Android launchers require different gestures.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={dismissDir}
            onChange={e => saveDismissDir(e.target.value as "auto" | "left" | "up")}
            disabled={!serial || dismissSaving}
            className="text-sm bg-background border border-border rounded px-3 py-1.5 text-foreground disabled:opacity-50"
          >
            <option value="auto">Auto — detect by model</option>
            <option value="left">Swipe left</option>
            <option value="up">Swipe up</option>
          </select>
          {dismissSaving && <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>}
        </div>
      </div>

      {/* ── SIM Card ────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">SIM Card</p>
          <Button type="button" size="sm" variant="ghost" onClick={loadDeviceSpec} disabled={specLoading}
            className="h-7 text-xs gap-1.5">
            <RefreshCw className={`w-3 h-3 ${specLoading ? "animate-spin" : ""}`} />
            {specLoading ? "Detecting…" : "Refresh"}
          </Button>
        </div>
        {deviceSpec && deviceSpec.sims?.length > 0 ? (
          <div className="space-y-2">
            {deviceSpec.sims.map(sim => (
              <div key={sim.slot} className="flex items-center gap-3 rounded-lg bg-muted/30 px-3 py-2.5">
                <CardSim className="w-8 h-8 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    SIM {sim.slot + 1}{sim.carrier ? ` · ${sim.carrier}` : ""}
                  </p>
                  <input
                    type="tel"
                    maxLength={15}
                    className="mt-1 w-36 text-xs rounded border border-border bg-background px-2 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="Enter phone number"
                    value={simPhoneInputs[sim.slot] ?? ""}
                    onChange={e => setSimPhoneInputs(prev => ({ ...prev, [sim.slot]: e.target.value }))}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            {specLoading ? "Detecting SIM cards…" : serial ? "No SIM detected — tap Refresh to try again." : "No device connected."}
          </p>
        )}
      </div>

      {/* ── My Device Spec ──────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">My Device Spec</p>
          {specLoading && <span className="text-xs text-muted-foreground animate-pulse">Auto-detecting…</span>}
        </div>
        {deviceSpec ? (() => {
          const rows: [string, string | null][] = [
            ["Manufacturer", deviceSpec.manufacturer],
            ["Model",        deviceSpec.model],
            ["Brand",        deviceSpec.brand],
            ["Android",      deviceSpec.androidVersion ? `Android ${deviceSpec.androidVersion} (SDK ${deviceSpec.sdkInt})` : null],
            ["CPU / ABI",    deviceSpec.cpuAbi],
            ["Hardware",     deviceSpec.hardware],
            ["Screen",       deviceSpec.resolution ? `${deviceSpec.resolution.w}×${deviceSpec.resolution.h} @ ${deviceSpec.density}dpi` : null],
            ["RAM",          fmtRam(deviceSpec.ramMb)],
            ["Storage",      fmtStorage(deviceSpec.storageTotalMb)],
            ["Kernel",       deviceSpec.kernel],
            ["Build Date",   deviceSpec.buildDate],
          ].filter(([, v]) => v) as [string, string][];
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {rows.map(([label, value]) => (
                  <div key={label}>
                    <p className="text-[10px] font-bold text-foreground uppercase tracking-wider">{label}</p>
                    <p className="text-xs text-foreground font-normal mt-0.5 break-all">{value}</p>
                  </div>
                ))}
              </div>
              {deviceSpec.buildFingerprint && (
                <div>
                  <p className="text-[10px] font-bold text-foreground uppercase tracking-wider">Build Fingerprint</p>
                  <p className="text-xs text-foreground font-normal mt-0.5 break-all">{deviceSpec.buildFingerprint}</p>
                </div>
              )}
            </div>
          );
        })() : (
          <p className="text-xs text-muted-foreground italic">
            {specLoading ? "Auto-detecting hardware…" : serial ? "Tap Refresh on the SIM Card section to detect specs." : "No device connected."}
          </p>
        )}
      </div>

      <h2 className="text-lg font-bold text-foreground">Phone Settings</h2>

      {/* ── Collision Preventer ────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        {/* Title row — always visible */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Collision Preventer</p>
            {!csEnabled && (
              <p className="text-xs text-muted-foreground mt-1">
                Prevents two account slots from running at the same time on this device. Enable to configure.
              </p>
            )}
          </div>
          <Switch checked={csEnabled} onCheckedChange={setCsEnabled} />
        </div>

        {/* Collapsed when off — only title + toggle shown above */}
        {csEnabled && (
          <>
            <p className="text-xs text-muted-foreground">
              Slots queue up and run one at a time, with a configurable rest between each, prioritising whichever has been waiting longest.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground block text-center">Rest between slots (min)</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={60} value={csMinMin}
                    onChange={e => setCsMinMin(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))}
                    className="w-20 text-center" />
                  <span className="text-muted-foreground text-sm">to</span>
                  <Input type="number" min={0} max={60} value={csMinMax}
                    onChange={e => setCsMinMax(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))}
                    className="w-20 text-center" />
                  <span className="text-muted-foreground text-sm">minutes</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Battery Charging Control ───────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        {/* Title row — always visible */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Stop Charging for X minutes every Y hours</p>
            {!enabled && (
              <p className="text-xs text-muted-foreground mt-1">
                Pause the physical charging current on a repeating schedule to protect battery health, while keeping USB connected for ADB.
              </p>
            )}
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {/* Collapsed when off — only title + toggle shown above */}
        {enabled && (
          <>
            {/* ── Device support status ─────────────────────────────── */}
            <div className="rounded-lg border border-border bg-background p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-foreground uppercase tracking-wider">Device Support</p>
                <Button type="button" variant="secondary" size="sm" onClick={handleProbe}
                  disabled={probing || !serial} className="h-7 text-xs px-3">
                  {probing ? "Probing…" : "Check Device"}
                </Button>
              </div>

              {!ctrl?.probed ? (
                <p className="text-xs text-muted-foreground">Click "Check Device" to test what this phone supports.</p>
              ) : isReal ? (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-green-500">✅ Real charging control — physically stops charging</p>
                  <p className="text-[11px] text-muted-foreground font-mono">{ctrl.path}{ctrl.needsRoot ? " · root required" : " · no root needed"}</p>
                  <p className="text-[11px] text-muted-foreground">Writing <code className="font-mono">0</code> to this sysfs node cuts current to the charging IC. USB data stays active. This is the real thing — battery level actually drops while stopped.</p>
                </div>
              ) : notReal ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-amber-500">⚠️ Real charging control not available on this device</p>
                  <p className="text-[11px] text-muted-foreground">{ctrl.failReason}</p>
                  <div className="rounded-md bg-muted/50 p-3 space-y-1.5 text-[11px] text-muted-foreground">
                    <p className="font-semibold text-foreground text-xs">Hardware option (universal):</p>
                    <p>A smart USB hub with per-port power switching (e.g. <strong>Plugable USB3-HUB7C</strong>, <strong>Acroname USBHub3+</strong>) cuts the 5V VBUS pin on command while keeping D+/D− data lines live. Software on the Windows side sends a USB host-controller request — completely device-agnostic, no root. This is the only guaranteed solution when the kernel doesn't expose a charging sysfs node.</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">The schedule below will fall back to <strong>app-level spoof only</strong> (Instagram sees "not charging" but physical charging continues).</p>
                </div>
              ) : null}

              {probeMsg && <p className="text-xs text-muted-foreground">{probeMsg}</p>}
            </div>

            {/* ── Live battery status ───────────────────────────────── */}
            {!serial ? (
              <p className="text-xs text-muted-foreground">No device connected.</p>
            ) : battError ? (
              <p className="text-xs text-destructive">{battError}</p>
            ) : battInfo ? (
              <div className="flex items-center gap-4 text-xs flex-wrap">
                <span className="text-muted-foreground">
                  Battery: <span className="font-mono font-semibold text-foreground">{battInfo.level}%</span>
                </span>
                <span className="text-muted-foreground">
                  Status: <span className="font-mono text-foreground">{battInfo.status}</span>
                </span>
                <span className="text-muted-foreground">
                  Plugged: <span className="font-mono text-foreground">{battInfo.plugged}</span>
                </span>
                <span className="text-muted-foreground">
                  Temp: <span className="font-mono text-foreground">{battInfo.temperatureC}°C</span>
                </span>
                {isActive && (
                  <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-500 font-semibold">
                    {isReal ? "⚡ Charging stopped" : "👁 App spoof active"}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading battery info…</p>
            )}

            {/* ── Schedule controls ─────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground block text-center">Stop charging for (minutes)</Label>
                <Input type="number" min={1} max={1440} value={unplugMinutes}
                  onChange={e => setUnplugMinutes(Math.max(1, parseInt(e.target.value) || 1))} className="w-full" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground block text-center">Every (hours)</Label>
                <Input type="number" min={0.5} max={24} step={0.5} value={cycleHours}
                  onChange={e => setCycleHours(Math.max(0.5, parseFloat(e.target.value) || 0.5))} className="w-full" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground block text-center">
                  {isReal ? "App-visible level (%) — cosmetic only" : "Show battery level (%) while stopped"}
                </Label>
                <Input type="number" min={1} max={100} value={spoofLevel}
                  onChange={e => setSpoofLevel(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} className="w-full" />
              </div>
            </div>

            {sched?.nextAt && enabled && (
              <p className="text-xs text-muted-foreground">
                Next stop window: {new Date(sched.nextAt).toLocaleTimeString()}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={handleSave} disabled={saving || !serial}>
                {saving ? "Saving…" : "Save Schedule"}
              </Button>
              <Button type="button" variant="secondary" onClick={handleStopNow} disabled={stopping || !serial}>
                {stopping ? "Stopping…" : isReal ? "Stop Now" : "Spoof Now"}
              </Button>
              <Button type="button" variant="secondary" onClick={handleResumeNow} disabled={resuming || !serial}>
                {resuming ? "Resuming…" : "Resume Now"}
              </Button>
              {saveMsg && <span className="text-xs text-muted-foreground">{saveMsg}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Action Log Panel ─────────────────────────────────────────────────────────

function ActionLogPanel({ lines, onClear }: { lines: string[]; onClear: () => void }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [lines.length]);

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(lines.join("\n")); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = lines.join("\n");
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `equinox-action-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col p-6">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-lg font-bold text-foreground">Action Log</h2>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={handleCopy} disabled={lines.length === 0}>
            {copied ? "Copied!" : "📄 Copy"}
          </Button>
          <Button type="button" variant="secondary" onClick={handleExport} disabled={lines.length === 0}>
            💾 Export
          </Button>
          <Button type="button" variant="secondary" onClick={onClear} disabled={lines.length === 0}>
            Clear
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto bg-white border border-border rounded-xl p-3 text-[12px] leading-relaxed text-gray-900">
        {lines.length === 0
          ? <p className="text-gray-400">No actions recorded yet — likes, follows, scrolls, shares and other automation actions will appear here.</p>
          : lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all py-0.5 border-b border-gray-100 last:border-0">{l}</div>)
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Metrics Panel ────────────────────────────────────────────────────────────

interface DbSlotStats {
  daily: Record<string, number>;
  lifetime: Record<string, number>;
}

function MetricsPanel({ serial, actionLogLines }: { serial: string | null; actionLogLines: string[] }) {
  const [slotUsernames, setSlotUsernames] = useState<string[]>([]);
  const [dbStats, setDbStats] = useState<Record<string, DbSlotStats>>({});

  // Load configured slot usernames from the server whenever the phone changes.
  useEffect(() => {
    if (!serial) { setSlotUsernames([]); return; }
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`)
      .then(r => r.json())
      .then(d => setSlotUsernames((d?.slots ?? []).map((s: any) => s?.username ?? "").filter(Boolean)))
      .catch(() => {});
  }, [serial]);

  // Poll DB stats for all configured slot usernames — refreshes every 60 s.
  // Stats are persisted after every cycle so they survive software restarts.
  useEffect(() => {
    if (slotUsernames.length === 0) { setDbStats({}); return; }
    let cancelled = false;
    const load = () => {
      Promise.all(
        slotUsernames.map(u =>
          fetch(`/api/mobile/slot-stats?username=${encodeURIComponent(u)}`)
            .then(r => r.json())
            .then(d => [u, d.ok ? { daily: d.daily ?? {}, lifetime: d.lifetime ?? {} } : null] as const)
            .catch(() => [u, null] as const)
        )
      ).then(results => {
        if (cancelled) return;
        const next: Record<string, DbSlotStats> = {};
        for (const [u, d] of results) { if (d) next[u] = d; }
        setDbStats(next);
      });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [slotUsernames]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also surface usernames seen in the action log but not yet in the slot config.
  const extraUsernames = useMemo(() => {
    const configured = new Set(slotUsernames);
    const seen = new Set<string>();
    const extra: string[] = [];
    for (const line of actionLogLines) {
      const m = line.match(/@(\S+)\s*—\s*Cycle complete/);
      if (!m) continue;
      const u = m[1];
      if (!configured.has(u) && !seen.has(u)) { seen.add(u); extra.push(u); }
    }
    return extra;
  }, [actionLogLines, slotUsernames]);

  const allUsernames = useMemo(() => [...slotUsernames, ...extraUsernames], [slotUsernames, extraUsernames]);

  const METRIC_DEFS: { label: string; dbKey: string }[] = [
    { label: "Cycles",       dbKey: "cycles"      },
    { label: "Likes",        dbKey: "likes"       },
    { label: "Follows",      dbKey: "follows"     },
    { label: "Story Views",  dbKey: "stories"     },
    { label: "Reels Viewed", dbKey: "reels"       },
    { label: "DMs Sent",     dbKey: "dms"         },
    { label: "Feed Shares",  dbKey: "feed_shares" },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <h2 className="text-lg font-bold text-foreground">Metrics</h2>
      {allUsernames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts configured yet.</p>
      ) : allUsernames.map(username => {
        const db = dbStats[username];
        return (
          <div key={username} className="bg-card border border-border rounded-xl p-5 space-y-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">@{username}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {METRIC_DEFS.map(({ label, dbKey }) => {
                const today   = db?.daily?.[dbKey]    ?? 0;
                const allTime = db?.lifetime?.[dbKey] ?? 0;
                return (
                  <div key={label} className="bg-background border border-border rounded-lg p-3 flex flex-col gap-1.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
                    <div className="space-y-1 mt-0.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground/60">Today</span>
                        <span className="text-base font-bold text-foreground tabular-nums">{today > 0 ? today : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground/60">All Time</span>
                        <span className="text-base font-bold text-primary/80 tabular-nums">{allTime > 0 ? allTime : "—"}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Debugging Log Panel ───────────────────────────────────────────────────────

function LogPanel({ lines, onClear, serial, onScanTray, addLog, getVideoSize, logRecMode, onToggleLogRec, logMarkers, phoneDims, inspectMode, onToggleInspect, onBack }: {
  lines: string[];
  onClear: () => void;
  serial?: string | null;
  /** Returns the captured lines so LogPanel can offer Copy Capture / Save. */
  onScanTray?: () => Promise<string[]>;
  /** Called when the user presses ← — restores the exact location they came from. */
  onBack?: () => void;
  addLog?: (msg: string) => void;
  /** Returns the mirror's current decoded video frame size, or null before
   *  the stream has produced a frame / while off. Used by Check Screen Info
   *  to show the video's actual dimensions next to `wm size`, since that's
   *  otherwise only visible transiently in the scrolling log ("Frame WxH")
   *  and disappears once the stream reconnects or the log scrolls past it. */
  getVideoSize?: () => { w: number; h: number } | null;
  /** True while Log Record mode is active — mirror clicks place expectation
   *  markers instead of tapping the phone. */
  logRecMode?: boolean;
  /** Toggle Log Record on/off. */
  onToggleLogRec?: () => void;
  /** The accumulated markers (expected + bot) from the current recording. */
  logMarkers?: LogMarker[];
  /** Phone screen size, needed to annotate the exported JSON. */
  phoneDims?: { w: number; h: number } | null;
  /** True while Inspect mode is active — hovering the mirror highlights elements. */
  inspectMode?: boolean;
  /** Toggle Inspect on/off. */
  onToggleInspect?: () => void;
}) {
  const bottomRef  = useRef<HTMLDivElement>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const pinnedRef  = useRef(true); // true = auto-scroll to bottom; false = user scrolled up
  const [scanning,       setScanning]       = React.useState(false);
  const [copied,         setCopied]         = React.useState(false);
  const [copiedCapture,  setCopiedCapture]  = React.useState(false);
  const [lastCapture,    setLastCapture]    = React.useState<string[] | null>(null);
  const [checkingInfo,   setCheckingInfo]   = React.useState(false);
  const [expandedLogGroups, setExpandedLogGroups] = React.useState<Set<string>>(() => new Set());

  // Only auto-scroll when the user is already at (or near) the bottom.
  useEffect(() => {
    if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [lines.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "at bottom" when within 60px of the end.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const handleCheckScreenInfo = async () => {
    if (!serial) return;
    setCheckingInfo(true);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/screen-info`);
      const body = await r.json();
      if (!r.ok) { addLog?.(`Screen info failed: ${body?.error ?? r.status}`); return; }
      addLog?.(`── wm size ──`);
      for (const line of String(body.sizeRaw ?? "").split("\n")) if (line.trim()) addLog?.(line.trim());
      addLog?.(`── wm density ──`);
      for (const line of String(body.densityRaw ?? "").split("\n")) if (line.trim()) addLog?.(line.trim());
      // `wm size` alone can't tell you whether the MIRROR is actually using
      // that resolution — the video stream (screenrecord) frequently picks a
      // different, encoder-friendly size on its own. Print the live decoded
      // frame size right next to it so a mismatch (or a "no video yet — is
      // Live on?" gap) is visible in one place instead of scrolling past in
      // the log or requiring you to hunt Android's own settings for it.
      const vs = getVideoSize?.() ?? null;
      addLog?.(`── mirror video stream ──`);
      addLog?.(vs ? `Decoded frame: ${vs.w}x${vs.h}` : `No frame decoded yet — turn Live on and wait for the mirror to connect, then re-run Check Screen Info.`);
      // A video/device size (or aspect-ratio) mismatch here is expected and
      // NOT a bug on its own — Android's screen capture never stretches the
      // real screen to fill a differently-shaped recording buffer, it
      // letterboxes/pillarboxes (centers the real content, pads the rest
      // with black). Every tap/swipe is already corrected for this
      // server-side (rescales through the real content sub-rect, not the
      // raw buffer) — this line is just so the numbers not matching doesn't
      // look alarming on its own.
      if (vs && body.physical && (vs.w !== body.physical.w || vs.h !== body.physical.h)) {
        addLog?.(`ℹ️ Video size differs from wm size — normal. Android's screen capture never stretches to fit; it letterboxes/pillarboxes the real screen inside the recording buffer, and taps are already rescaled through the real content area, not the raw buffer.`);
      }
      if (body.override) {
        addLog?.(`ℹ️ Override size detected — phone is currently running at ${body.override.w}x${body.override.h} (physical: ${body.physical?.w ?? "?"}x${body.physical?.h ?? "?"}). The code handles this automatically — no action needed.`);
      } else {
        addLog?.(`No resolution override active — the device is running at its native physical resolution.`);
      }
    } catch (e: any) { addLog?.(`Screen info error: ${e?.message ?? "network error"}`); }
    finally { setCheckingInfo(false); }
  };


  const writeToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

  const handleScan = async () => {
    if (!onScanTray) return;
    setScanning(true);
    try {
      const captured = await onScanTray();
      if (captured.length > 0) setLastCapture(captured);
    } finally { setScanning(false); }
  };

  /** Export the accumulated Log Record markers as a JSON file and stop. */
  const handleLogRecordStop = () => {
    if (logMarkers && logMarkers.length > 0) {
      const payload = {
        exportedAt:  new Date().toISOString(),
        serial:      serial ?? "unknown",
        phoneSize:   phoneDims ?? null,
        markerCount:   logMarkers.length,
        expectedCount: logMarkers.filter(m => m.type === "expected").length,
        vicinityCount: logMarkers.filter(m => m.type === "vicinity").length,
        botCount:      logMarkers.filter(m => m.type === "bot").length,
        markers:     logMarkers,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `equinox-log-record-${serial ?? "unknown"}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog?.(`📍 Log Record stopped — ${logMarkers.length} markers exported (${payload.expectedCount} expected, ${payload.botCount} bot).`);
    } else {
      addLog?.("📍 Log Record stopped — no markers to export.");
    }
    onToggleLogRec?.();
  };

  const handleCopyLog = async () => {
    await writeToClipboard(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExportLog = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `equinox-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyCapture = async () => {
    if (!lastCapture) return;
    await writeToClipboard(lastCapture.join("\n"));
    setCopiedCapture(true);
    setTimeout(() => setCopiedCapture(false), 1500);
  };

  const handleSaveCapture = () => {
    if (!lastCapture) return;
    const blob = new Blob([lastCapture.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `screen-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col p-6">
      <div className="flex flex-col gap-2 mb-3 shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-foreground">Debugging Log</h2>
          <div className="flex items-center gap-2">

            <Button
              type="button"
              variant="secondary"
              onClick={() => onBack ? onBack() : window.history.back()}
              title="Go back to the previous page"
              className="px-2"
            >
              ←
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onToggleInspect}
              disabled={!serial}
              title="Inspect mode — hover the phone mirror to see element info (Chrome DevTools style)"
              className={inspectMode ? "border-yellow-400/60 text-yellow-300 bg-yellow-400/10 hover:bg-yellow-400/20" : ""}
            >
              {inspectMode ? "🔍 Inspecting…" : "🔍 Inspect"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleCopyLog} disabled={lines.length === 0}>
              {copied ? "Copied!" : "📄 Copy"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleExportLog} disabled={lines.length === 0} title="Save the full log as a .txt file — browser Save As dialog will appear">
              💾 Export
            </Button>
            <Button type="button" variant="secondary" onClick={onClear} disabled={lines.length === 0}>
              Clear
            </Button>
          </div>
        </div>

      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto bg-black/90 border border-border rounded-xl p-3 font-mono text-[11px] leading-relaxed">
        {lines.length === 0
          ? <p className="text-white/30">No activity yet — taps, swipes, keys, and automation cycles will show up here.</p>
          : (() => {
            let currentTool: string | null = null;
             const timestampOf = (line: string) => line.match(/^\[([^\]]+)\]/)?.[1] ?? "";
             // Accessibility/XML dumps are often logged one node per line,
             // with a slightly different timestamp on each row. Treat a
             // consecutive run of those rows as one visual group too, or a
             // large dump can still fill the entire panel despite the
             // same-timestamp max-three-row rule.
             const isAccessibilityDumpLine = (line: string) =>
               /(?:\b(?:rid|resource-id|content-desc|bounds|class)=["'])|(?:android\.(?:widget|view)\.)/.test(line);
             const isInjectBrowsingBurstLine = (line: string) =>
               /\bInject Browsing:\s+(?:waiting for media to render|media .*?render|no .*?media)/i.test(line);
             const isStoryTrayBurstLine = (line: string) =>
               /\bStory tray:\s+/i.test(line);
             const isReelsBurstLine = (line: string) =>
               /\b(?:Reel|View Reels):\s+/i.test(line) ||
               /▶\s*View Reels\b/i.test(line);
             const groups: string[][] = [];
             for (const line of lines) {
               const previous = groups[groups.length - 1];
                const previousIsDump = previous?.some(isAccessibilityDumpLine) ?? false;
                const previousIsInjectBurst = previous?.some(isInjectBrowsingBurstLine) ?? false;
                const previousIsStoryTray = previous?.some(isStoryTrayBurstLine) ?? false;
                const previousIsReelsBurst = previous?.some(isReelsBurstLine) ?? false;
                if (
                  previous &&
                  previous.length > 0 &&
                  (
                    timestampOf(previous[0]) === timestampOf(line) ||
                    (previousIsDump && isAccessibilityDumpLine(line)) ||
                    (previousIsInjectBurst && isInjectBrowsingBurstLine(line)) ||
                    (previousIsStoryTray && isStoryTrayBurstLine(line)) ||
                    (previousIsReelsBurst && isReelsBurstLine(line))
                  )
                ) previous.push(line);
               else groups.push([line]);
             }
              const renderLine = (l: string, i: number, key: string, groupControl?: React.ReactNode) => {
              // Parse:  [HH:MM:SS AM/PM]  [Xm Ys / Xs]  message
              //         [HH:MM:SS AM/PM]               message   (no duration)
              const m   = l.match(/^\[([^\]]+)\]\s*(?:\[(\d+m \d+(?:\.\d+)?s|\d+(?:\.\d+)?s)\]\s*)?([\s\S]*)$/);
              const ts  = m?.[1] ?? '';
              const dur = m?.[2] ?? '';
              const msg = m ? (m[3] ?? '') : l;

              // Track the active tool from ▶ header lines so ALL sub-messages
              // that follow inherit the tool's colour (e.g. every explore
              // sub-action is green, not just lines that contain "Explore").
              if      (/▶ View Explore/.test(msg))    currentTool = 'explore';
              else if (/▶ View Feed/.test(msg))       currentTool = 'feed';
              else if (/▶ View Reels/.test(msg))      currentTool = 'reels';
              else if (/▶.*[Ss]tories/.test(msg))     currentTool = 'stories';
              else if (/▶ Make a Post/.test(msg))     currentTool = 'makepost';
              else if (/▶ Follow Users/.test(msg))    currentTool = 'follow';
              else if (/▶ Random Actions/.test(msg))  currentTool = 'randomactions';
              else if (/^▶/.test(msg))                currentTool = null;
              if (/Cycle\s+(complete|failed|aborted)/i.test(msg)) currentTool = null;

              // Colour the message based on its tool / prefix.
              // Tool-specific colours take priority over general prefix colours.
              // System / untagged messages are white. Tool messages keep their tool colour.
               let msgClass = 'text-white';
               // Follow owns one color, including Spread Follow, inject
               // browsing, success, navigation, and failure lines. Keep this
               // ahead of generic ERROR/success rules so a Follow failure
               // cannot turn red or white and lose its tool identity.
               if      (currentTool === 'follow' ||
                        /\bFollow\b|\bfollowing\b|\bSpread Follow\b|\bInject Browsing\b/i.test(msg))
                                                                     msgClass = 'text-blue-400';
               else if (/\bView Feed\b|▶ View Feed/.test(msg))      msgClass = 'text-orange-400';
              else if (/\bView Explore\b|▶ View Explore|[Ee]xplore/.test(msg))
                                                                    msgClass = 'text-green-400';
              else if (/[Rr]eel/.test(msg))                          msgClass = 'text-rose-500';
              else if (/▶.*[Ss]tories|\b[Ss]tories\b/.test(msg))  msgClass = 'text-cyan-400';
              else if (/\bMake a Post\b|▶ Make a Post/.test(msg))  msgClass = 'text-purple-400';
              else if (/\bRandom Actions\b|▶ Random Actions|^jitter-/.test(msg)) msgClass = 'text-purple-400';
              else if (/Switching to Instagram account|account switcher|Long-pressing profile tab|Profile tab found/.test(msg))
                                                                    msgClass = 'text-amber-400';
              else if (/^(ERROR|FAILED|✗)/.test(msg))              msgClass = 'text-rose-500';
              else if (/^⚠/.test(msg))                             msgClass = 'text-yellow-400';
              else if (/^[✓✅]/.test(msg))                         msgClass = 'text-white/90';
              else if (/shuffled/.test(msg))                       msgClass = 'text-blue-400';
              else if (/^▶/.test(msg))                             msgClass = 'text-white/90';
              // Sub-messages: fall back to the active tool's colour.
              else if (currentTool === 'explore')  msgClass = 'text-green-400';
              else if (currentTool === 'feed')     msgClass = 'text-orange-400';
              else if (currentTool === 'reels')    msgClass = 'text-rose-500';
              else if (currentTool === 'stories')  msgClass = 'text-cyan-400';
              else if (currentTool === 'makepost')      msgClass = 'text-purple-400';
              else if (currentTool === 'follow')        msgClass = 'text-blue-400';
              else if (currentTool === 'randomactions') msgClass = 'text-purple-400';

                return (
                  <div key={key} className="flex min-w-0 py-[1px]">
                  <span className="text-white whitespace-nowrap shrink-0 select-none w-[5rem]">[{ts}]</span>
                   <span className="w-4 shrink-0 inline-flex items-center justify-center">
                     {groupControl}
                   </span>
                   <span className="shrink-0 whitespace-nowrap text-white w-[5rem]">{dur ? `[${dur}]` : ''}</span>
                  <span className={`flex-1 min-w-0 break-words ${msgClass}`}>{msg}</span>
                </div>
              );
             };
              return groups.map((group, groupIndex) => {
                // Keep ordinary same-timestamp groups compact, but show only
                // the summary/header for Reels bursts. Reels often immediately
                // emit a very large accessibility/XML dump; showing three
                // rows still exposed that clutter before the chevron.
                const isReelsGroup = group.some(isReelsBurstLine);
                const visibleRowCount = isReelsGroup ? 1 : 3;
                const collapsible = group.length > visibleRowCount;
               const groupKey = `${groupIndex}:${timestampOf(group[0])}`;
               const expanded = expandedLogGroups.has(groupKey);
               if (!collapsible || expanded) {
                 return (
                   <React.Fragment key={groupKey}>
                      {group.map((line, index) => renderLine(
                        line,
                        index,
                        `${groupKey}:${index}`,
                         index === visibleRowCount - 1 && collapsible ? (
                          <button
                            type="button"
                            aria-label={`Collapse ${group.length} log rows at ${timestampOf(group[0])}`}
                            title="Collapse same-timestamp log rows"
                            onClick={() => setExpandedLogGroups(prev => {
                              const next = new Set(prev);
                              next.delete(groupKey);
                              return next;
                            })}
                            className="inline-flex text-white/60 hover:text-white"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </button>
                        ) : undefined
                      ))}
                   </React.Fragment>
                 );
               }
                const collapsedContent = group.join("\n");
                return (
                  <React.Fragment key={groupKey}>
                    {/* Keep the complete group available to accessibility tools
                        and DOM-based readers while only the first rows are
                        painted. Copy/Export already use the source `lines`
                        array, so collapsing is presentation-only. */}
                    <pre
                      className="sr-only"
                      aria-label={`Collapsed log group containing ${group.length} rows`}
                      data-log-group-content={collapsedContent}
                    >
                      {collapsedContent}
                    </pre>
                    {group.slice(0, visibleRowCount).map((line, index) => renderLine(
                      line,
                      index,
                      `${groupKey}:visible:${index}`,
                      index === visibleRowCount - 1 ? (
                        <button
                          type="button"
                          aria-label={`Expand ${group.length} log rows at ${timestampOf(group[0])}`}
                            title={`Expand ${group.length} log rows — full content remains available to Copy and Export`}
                          onClick={() => setExpandedLogGroups(prev => new Set(prev).add(groupKey))}
                          className="inline-flex text-white/60 hover:text-white"
                        >
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      ) : undefined
                    ))}
                  </React.Fragment>
                );
             });
          })()
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TOTAL_SLOTS = 1;

type MobileTab = "account" | "browser" | "metrics" | "phonesettings" | "actionlog" | "log";
// Left-side tabs shown in order before the spacer.
const MOBILE_TABS_LEFT: { id: MobileTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "account",      label: "Accounts",  icon: Users       },
  { id: "browser",      label: "Browser",   icon: Globe       },
  { id: "metrics",      label: "Metrics",   icon: BarChart2   },
  { id: "phonesettings",label: "My Device", icon: Tablet      },
];
// Right-side tabs — pushed to the far right with ml-auto on the first one.
const MOBILE_TABS_RIGHT: { id: MobileTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "actionlog", label: "Action Log",    icon: ClipboardList },
  { id: "log",       label: "Debugging Log", icon: Bug           },
];
const LOG_MAX_LINES = 500;

/** Deterministic numeric browser-profile ID from a device serial.
 *  Kept in the 1,000,000–9,999,999 range to avoid collision with real DB profile IDs. */
function serialToBrowserId(serial: string): number {
  let h = 5381;
  for (let i = 0; i < serial.length; i++) {
    h = (((h << 5) + h) ^ serial.charCodeAt(i)) >>> 0;
  }
  return 1_000_000 + (h % 8_999_999);
}

// Regex for detecting bot automation taps in log lines.
// Matches "tapping … at (X,Y)" / "tapped … (X,Y)" patterns emitted by the
// automation engine.  Plain manual "Tap → (X,Y)" lines are deliberately
// excluded so user taps aren't double-counted as bot markers.
const BOT_TAP_RE = /tapp(?:ing|ed)[^\n(]*\((\d+),\s*(\d+)\)/i;

// Regex for filtering action-only lines into the Action Log tab.
// Matches automation action keywords emitted by the engine.
// Only cycle-level outcome lines go to the Action Log — no debug noise.
const ACTION_LOG_RE = /Cycle\s+(complete|failed|aborted)/i;

export function MobilePage() {
  // When navigated from the Phone Farm grid (/mobile/farm/:serial), only this
  // phone's serial is shown. When navigated directly (/mobile/farm with no
  // param) all connected phones are shown as before.
  const params = useParams<{ serial?: string }>();
  const targetSerial = params.serial ? decodeURIComponent(params.serial) : null;
  const search = useSearch();
  const initialSlot = (() => {
    const s = new URLSearchParams(search).get("slot");
    return s !== null ? Number(s) : null;
  })();

  const [data,    setData]    = useState<PhonesResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phoneDims, setPhoneDims] = useState<{ w: number; h: number } | null>(null);
  // Measured size of the pane the phone shell lives in — feeds PhoneSlot's
  // exact-fit sizing (see PhoneSlot's "Exact shell sizing" block). Must be
  // the real available box, not derived from CSS aspect-ratio math, or the
  // header/nav chrome eats into the phone-ratio budget again.
  // A plain useRef + `useEffect(..., [])` here would silently never attach:
  // this pane <div> is behind a loading/data gate, so on first mount (while
  // still loading) the ref is null, the effect bails out, and nothing ever
  // re-runs it once the div actually appears — paneSize stays null forever
  // and PhoneSlot's exact-fit sizing permanently falls back to "fill the
  // box", which is the pillarbox regression. A ref *callback* (via state)
  // re-fires whenever the element itself changes, including "was null, now
  // mounted", so it reliably attaches once the div exists.
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!paneEl) return;
    const measure = () => {
      const r = paneEl.getBoundingClientRect();
      setPaneSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);
  const [activeTab, setActiveTab] = useState<MobileTab>("account");

  // Metrics and Action Log are overview-level tabs. Once the user opens a
  // specific device from the Phone Farm grid, the screen is dedicated to that
  // device and those two tabs are not useful visually. Keep the tab state
  // intact for the farm overview, but never leave the detail view showing a
  // panel whose tab has been hidden.
  const deviceDetailView = !!targetSerial;
  useEffect(() => {
    if (deviceDetailView && (activeTab === "metrics" || activeTab === "actionlog")) {
      setActiveTab("account");
    }
  }, [deviceDetailView, activeTab]);

  // Derived phone/slot data — declared here so activeSerial is in scope for
  // all hooks below (useEffect dependency arrays are evaluated synchronously).
  const allPhones = data?.phones ?? [];
  const phones = targetSerial
    ? allPhones.filter(p => p.serial === targetSerial)
    : [...allPhones].sort((a, b) => a.serial.localeCompare(b.serial));
  const slots: (UsbPhone | null)[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => phones[i] ?? null);
  const activeSerial = slots[0]?.serial ?? null;
  const { navigateTo } = useBrowserWindows();
  const openBrowserProfile = useCallback((username: string) => {
    const cleanUsername = username.trim().replace(/^@+/, "");
    if (!cleanUsername || !activeSerial) return;
    setActiveTab("browser");
    navigateTo(
      serialToBrowserId(activeSerial),
      activeSerial,
      "",
      `https://www.instagram.com/${encodeURIComponent(cleanUsername)}/`,
    );
  }, [activeSerial, navigateTo]);

  // ── Device Browser proxy config ───────────────────────────────────────────
  const [browserProxyHostPort, setBrowserProxyHostPort] = useState("");
  const [browserProxyUser,     setBrowserProxyUser]     = useState("");
  const [browserProxyPass,     setBrowserProxyPass]     = useState("");
  const [browserProxySaving,   setBrowserProxySaving]   = useState(false);
  const [browserProxyError,    setBrowserProxyError]    = useState<string | null>(null);
  const [browserUseLocalIp,    setBrowserUseLocalIp]    = useState(false);

  useEffect(() => {
    if (!activeSerial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/browser-proxy`)
      .then(r => r.json())
      .then(d => {
        if (d.proxy?.useLocalIp) {
          setBrowserUseLocalIp(true);
          setBrowserProxyHostPort("");
          setBrowserProxyUser("");
          setBrowserProxyPass("");
        } else if (d.proxy) {
          setBrowserUseLocalIp(false);
          setBrowserProxyHostPort(`${d.proxy.host}:${d.proxy.port}`);
          setBrowserProxyUser(d.proxy.username ?? "");
          setBrowserProxyPass(d.proxy.password ?? "");
        } else {
          setBrowserUseLocalIp(false);
          setBrowserProxyHostPort("");
          setBrowserProxyUser("");
          setBrowserProxyPass("");
        }
      })
      .catch(() => {});
  }, [activeSerial]);

  const saveBrowserProxy = async () => {
    if (!activeSerial) return;
    setBrowserProxySaving(true);
    setBrowserProxyError(null);
    try {
      let payload: object;
      if (browserUseLocalIp) {
        payload = { useLocalIp: true };
      } else {
        const [host, portStr] = browserProxyHostPort.trim().split(":");
        const port = parseInt(portStr ?? "", 10);
        if (!host || !portStr || isNaN(port) || port < 1 || port > 65535) {
          setBrowserProxyError("Enter proxy as host:port (e.g. 192.168.1.254:29842)");
          return;
        }
        payload = { host, port, username: browserProxyUser, password: browserProxyPass };
      }
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/browser-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.ok) setBrowserProxyError(body?.error ?? "Save failed");
    } catch (e: any) {
      setBrowserProxyError(e?.message ?? "Network error");
    } finally {
      setBrowserProxySaving(false);
    }
  };

  // Remembers where the user was before opening the Debugging Log tab so the
  // ← back button can return them to the exact same location (tab + slot).
  const [prevLogLocation, setPrevLogLocation] = useState<{ tab: MobileTab; slotIdx: number | null } | null>(null);
  const accountPanelRef = useRef<AccountSettingsPanelHandle>(null);
  // Per-serial "user explicitly turned the live view on" flag. Visiting the
  // Mobile tab, or a phone simply being connected, must never by itself
  // start streaming/waking the device — only pressing Power (below) or the
  // automation toggle being enabled does.
  const [liveOn, setLiveOn] = useState<Record<string, boolean>>({});

  // ── Slot customizations (wallpaper + text layers) — persisted to localStorage
  const [slotCustom, setSlotCustom] = useState<Record<number, SlotCustomization>>(() => {
    try {
      const stored = localStorage.getItem('slot-customizations');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('slot-customizations', JSON.stringify(slotCustom)); }
    catch { /* quota exceeded — ignore */ }
  }, [slotCustom]);

  // ── Inspect state ───────────────────────────────────────────────────────────
  // Lifted here so the LogPanel button (sibling of PhoneSlot) can toggle it.
  const [inspectMode, setInspectMode] = useState(false);

  // ── Log Record state ────────────────────────────────────────────────────────
  const [logRecMode,    setLogRecMode]    = useState(false);
  const [logMarkers,    setLogMarkers]    = useState<LogMarker[]>([]);
  // Ref so addLog's stable useCallback closure can read current logRecMode
  // without going stale.
  const logRecModeRef = useRef(false);
  useEffect(() => { logRecModeRef.current = logRecMode; }, [logRecMode]);

  const addLogMarker = useCallback((m: LogMarker) => {
    setLogMarkers(prev => [...prev, m]);
  }, []);

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

  // Points at whichever rendered PhoneSlot corresponds to activeSerial, so
  // the Log tab (a sibling, not a child, of the mirror) can pull the live
  // decoded video frame size for Check Screen Info.
  const activeSlotRef = useRef<PhoneSlotHandle>(null);

  // Sticky phone: never pass null to AccountSettingsPanel due to transient USB
  // poll flickers. When phones[] empties briefly, keep the last seen phone so
  // phone?.serial stays stable → connectedKey doesn't increment → hydration
  // doesn't re-fire → run-loop timers stay alive.
  const stickySlot0Ref = useRef<UsbPhone | null>(null);
  if (slots[0] !== null) stickySlot0Ref.current = slots[0];

  // ── Global log state (persists regardless of which page is open) ────────────
  const {
    logLines,
    actionLogLines,
    addLog: _ctxAddLog,
    clearLogLines,
    clearActionLogLines,
  } = useDeviceLog(activeSerial);

  // Wrap the context addLog to preserve BOT_TAP_RE log-marker logic.
  const addLog = useCallback((msg: string) => {
    _ctxAddLog(msg);
    if (logRecModeRef.current) {
      const m = BOT_TAP_RE.exec(msg);
      if (m) {
        setLogMarkers(prev => [...prev, {
          x: parseInt(m[1], 10),
          y: parseInt(m[2], 10),
          t: Date.now(),
          type: "bot",
          label: msg.length > 80 ? msg.substring(0, 77) + "…" : msg,
        }]);
      }
    }
  }, [_ctxAddLog]);

  // True only while a slot's HST cycle is actively executing — bubbled up from
  // AccountSettingsPanel via onAnyEnabled (which checks s.running only).
  // Drops to false the moment all cycles stop → wallpaper/text returns.
  // This is one of exactly two conditions that turn the mirror on; the other
  // is the manual Power button (liveOn). Nothing else may activate the mirror.
  const [hstEnabled, setHstEnabled] = useState(false);
  // True while a Phone Apps cycle is actively executing — bubbled up from
  // AccountSettingsPanel via onPhoneAppsRunning. Activates the mirror alongside
  // hstEnabled and liveOn.
  const [phoneAppsRunning, setPhoneAppsRunning] = useState(false);

  // Drop any previously-learned aspect ratio when the connected device
  // changes (or disconnects) — otherwise a stale ratio from the last phone
  // can briefly letterbox the next one before its first frame arrives.
  useEffect(() => { setPhoneDims(null); }, [activeSerial]);

  // Tracks which account slot is open in the Human Session Tool, so the header title updates.
  const [openAccountSlot, setOpenAccountSlot] = useState<number | null>(null);

  // Fetch the farm slot index for the targeted serial so the header can
  // show "Phone Farm - Slot X - Device Name" instead of just "Phone Farm".
  const [farmSlotIndex, setFarmSlotIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!targetSerial) { setFarmSlotIndex(null); return; }
    fetch("/api/mobile/farm-devices")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { devices: Array<{ serial: string; slotIndex: number }> }) => {
        const dev = d.devices.find(dev => dev.serial === targetSerial);
        setFarmSlotIndex(dev?.slotIndex ?? null);
      })
      .catch(() => setFarmSlotIndex(null));
  }, [targetSerial]);

  // Forget "live" state for any serial that's no longer plugged in, so a
  // phone unplugged then reconnected (or a different phone reusing a slot)
  // always starts idle again instead of resuming a stream on its own.
  useEffect(() => {
    const connected = new Set(phones.map(p => p.serial));
    setLiveOn(prev => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [serial, on] of Object.entries(prev)) {
        if (connected.has(serial)) next[serial] = on; else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phones.map(p => p.serial).join(",")]);

  // Only true once we have real data AND either a phone is connected or one
  // of the setup panels needs to take over the whole content area.
  const showSplitView = !!(data && data.adbFound && !error && (phones.length > 0 || loading));

  // Resolved display info for the header when viewing a specific device.
  const targetPhone = targetSerial ? allPhones.find(p => p.serial === targetSerial) : null;
  const deviceFriendlyName = targetPhone
    ? ([targetPhone.manufacturer, targetPhone.marketName || targetPhone.model].filter(Boolean).join(" ") || targetSerial)
    : targetSerial;
  // Best-effort slot number: use farmSlotIndex once loaded, otherwise fall back
  // to the phone's index in the connected-phone list.
  const slotNum = farmSlotIndex ?? (targetSerial ? allPhones.findIndex(p => p.serial === targetSerial) + 1 || null : null);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      {/* h-screen + flex-col + overflow-hidden here (instead of the old
          overflow-y-auto page scroll) is required: it's what gives every
          descendant below a real, computed pixel height to stretch/percent
          against. Without it, "h-full" a few levels down silently resolves
          to 0 against an auto-height ancestor — which is why the phone used
          to render far down the page (extra collapsed space above it) and
          why taps landed on a zero-size element and did nothing. */}
      <main className="ml-[133px] flex-1 h-screen flex flex-col overflow-hidden">
        <LiveActivityTicker />
        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 relative flex items-center justify-end">
          {/* Title — absolutely centred in the bar, independent of button widths */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-3 pointer-events-auto">
              <FilledFarmIcon className="w-5 h-5" style={{ color: "#1AD2F2" }} />
              <h1 className="text-lg font-bold text-foreground">
                {targetSerial
                  ? openAccountSlot !== null
                    ? `Phone Farm - Slot ${openAccountSlot + 1} - ${deviceFriendlyName ?? targetSerial}`
                    : `Phone Farm - ${deviceFriendlyName ?? targetSerial}`
                  : "Phone Farm"}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => refresh(true)} disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
            </button>
          </div>
        </div>

        {/* Setup / error states — the only part of the page allowed to scroll */}
        {!showSplitView && (
          <div className="flex-1 min-h-0 overflow-y-auto p-6">
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

            {data && data.adbFound && phones.length === 0 && !loading && !error && (
              <NoPhonesPanel rawOutput={data.rawOutput} />
            )}
          </div>
        )}

        {/* Phone (left half, full height) + automation settings (right half) */}
        {/* ALWAYS MOUNTED — never use {showSplitView && ...} here.  The outer
            conditional would unmount AccountSettingsPanel (and every
            SlotHumanSessionView inside it) whenever the USB poll transiently
            returns 0 phones for the targeted serial.  That destroyed all
            automation run-loop timers on every 3-second USB poll flicker.
            Use CSS hiding instead so the hooks stay alive through any gap. */}
        <div className={showSplitView ? "flex-1 min-h-0 flex" : "hidden"}>
            <div ref={setPaneEl} className="w-1/2 h-full flex items-center justify-center p-4 min-h-0">
              {/* Hidden on the Browser tab — panel keeps its width so the
                  right-hand tab bar never shifts position. */}
              {activeTab !== "browser" && slots.map((phone, i) => (
                <PhoneSlot
                  key={i}
                  phone={phone}
                  idx={i}
                  onLog={addLog}
                  onDimensions={(w, h) => setPhoneDims({ w, h })}
                  phoneDims={phoneDims}
                  paneSize={paneSize}
                  // Mirror activates under exactly three conditions — nothing else:
                  //   • user clicked the Power button (liveOn) — manual override
                  //   • a HST cycle is actively executing right now (hstEnabled)
                  //   • a Phone Apps cycle is actively executing (phoneAppsRunning)
                  live={!!(phone && (liveOn[phone.serial] || hstEnabled || phoneAppsRunning))}
                  onPower={() => { if (phone) setLiveOn(s => ({ ...s, [phone.serial]: true })); }}
                  ref={phone?.serial === activeSerial ? activeSlotRef : undefined}
                  inspectMode={inspectMode}
                  logRecMode={logRecMode}
                  logMarkers={logMarkers}
                  onExpectedTap={(x, y, kind) => addLogMarker({ x, y, t: Date.now(), type: kind ?? "expected" })}
                  custom={slotCustom[i] ?? DEFAULT_SLOT_CUSTOM}
                  onCustomChange={c => setSlotCustom(prev => ({ ...prev, [i]: c }))}
                />
              ))}
            </div>
            <div className="w-1/2 border-l border-border h-full min-h-0 flex flex-col">
              <div className="shrink-0 flex items-center border-b border-border px-4">
                {MOBILE_TABS_LEFT.map(t => (
                  (!deviceDetailView || t.id !== "metrics") && (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(t.id);
                      if (t.id === "account") accountPanelRef.current?.backToSlots();
                    }}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                      activeTab === t.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}<t.icon className="w-3.5 h-3.5 opacity-70" />
                  </button>
                  )
                ))}
                <div className="flex-1" />
                {MOBILE_TABS_RIGHT.map(t => (
                  (!deviceDetailView || t.id !== "actionlog") && (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      if (t.id === "log") {
                        setPrevLogLocation({ tab: activeTab, slotIdx: openAccountSlot });
                      }
                      setActiveTab(t.id);
                    }}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                      activeTab === t.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}<t.icon className="w-3.5 h-3.5 opacity-70" />
                  </button>
                  )
                ))}
              </div>
              <div className="flex-1 min-h-0 relative">
                {/* Accounts panel: always mounted so each slot's automation
                    hook persists across tab switches and navigation. */}
                <div className={activeTab === "account" ? "h-full" : "hidden"}>
                  <AccountSettingsPanel ref={accountPanelRef} phone={stickySlot0Ref.current} addLog={addLog} onSlotChange={setOpenAccountSlot} initialSlot={initialSlot} onAnyEnabled={setHstEnabled} onPhoneAppsRunning={setPhoneAppsRunning} onOpenBrowserProfile={openBrowserProfile} />
                </div>
                {/* Browser tab — isolated ghost browser per device serial */}
                {/* Positioned absolutely so it spans the full split-view width
                    (left: -100% reaches the left edge of the split container)
                    while the tab bar above stays exactly where it is. */}
                <div
                  className={activeTab === "browser"
                    ? "absolute top-0 right-0 bottom-0 bg-background flex flex-col z-10"
                    : "hidden"}
                  style={{ left: "-100%" }}
                >
                    {/* Proxy config bar */}
                    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Proxy</span>
                      <input
                        type="text"
                        placeholder="host:port"
                        value={browserProxyHostPort}
                        onChange={e => setBrowserProxyHostPort(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-40 font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <input
                        type="text"
                        placeholder="Username"
                        value={browserProxyUser}
                        onChange={e => setBrowserProxyUser(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-28 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <input
                        type="password"
                        placeholder="Password"
                        value={browserProxyPass}
                        onChange={e => setBrowserProxyPass(e.target.value)}
                        disabled={browserUseLocalIp}
                        className="h-7 rounded border border-border bg-background px-2 text-xs w-28 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <button
                        type="button"
                        disabled={browserProxySaving || (!browserUseLocalIp && !browserProxyHostPort.trim())}
                        onClick={saveBrowserProxy}
                        className="h-7 px-3 rounded text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50"
                      >
                        {browserProxySaving ? "Saving…" : "Save"}
                      </button>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none ml-1">
                        <input
                          type="checkbox"
                          checked={browserUseLocalIp}
                          onChange={e => setBrowserUseLocalIp(e.target.checked)}
                          className="w-3.5 h-3.5 accent-primary"
                        />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Use local PC's IP</span>
                      </label>
                      {browserProxyError && (
                        <span className="text-xs text-destructive">{browserProxyError}</span>
                      )}
                    </div>
                    {/* Browser panel — fills remaining height */}
                    {activeSerial ? (
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <BrowserPanel
                          profileId={serialToBrowserId(activeSerial)}
                          userAgent=""
                          username={activeSerial}
                          embedded
                          forceStream
                        />
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                        No device connected
                      </div>
                    )}
                </div>
                {activeTab === "phonesettings" && (
                  <PhoneSettingsPanel serial={activeSerial} />
                )}
                {activeTab === "actionlog" && (
                  <ActionLogPanel
                    lines={actionLogLines}
                    onClear={clearActionLogLines}
                  />
                )}
                {activeTab === "metrics" && (
                  <MetricsPanel serial={activeSerial ?? null} actionLogLines={actionLogLines} />
                )}
                {activeTab === "log"     && (
                  <LogPanel
                    lines={logLines}
                    onClear={clearLogLines}
                    serial={activeSerial}
                    addLog={addLog}
                    getVideoSize={() => activeSlotRef.current?.getVideoSize() ?? null}
                    logRecMode={logRecMode}
                    onToggleLogRec={() => {
                      if (logRecMode) {
                        // Stopping: export happens inside LogPanel's handleLogRecordStop
                      } else {
                        // Starting: clear old markers
                        setLogMarkers([]);
                        addLog("📍 Log Record started — click the mirror to place expected-tap markers (cyan). Bot taps auto-marked orange.");
                      }
                      setLogRecMode(v => !v);
                    }}
                    logMarkers={logMarkers}
                    phoneDims={phoneDims}
                    inspectMode={inspectMode}
                    onToggleInspect={() => setInspectMode(v => !v)}
                    onScanTray={activeSerial ? async () => {
                      addLog("── Capturing screen layout… ──");
                      try {
                        const r = await fetch(`/api/mobile/devices/${encodeURIComponent(activeSerial)}/screen-layout-scan`);
                        const body = await r.json();
                        if (!r.ok) { addLog(`Capture failed: ${body?.error ?? r.status}`); return []; }
                        for (const line of (body.lines as string[])) addLog(line);
                        return body.lines as string[];
                      } catch (e: any) { addLog(`Capture error: ${e?.message ?? "network error"}`); return []; }
                    } : undefined}
                    onBack={prevLogLocation ? () => {
                      const { tab, slotIdx } = prevLogLocation;
                      setActiveTab(tab);
                      if (tab === "account") {
                        accountPanelRef.current?.backToSlot(slotIdx);
                      }
                    } : undefined}
                  />
                )}
              </div>
            </div>
          </div>
      </main>
    </div>
  );
}
