/**
 * Mobile Farm — USB Phone Management (4-slot single row, Electron-safe WS)
 */

import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
  ChevronLeft, Home, LayoutGrid, Power, Volume2, VolumeX, Trash2,
  FolderOpen,
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

type LiveCanvasHandle = { clearToBlack: () => void; getVideoSize: () => { w: number; h: number } | null };

type InspectNode = {
  cls: string; resourceId: string; contentDesc: string; text: string;
  bounds: string; boundsRaw: [number,number,number,number];
  center: { x: number; y: number }; clickable: boolean; area: number;
};
type InspectResult = {
  ok: boolean; nodes: InspectNode[]; screenW: number; screenH: number;
  tappedAt: { x: number; y: number }; error?: string;
  // Client-only: CSS-pixel position of the click relative to the canvas
  // container top-left, used to render the crosshair dot on the mirror.
  _cssX?: number; _cssY?: number;
};

const LiveCanvas = React.memo(React.forwardRef<LiveCanvasHandle, { serial: string; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; inspectMode?: boolean; onInspectResult?: (r: InspectResult) => void; clickTestMode?: boolean }>(function LiveCanvas({ serial, onLog, onDimensions, inspectMode, onInspectResult, clickTestMode }, ref) {
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
  useEffect(() => { inspectModeRef.current = !!inspectMode; }, [inspectMode]);
  useEffect(() => {
    clickTestModeRef.current = !!clickTestMode;
    if (!clickTestMode) { clickTestPhaseRef.current = "idle"; setTapDots(null); }
  }, [clickTestMode]);
  const onInspectResultRef = useRef(onInspectResult);
  useEffect(() => { onInspectResultRef.current = onInspectResult; }, [onInspectResult]);

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
    // Lets the page-level Log tab (Check Screen Info) show the mirror's
    // actual decoded video frame size next to `wm size`'s device resolution
    // — otherwise the only place that size is ever visible is a "Frame WxH"
    // line that scrolls past in the log the moment the stream (re)connects.
    getVideoSize() {
      return phoneSizeRef.current;
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
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const p = mapToPhone(e.clientX, e.clientY);
    if (p) { drag.lastX = p.x; drag.lastY = p.y; }
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
      if (inspectModeRef.current) {
        // Compute where the click sits in CSS pixels relative to the canvas
        // top-left so PhoneSlot can draw a crosshair at the exact spot.
        // Uses the same drawRectRef as mapToPhone — guaranteed to match the
        // visual position of the element on screen.
        let _cssX: number | undefined, _cssY: number | undefined;
        const canvas = canvasRef.current;
        const ps = phoneSizeRef.current;
        const dr = drawRectRef.current;
        if (canvas && ps && dr) {
          const { w: phoneW, h: phoneH } = ps;
          const { dx, dy, dw, dh } = dr;
          _cssX = dx + (drag.startX / phoneW) * dw;
          _cssY = dy + (drag.startY / phoneH) * dh;
        }
        addLog(`🔍 Inspecting phone (${drag.startX}, ${drag.startY})…`);
        try {
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/inspect-node`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: drag.startX, y: drag.startY }),
          });
          const body: InspectResult = await r.json();
          onInspectResultRef.current?.({ ...body, _cssX, _cssY });
          if (!body.ok) addLog(`🔍 Inspect failed — ${body.error ?? "unknown"}`);
        } catch (err: any) {
          addLog(`🔍 Inspect error — ${err?.message ?? "network error"}`);
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

      {/* FPS */}
      {status === "live" && (
        <span className="absolute top-1 right-1.5 text-[8px] font-mono text-white/30 select-none z-10">
          {fps} fps
        </span>
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

const PhoneSlot = React.forwardRef<PhoneSlotHandle, { phone: UsbPhone | null; idx: number; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; live: boolean; onPower: () => void; phoneDims: { w: number; h: number } | null; paneSize: { w: number; h: number } | null }>(function PhoneSlot({ phone, idx, onLog, onDimensions, live, onPower, phoneDims, paneSize }, ref) {
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
  const [inspectMode,   setInspectMode]   = useState(false);
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null);
  const [inspecting,    setInspecting]    = useState(false);
  const [clickTestMode, setClickTestMode] = useState(false);

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

  const handleInspectResult = useCallback(async (r: InspectResult) => {
    setInspecting(false);
    setInspectResult(r);
  }, []);

  // Log a line while the inspect fetch is in flight so the user knows it's working
  const handleInspectStart = useCallback(() => { setInspecting(true); setInspectResult(null); }, []);

  const copyInspectResult = async () => {
    if (!inspectResult) return;
    const lines = [
      `── INSPECT @ (${inspectResult.tappedAt?.x}, ${inspectResult.tappedAt?.y}) — ${inspectResult.screenW}×${inspectResult.screenH} ──`,
      ...inspectResult.nodes.map((n, i) =>
        `[${i}] ${n.clickable ? "●" : "○"} ${n.cls}  bounds=${n.bounds}  center=(${n.center.x},${n.center.y})\n    id="${n.resourceId}"  desc="${n.contentDesc}"  text="${n.text}"`
      ),
    ];
    try { await navigator.clipboard.writeText(lines.join("\n")); } catch { /* ignore */ }
  };

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
          {isReady && phone && live && (
            <>
              <button
                onClick={() => { setClickTestMode(m => !m); setInspectMode(false); setInspectResult(null); }}
                title={clickTestMode ? "Exit Click Test — 1st click sends tap + shows bullseye, 2nd click marks where it should have landed (yellow dot)" : "Click Test — diagnose tap offset: 1st click shows where tap was sent, 2nd click marks the correct target"}
                className={`text-[9px] font-semibold px-2 py-0.5 rounded transition-colors ${
                  clickTestMode
                    ? "bg-orange-400/20 text-orange-300 border border-orange-400/40"
                    : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10 hover:text-white/70"
                }`}
              >
                {clickTestMode ? "🎯 Testing" : "🎯 Click Test"}
              </button>
              <button
                onClick={() => { setInspectMode(m => !m); setInspectResult(null); setClickTestMode(false); }}
                title={inspectMode ? "Exit inspect mode — clicks will tap the phone again" : "Inspect mode — click any element on screen to identify it (like Chrome F12)"}
                className={`text-[9px] font-semibold px-2 py-0.5 rounded transition-colors ${
                  inspectMode
                    ? "bg-yellow-400/20 text-yellow-300 border border-yellow-400/40"
                    : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10 hover:text-white/70"
                }`}
              >
                {inspectMode ? "🔍 Inspecting" : "🔍 Inspect"}
              </button>
            </>
          )}
          {isReady        && <span className="flex items-center gap-1 text-[9px] font-bold text-green-400 shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Live</span>}
          {isUnauthorized && <span className="text-[9px] font-semibold text-yellow-500 shrink-0">Auth needed</span>}
          {isOffline      && <span className="text-[9px] font-semibold text-red-500 shrink-0">Offline</span>}
          {isEmpty        && <span className="text-[9px] font-mono text-white/15 shrink-0">empty</span>}
        </div>
      </div>

      {/* Screen area */}
      <div className="relative bg-zinc-900 flex-1 min-h-0">
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
            onInspectResult={handleInspectResult}
            clickTestMode={clickTestMode}
          />
        )}
        {isReady && phone && !live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <Power className="w-5 h-5 text-white/25" />
            <p className="text-[10px] text-white/40 leading-relaxed">Press Power to view this phone's screen</p>
          </div>
        )}

        {/* Inspect mode banner */}
        {inspectMode && !inspectResult && (
          <div className="absolute bottom-2 inset-x-2 flex items-center justify-center pointer-events-none z-20">
            <span className="bg-yellow-400/90 text-black text-[9px] font-bold px-2 py-1 rounded-full shadow">
              {inspecting ? "Scanning…" : "Click any element to inspect it"}
            </span>
          </div>
        )}

        {/* Crosshair dot — shows exactly where the click registered on the phone */}
        {inspectMode && inspectResult && inspectResult._cssX != null && inspectResult._cssY != null && (
          <div
            className="absolute z-40 pointer-events-none"
            style={{ left: inspectResult._cssX, top: inspectResult._cssY, transform: "translate(-50%,-50%)" }}
          >
            <div className="w-4 h-4 rounded-full border-2 border-yellow-400 bg-yellow-400/20 shadow-lg shadow-yellow-400/50" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-px h-4 bg-yellow-400" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-4 h-px bg-yellow-400" />
            </div>
          </div>
        )}

        {/* Inspect result overlay */}
        {inspectResult && inspectMode && (() => {
          const screenArea = (inspectResult.screenW || 1) * (inspectResult.screenH || 1);
          // Show the 5 most-specific (smallest-area) nodes; the rest are just wrapping containers
          const TOP_N = 5;
          const shown = inspectResult.nodes.slice(0, TOP_N);
          const hidden = inspectResult.nodes.length - shown.length;
          // Warn if no node is "specific" — smallest found still covers > 8% of screen
          const smallestArea = inspectResult.nodes[0]?.area ?? Infinity;
          const noSpecific = inspectResult.nodes.length > 0 && smallestArea > screenArea * 0.08;
          return (
            <div className="absolute inset-x-1 bottom-1 z-30 bg-zinc-900/97 border border-yellow-400/30 rounded-xl shadow-2xl text-[9px] font-mono max-h-[65%] flex flex-col">
              {/* Toolbar */}
              <div className="flex items-center justify-between px-2 py-1.5 border-b border-white/8 shrink-0">
                <span className="text-yellow-300 font-bold text-[8px]">
                  🔍 phone ({inspectResult.tappedAt?.x},{inspectResult.tappedAt?.y})
                  <span className="text-white/30 font-normal"> on {inspectResult.screenW}×{inspectResult.screenH}</span>
                </span>
                <div className="flex gap-1">
                  <button onClick={copyInspectResult} className="text-[8px] text-white/50 hover:text-white px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10">📋 Copy</button>
                  <button onClick={() => setInspectResult(null)} className="text-[8px] text-white/50 hover:text-white px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10">✕</button>
                </div>
              </div>

              {/* "No specific element" warning */}
              {noSpecific && (
                <div className="px-2 py-1.5 bg-orange-900/30 border-b border-orange-500/20 text-[8px] text-orange-300 shrink-0">
                  ⚠ No specific element found — the smallest node here covers{" "}
                  {Math.round((smallestArea / screenArea) * 100)}% of the screen.
                  Gallery/grid tiles are often rendered without accessibility data and won't appear here.
                  Try clicking a button, label, or icon instead.
                </div>
              )}

              {/* Empty state */}
              {inspectResult.nodes.length === 0 && (
                <p className="text-white/30 text-center py-3">No elements found at this point</p>
              )}

              {/* Node list — top 5 most specific */}
              <div className="overflow-y-auto flex-1 p-1.5 space-y-1">
                {shown.map((n, i) => (
                  <div key={i} className={`rounded-lg p-1.5 border ${i === 0 ? "border-yellow-400/40 bg-yellow-400/5" : "border-white/6 bg-white/2"}`}>
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className={`text-[8px] font-bold ${n.clickable ? "text-green-400" : "text-white/30"}`}>{n.clickable ? "● TAP" : "○ VIEW"}</span>
                      <span className="text-white/70 font-semibold">{n.cls}</span>
                      {i === 0 && <span className="text-[7px] text-yellow-300 ml-auto">innermost</span>}
                    </div>
                    <div className="text-white/40 leading-relaxed">
                      <div>center=<span className="text-cyan-400">({n.center.x},{n.center.y})</span>  bounds=<span className="text-white/60">{n.bounds}</span></div>
                      {n.resourceId  && <div>id=<span className="text-orange-300">"{n.resourceId}"</span></div>}
                      {n.contentDesc && <div>desc=<span className="text-lime-300">"{n.contentDesc}"</span></div>}
                      {n.text        && <div>text=<span className="text-sky-300">"{n.text}"</span></div>}
                    </div>
                  </div>
                ))}
                {hidden > 0 && (
                  <p className="text-[7px] text-white/20 text-center py-0.5">+{hidden} larger wrapper containers (use 📋 Copy to see all)</p>
                )}
              </div>
              <div className="px-2 py-1 border-t border-white/6 shrink-0">
                <span className="text-[7px] text-white/20">● tappable  ○ view-only  |  most specific (innermost) at top  |  yellow dot = where you clicked</span>
              </div>
            </div>
          );
        })()}
      </div>

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
  // Follow Users — HikerAPI-driven follow flow.
  // followSources is stored inline (no separate DB table) to keep mobile
  // settings self-contained. Each entry is a source the HikerAPI client
  // will query for target usernames.
  followEnabled: boolean;
  followUsersMin: number;
  followUsersMax: number;
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
  makePostMakeUnique: boolean;
  makePostDisableComments: boolean;
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
  followEnabled: false,
  followUsersMin: 1, followUsersMax: 3,
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
  makePostMakeUnique: false,
  makePostDisableComments: false,
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
function useAutomationSettings(phone: UsbPhone | null, onLog?: (msg: string) => void) {
  const [settings, setSettings] = useState<AutomationSettingsData>(AUTOMATION_DEFAULTS);
  const [loading,  setLoading]  = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [running,  setRunning]  = useState(false);
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);

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

  const setEnabledByUser = useCallback((enabled: boolean) => {
    if (enabled) manualToggleOnRef.current = true;
    setSettings(s => ({ ...s, enabled }));
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    if (!phone) { setSettings(AUTOMATION_DEFAULTS); return; }
    let active = true;
    setLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/automation-settings`)
      .then(r => r.json())
      .then(d => {
        if (!active) return;
        const merged = { ...AUTOMATION_DEFAULTS, ...d };
        lastSavedRef.current = JSON.stringify(merged);
        setSettings(merged);
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => { if (active) { setLoading(false); hydratedRef.current = true; } });
    return () => { active = false; };
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
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-settings`, {
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
            followEnabled: s.followEnabled,
            followUsersMin: s.followUsersMin,
            followUsersMax: s.followUsersMax,
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
            makePostMakeUnique: s.makePostMakeUnique,
            makePostDisableComments: s.makePostDisableComments,
            makePostCaptionText: s.makePostCaptionText,
            makePostImageSettings: s.makePostImageSettings,
          }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body?.ok) {
          onLog?.(`Cycle failed — ${body?.error ?? r.status}${body?.steps?.length ? ` (reached: ${body.steps.join(", ")})` : ""}`);
        } else {
          onLog?.(`Cycle complete — ${body.likes} likes${body.storiesWatched ? `, ${body.storiesWatched} stories` : ""}, closed Instagram, airplane-mode recycled, phone locked`);
        }
      } catch (e: any) {
        if ((e as any)?.name === "AbortError") {
          onLog?.("Cycle aborted — toggle turned off");
          return;
        }
        onLog?.(`Cycle failed — ${e?.message ?? "network error"}`);
      } finally {
        cycleAbortRef.current = null;
        cycleIdRef.current = null;
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

    // Deliberately turning the toggle on should run the first cycle right
    // away — that's the whole point of flipping it on. But this effect also
    // re-fires when settings load with `enabled` already true (e.g. the app
    // restarting with a phone left on from before), and that case must NOT
    // fire instantly — it should wait the configured Run-every interval like
    // every other cycle. `manualToggleOnRef` (set by `setEnabledByUser`)
    // tells us which situation this is; it's consumed once and reset so a
    // later re-render of this same "on" session doesn't re-trigger it.
    if (manualToggleOnRef.current) {
      manualToggleOnRef.current = false;
      runCycle();
    } else {
      const s0 = settingsRef.current;
      const initMin = Math.max(1, Math.min(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const initMax = Math.max(1, Math.max(s0.cycleIntervalMin, s0.cycleIntervalMax));
      const initGapMs = (initMin + Math.random() * (initMax - initMin)) * 60_000;
      setNextRunAt(Date.now() + Math.round(initGapMs));
      timer = setTimeout(runCycle, Math.round(initGapMs));
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setRunning(false);
      setNextRunAt(null);
      // Immediately abort any in-flight cycle fetch and tell the server to stop.
      // Pass the cycleId so the server only aborts the specific cycle that was
      // running when the toggle was flipped — stale abort POSTs that arrive
      // after the next cycle has already started will be ignored.
      const ctrl = cycleAbortRef.current;
      if (ctrl) {
        const abortingId = cycleIdRef.current;
        ctrl.abort();
        cycleAbortRef.current = null;
        cycleIdRef.current = null;
        fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle/abort`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cycleId: abortingId }),
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.serial, settings.enabled]);

  return { settings, setSettings, setEnabledByUser, loading, saveError, running, nextRunAt };
}

function AutomationSettingsPanel({
  phone, settings, setSettings, setEnabledByUser, loading, saveError, running, nextRunAt,
}: {
  phone: UsbPhone | null;
  settings: AutomationSettingsData;
  setSettings: React.Dispatch<React.SetStateAction<AutomationSettingsData>>;
  setEnabledByUser: (enabled: boolean) => void;
  loading: boolean;
  saveError: string | null;
  running: boolean;
  nextRunAt: number | null;
}) {
  // Follow Users UI local state — hooks must come before any conditional return.
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [newFollowSourceType, setNewFollowSourceType] = useState<'hashtag' | 'target_followers'>('hashtag');
  const [newFollowSourceValue, setNewFollowSourceValue] = useState('');
  const [mobileFollowedList, setMobileFollowedList] = useState<{username:string;followedAt:number}[]>([]);
  const [loadingFollowed, setLoadingFollowed] = useState(false);
  // Make a Post UI local state
  const [makePostImageSettingsOpen, setMakePostImageSettingsOpen] = useState(false);

  const loadFollowedUsers = React.useCallback(async () => {
    if (!phone?.serial) return;
    setLoadingFollowed(true);
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/followed-users`);
      const data = await r.json().catch(() => null);
      if (data?.users) setMobileFollowedList(data.users);
    } catch {} finally { setLoadingFollowed(false); }
  }, [phone?.serial]);

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
        <h2 className="text-lg font-bold text-foreground">Human Session Tool</h2>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
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
              <span className="text-muted-foreground text-sm">%</span>
            </div>
          </div>
        </div>}

        {/* Border separator between View Stories from Feed above and the new
            Follow Users feature below — same card/step (STEP2), mirrors the
            divider above between View Feed and View Stories from Feed. */}
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
              <span className="text-muted-foreground text-sm">%</span>
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
        </div>}

        {/* ── Inject Browsing ─────────────────────────────────
             Always visible, never collapsible — this drives real
             per-user behaviour in the follow flow, not an optional extra.
             No per-item toggles: search-browsing is mandatory (removed),
             "Get Suggested Users" was removed, and the old separate
             "Inject Profile Browsing" toggle was a duplicate of this
             whole section — injectBrowsingEnabled alone gates everything
             below. Row 1 = title + checkbox. Row 2 = Browse before
             follow / Feed chance / Feed posts (3-up). Row 3 = Click
             posts / Like / Share feed / Share to DM (4-up). Labels sit
             above their min–max fields, matching the panel's other
             settings (e.g. "Users to follow per operation" above). */}
        <div className="space-y-3">
          {/* Row 1: title + checkbox only */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="inject-browsing-enabled"
              checked={settings.injectBrowsingEnabled}
              onChange={e => setSettings(s => ({ ...s, injectBrowsingEnabled: e.target.checked }))}
              disabled={loading}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
            <label htmlFor="inject-browsing-enabled" className="text-sm font-semibold text-foreground cursor-pointer select-none">Inject Browsing</label>
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
        </div>

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
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-foreground">Activate Percentage</Label>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Chance %</Label>
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
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-foreground">Check Notifications</Label>
                  <div className="flex items-start gap-6 flex-wrap">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Chance %</Label>
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
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-foreground">Visit My Profile</Label>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Chance %</Label>
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
                      <Input type="text" placeholder="C:\Users\You\Pictures\Posts" className="h-8 text-xs font-mono w-[280px]"
                        value={settings.makePostLocalFolderPath}
                        onChange={e => setSettings(s => ({ ...s, makePostLocalFolderPath: e.target.value }))}
                        disabled={loading} />
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
                        className="h-8 px-3 text-xs rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors flex items-center gap-1.5 shrink-0"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Browse…
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
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id="make-a-post-local-delete-after"
                          checked={settings.makePostLocalFolderDeleteAfterUpload}
                          onChange={e => setSettings(s => ({ ...s, makePostLocalFolderDeleteAfterUpload: e.target.checked }))}
                          disabled={loading}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                        <label htmlFor="make-a-post-local-delete-after" className="text-xs text-muted-foreground cursor-pointer select-none">Delete after upload</label>
                      </div>
                    </div>
                  </div>
                )}
              </div>

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
                    Each control has its own enable checkbox; when off, the control
                    stays visible (not hidden) but shows as inactive/disabled rather
                    than disappearing. */}
                <div className="flex flex-wrap items-end gap-4">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <input type="checkbox" id="make-a-post-alteration-enabled"
                        checked={settings.makePostAlterationEnabled}
                        onChange={e => setSettings(s => ({ ...s, makePostAlterationEnabled: e.target.checked }))}
                        disabled={loading}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                      <label htmlFor="make-a-post-alteration-enabled" className="text-xs text-muted-foreground cursor-pointer select-none">Alteration level</label>
                    </div>
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
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <input type="checkbox" id="make-a-post-image-settings-enabled"
                        checked={settings.makePostImageSettingsEnabled}
                        onChange={e => setSettings(s => ({ ...s, makePostImageSettingsEnabled: e.target.checked }))}
                        disabled={loading}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                      <label htmlFor="make-a-post-image-settings-enabled" className="text-xs text-muted-foreground cursor-pointer select-none">Image settings</label>
                    </div>
                    <button type="button" disabled={loading || !settings.makePostImageSettingsEnabled}
                      onClick={() => setMakePostImageSettingsOpen(true)}
                      className={`h-8 px-3 text-xs rounded border transition-colors ${
                        settings.makePostImageSettingsEnabled
                          ? "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          : "bg-background border-border text-muted-foreground/40 cursor-not-allowed"
                      }`}
                    >Configure</button>
                  </div>
                  <div className="flex items-center gap-1.5 pb-2.5">
                    <input type="checkbox" id="make-a-post-make-unique"
                      checked={settings.makePostMakeUnique}
                      onChange={e => setSettings(s => ({ ...s, makePostMakeUnique: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor="make-a-post-make-unique" className="text-xs text-muted-foreground cursor-pointer select-none">Make it unique</label>
                  </div>
                  <div className="flex items-center gap-1.5 pb-2.5">
                    <input type="checkbox" id="make-a-post-disable-comments"
                      checked={settings.makePostDisableComments}
                      onChange={e => setSettings(s => ({ ...s, makePostDisableComments: e.target.checked }))}
                      disabled={loading}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <label htmlFor="make-a-post-disable-comments" className="text-xs text-muted-foreground cursor-pointer select-none">Disable comments</label>
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

        {/* ── Target Sources panel (toggled via the Sources button above) ─ */}
        <div className="space-y-2">
          {showSources && (
            <div className="border border-border rounded-lg p-3 space-y-2">
              {/* Existing sources list */}
              {settings.followSources.length > 0 ? (
                <div className="space-y-1">
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
                <p className="text-xs text-muted-foreground">No sources yet.</p>
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
                {settings.followSources.length > 0 && (
                  <Button
                    variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive shrink-0"
                    disabled={loading}
                    onClick={() => setSettings(s => ({ ...s, followSources: [] }))}
                  >Clear all</Button>
                )}
              </div>
            </div>
          )}
        </div>

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
    </div>
  );
}

const ACCT_SLOT_COUNT = 5;
const emptySlot = () => ({ username: "", password: "", totpSecret: "" });
type AccountSlot = { username: string; password: string; totpSecret: string };

function AccountSettingsPanel({ phone }: { phone: UsbPhone | null }) {
  const [slots, setSlots] = useState<AccountSlot[]>(
    Array.from({ length: ACCT_SLOT_COUNT }, emptySlot)
  );
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState<boolean[]>(Array(ACCT_SLOT_COUNT).fill(false));
  const [totpCode, setTotpCode] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
  const [totpError, setTotpError] = useState<(string | null)[]>(Array(ACCT_SLOT_COUNT).fill(null));
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
          }));
        } else if (d && d.username) {
          loaded = [{ username: d.username, password: d.password ?? "", totpSecret: "" }];
        } else {
          loaded = Array.from({ length: ACCT_SLOT_COUNT }, emptySlot);
        }
        lastSavedRef.current = JSON.stringify(loaded);
        setSlots(loaded);
        setShowPassword(Array(loaded.length).fill(false));
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
    setTotpCode(c => [...c, null]);
    setTotpError(e => [...e, null]);
  };

  const removeSlot = (i: number) => {
    setSlots(s => s.filter((_, idx) => idx !== i));
    setShowPassword(s => s.filter((_, idx) => idx !== i));
    setTotpCode(c => c.filter((_, idx) => idx !== i));
    setTotpError(e => e.filter((_, idx) => idx !== i));
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

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold text-foreground">Account Settings</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {phone.manufacturer ? `${phone.manufacturer} ` : ""}{phone.model ?? phone.serial}
        </p>
      </div>

      <div className="space-y-4">
        {slots.map((slot, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Instagram Account Slot {i + 1}</p>

            {/* All three fields on one row */}
            <div className="flex items-end gap-3 flex-wrap">
              {/* Username */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Username</Label>
                <Input
                  value={slot.username}
                  onChange={e => updateSlot(i, { username: e.target.value })}
                  placeholder="username"
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
                    placeholder="password"
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
                    placeholder="JBSWY3DPEHPK3PXP"
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

              {/* Delete slot */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => removeSlot(i)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Delete Instagram Account Slot ${i + 1}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
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
      </div>

      {saved && <p className="text-xs text-green-500">Saved</p>}
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}
    </div>
  );
}

function LogPanel({ lines, onClear, serial, onScanTray, addLog, getVideoSize }: {
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
          <h2 className="text-lg font-bold text-foreground">Log</h2>
          <div className="flex items-center gap-2">
            {serial && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleScan}
                disabled={scanning}
                title="Captures every element on screen with pixel coords and screen %. Use Copy Capture or Save to send just the layout — no log noise."
              >
                {scanning ? "Scanning…" : "📱 Capture Screen"}
              </Button>
            )}
            {serial && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleCheckScreenInfo}
                disabled={checkingInfo}
                title="Prints the device's raw wm size / wm density into the log, and flags a resolution override if one is active. Use this before Reset."
              >
                {checkingInfo ? "Checking…" : "📐 Check Screen Info"}
              </Button>
            )}
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

        {/* Capture action row — only visible after a capture has been taken */}
        {lastCapture && (
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs text-muted-foreground">Last capture ready →</span>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCopyCapture}
              className="text-xs h-7 px-2"
            >
              {copiedCapture ? "Copied!" : "📋 Copy Capture"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleSaveCapture}
              className="text-xs h-7 px-2"
              title="Downloads the capture as a .txt file"
            >
              ⬇️ Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLastCapture(null)}
              className="text-xs h-7 px-2 text-muted-foreground"
            >
              ✕
            </Button>
          </div>
        )}
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

type MobileTab = "account" | "tool" | "log";
const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "account", label: "Account Settings" },
  { id: "tool",    label: "Human Session Tool" },
  { id: "log",     label: "Log" },
];
const LOG_MAX_LINES = 500;

export function MobilePage() {
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
  const [activeTab, setActiveTab] = useState<MobileTab>("tool");
  // Per-serial "user explicitly turned the live view on" flag. Visiting the
  // Mobile tab, or a phone simply being connected, must never by itself
  // start streaming/waking the device — only pressing Power (below) or the
  // automation toggle being enabled does.
  const [liveOn, setLiveOn] = useState<Record<string, boolean>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const addLog = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogLines(prev => {
      const next = [...prev, `[${stamp}] ${msg}`];
      return next.length > LOG_MAX_LINES ? next.slice(next.length - LOG_MAX_LINES) : next;
    });
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

  const phones = data?.phones ?? [];
  const slots: (UsbPhone | null)[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => phones[i] ?? null);
  const activeSerial = slots[0]?.serial ?? null;
  // Points at whichever rendered PhoneSlot corresponds to activeSerial, so
  // the Log tab (a sibling, not a child, of the mirror) can pull the live
  // decoded video frame size for Check Screen Info.
  const activeSlotRef = useRef<PhoneSlotHandle>(null);

  // Owned here (not inside the tab-conditional panel) so the run-loop keeps
  // going in the background no matter which right-panel tab is active.
  const automation = useAutomationSettings(slots[0], addLog);

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
                  live={!!(phone && (liveOn[phone.serial] || automation.running))}
                  onPower={() => { if (phone) setLiveOn(s => ({ ...s, [phone.serial]: true })); }}
                  ref={phone?.serial === activeSerial ? activeSlotRef : undefined}
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
              <div className="flex-1 min-h-0">
                {activeTab === "account" && <AccountSettingsPanel phone={slots[0]} />}
                {activeTab === "tool"    && (
                  <AutomationSettingsPanel
                    phone={slots[0]}
                    settings={automation.settings}
                    setSettings={automation.setSettings}
                    setEnabledByUser={automation.setEnabledByUser}
                    loading={automation.loading}
                    saveError={automation.saveError}
                    running={automation.running}
                    nextRunAt={automation.nextRunAt}
                  />
                )}
                {activeTab === "log"     && (
                  <LogPanel
                    lines={logLines}
                    onClear={() => setLogLines([])}
                    serial={activeSerial}
                    addLog={addLog}
                    getVideoSize={() => activeSlotRef.current?.getVideoSize() ?? null}
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
