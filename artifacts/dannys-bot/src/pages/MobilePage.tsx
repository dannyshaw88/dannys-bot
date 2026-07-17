/**
 * Mobile Farm — USB Phone Management (4-slot single row, Electron-safe WS)
 */

import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, useMemo, type ReactNode } from "react";
import { useParams } from "wouter";
import { Sidebar, FilledFarmIcon } from "@/components/layout/Sidebar";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
  ChevronLeft, Home, LayoutGrid, Power, Volume2, VolumeX, Trash2,
  FolderOpen, Upload, Download, Fingerprint, ArrowLeft, Copy,
} from "lucide-react";

import { AnnexBDemuxer, spsToCodecString } from "@/lib/h264Stream";
import { ImageSettingsDialog, type ImageFilterSettings } from "@/components/tools/ImageSettingsDialog";

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

const LiveCanvas = React.memo(React.forwardRef<LiveCanvasHandle, { serial: string; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; inspectMode?: boolean; inspectNodes?: InspectNode[] | null; onInspectResult?: (r: InspectResult) => void; onHoverNode?: (n: InspectNode | null) => void; clickTestMode?: boolean; logRecMode?: boolean; logMarkers?: LogMarker[]; onExpectedTap?: (x: number, y: number, kind?: "expected" | "vicinity") => void }>(function LiveCanvas({ serial, onLog, onDimensions, inspectMode, inspectNodes, onInspectResult, onHoverNode, clickTestMode, logRecMode, logMarkers, onExpectedTap }, ref) {
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
            addLog("10s timeout — no frames received. Unlock screen?");
            setStatus("error");
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

  useEffect(() => {
    return () => { if (pendingSingleTapRef.current) clearTimeout(pendingSingleTapRef.current.timer); };
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
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
        addLog(`Tap → (${tapX}, ${tapY})`);
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
        const text = await navigator.clipboard.readText().catch(() => "");
        if (text) await fetch(`${base}/input/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      }
    } catch { /* silently ignore */ }
  }, [serial]);

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

type PhoneSlotHandle = { getVideoSize: () => { w: number; h: number } | null };

const PhoneSlot = React.forwardRef<PhoneSlotHandle, { phone: UsbPhone | null; idx: number; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; live: boolean; onPower: () => void; phoneDims: { w: number; h: number } | null; paneSize: { w: number; h: number } | null; inspectMode?: boolean; logRecMode?: boolean; logMarkers?: LogMarker[]; onExpectedTap?: (x: number, y: number, kind?: "expected" | "vicinity") => void }>(function PhoneSlot({ phone, idx, onLog, onDimensions, live, onPower, phoneDims, paneSize, inspectMode = false, logRecMode, logMarkers, onExpectedTap }, ref) {
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
  const [clickTestMode, setClickTestMode] = useState(false);

  // ── Element tree inspector ─────────────────────────────────────────────────
  // Full UIAutomator node tree shown below the mirror when inspect mode is on.
  // "Tree" tab: hover a row to highlight its bounds on the mirror; hover the
  // mirror to scroll the matching row into view.
  // "Scan" tab: full screenshot with UIAutomator bounds overlaid as rectangles,
  // plus click-to-pin for custom-drawn elements UIAutomator can't see.
  const [inspectTab,     setInspectTab]     = useState<'tree' | 'scan'>('tree');
  const [inspectNodes,   setInspectNodes]   = useState<InspectNode[] | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
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
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/inspect-all-nodes`)
      .then(r => r.json())
      .then(body => { if (!cancelled) setInspectNodes(body.ok ? body.nodes : []); })
      .catch(() => { if (!cancelled) setInspectNodes([]); })
      .finally(() => { if (!cancelled) setInspectLoading(false); });
    return () => { cancelled = true; };
  }, [inspectMode, phone?.serial]);

  const refreshInspectNodes = () => {
    if (!phone) return;
    setInspectLoading(true);
    setInspectNodes(null);
    setMirrorHoveredIdx(null);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/inspect-all-nodes`)
      .then(r => r.json())
      .then(body => setInspectNodes(body.ok ? body.nodes : []))
      .catch(() => setInspectNodes([]))
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
            onLog={onLog}
            onDimensions={onDimensions}
            inspectMode={inspectMode}
            inspectNodes={inspectNodes}
            onHoverNode={handleMirrorHoverNode}
            clickTestMode={clickTestMode}
            logRecMode={logRecMode}
            logMarkers={logMarkers}
            onExpectedTap={onExpectedTap}
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
        <div ref={navRef} className="flex items-center justify-center gap-2 py-2 bg-zinc-900 border-t border-white/6 shrink-0">
          <NavBtn icon={<ChevronLeft className="w-3.5 h-3.5" />} label="Back"   onClick={() => sendKey(phone.serial, 4,   "Back",   onLog)} />
          <NavBtn icon={<Home        className="w-3.5 h-3.5" />} label="Home"   onClick={() => sendKey(phone.serial, 3,   "Home",   onLog)} />
          <NavBtn icon={<LayoutGrid  className="w-3.5 h-3.5" />} label="Recent" onClick={() => sendKey(phone.serial, 187, "Recent", onLog)} />
          <div className="w-px h-4 bg-white/10" />
          <NavBtn icon={<Power       className="w-3 h-3" />}     label="Power"  onClick={() => { liveCanvasRef.current?.clearToBlack(); onPower(); sendKey(phone.serial, 26, "Power", onLog); }} />
          <NavBtn icon={<Volume2     className="w-3 h-3" />}     label="Vol +"  onClick={() => sendKey(phone.serial, 24,  "Vol +",  onLog)} />
          <NavBtn icon={<VolumeX     className="w-3 h-3" />}     label="Vol −"  onClick={() => sendKey(phone.serial, 25,  "Vol −",  onLog)} />
        </div>
      )}
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
        <p className="text-sm text-muted-foreground mt-1">Equinox can download and set it up for you — no manual install needed.</p>
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

interface AutomationSettingsData {
  enabled: boolean;
  cycleIntervalMin: number;
  cycleIntervalMax: number;
  // Per-slide on/off switches (12 Jul 2026) — when unticked, that whole
  // slide of the cycle never runs. Independent of the percentage/chance
  // fields below, which only take effect once a slide is enabled.
  feedEnabled: boolean;
  storiesEnabled: boolean;
  actionDelayMin: number;
  actionDelayMax: number;
  likePercentMin: number;
  likePercentMax: number;
  shareFeedPercentMin: number;
  shareFeedPercentMax: number;
  shareDmPercentMin: number;
  shareDmPercentMax: number;
  feedScrollMin: number;
  feedScrollMax: number;
  viewStoriesSlidesMin: number;
  viewStoriesSlidesMax: number;
  viewStoriesSlideWatchPctMin: number;
  viewStoriesSlideWatchPctMax: number;
  viewStoriesLikePercentMin: number;
  viewStoriesLikePercentMax: number;
  viewStoriesShareDmPercentMin: number;
  viewStoriesShareDmPercentMax: number;
  // View Reels — taps the Reels tab, then snap-swipes through N reels,
  // acting on each via the right-side vertical icon column instead of the
  // feed's horizontal bottom action bar.
  viewReelsEnabled: boolean;
  viewReelsScrollMin: number;
  viewReelsScrollMax: number;
  viewReelsLikePercentMin: number;
  viewReelsLikePercentMax: number;
  viewReelsShareFeedPercentMin: number;
  viewReelsShareFeedPercentMax: number;
  viewReelsShareDmPercentMin: number;
  viewReelsShareDmPercentMax: number;
  viewReelsActivatePctMin: number;
  viewReelsActivatePctMax: number;
  viewReelsWatchPctMin: number;
  viewReelsWatchPctMax: number;
  // Follow Users — HikerAPI-driven follow flow.
  // followSources is stored inline (no separate DB table) to keep mobile
  // settings self-contained. Each entry is a source the HikerAPI client
  // will query for target usernames.
  followEnabled: boolean;
  followUsersMin: number;
  followUsersMax: number;
  followSkipFollowed: boolean;
  followSources: { type: string; value: string }[];
  // Inject Browsing — per-user profile-browsing behaviour woven into the
  // Follow Users flow (12 Jul 2026 rework). No per-item toggles: search
  // browsing is mandatory, "Get Suggested Users" was removed, and the old
  // "Inject Profile Browsing" toggle was a duplicate of this whole
  // section — injectBrowsingEnabled alone gates everything below, and the
  // panel is always visible (not a collapsible dialog) since it's core to
  // how following behaves, not an optional extra.
  injectBrowsingEnabled: boolean;
  injectBrowsingActivatePctMin: number; injectBrowsingActivatePctMax: number;
  injectBrowsingBeforeFollowPctMin: number; injectBrowsingBeforeFollowPctMax: number;
  injectBrowsingFeedChanceMin: number; injectBrowsingFeedChanceMax: number;
  injectBrowsingFeedMin: number; injectBrowsingFeedMax: number;
  injectBrowsingClickPostPctMin: number; injectBrowsingClickPostPctMax: number;
  injectBrowsingLikePctMin: number; injectBrowsingLikePctMax: number;
  injectBrowsingShareFeedPctMin: number; injectBrowsingShareFeedPctMax: number;
  injectBrowsingShareDmPctMin: number; injectBrowsingShareDmPctMax: number;
  // Follow Filters — profile-quality gates applied before each follow action.
  // Not wired to execution logic yet — UI-only until the automation hooks are built.
  followFiltersEnabled: boolean;
  followFilterPrivateUsers: boolean;
  followFilterEnglishSpeaking: boolean;
  followFilterMinFollowers250: boolean;
  followFilterVerifiedUsers: boolean;
  // Random Jitter — human-like interstitial actions fired probabilistically
  // on each cycle run. Master gate: randomJitterEnabled tickbox.
  randomJitterEnabled: boolean;
  checkNotificationsPctMin: number; checkNotificationsPctMax: number;
  checkNotificationsScrollsMin: number; checkNotificationsScrollsMax: number;
  checkNotificationsClickPctMin: number; checkNotificationsClickPctMax: number;
  visitProfilePctMin: number; visitProfilePctMax: number;
  // Activate Percentage — top-level per-execution chance gate for each tool
  // (rolled once per automation-cycle run/"toggle tick", before the tool's
  // own internal settings are even considered). 100/100 = always runs.
  feedActivatePctMin: number; feedActivatePctMax: number;
  viewStoriesActivatePctMin: number; viewStoriesActivatePctMax: number;
  followActivatePctMin: number; followActivatePctMax: number;
  randomJitterActivatePctMin: number; randomJitterActivatePctMax: number;
  // Make a Post — ported over from the old browser-automation "Make a Post"
  // tool (HumanSessionPanel's repost* settings) at the user's request
  // (13 Jul 2026). Wired into the mobile automation-cycle (13 Jul 2026): when
  // gated on by makePostEnabled + this Activate Percentage roll, the cycle
  // taps Instagram's "+" compose icon and posts a photo pulled from the
  // configured local folder.
  makePostEnabled: boolean;
  makePostActivatePctMin: number; makePostActivatePctMax: number;
  makePostPerSessionMin: number; makePostPerSessionMax: number;
  makePostSourceUsername: string;
  makePostDisableUsernameSource: boolean;
  makePostAlterationEnabled: boolean;
  makePostAlterationLevel: "small" | "medium" | "high";
  makePostImageSettingsEnabled: boolean;
  makePostUseHikerApi: boolean;
  makePostDisableAtPostCount: number;
  makePostDisableWhenExhausted: boolean;
  makePostLocalFolderEnabled: boolean;
  makePostLocalFolderPath: string;
  makePostLocalFolderNoRepeat: boolean;
  makePostLocalFolderRandom: boolean;
  makePostLocalFolderDeleteAfterUpload: boolean;
  makePostUseChatGpt: boolean;
  makePostFixAiSlop: boolean;
  makePostMakeUnique: boolean;
  makePostCaptionText: string;
  makePostImageSettings: ImageFilterSettings;
}

const AUTOMATION_DEFAULTS: AutomationSettingsData = {
  enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
  feedEnabled: true, storiesEnabled: true,
  actionDelayMin: 5, actionDelayMax: 10,
  likePercentMin: 3, likePercentMax: 5,
  shareFeedPercentMin: 0, shareFeedPercentMax: 0,
  shareDmPercentMin: 0, shareDmPercentMax: 0,
  feedScrollMin: 5, feedScrollMax: 10,
  viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
  viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
  viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
  viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,
  viewReelsEnabled: false,
  viewReelsScrollMin: 0, viewReelsScrollMax: 0,
  viewReelsLikePercentMin: 0, viewReelsLikePercentMax: 0,
  viewReelsShareFeedPercentMin: 0, viewReelsShareFeedPercentMax: 0,
  viewReelsShareDmPercentMin: 0, viewReelsShareDmPercentMax: 0,
  viewReelsActivatePctMin: 100, viewReelsActivatePctMax: 100,
  viewReelsWatchPctMin: 30, viewReelsWatchPctMax: 70,
  followEnabled: false,
  followUsersMin: 1, followUsersMax: 3,
  followSkipFollowed: true,
  followSources: [],
  injectBrowsingEnabled: false,
  injectBrowsingActivatePctMin: 0, injectBrowsingActivatePctMax: 0,
  injectBrowsingBeforeFollowPctMin: 0, injectBrowsingBeforeFollowPctMax: 0,
  injectBrowsingFeedChanceMin: 100, injectBrowsingFeedChanceMax: 100,
  injectBrowsingFeedMin: 3, injectBrowsingFeedMax: 6,
  injectBrowsingClickPostPctMin: 0, injectBrowsingClickPostPctMax: 0,
  injectBrowsingLikePctMin: 0, injectBrowsingLikePctMax: 0,
  injectBrowsingShareFeedPctMin: 0, injectBrowsingShareFeedPctMax: 0,
  injectBrowsingShareDmPctMin: 0, injectBrowsingShareDmPctMax: 0,
  followFiltersEnabled: false,
  followFilterPrivateUsers: false,
  followFilterEnglishSpeaking: false,
  followFilterMinFollowers250: false,
  followFilterVerifiedUsers: false,
  randomJitterEnabled: false,
  checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
  checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
  checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
  visitProfilePctMin: 0, visitProfilePctMax: 0,
  feedActivatePctMin: 100, feedActivatePctMax: 100,
  viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
  followActivatePctMin: 100, followActivatePctMax: 100,
  randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
  makePostEnabled: false,
  makePostActivatePctMin: 100, makePostActivatePctMax: 100,
  makePostPerSessionMin: 1, makePostPerSessionMax: 1,
  makePostSourceUsername: "",
  makePostDisableUsernameSource: false,
  makePostAlterationEnabled: true,
  makePostAlterationLevel: "small",
  makePostImageSettingsEnabled: true,
  makePostUseHikerApi: false,
  makePostDisableAtPostCount: 0,
  makePostDisableWhenExhausted: true,
  makePostLocalFolderEnabled: false,
  makePostLocalFolderPath: "",
  makePostLocalFolderNoRepeat: false,
  makePostLocalFolderRandom: false,
  makePostLocalFolderDeleteAfterUpload: true,
  makePostUseChatGpt: false,
  makePostFixAiSlop: false,
  makePostMakeUnique: false,
  makePostCaptionText: "",
  makePostImageSettings: {
    contrast: { enabled: true, min: 5, max: 250 },
    brightness: { enabled: true, min: 5, max: 250 },
    noise: { enabled: true, min: 5, max: 15 },
    sharpen: { enabled: true, min: 1.0, max: 2.0 },
    pixelate: { enabled: true, min: 0.9, max: 2.1 },
  },
};

// 4-digit-wide number inputs, shared by every field in this panel.
const NUM_INPUT_CLASS = "w-16 text-center";
// HTML `maxLength` isn't reliably enforced on type="number" inputs, so clamp
// values to 4 digits (0-9999) in code as well.
const clamp4 = (n: number) => Math.min(9999, Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0)));

// Owns settings load/autosave and the continuous run-loop. Called once from
// `MobilePage` (not from the tab-conditional panel) so switching away from
// the Human Session Tool tab never unmounts this and interrupts an
// in-progress automation cycle — the loop must keep running in the
// background regardless of which tab is currently visible.
function useAutomationSettings(phone: UsbPhone | null, onLog?: (msg: string) => void, slotIdx?: number, slotUsername?: string, requestSlot?: (idx: number, readyAt: number) => Promise<void>, releaseSlot?: (idx: number) => void, refreshKey?: number) {
  const [settings, setSettings] = useState<AutomationSettingsData>(AUTOMATION_DEFAULTS);
  const [loading,  setLoading]  = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [running,  setRunning]  = useState(false);
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);
  // Reflects server-side cycle state independently of the client fetch.
  // Keeps running=true even right after remount, before runCycle() fires.
  const [serverCycleRunning, setServerCycleRunning] = useState(false);

  // Loaded settings (including `enabled`) come from the server per phone —
  // used to detect real user edits vs. the initial load, so autosave never
  // fires before the fetch resolves.
  const hydratedRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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

  const setEnabledByUser = useCallback((enabled: boolean) => {
    if (enabled) {
      manualToggleOnRef.current = true;
    } else {
      explicitToggleOffRef.current = true; // explicit user action — cleanup should abort
    }
    setSettings(s => ({ ...s, enabled }));
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    if (!phone) { setSettings(AUTOMATION_DEFAULTS); return; }
    let active = true;
    setLoading(true);
    const settingsUrl = slotIdx !== undefined
      ? `/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/automation-settings`
      : `/api/mobile/devices/${encodeURIComponent(phone.serial)}/automation-settings`;
    fetch(settingsUrl)
      .then(r => r.json())
      .then(d => {
        if (!active) return;
        const merged = { ...AUTOMATION_DEFAULTS, ...d };
        lastSavedRef.current = JSON.stringify(merged);
        setSettings(merged);
        // Do NOT set manualToggleOnRef here. On restart the toggle is already
        // on, but accounts must NOT fire immediately — each slot schedules its
        // own random first-run delay within the configured interval instead.
        // manualToggleOnRef is only set by explicit user action (setEnabledByUser).
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => { if (active) { setLoading(false); hydratedRef.current = true; } });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.serial, slotIdx, refreshKey]);

  // Poll /api/mobile/cycle-active every 2 s while the toggle is on.
  // This keeps `serverCycleRunning` accurate so:
  //   • the mirror stays live even right after remount (before runCycle fires)
  //   • a 409-deferred cycle is still visible as "running" in the UI
  useEffect(() => {
    if (!phone || !settings.enabled) { setServerCycleRunning(false); return; }
    const serial = phone.serial;
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const r = await fetch('/api/mobile/cycle-active');
        if (!active) return;
        const body: { serials: string[] } = await r.json().catch(() => ({ serials: [] }));
        setServerCycleRunning(body.serials.includes(serial));
      } catch { /* ignore transient errors */ }
      if (active) setTimeout(poll, 2_000);
    };
    poll();
    return () => { active = false; setServerCycleRunning(false); };
  }, [phone?.serial, settings.enabled]);

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
  useEffect(() => {
    if (!phone || !settings.enabled) { setRunning(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const serial = phone.serial;

    const runCycle = async () => {
      if (cancelled) return;
      setNextRunAt(null);
      // Collision scheduler: wait for device to be free before running.
      if (requestSlot && slotIdx !== undefined) {
        await requestSlot(slotIdx, Date.now());
        if (cancelled) { releaseSlot?.(slotIdx); return; }
      }
      const s = settingsRef.current;
      const min = Math.max(1, Math.min(s.feedScrollMin, s.feedScrollMax));
      const max = Math.max(s.feedScrollMin, s.feedScrollMax);
      const count = Math.floor(Math.random() * (max - min + 1)) + min;
      setRunning(true);
      // Full lifecycle per cycle: power on → open Instagram → run the tools
      // → close Instagram → cycle airplane mode → power off. The whole
      // sequence recycles every time this fires, for as long as the master
      // toggle stays on.
      onLog?.(`Cycle starting → power on, open Instagram, ${count} downward scrolls`);
      // Generate a unique ID for this cycle.  Both the cycle POST and the abort
      // POST carry it so the server can ignore stale aborts from the previous
      // cycle that race with the start of this new one.
      const cycleId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const ctrl = new AbortController();
      cycleAbortRef.current = ctrl;
      cycleIdRef.current = cycleId; // expose to cleanup closure for the abort POST
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
            viewStoriesSlidesMin: s.viewStoriesSlidesMin,
            viewStoriesSlidesMax: s.viewStoriesSlidesMax,
            viewStoriesSlideWatchPctMin: s.viewStoriesSlideWatchPctMin,
            viewStoriesSlideWatchPctMax: s.viewStoriesSlideWatchPctMax,
            viewStoriesLikePercentMin: s.viewStoriesLikePercentMin,
            viewStoriesLikePercentMax: s.viewStoriesLikePercentMax,
            viewStoriesShareDmPercentMin: s.viewStoriesShareDmPercentMin,
            viewStoriesShareDmPercentMax: s.viewStoriesShareDmPercentMax,
            viewReelsEnabled: s.viewReelsEnabled,
            viewReelsScrollMin: s.viewReelsScrollMin,
            viewReelsScrollMax: s.viewReelsScrollMax,
            viewReelsLikePercentMin: s.viewReelsLikePercentMin,
            viewReelsLikePercentMax: s.viewReelsLikePercentMax,
            viewReelsShareFeedPercentMin: s.viewReelsShareFeedPercentMin,
            viewReelsShareFeedPercentMax: s.viewReelsShareFeedPercentMax,
            viewReelsShareDmPercentMin: s.viewReelsShareDmPercentMin,
            viewReelsShareDmPercentMax: s.viewReelsShareDmPercentMax,
            viewReelsActivatePctMin: s.viewReelsActivatePctMin,
            viewReelsActivatePctMax: s.viewReelsActivatePctMax,
            viewReelsWatchPctMin: s.viewReelsWatchPctMin,
            viewReelsWatchPctMax: s.viewReelsWatchPctMax,
            followEnabled: s.followEnabled,
            followUsersMin: s.followUsersMin,
            followUsersMax: s.followUsersMax,
            followSkipFollowed: s.followSkipFollowed,
            followSources: s.followSources,
            injectBrowsingEnabled: s.injectBrowsingEnabled,
            injectBrowsingActivatePctMin: s.injectBrowsingActivatePctMin,
            injectBrowsingActivatePctMax: s.injectBrowsingActivatePctMax,
            injectBrowsingBeforeFollowPctMin: s.injectBrowsingBeforeFollowPctMin,
            injectBrowsingBeforeFollowPctMax: s.injectBrowsingBeforeFollowPctMax,
            injectBrowsingFeedChanceMin: s.injectBrowsingFeedChanceMin,
            injectBrowsingFeedChanceMax: s.injectBrowsingFeedChanceMax,
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
            followFiltersEnabled: s.followFiltersEnabled,
            followFilterPrivateUsers: s.followFilterPrivateUsers,
            followFilterEnglishSpeaking: s.followFilterEnglishSpeaking,
            followFilterMinFollowers250: s.followFilterMinFollowers250,
            followFilterVerifiedUsers: s.followFilterVerifiedUsers,
            randomJitterEnabled: s.randomJitterEnabled,
            checkNotificationsPctMin: s.checkNotificationsPctMin,
            checkNotificationsPctMax: s.checkNotificationsPctMax,
            checkNotificationsScrollsMin: s.checkNotificationsScrollsMin,
            checkNotificationsScrollsMax: s.checkNotificationsScrollsMax,
            checkNotificationsClickPctMin: s.checkNotificationsClickPctMin,
            checkNotificationsClickPctMax: s.checkNotificationsClickPctMax,
            visitProfilePctMin: s.visitProfilePctMin,
            visitProfilePctMax: s.visitProfilePctMax,
            makePostEnabled: s.makePostEnabled,
            makePostActivatePctMin: s.makePostActivatePctMin,
            makePostActivatePctMax: s.makePostActivatePctMax,
            makePostPerSessionMin: s.makePostPerSessionMin,
            makePostPerSessionMax: s.makePostPerSessionMax,
            makePostSourceUsername: s.makePostSourceUsername,
            makePostDisableUsernameSource: s.makePostDisableUsernameSource,
            makePostAlterationEnabled: s.makePostAlterationEnabled,
            makePostAlterationLevel: s.makePostAlterationLevel,
            makePostImageSettingsEnabled: s.makePostImageSettingsEnabled,
            makePostUseHikerApi: s.makePostUseHikerApi,
            makePostDisableAtPostCount: s.makePostDisableAtPostCount,
            makePostDisableWhenExhausted: s.makePostDisableWhenExhausted,
            makePostLocalFolderEnabled: s.makePostLocalFolderEnabled,
            makePostLocalFolderPath: s.makePostLocalFolderPath,
            makePostLocalFolderNoRepeat: s.makePostLocalFolderNoRepeat,
            makePostLocalFolderRandom: s.makePostLocalFolderRandom,
            makePostLocalFolderDeleteAfterUpload: s.makePostLocalFolderDeleteAfterUpload,
            makePostUseChatGpt: s.makePostUseChatGpt,
            makePostFixAiSlop: s.makePostFixAiSlop,
            makePostMakeUnique: s.makePostMakeUnique,
            makePostCaptionText: s.makePostCaptionText,
            makePostImageSettings: s.makePostImageSettings,
            slotUsername: slotUsername ?? "",
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
        onLog?.(`${acctTag}Cycle failed — ${e?.message ?? "network error"}`);
      } finally {
        cycleAbortRef.current = null;
        cycleIdRef.current = null;
        // Release the collision scheduler slot regardless of outcome (success / error / abort).
        if (releaseSlot && slotIdx !== undefined) releaseSlot(slotIdx);
      }
      if (cancelled) return;
      setRunning(false);
      const s2 = settingsRef.current;
      const safeMin = Math.max(1, Math.min(s2.cycleIntervalMin, s2.cycleIntervalMax));
      const safeMax = Math.max(1, Math.max(s2.cycleIntervalMin, s2.cycleIntervalMax));
      const gapMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
      setNextRunAt(Date.now() + Math.round(gapMs));
      timer = setTimeout(runCycle, Math.round(gapMs));
    };

    // Manual toggle-on → fire immediately (user asked for it right now).
    // App restart with toggle already on → spread the first run across a
    // random delay within the configured Run-every interval so all accounts
    // don't fire simultaneously the moment the software restarts.
    const wasManualToggleOn = manualToggleOnRef.current;
    manualToggleOnRef.current = false;
    if (wasManualToggleOn) {
      runCycle();
    } else {
      const s0 = settingsRef.current;
      const safeMin = Math.max(1, Math.min(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const safeMax = Math.max(1, Math.max(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const startDelayMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
      setNextRunAt(Date.now() + Math.round(startDelayMs));
      timer = setTimeout(runCycle, Math.round(startDelayMs));
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setRunning(false);
      setNextRunAt(null);
      // Only abort the server-side cycle when the user explicitly turned the
      // toggle off.  If the cleanup fires because the component unmounted
      // (user navigated away) or the serial changed, leave the current cycle
      // running on the server — `cancelled = true` already prevents the
      // client from scheduling the next cycle.
      const shouldAbortServer = explicitToggleOffRef.current;
      explicitToggleOffRef.current = false; // reset for next toggle
      const ctrl = cycleAbortRef.current;
      const abortingId = cycleIdRef.current;
      cycleAbortRef.current = null;
      cycleIdRef.current = null;
      if (shouldAbortServer) {
        // Abort the in-flight client-side fetch if one is running.
        ctrl?.abort();
        // Only send the server-side abort POST when we have a real cycleId.
        // If abortingId is null the client had no cycle in-flight, so there
        // is nothing on the server to abort.  Sending a null cycleId was the
        // root cause of the "toggle dead after first run" bug: the abort POST
        // could arrive after a new cycle had already registered its ID on the
        // server, causing the server to match the null guard and kill the new
        // cycle immediately (fixed server-side too, but defence-in-depth here).
        if (abortingId) {
          fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle/abort`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cycleId: abortingId }),
          }).catch(() => {});
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.serial, settings.enabled]);

  // Expose the union: client fetch in-flight OR server confirmed active.
  // This keeps the mirror live immediately on remount without waiting for
  // runCycle() to start its own fetch.
  return { settings, setSettings, setEnabledByUser, loading, saveError, running: running || serverCycleRunning, nextRunAt };
}

// ── Per-device collision scheduler ───────────────────────────────────────────
// Ensures only one account slot on a device runs at a time. When a second slot
// becomes ready while one is running, it queues itself (sorted by readyAt so
// the slot that has been waiting longest goes next). After each slot finishes,
// the device rests for restMinMin–restMinMax minutes before the next slot runs.
interface CollisionSchedulerConfig { enabled: boolean; restMinMin: number; restMinMax: number; }

function useCollisionScheduler(serial: string | null) {
  const [config, setConfig] = useState<CollisionSchedulerConfig>({ enabled: false, restMinMin: 1, restMinMax: 3 });
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // Queue entries: slotIdx, the timestamp the slot first became ready, and the
  // resolve callback that grants permission to run.
  const queueRef = useRef<{ slotIdx: number; readyAt: number; resolve: () => void }[]>([]);
  const busyRef  = useRef(false); // true = a slot is currently running

  // Load saved config on mount / serial change.
  useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-scheduler`)
      .then(r => r.json()).then(d => { if (d.config) setConfig(d.config); }).catch(() => {});
  }, [serial]);

  const processNext = useCallback(() => {
    if (queueRef.current.length === 0) { busyRef.current = false; return; }
    queueRef.current.sort((a, b) => a.readyAt - b.readyAt);
    const next = queueRef.current.shift()!;
    busyRef.current = true;
    next.resolve();
  }, []);

  const requestSlot = useCallback((slotIdx: number, readyAt: number): Promise<void> => {
    if (!configRef.current.enabled) return Promise.resolve();
    return new Promise<void>(resolve => {
      if (!busyRef.current) { busyRef.current = true; resolve(); }
      else queueRef.current.push({ slotIdx, readyAt, resolve });
    });
  }, []);

  const releaseSlot = useCallback((_slotIdx: number) => {
    if (!configRef.current.enabled) return;
    const cfg = configRef.current;
    const restMs = (cfg.restMinMin + Math.random() * Math.max(0, cfg.restMinMax - cfg.restMinMin)) * 60_000;
    setTimeout(processNext, Math.round(restMs));
  }, [processNext]);

  return { config, setConfig, requestSlot, releaseSlot };
}

// ── Copy Settings dialog ──────────────────────────────────────────────────────
// Lets the user duplicate the current slot's Human Session Tool settings to one
// or more other account slots on the same device. Both sides (target slots and
// setting sections) support Select All / Select None.
const COPY_SECTIONS: { key: string; label: string; fields: string[] }[] = [
  { key: 'toolToggle',     label: 'Tool Toggle (enabled/disabled)', fields: ['enabled'] },
  { key: 'runInterval',    label: 'Run Interval',     fields: ['cycleIntervalMin','cycleIntervalMax'] },
  { key: 'actionDelay',   label: 'Action Delay',      fields: ['actionDelayMin','actionDelayMax'] },
  { key: 'feed',          label: 'View Feed',         fields: ['feedEnabled','feedActivatePctMin','feedActivatePctMax','feedScrollMin','feedScrollMax','likePercentMin','likePercentMax','shareFeedPercentMin','shareFeedPercentMax','shareDmPercentMin','shareDmPercentMax'] },
  { key: 'stories',       label: 'View Stories',      fields: ['storiesEnabled','viewStoriesActivatePctMin','viewStoriesActivatePctMax','viewStoriesSlidesMin','viewStoriesSlidesMax','viewStoriesSlideWatchPctMin','viewStoriesSlideWatchPctMax','viewStoriesLikePercentMin','viewStoriesLikePercentMax','viewStoriesShareDmPercentMin','viewStoriesShareDmPercentMax'] },
  { key: 'reels',         label: 'View Reels',        fields: ['viewReelsEnabled','viewReelsActivatePctMin','viewReelsActivatePctMax','viewReelsScrollMin','viewReelsScrollMax','viewReelsWatchPctMin','viewReelsWatchPctMax','viewReelsLikePercentMin','viewReelsLikePercentMax','viewReelsShareFeedPercentMin','viewReelsShareFeedPercentMax','viewReelsShareDmPercentMin','viewReelsShareDmPercentMax'] },
  { key: 'follow',        label: 'Follow Users',      fields: ['followEnabled','followActivatePctMin','followActivatePctMax','followUsersMin','followUsersMax','followSkipFollowed','followSources'] },
  { key: 'injectBrowsing',label: 'Inject Browsing',   fields: ['injectBrowsingEnabled','injectBrowsingActivatePctMin','injectBrowsingActivatePctMax','injectBrowsingBeforeFollowPctMin','injectBrowsingBeforeFollowPctMax','injectBrowsingFeedChanceMin','injectBrowsingFeedChanceMax','injectBrowsingFeedMin','injectBrowsingFeedMax','injectBrowsingClickPostPctMin','injectBrowsingClickPostPctMax','injectBrowsingLikePctMin','injectBrowsingLikePctMax','injectBrowsingShareFeedPctMin','injectBrowsingShareFeedPctMax','injectBrowsingShareDmPctMin','injectBrowsingShareDmPctMax'] },
  { key: 'followFilters', label: 'Follow Filters',    fields: ['followFiltersEnabled','followFilterPrivateUsers','followFilterEnglishSpeaking','followFilterMinFollowers250','followFilterVerifiedUsers'] },
  { key: 'randomJitter',  label: 'Random Jitter',     fields: ['randomJitterEnabled','randomJitterActivatePctMin','randomJitterActivatePctMax','checkNotificationsPctMin','checkNotificationsPctMax','checkNotificationsScrollsMin','checkNotificationsScrollsMax','checkNotificationsClickPctMin','checkNotificationsClickPctMax','visitProfilePctMin','visitProfilePctMax'] },
  { key: 'makePost',      label: 'Make a Post',       fields: ['makePostEnabled','makePostActivatePctMin','makePostActivatePctMax','makePostPerSessionMin','makePostPerSessionMax','makePostSourceUsername','makePostDisableUsernameSource','makePostAlterationEnabled','makePostAlterationLevel','makePostImageSettingsEnabled','makePostUseHikerApi','makePostDisableAtPostCount','makePostDisableWhenExhausted','makePostLocalFolderEnabled','makePostLocalFolderPath','makePostLocalFolderNoRepeat','makePostLocalFolderRandom','makePostLocalFolderDeleteAfterUpload','makePostUseChatGpt','makePostFixAiSlop','makePostMakeUnique','makePostCaptionText','makePostImageSettings'] },
];

function CopySettingsDialog({
  open, onClose, currentSlotIdx, slotUsernames, settings, phone, onCopied,
}: {
  open: boolean;
  onClose: () => void;
  currentSlotIdx: number;
  slotUsernames: string[];
  settings: AutomationSettingsData;
  phone: UsbPhone | null;
  onCopied?: (targetSlotIdxs: number[]) => void;
}) {
  const allKeys = COPY_SECTIONS.map(s => s.key);
  const [selectedSlots, setSelectedSlots] = useState<number[]>([]);
  const [selectedSections, setSelectedSections] = useState<string[]>(allKeys);
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedSlots(slotUsernames.map((_, i) => i).filter(i => i !== currentSlotIdx));
      setSelectedSections(allKeys);
      setResult(null);
      setCopying(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const otherSlots = slotUsernames
    .map((username, i) => ({ username, idx: i }))
    .filter(s => s.idx !== currentSlotIdx);

  const handleCopy = async () => {
    if (!phone?.serial || selectedSlots.length === 0) return;
    setCopying(true);
    setResult(null);
    const partial: Record<string, unknown> = {};
    for (const section of COPY_SECTIONS) {
      if (selectedSections.includes(section.key)) {
        for (const field of section.fields) {
          partial[field] = (settings as Record<string, unknown>)[field];
        }
      }
    }
    let ok = 0, fail = 0;
    const succeededSlots: number[] = [];
    for (const slotIdx of selectedSlots) {
      try {
        const r = await fetch(
          `/api/mobile/devices/${encodeURIComponent(phone.serial)}/slots/${slotIdx}/automation-settings`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(partial) },
        );
        if (r.ok) { ok++; succeededSlots.push(slotIdx); } else fail++;
      } catch { fail++; }
    }
    const msg = fail
      ? `Copied to ${ok}; ${fail} failed`
      : `Copied to ${ok} slot${ok !== 1 ? "s" : ""}`;
    setResult(msg);
    setCopying(false);
    if (succeededSlots.length > 0) onCopied?.(succeededSlots);
    setTimeout(() => { onClose(); }, 1600);
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !copying) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy Settings to Other Slots</DialogTitle>
        </DialogHeader>
        <div className="flex gap-8 mt-2">
          {/* Left: target slots */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Copy to</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                  onClick={() => setSelectedSlots(otherSlots.map(s => s.idx))}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                  onClick={() => setSelectedSlots([])}>None</Button>
              </div>
            </div>
            {otherSlots.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No other slots to copy to.</p>
            ) : otherSlots.map(s => (
              <label key={s.idx} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" className="w-3.5 h-3.5 accent-primary"
                  checked={selectedSlots.includes(s.idx)}
                  onChange={e => setSelectedSlots(prev =>
                    e.target.checked ? [...prev, s.idx] : prev.filter(i => i !== s.idx)
                  )} />
                <span className="text-sm truncate">
                  {s.username ? `@${s.username}` : `Slot ${s.idx + 1}`}
                </span>
              </label>
            ))}
          </div>

          {/* Right: setting sections */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settings</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                  onClick={() => setSelectedSections(allKeys)}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                  onClick={() => setSelectedSections([])}>None</Button>
              </div>
            </div>
            {COPY_SECTIONS.map(s => (
              <label key={s.key} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" className="w-3.5 h-3.5 accent-primary"
                  checked={selectedSections.includes(s.key)}
                  onChange={e => setSelectedSections(prev =>
                    e.target.checked ? [...prev, s.key] : prev.filter(k => k !== s.key)
                  )} />
                <span className="text-sm">{s.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border">
          {result && (
            <span className={`text-xs mr-auto ${result.includes('failed') ? 'text-destructive' : 'text-green-500'}`}>
              {result}
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={copying}>Cancel</Button>
          <Button onClick={handleCopy}
            disabled={copying || selectedSlots.length === 0 || selectedSections.length === 0}>
            {copying ? "Copying…" : "Copy Settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AutomationSettingsPanel({
  phone, settings, setSettings, setEnabledByUser, loading, saveError, running, nextRunAt,
  slotIdx, slotUsernames, onCopied,
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
  slotUsernames?: string[];
  onCopied?: (targetSlotIdxs: number[]) => void;
}) {
  // Follow Users UI local state — hooks must come before any conditional return.
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);
  const [showSources, setShowSources] = useState(false);
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
  const [mobileFollowedList, setMobileFollowedList] = useState<{username:string;followedAt:number}[]>([]);
  const [loadingFollowed, setLoadingFollowed] = useState(false);
  // Make a Post UI local state
  const [makePostImageSettingsOpen, setMakePostImageSettingsOpen] = useState(false);
  const [showPostedMedia, setShowPostedMedia] = useState(false);
  const [postedMediaFiles, setPostedMediaFiles] = useState<string[]>([]);
  const [loadingPostedMedia, setLoadingPostedMedia] = useState(false);

  const loadFollowedUsers = React.useCallback(async () => {
    if (!phone?.serial) return;
    setLoadingFollowed(true);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/followed-users`);
      const data = await r.json().catch(() => null);
      if (data?.users) setMobileFollowedList(data.users);
    } catch {} finally { setLoadingFollowed(false); }
  }, [phone?.serial]);

  const loadPostedMedia = React.useCallback(async () => {
    if (!phone?.serial) return;
    setLoadingPostedMedia(true);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/posted-media`);
      const data = await r.json().catch(() => null);
      if (data?.files) setPostedMediaFiles(data.files);
    } catch {} finally { setLoadingPostedMedia(false); }
  }, [phone?.serial]);

  const deletePostedMediaEntry = async (filename: string) => {
    if (!phone?.serial) return;
    try {
      await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/posted-media/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      setPostedMediaFiles(f => f.filter(x => x !== filename));
    } catch {}
  };

  // Auto-refresh the followed list every 5 s while the panel is open so
  // users followed during a running cycle appear without manual re-toggle.
  React.useEffect(() => {
    if (!showFollowedUsers) return;
    const id = setInterval(loadFollowedUsers, 5000);
    return () => clearInterval(id);
  }, [showFollowedUsers, loadFollowedUsers]);

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
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-foreground">Human Session Tool</h2>
          {slotIdx !== undefined && slotUsernames && slotUsernames.length > 1 && (
            <Button type="button" variant="secondary" size="sm" className="h-7 text-xs gap-1.5"
              onClick={() => setShowCopyDialog(true)}>
              <Copy className="w-3 h-3" />
              Copy Settings
            </Button>
          )}
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {phone.manufacturer ? `${phone.manufacturer} ` : ""}{phone.model ?? phone.serial}
        </span>
      </div>

      {/* Master toggle — turns the whole tool on/off. */}
      <div className="inline-flex flex-col self-start bg-card border border-border rounded-xl p-5 gap-4">
        {/* Row 1: toggle + status */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">(STEP1)</span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={setEnabledByUser}
            disabled={loading}
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
        </div>

        {/* Row 2: cycle interval */}
        <div className="flex items-center gap-3 flex-wrap">
          <Label className="text-sm text-muted-foreground whitespace-nowrap">Run every</Label>
          <Input
            type="number"
            min={1}
            className={NUM_INPUT_CLASS}
            value={settings.cycleIntervalMin}
            onChange={e => setSettings(s => ({ ...s, cycleIntervalMin: Math.max(1, clamp4(Number(e.target.value))) }))}
            disabled={loading}
          />
          <span className="text-muted-foreground text-sm">to</span>
          <Input
            type="number"
            min={1}
            className={NUM_INPUT_CLASS}
            value={settings.cycleIntervalMax}
            onChange={e => setSettings(s => ({ ...s, cycleIntervalMax: Math.max(1, clamp4(Number(e.target.value))) }))}
            disabled={loading}
          />
          <Label className="text-sm text-muted-foreground whitespace-nowrap">minutes</Label>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">(STEP2)</p>
          <br />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="feed-enabled"
              checked={settings.feedEnabled}
              onChange={e => setSettings(s => ({ ...s, feedEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="feed-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">View Feed</label>
          </div>
        </div>
        {settings.feedEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Activate Percentage</Label>
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
            <Label className="text-sm text-muted-foreground">Scroll this many times</Label>
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
            <Label className="text-sm text-muted-foreground">Delay between actions</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                maxLength={4}
                className={NUM_INPUT_CLASS}
                value={settings.actionDelayMin}
                onChange={e => setSettings(s => ({ ...s, actionDelayMin: clamp4(Number(e.target.value)) }))}
                disabled={loading}
              />
              <span className="text-muted-foreground text-sm">s</span>
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
        </div>}

        {/* Like + Share to Feed + Share via DM — all three on the same row */}
        {settings.feedEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Like % of posts</Label>
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

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Share to Feed % of posts</Label>
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
            <Label className="text-sm text-muted-foreground">Share via DM % of posts</Label>
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
        </div>}

        {saveError && <p className="text-xs text-destructive">{saveError}</p>}

        {/* Border separator between the like/share settings above and View
            Stories from Feed below — same card/step (STEP2), not its own step. */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="stories-enabled"
              checked={settings.storiesEnabled}
              onChange={e => setSettings(s => ({ ...s, storiesEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="stories-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">View Stories from Feed</label>
          </div>
        </div>

        {settings.storiesEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Activate Percentage</Label>
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
            <Label className="text-sm text-muted-foreground">Stories to watch</Label>
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
            <Label className="text-sm text-muted-foreground">% to watch</Label>
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
            <Label className="text-sm text-muted-foreground">Like %</Label>
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
            <Label className="text-sm text-muted-foreground">Share DM %</Label>
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
        </div>}

        {/* Border separator between View Stories from Feed above and View
            Reels below — same card/step (STEP2), mirrors the divider above
            between View Feed and View Stories from Feed. */}
        <div className="border-t border-border" />

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="reels-enabled"
              checked={settings.viewReelsEnabled}
              onChange={e => setSettings(s => ({ ...s, viewReelsEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="reels-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">View Reels</label>
          </div>
        </div>

        {settings.viewReelsEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Activate Percentage</Label>
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
            <Label className="text-sm text-muted-foreground">Scroll amount</Label>
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
            <Label className="text-sm text-muted-foreground">Watch %</Label>
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
            <Label className="text-sm text-muted-foreground">Like %</Label>
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
            <Label className="text-sm text-muted-foreground">Share Feed %</Label>
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
            <Label className="text-sm text-muted-foreground">Share DM %</Label>
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
        </div>}

        {/* Border separator between View Reels above and the Follow Users
            feature below — same card/step (STEP2). */}
        <div className="border-t border-border" />

        {/* ── Follow Users header — tickbox, label, Sources, Followed all
               on one row (Sources/Followed panels are collapsible below,
               same pattern as before — only the buttons live on this row). */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="follow-enabled"
            checked={settings.followEnabled}
            onChange={e => setSettings(s => ({ ...s, followEnabled: e.target.checked }))}
            disabled={loading}
            className="w-4 h-4 accent-primary cursor-pointer"
          />
          <label htmlFor="follow-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">Follow Users</label>
          <Button
            variant="outline" size="sm"
            className="h-7 text-xs px-3 ml-auto"
            onClick={() => setShowSources(v => !v)}
          >{showSources ? 'Hide' : 'Sources'}</Button>
          <Button
            variant="outline" size="sm" className="h-7 text-xs px-3"
            disabled={loadingFollowed}
            onClick={() => { setShowFollowedUsers(v => !v); if (!showFollowedUsers) loadFollowedUsers(); }}
          >{showFollowedUsers ? 'Hide' : 'Followed'}</Button>
        </div>

        {/* ── Activate Percentage + Users to follow per operation ────── */}
        {settings.followEnabled && <div className="flex items-start gap-6 flex-wrap">
          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Activate Percentage</Label>
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

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Users to follow per operation</Label>
            <div className="flex items-center gap-3">
              <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.followUsersMin}
                onChange={e => setSettings(s => ({ ...s, followUsersMin: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="number" min={0} maxLength={4} className={NUM_INPUT_CLASS}
                value={settings.followUsersMax}
                onChange={e => setSettings(s => ({ ...s, followUsersMax: clamp4(Number(e.target.value)) }))}
                disabled={loading} />
            </div>
          </div>

          {/* Skip Followed Users — vertically centred alongside the row above */}
          <div className="flex items-center gap-2 self-center mt-4">
            <input
              type="checkbox"
              id="follow-skip-followed"
              checked={settings.followSkipFollowed}
              onChange={e => setSettings(s => ({ ...s, followSkipFollowed: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer shrink-0"
            />
            <label
              htmlFor="follow-skip-followed"
              className="text-sm font-medium text-foreground cursor-pointer select-none whitespace-nowrap"
            >
              Skip Followed Users
            </label>
          </div>
        </div>}

        {/* ── Target Sources panel (toggled via the Sources button above) ─ */}
        <div className="space-y-2">
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
                  disabled={loading}
                >
                  <Upload className="w-3 h-3" /> Import
                </Button>
                <Button
                  variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1 shrink-0"
                  onClick={handleExportFollowSources}
                  disabled={loading || !settings.followSources.length}
                >
                  <Download className="w-3 h-3" /> Export
                </Button>
                {settings.followSources.length > 0 && (
                  <Button
                    variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive shrink-0"
                    disabled={loading}
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
                        disabled={loading}
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
                  disabled={loading}
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
                  disabled={loading}
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
                  disabled={loading || !newFollowSourceValue.trim()}
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

        {/* ── Inject Browsing — only visible when Follow Users is ticked ── */}
        {settings.followEnabled && <div className="space-y-3">
          {/* Row 1: title + checkbox only */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="inject-browsing-enabled"
              checked={settings.injectBrowsingEnabled}
              onChange={e => setSettings(s => ({ ...s, injectBrowsingEnabled: e.target.checked }))}
              disabled={loading || !settings.followEnabled}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="inject-browsing-enabled" className={`text-sm font-semibold cursor-pointer select-none ${settings.followEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>Inject Browsing</label>
          </div>

          {settings.injectBrowsingEnabled && (<>
          {/* Row 2: Activate Percentage (first field) / Browse before follow / Feed chance / Feed posts / Click posts % */}
          <div className="flex items-start flex-wrap gap-6">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Activate Percentage</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingActivatePctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingActivatePctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingActivatePctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingActivatePctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Browse before follow %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingBeforeFollowPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingBeforeFollowPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingBeforeFollowPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingBeforeFollowPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Feed chance %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedChanceMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedChanceMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedChanceMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedChanceMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Feed posts</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={50} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingFeedMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingFeedMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Click posts %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingClickPostPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingClickPostPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingClickPostPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingClickPostPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Like %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingLikePctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingLikePctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingLikePctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingLikePctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Share feed %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareFeedPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareFeedPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareFeedPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareFeedPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Share to DM %</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareDmPctMin} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareDmPctMin: clamp4(Number(e.target.value)) }))} disabled={loading} />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="number" min={0} max={100} maxLength={4} className={NUM_INPUT_CLASS} value={settings.injectBrowsingShareDmPctMax} onChange={e => setSettings(s => ({ ...s, injectBrowsingShareDmPctMax: clamp4(Number(e.target.value)) }))} disabled={loading} />
              </div>
            </div>
          </div>
          </>)}

          {/* ── Filters — profile-quality gates applied before each follow ── */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="follow-filters-enabled"
              checked={settings.followFiltersEnabled}
              onChange={e => setSettings(s => ({ ...s, followFiltersEnabled: e.target.checked }))}
              disabled={loading || !settings.followEnabled}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="follow-filters-enabled" className={`text-sm font-semibold cursor-pointer select-none ${settings.followEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>Filters</label>
          </div>

          {settings.followFiltersEnabled && (
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="filter-private-users"
                  checked={settings.followFilterPrivateUsers}
                  onChange={e => setSettings(s => ({ ...s, followFilterPrivateUsers: e.target.checked }))}
                  disabled={loading}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor="filter-private-users" className="text-xs text-muted-foreground cursor-pointer select-none">Private Users</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="filter-english-speaking"
                  checked={settings.followFilterEnglishSpeaking}
                  onChange={e => setSettings(s => ({ ...s, followFilterEnglishSpeaking: e.target.checked }))}
                  disabled={loading}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor="filter-english-speaking" className="text-xs text-muted-foreground cursor-pointer select-none">English Speaking</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="filter-min-followers-250"
                  checked={settings.followFilterMinFollowers250}
                  onChange={e => setSettings(s => ({ ...s, followFilterMinFollowers250: e.target.checked }))}
                  disabled={loading}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor="filter-min-followers-250" className="text-xs text-muted-foreground cursor-pointer select-none">250 Followers+</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="filter-verified-users"
                  checked={settings.followFilterVerifiedUsers}
                  onChange={e => setSettings(s => ({ ...s, followFilterVerifiedUsers: e.target.checked }))}
                  disabled={loading}
                  className="w-4 h-4 accent-primary cursor-pointer"
                />
                <label htmlFor="filter-verified-users" className="text-xs text-muted-foreground cursor-pointer select-none">Skip Verified</label>
              </div>
            </div>
          )}
        </div>}

        {/* ── Random Jitter — probabilistic human-like actions each cycle ─ */}
        <div className="border-t border-border" />

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="random-jitter-enabled"
              checked={settings.randomJitterEnabled}
              onChange={e => setSettings(s => ({ ...s, randomJitterEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="random-jitter-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">Random Jitter</label>
          </div>

          {settings.randomJitterEnabled && (
            <div className="pl-1">
              {/* All jitter settings on one flex-wrap row, grouped by section title */}
              <div className="flex items-start gap-8 flex-wrap">
                {/* ── Activate Percentage — outer gate for the whole Random
                     Jitter tool this execution, independent of each
                     sub-action's own chance below. ── */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-medium text-foreground">Activate Percentage</Label>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Chance %</Label>
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
                </div>

                {/* ── Check Notifications group ── */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-medium text-foreground">Check Notifications</Label>
                  <div className="flex items-start gap-6 flex-wrap">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Chance %</Label>
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
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Scrolls</Label>
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
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Click notification %</Label>
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
                  </div>
                </div>

                {/* ── Visit My Profile group — same row via flex-wrap ── */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-medium text-foreground">Visit My Profile</Label>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Chance %</Label>
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

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="make-a-post-enabled"
              checked={settings.makePostEnabled}
              onChange={e => setSettings(s => ({ ...s, makePostEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="make-a-post-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">Make a Post</label>
            <Button
              variant="outline" size="sm"
              className="h-7 text-xs px-3 ml-auto"
              onClick={() => { setShowPostedMedia(v => !v); if (!showPostedMedia) loadPostedMedia(); }}
              disabled={loading}
            >{showPostedMedia ? 'Hide' : 'Posted Media'}</Button>
          </div>

          {settings.makePostEnabled && (
            <div className="pl-1 space-y-4">
              {/* Activate Percentage / Order % / Skip Chance % / Posts per session */}
              <div className="flex items-start gap-8 flex-wrap">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Activate Percentage</Label>
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
                  <Label className="text-xs text-muted-foreground">Posts per session</Label>
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

              {/* Source: Instagram Account */}
              <div className="border border-border/60 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="make-a-post-username-source-enabled"
                    checked={!settings.makePostDisableUsernameSource}
                    onChange={e => setSettings(s => ({ ...s, makePostDisableUsernameSource: !e.target.checked }))}
                    disabled={loading}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor="make-a-post-username-source-enabled" className="text-xs font-semibold text-foreground cursor-pointer select-none tracking-wide">
                    SOURCE: INSTAGRAM ACCOUNT
                  </label>
                </div>
                {!settings.makePostDisableUsernameSource && (
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Account username <span className="text-muted-foreground/60">(without @)</span></Label>
                      <Input type="text" placeholder="username" className="h-8 text-xs max-w-[220px]"
                        value={settings.makePostSourceUsername}
                        onChange={e => setSettings(s => ({ ...s, makePostSourceUsername: e.target.value.replace(/^@/, '') }))}
                        disabled={loading} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Disable when my posts reach <span className="text-muted-foreground/60">(0 = off)</span></Label>
                      <Input type="number" min={0} maxLength={5} className="w-20 h-8 text-xs text-center"
                        value={settings.makePostDisableAtPostCount}
                        onChange={e => setSettings(s => ({ ...s, makePostDisableAtPostCount: clamp4(Number(e.target.value)) }))}
                        disabled={loading} />
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="make-a-post-hiker-api"
                        checked={settings.makePostUseHikerApi}
                        onChange={e => setSettings(s => ({ ...s, makePostUseHikerApi: e.target.checked }))}
                        disabled={loading}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                      <label htmlFor="make-a-post-hiker-api" className="text-xs text-muted-foreground cursor-pointer select-none">Use HikerAPI for scraping</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="make-a-post-disable-exhausted"
                        checked={settings.makePostDisableWhenExhausted}
                        onChange={e => setSettings(s => ({ ...s, makePostDisableWhenExhausted: e.target.checked }))}
                        disabled={loading}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                      <label htmlFor="make-a-post-disable-exhausted" className="text-xs text-muted-foreground cursor-pointer select-none">Disable when no more posts are found</label>
                    </div>
                  </div>
                )}
              </div>

              {/* Source: Local Folder */}
              <div className="border border-border/60 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="make-a-post-local-folder-enabled"
                    checked={settings.makePostLocalFolderEnabled}
                    onChange={e => setSettings(s => ({ ...s, makePostLocalFolderEnabled: e.target.checked }))}
                    disabled={loading}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                  <label htmlFor="make-a-post-local-folder-enabled" className="text-xs font-semibold text-foreground cursor-pointer select-none tracking-wide">SOURCE: MY COMPUTER</label>
                </div>
                {settings.makePostLocalFolderEnabled && (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={async () => {
                          const api = (window as any).electronAPI;
                          if (!api?.openFolderDialog) return;
                          const result = await api.openFolderDialog();
                          if (result?.canceled || !result?.folder) return;
                          setSettings(s => ({ ...s, makePostLocalFolderPath: result.folder }));
                        }}
                        className="h-7 px-3 text-xs rounded border border-border bg-background hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium text-foreground"
                      >
                        {settings.makePostLocalFolderPath ? "Assigned Directory" : "Browse"}
                      </button>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id="make-a-post-local-no-repeat"
                          checked={settings.makePostLocalFolderNoRepeat}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderNoRepeat: e.target.checked }))}
                          disabled={loading}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor="make-a-post-local-no-repeat" className="text-xs text-muted-foreground cursor-pointer select-none">Do not repost the same image</label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id="make-a-post-local-random"
                          checked={settings.makePostLocalFolderRandom}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderRandom: e.target.checked }))}
                          disabled={loading}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor="make-a-post-local-random" className="text-xs text-muted-foreground cursor-pointer select-none">Pick at random</label>
                      </div>
                    </div>

                  </div>
                )}
              </div>

              {/* Posted Media panel — shown when the Posted Media button is toggled */}
              {showPostedMedia && (
                <div className="border border-border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground flex-1">
                      {postedMediaFiles.length} image{postedMediaFiles.length !== 1 ? 's' : ''} posted
                    </span>
                    <Button
                      variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1 shrink-0"
                      onClick={loadPostedMedia}
                      disabled={loadingPostedMedia}
                    >Refresh</Button>
                    {postedMediaFiles.length > 0 && (
                      <Button
                        variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive shrink-0"
                        disabled={loadingPostedMedia}
                        onClick={async () => {
                          if (!phone?.serial) return;
                          await Promise.all(postedMediaFiles.map(f =>
                            fetch(`/api/mobile/devices/${encodeURIComponent(phone!.serial)}/posted-media/${encodeURIComponent(f)}`, { method: 'DELETE' })
                          ));
                          setPostedMediaFiles([]);
                        }}
                      >Clear all</Button>
                    )}
                  </div>
                  {postedMediaFiles.length > 0 ? (
                    <div className="space-y-1 max-h-[260px] overflow-y-auto pr-0.5">
                      {postedMediaFiles.map((fname, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="flex-1 text-foreground font-mono truncate">{fname}</span>
                          <button
                            onClick={() => deletePostedMediaEntry(fname)}
                            disabled={loadingPostedMedia}
                            title="Remove — allows this image to be reposted"
                            className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  ) : loadingPostedMedia ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No images posted yet.</p>
                  )}
                </div>
              )}

              {/* Caption */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="text-xs text-muted-foreground font-semibold">Post Caption Text</Label>
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" id="make-a-post-use-chatgpt"
                      checked={settings.makePostUseChatGpt}
                      onChange={e => setSettings(s => ({ ...s, makePostUseChatGpt: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor="make-a-post-use-chatgpt" className="text-xs text-muted-foreground cursor-pointer select-none">Use ChatGPT</label>
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
                    <input type="checkbox" id="make-a-post-alteration-enabled"
                      checked={settings.makePostAlterationEnabled}
                      onChange={e => setSettings(s => ({ ...s, makePostAlterationEnabled: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <label htmlFor="make-a-post-alteration-enabled" className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">Alteration level</label>
                    <div className="flex gap-1">
                      {(["small", "medium", "high"] as const).map(lvl => (
                        <button key={lvl} type="button" disabled={loading || !settings.makePostAlterationEnabled}
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
                    <input type="checkbox" id="make-a-post-image-settings-enabled"
                      checked={settings.makePostImageSettingsEnabled}
                      onChange={e => setSettings(s => ({ ...s, makePostImageSettingsEnabled: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <label htmlFor="make-a-post-image-settings-enabled" className="text-xs text-muted-foreground cursor-pointer select-none shrink-0">Image settings</label>
                    <button type="button" disabled={loading || !settings.makePostImageSettingsEnabled}
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
                    <input type="checkbox" id="make-a-post-fix-ai-slop"
                      checked={settings.makePostFixAiSlop}
                      onChange={e => setSettings(s => ({ ...s, makePostFixAiSlop: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor="make-a-post-fix-ai-slop" className="text-xs text-muted-foreground cursor-pointer select-none">Fix AI Slop</label>
                  </div>
                  {/* Make it unique */}
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" id="make-a-post-make-unique"
                      checked={settings.makePostMakeUnique}
                      onChange={e => setSettings(s => ({ ...s, makePostMakeUnique: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor="make-a-post-make-unique" className="text-xs text-muted-foreground cursor-pointer select-none">Make it unique</label>
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

        {/* ── Followed Users panel (toggled via the Followed button above) */}
        <div className="space-y-2">
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
                          <td className="px-3 py-1.5 text-foreground">@{u.username}</td>
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
          open={showCopyDialog}
          onClose={() => setShowCopyDialog(false)}
          currentSlotIdx={slotIdx}
          slotUsernames={slotUsernames}
          settings={settings}
          phone={phone}
          onCopied={onCopied}
        />
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
function SlotHumanSessionView({
  phone, slotIdx, slotUsername, slotUsernames, addLog, onBack, requestSlot, releaseSlot, refreshKey, onCopied,
}: {
  phone: UsbPhone | null;
  slotIdx: number;
  slotUsername: string;
  slotUsernames?: string[];
  addLog: (msg: string) => void;
  onBack: () => void;
  requestSlot?: (idx: number, readyAt: number) => Promise<void>;
  releaseSlot?: (idx: number) => void;
  refreshKey?: number;
  onCopied?: (targetSlotIdxs: number[]) => void;
}) {
  const automation = useAutomationSettings(phone, addLog, slotIdx, slotUsername, requestSlot, releaseSlot, refreshKey);
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 h-7 px-2">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
        <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Fingerprint className="w-3.5 h-3.5 text-primary" />
          Human Session Tool {slotUsername ? `for @${slotUsername}` : `Slot ${slotIdx + 1}`}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <AutomationSettingsPanel phone={phone} {...automation} slotIdx={slotIdx} slotUsernames={slotUsernames} onCopied={onCopied} />
      </div>
    </div>
  );
}

function AccountSettingsPanel({ phone, addLog }: { phone: UsbPhone | null; addLog: (msg: string) => void }) {
  const [slotRefreshKeys, setSlotRefreshKeys] = useState<Record<number, number>>({});
  const handleCopied = useCallback((targetSlotIdxs: number[]) => {
    setSlotRefreshKeys(prev => {
      const next = { ...prev };
      for (const idx of targetSlotIdxs) next[idx] = (next[idx] ?? 0) + 1;
      return next;
    });
  }, []);
  const [slots, setSlots] = useState<AccountSlot[]>(
    Array.from({ length: ACCT_SLOT_COUNT }, emptySlot)
  );
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState<boolean[]>(Array(ACCT_SLOT_COUNT).fill(false));
  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState<number | null>(null);
  const [totpCode, setTotpCode] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
  const [totpError, setTotpError] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
  const [showEmailPassword, setShowEmailPassword] = useState<boolean[]>(Array(ACCT_SLOT_COUNT).fill(false));
  // null = show slot list; number = show Human Session Tool for that slot index
  const [openSlotTool, setOpenSlotTool] = useState<number | null>(null);
  const { requestSlot, releaseSlot } = useCollisionScheduler(phone?.serial ?? null);
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
      .then(d => {
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

  const addSlot = () => {
    setSlots(s => [...s, emptySlot()]);
    setShowPassword(s => [...s, false]);
    setShowEmailPassword(s => [...s, false]);
    setTotpCode(c => [...c, null]);
    setTotpError(e => [...e, null]);
  };

  const removeSlot = (i: number) => {
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

  if (!phone) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-2">
        <Smartphone className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground max-w-xs">
          Connect a phone via USB to link an Instagram account to it.
        </p>
      </div>
    );
  }

  const deviceName = phone.manufacturer
    ? `${phone.manufacturer} ${phone.model ?? phone.serial}`
    : (phone.model ?? phone.serial);

  return (
    <div className="h-full flex flex-col">
      {/* Always-mounted slot Human Session Tool views — hidden when not active
          so each slot's automation hook keeps running in the background. */}
      {slots.map((_, i) => (
        <div key={`hst-${i}`} className={openSlotTool === i ? "h-full" : "hidden"}>
          <SlotHumanSessionView
            phone={phone}
            slotIdx={i}
            slotUsername={slots[i]?.username ?? ""}
            slotUsernames={slots.map(s => s.username)}
            addLog={addLog}
            onBack={() => setOpenSlotTool(null)}
            requestSlot={requestSlot}
            releaseSlot={releaseSlot}
            refreshKey={slotRefreshKeys[i] ?? 0}
            onCopied={handleCopied}
          />
        </div>
      ))}

      {/* Slot list — hidden when a slot tool view is open */}
      <div className={openSlotTool === null ? "h-full overflow-y-auto p-6 space-y-6" : "hidden"}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-foreground">Accounts</h2>
          <span className="text-xs text-muted-foreground text-right shrink-0 pt-1">{deviceName}</span>
        </div>

        <div className="space-y-4">
          {slots.map((slot, i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
              {/* Slot header: title + Delete + Human Session Tool button */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Instagram Account Slot {i + 1}</p>
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1.5 text-primary border-primary/30 hover:bg-primary/10"
                  onClick={() => setOpenSlotTool(i)}
                >
                  Human Session Tool
                  <Fingerprint className="w-3 h-3" />
                </Button>
              </div>

              {/* Row 1: Username + Password + 2FA OTP Secret */}
              <div className="flex items-end gap-3 flex-wrap">
                {/* Username */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Username</Label>
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
                  <Label className="text-xs text-muted-foreground">Password</Label>
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
                  <Label className="text-xs text-muted-foreground">2FA OTP Secret</Label>
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
                  <Label className="text-xs text-muted-foreground">Email Address</Label>
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
                  <Label className="text-xs text-muted-foreground">Email Password</Label>
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
                  <Label className="text-xs text-muted-foreground">Phone Number</Label>
                  <Input
                    value={slot.phoneNumber}
                    onChange={e => updateSlot(i, { phoneNumber: e.target.value })}
                    disabled={loading}
                    autoComplete="off"
                    className="w-[20ch]"
                  />
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
}

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

  // Collision Scheduler form
  const [csEnabled,    setCsEnabled]    = React.useState(false);
  const [csMinMin,     setCsMinMin]     = React.useState(1);
  const [csMinMax,     setCsMinMax]     = React.useState(3);
  const [csSaving,     setCsSaving]     = React.useState(false);
  const [csSaveMsg,    setCsSaveMsg]    = React.useState<string | null>(null);

  const applyConfig = React.useCallback((cfg: BatteryScheduleConfig) => {
    setEnabled(cfg.enabled);
    setUnplugMinutes(cfg.unplugMinutes);
    setCycleHours(cfg.cycleHours);
    setSpoofLevel(cfg.spoofLevel);
  }, []);

  // Load saved schedule + probe cache on mount
  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/battery/schedule`)
      .then(r => r.json()).then(d => { if (d.config) applyConfig(d.config); })
      .catch(() => {});
  }, [serial, applyConfig]);

  // Load collision scheduler settings
  React.useEffect(() => {
    if (!serial) return;
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-scheduler`)
      .then(r => r.json()).then(d => {
        if (d.config) { setCsEnabled(d.config.enabled); setCsMinMin(d.config.restMinMin); setCsMinMax(d.config.restMinMax); }
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

  const handleCsSave = async () => {
    if (!serial) return;
    setCsSaving(true); setCsSaveMsg(null);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/collision-scheduler`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: csEnabled, restMinMin: csMinMin, restMinMax: csMinMax }),
      });
      if (!r.ok) throw new Error((await r.json())?.error ?? r.status);
      setCsSaveMsg("Saved");
      setTimeout(() => setCsSaveMsg(null), 2000);
    } catch (e: any) { setCsSaveMsg(`Error: ${e?.message}`); }
    finally { setCsSaving(false); }
  };

  const ctrl     = battInfo?.chargingControl;
  const sched    = battInfo?.schedule;
  const isReal   = ctrl?.supported === true;
  const notReal  = ctrl?.probed && ctrl?.supported === false;
  const isActive = sched?.running ?? false;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <h2 className="text-lg font-bold text-foreground">Phone Settings</h2>

      {/* ── Collision Scheduler ────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        {/* Title row — always visible */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Collision Scheduler</p>
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
              When multiple slots are ready to run at the same time, they queue up — one runs at a time. After each slot finishes, the device rests for the time below before the next slot starts. Slots are prioritised by which one has been waiting the longest.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Rest between slots (min)</Label>
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
            <div className="flex items-center gap-2">
              <Button onClick={handleCsSave} disabled={csSaving || !serial}>
                {csSaving ? "Saving…" : "Save"}
              </Button>
              {csSaveMsg && <span className="text-xs text-muted-foreground">{csSaveMsg}</span>}
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
                USB stays connected for ADB data. Equinox stops the physical charging current on a repeating schedule — good for battery health and electricity. Enable to configure.
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
                <Label className="text-xs text-muted-foreground">Stop charging for (minutes)</Label>
                <Input type="number" min={1} max={1440} value={unplugMinutes}
                  onChange={e => setUnplugMinutes(Math.max(1, parseInt(e.target.value) || 1))} className="w-full" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Every (hours)</Label>
                <Input type="number" min={0.5} max={24} step={0.5} value={cycleHours}
                  onChange={e => setCycleHours(Math.max(0.5, parseFloat(e.target.value) || 0.5))} className="w-full" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
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

interface SlotStats {
  cycles: number; likes: number; follows: number;
  stories: number; reels: number; dms: number; feedShares: number;
}
const EMPTY_STATS = (): SlotStats => ({ cycles: 0, likes: 0, follows: 0, stories: 0, reels: 0, dms: 0, feedShares: 0 });

function MetricsPanel({ serial, actionLogLines }: { serial: string | null; actionLogLines: string[] }) {
  const [slotUsernames, setSlotUsernames] = useState<string[]>([]);

  // Load configured slot usernames from the server whenever the phone changes.
  useEffect(() => {
    if (!serial) { setSlotUsernames([]); return; }
    fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`)
      .then(r => r.json())
      .then(d => {
        const names: string[] = (d?.slots ?? []).map((s: any) => s?.username ?? "").filter(Boolean);
        setSlotUsernames(names);
      })
      .catch(() => {});
  }, [serial]);

  // Aggregate per-account stats from Action Log lines.
  // Line format: [date]  @username — Cycle complete — X liked  ·  Y stories  ·  Z followed …
  const statsByUsername = useMemo(() => {
    const acc: Record<string, SlotStats> = {};
    const num = (text: string, re: RegExp) => { const m = text.match(re); return m ? parseInt(m[1], 10) : 0; };
    for (const line of actionLogLines) {
      const m = line.match(/@(\S+)\s*—\s*Cycle complete/);
      if (!m) continue;
      const u = m[1];
      if (!acc[u]) acc[u] = EMPTY_STATS();
      acc[u].cycles++;
      acc[u].likes      += num(line, /(\d+)\s+liked/);
      acc[u].follows    += num(line, /(\d+)\s+followed/);
      acc[u].stories    += num(line, /(\d+)\s+stories/);
      acc[u].reels      += num(line, /(\d+)\s+reels/);
      acc[u].dms        += num(line, /(\d+)\s+DM'd/);
      acc[u].feedShares += num(line, /(\d+)\s+feed-shared/);
    }
    return acc;
  }, [actionLogLines]);

  // Show every configured slot username; append any extra usernames seen in the log.
  const allUsernames = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const u of slotUsernames) { if (u && !seen.has(u)) { seen.add(u); names.push(u); } }
    for (const u of Object.keys(statsByUsername)) { if (!seen.has(u)) { seen.add(u); names.push(u); } }
    return names;
  }, [slotUsernames, statsByUsername]);

  const METRIC_DEFS: { label: string; key: keyof SlotStats }[] = [
    { label: "Cycles",       key: "cycles"     },
    { label: "Likes",        key: "likes"       },
    { label: "Follows",      key: "follows"     },
    { label: "Story Views",  key: "stories"     },
    { label: "Reels Viewed", key: "reels"       },
    { label: "DMs Sent",     key: "dms"         },
    { label: "Feed Shares",  key: "feedShares"  },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <h2 className="text-lg font-bold text-foreground">Metrics</h2>
      {allUsernames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts configured yet.</p>
      ) : allUsernames.map(username => {
        const s = statsByUsername[username] ?? EMPTY_STATS();
        return (
          <div key={username} className="bg-card border border-border rounded-xl p-5 space-y-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">@{username}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {METRIC_DEFS.map(({ label, key }) => (
                <div key={label} className="bg-background border border-border rounded-lg p-3 flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
                  <span className="text-2xl font-bold text-foreground">{s[key] || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Debugging Log Panel ───────────────────────────────────────────────────────

function LogPanel({ lines, onClear, serial, onScanTray, addLog, getVideoSize, logRecMode, onToggleLogRec, logMarkers, phoneDims, inspectMode, onToggleInspect }: {
  lines: string[];
  onClear: () => void;
  serial?: string | null;
  /** Returns the captured lines so LogPanel can offer Copy Capture / Save. */
  onScanTray?: () => Promise<string[]>;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const [scanning,       setScanning]       = React.useState(false);
  const [copied,         setCopied]         = React.useState(false);
  const [copiedCapture,  setCopiedCapture]  = React.useState(false);
  const [lastCapture,    setLastCapture]    = React.useState<string[] | null>(null);
  const [checkingInfo,   setCheckingInfo]   = React.useState(false);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [lines.length]);

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
              onClick={onToggleInspect}
              disabled={!serial}
              title="Inspect mode — hover the phone mirror to see element info (Chrome DevTools style)"
              className={inspectMode ? "border-yellow-400/60 text-yellow-300 bg-yellow-400/10 hover:bg-yellow-400/20" : ""}
            >
              {inspectMode ? "🔍 Inspecting…" : "🔍 Inspect"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleCopyLog} disabled={lines.length === 0}>
              {copied ? "Copied!" : "📄 Copy Log"}
            </Button>
            <Button type="button" variant="secondary" onClick={handleExportLog} disabled={lines.length === 0} title="Save the full log as a .txt file — browser Save As dialog will appear">
              💾 Export Log
            </Button>
            <Button type="button" variant="secondary" onClick={onClear} disabled={lines.length === 0}>
              Clear
            </Button>
          </div>
        </div>

      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-black/90 border border-border rounded-xl p-3 font-mono text-[11px] leading-relaxed text-green-400/90">
        {lines.length === 0
          ? <p className="text-white/30">No activity yet — taps, swipes, keys, and automation cycles will show up here.</p>
          : lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TOTAL_SLOTS = 1;

type MobileTab = "account" | "phonesettings" | "actionlog" | "metrics" | "log";
const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "account",      label: "Accounts"       },
  { id: "phonesettings",label: "Phone Settings" },
  { id: "actionlog",    label: "Action Log"     },
  { id: "metrics",      label: "Metrics"        },
  { id: "log",          label: "Debugging Log"  },
];
const LOG_MAX_LINES = 500;

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
  // Per-serial "user explicitly turned the live view on" flag. Visiting the
  // Mobile tab, or a phone simply being connected, must never by itself
  // start streaming/waking the device — only pressing Power (below) or the
  // automation toggle being enabled does.
  const [liveOn, setLiveOn] = useState<Record<string, boolean>>({});
  const [logLines,       setLogLines]       = useState<string[]>([]);
  const [actionLogLines, setActionLogLines] = useState<string[]>([]);

  // ── Inspect state ───────────────────────────────────────────────────────────
  // Lifted here so the LogPanel button (sibling of PhoneSlot) can toggle it.
  const [inspectMode, setInspectMode] = useState(false);

  // ── Log Record state ────────────────────────────────────────────────────────
  const [logRecMode,    setLogRecMode]    = useState(false);
  const [logMarkers,    setLogMarkers]    = useState<LogMarker[]>([]);
  // Ref so addLog's stable useCallback closure can read current logRecMode
  // without going stale (addLog has [] deps to avoid re-creating every render).
  const logRecModeRef = useRef(false);
  useEffect(() => { logRecModeRef.current = logRecMode; }, [logRecMode]);

  const addLogMarker = useCallback((m: LogMarker) => {
    setLogMarkers(prev => [...prev, m]);
  }, []);

  const addLog = useCallback((msg: string) => {
    const now  = new Date();
    const stamp = now.toLocaleTimeString();
    setLogLines(prev => {
      const next = [...prev, `[${stamp}] ${msg}`];
      return next.length > LOG_MAX_LINES ? next.slice(next.length - LOG_MAX_LINES) : next;
    });
    // Mirror matching lines into the Action Log with a full date+time stamp.
    if (ACTION_LOG_RE.test(msg)) {
      const dateStamp = now.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
      setActionLogLines(prev => {
        const next = [...prev, `[${dateStamp}]  ${msg}`];
        return next.length > LOG_MAX_LINES ? next.slice(next.length - LOG_MAX_LINES) : next;
      });
    }
    // When Log Record is active, parse automation taps and add orange bot markers.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const allPhones = data?.phones ?? [];
  // When a specific serial is requested (from Phone Farm grid), show only that phone.
  const phones = targetSerial
    ? allPhones.filter(p => p.serial === targetSerial)
    : allPhones;
  const slots: (UsbPhone | null)[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => phones[i] ?? null);
  const activeSerial = slots[0]?.serial ?? null;
  // Points at whichever rendered PhoneSlot corresponds to activeSerial, so
  // the Log tab (a sibling, not a child, of the mirror) can pull the live
  // decoded video frame size for Check Screen Info.
  const activeSlotRef = useRef<PhoneSlotHandle>(null);

  // Poll /api/mobile/cycle-active every 2 s so the mirror auto-connects
  // whenever any slot's automation is running, without needing a device-level
  // useAutomationSettings hook here. Per-slot hooks live inside each slot's
  // SlotHumanSessionView (always mounted in AccountSettingsPanel).
  const [anyCycleRunning, setAnyCycleRunning] = useState(false);
  useEffect(() => {
    const serial = activeSerial;
    if (!serial) { setAnyCycleRunning(false); return; }
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const r = await fetch('/api/mobile/cycle-active');
        const b: { serials: string[] } = await r.json().catch(() => ({ serials: [] }));
        if (!active) return;
        setAnyCycleRunning(b.serials.includes(serial));
      } catch { /* ignore */ }
      if (active) setTimeout(poll, 2_000);
    };
    poll();
    return () => { active = false; setAnyCycleRunning(false); };
  }, [activeSerial]);

  // Drop any previously-learned aspect ratio when the connected device
  // changes (or disconnects) — otherwise a stale ratio from the last phone
  // can briefly letterbox the next one before its first frame arrives.
  useEffect(() => { setPhoneDims(null); }, [activeSerial]);

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

        {/* Header */}
        <div className="shrink-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FilledFarmIcon className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold text-foreground">Mobile Farm</h1>
            {data && (
              <span className="text-xs text-muted-foreground">
                {phones.length === 0 ? "No phones connected" : `${phones.length} / ${TOTAL_SLOTS} connected`}
              </span>
            )}
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
        {showSplitView && (
          <div className="flex-1 min-h-0 flex">
            <div ref={setPaneEl} className="w-1/2 h-full flex items-center justify-center p-4 min-h-0">
              {/* PhoneSlot sizes its own shell exactly to the phone's real
                  reported resolution using the measured pane size below —
                  see PhoneSlot's "Exact shell sizing" block for why this
                  can't be a CSS aspect-ratio on a wrapper div (that was the
                  bug: it included the header/nav chrome in the ratio math,
                  which shrank the resolved screen height and forced the
                  canvas to pillarbox/letterbox — the "dead space" bug). */}
              {slots.map((phone, i) => (
                <PhoneSlot
                  key={phone?.serial ?? `empty-${i}`}
                  phone={phone}
                  idx={i}
                  onLog={addLog}
                  onDimensions={(w, h) => setPhoneDims({ w, h })}
                  phoneDims={phoneDims}
                  paneSize={paneSize}
                  // Only auto-connect the live feed while a cycle is
                  // actually executing (automation.running) — NOT merely
                  // because the master toggle is enabled. Previously this
                  // used `automation.settings.enabled`, so after a
                  // restart/update with the toggle left on, opening this
                  // tab reconnected the phone's video feed immediately
                  // just to "check if it's alive" even though the
                  // automation loop was idle, waiting for its next
                  // scheduled run — an unnecessary connection. Clicking
                  // Power (liveOn) is still a deliberate manual-view
                  // action and always connects regardless of execution.
                  live={!!(phone && (liveOn[phone.serial] || anyCycleRunning))}
                  onPower={() => { if (phone) setLiveOn(s => ({ ...s, [phone.serial]: true })); }}
                  ref={phone?.serial === activeSerial ? activeSlotRef : undefined}
                  inspectMode={inspectMode}
                  logRecMode={logRecMode}
                  logMarkers={logMarkers}
                  onExpectedTap={(x, y, kind) => addLogMarker({ x, y, t: Date.now(), type: kind ?? "expected" })}
                />
              ))}
            </div>
            <div className="w-1/2 h-full min-h-0 flex flex-col border-l border-border">
              <div className="shrink-0 flex items-center border-b border-border px-4">
                {MOBILE_TABS.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      activeTab === t.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 relative">
                {/* Accounts panel: always mounted so each slot's automation
                    hook persists across tab switches and navigation. */}
                <div className={activeTab === "account" ? "h-full" : "hidden"}>
                  <AccountSettingsPanel phone={slots[0]} addLog={addLog} />
                </div>
                {activeTab === "phonesettings" && (
                  <PhoneSettingsPanel serial={activeSerial} />
                )}
                {activeTab === "actionlog" && (
                  <ActionLogPanel
                    lines={actionLogLines}
                    onClear={() => setActionLogLines([])}
                  />
                )}
                {activeTab === "metrics" && (
                  <MetricsPanel serial={activeSerial ?? null} actionLogLines={actionLogLines} />
                )}
                {activeTab === "log"     && (
                  <LogPanel
                    lines={logLines}
                    onClear={() => setLogLines([])}
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
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
