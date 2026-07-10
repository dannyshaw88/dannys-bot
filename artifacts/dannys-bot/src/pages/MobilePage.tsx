/**
 * Mobile Farm — USB Phone Management (4-slot single row, Electron-safe WS)
 */

import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Smartphone, RefreshCw, CheckCircle2, AlertTriangle,
  WifiOff, Loader2, Terminal, ExternalLink, Usb,
  ChevronLeft, Home, LayoutGrid, Power, Volume2, VolumeX,
} from "lucide-react";

import { AnnexBDemuxer, spsToCodecString } from "@/lib/h264Stream";

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

const LiveCanvas = React.memo(function LiveCanvas({ serial, onLog, onDimensions }: { serial: string; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const phoneSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fpsCountRef  = useRef(0);
  const frameSeenRef = useRef(false);
  // Video mode: true H.264 stream decoded with WebCodecs (near-instant).
  // Falls back to the legacy PNG-polling endpoint if screenrecord/WebCodecs
  // isn't available on this machine/device.
  const useVideoRef  = useRef(WEBCODECS_SUPPORTED);
  const demuxerRef   = useRef<AnnexBDemuxer | null>(null);
  const decoderRef   = useRef<VideoDecoder | null>(null);
  const configuredRef = useRef(false);

  const [status, setStatus] = useState<"connecting" | "waiting" | "live" | "asleep" | "error">("connecting");
  const [fps,    setFps]    = useState(0);

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

    const closeDecoder = () => {
      try { decoderRef.current?.close(); } catch { /* ignore */ }
      decoderRef.current = null;
      configuredRef.current = false;
      demuxerRef.current = null;
    };

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) { frame.close(); return; }
      if (!phoneSizeRef.current || phoneSizeRef.current.w !== frame.displayWidth || phoneSizeRef.current.h !== frame.displayHeight) {
        const sz = { w: frame.displayWidth, h: frame.displayHeight };
        phoneSizeRef.current = sz;
        canvas.width  = sz.w;
        canvas.height = sz.h;
        addLog(`Canvas set ${sz.w}×${sz.h}`);
        onDimensions?.(sz.w, sz.h);
      }
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(frame, 0, 0);
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
              onDimensions?.(sz.w, sz.h);
            }
            ctx.drawImage(img, 0, 0);
            revoke();
          };
          img.onerror = revoke;
          img.src = url;
          return;
        }

        // Real H.264 stream: demux Annex-B bytes into access units and feed
        // WebCodecs. This is what gives ~30fps live mirroring instead of the
        // 150-400ms-per-screenshot polling loop.
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

  // Maps a client (viewport) point to phone-panel coordinates, accounting
  // for the canvas's object-fit: contain letterboxing. Returns null if the
  // point falls outside the actual displayed image (in the letterbox
  // padding) or geometry isn't ready yet.
  const mapToPhone = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!canvasRef.current || !phoneSizeRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const { w: phoneW, h: phoneH } = phoneSizeRef.current;
    if (rect.width <= 0 || rect.height <= 0 || phoneW <= 0 || phoneH <= 0) return null;

    const boxRatio   = rect.width / rect.height;
    const phoneRatio = phoneW / phoneH;
    let dispW = rect.width, dispH = rect.height, offsetX = 0, offsetY = 0;
    if (boxRatio > phoneRatio) {
      dispH = rect.height;
      dispW = dispH * phoneRatio;
      offsetX = (rect.width - dispW) / 2;
    } else {
      dispW = rect.width;
      dispH = dispW / phoneRatio;
      offsetY = (rect.height - dispH) / 2;
    }

    const localX = clientX - rect.left - offsetX;
    const localY = clientY - rect.top  - offsetY;
    if (localX < 0 || localY < 0 || localX > dispW || localY > dispH) return null;

    const x = Math.min(phoneW - 1, Math.max(0, Math.round((localX / dispW) * phoneW)));
    const y = Math.min(phoneH - 1, Math.max(0, Math.round((localY / dispH) * phoneH)));
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
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/double-tap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: drag.startX, y: drag.startY, videoW: phoneSize.w, videoH: phoneSize.h }),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Double-tap FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
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
          const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/tap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: tapX, y: tapY, videoW: phoneSize.w, videoH: phoneSize.h }),
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            addLog(`Tap FAILED (${r.status}) — ${body?.error ?? "no error detail"}`);
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
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/input/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x1: drag.startX, y1: drag.startY, x2: endX, y2: endY,
          durationMs, videoW: phoneSize.w, videoH: phoneSize.h,
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
    <div className="absolute inset-0 bg-black flex flex-col">
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
          display:      status === "connecting" ? "none" : "block",
          position:     "absolute",
          inset:        0,
          width:        "100%",
          height:       "100%",
          objectFit:    "contain",
          cursor:       clickable ? "pointer" : "default",
          pointerEvents: clickable ? "auto" : "none",
          zIndex:       5,
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

function PhoneSlot({ phone, idx, onLog, onDimensions, live, onPower }: { phone: UsbPhone | null; idx: number; onLog?: (msg: string) => void; onDimensions?: (w: number, h: number) => void; live: boolean; onPower: () => void }) {
  const label = phone?.model
    ? `${phone.manufacturer ? phone.manufacturer + " " : ""}${phone.model}`
    : phone?.product ?? phone?.serial ?? null;

  const isReady        = phone?.state === "device";
  const isUnauthorized = phone?.state === "unauthorized";
  const isOffline      = phone?.state === "offline";
  const isEmpty        = !phone;

  return (
    <div className="flex flex-col bg-zinc-950 rounded-2xl border border-white/8 overflow-hidden shadow-xl w-full h-full">

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

      {/* Screen area — fills whatever height is left in the card. Using
          flex-1/min-h-0 here (instead of a fixed aspect-ratio) means the
          card's real, computed pixel height always matches its parent, so
          nested percentage heights below (the canvas) never collapse to 0 —
          which is what made the old layout both overflow the viewport and
          silently stop registering clicks. The canvas itself preserves the
          real phone aspect ratio via object-fit: contain. */}
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

        {/* Live stream only mounts once explicitly turned on — either by the
            automation toggle or by pressing the Power button below. Merely
            opening the Mobile tab / having a phone plugged in must never by
            itself wake the device or start pulling frames. */}
        {isReady && phone && live && <LiveCanvas serial={phone.serial} onLog={onLog} onDimensions={onDimensions} />}
        {isReady && phone && !live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <Power className="w-5 h-5 text-white/25" />
            <p className="text-[10px] text-white/40 leading-relaxed">Press Power to view this phone's screen</p>
          </div>
        )}
      </div>

      {/* Nav bar */}
      {isReady && phone && (
        <div className="flex items-center justify-center gap-2 py-2 bg-zinc-900 border-t border-white/6 shrink-0">
          <NavBtn icon={<ChevronLeft className="w-3.5 h-3.5" />} label="Back"   onClick={() => sendKey(phone.serial, 4,   "Back",   onLog)} />
          <NavBtn icon={<Home        className="w-3.5 h-3.5" />} label="Home"   onClick={() => sendKey(phone.serial, 3,   "Home",   onLog)} />
          <NavBtn icon={<LayoutGrid  className="w-3.5 h-3.5" />} label="Recent" onClick={() => sendKey(phone.serial, 187, "Recent", onLog)} />
          <div className="w-px h-4 bg-white/10" />
          {/* Power both sends the real hardware keyevent AND is the one
              explicit user action allowed to turn the live view on — never
              triggered automatically by mounting/visiting this tab. */}
          <NavBtn icon={<Power       className="w-3 h-3" />}     label="Power"  onClick={() => { onPower(); sendKey(phone.serial, 26, "Power", onLog); }} />
          <NavBtn icon={<Volume2     className="w-3 h-3" />}     label="Vol +"  onClick={() => sendKey(phone.serial, 24,  "Vol +",  onLog)} />
          <NavBtn icon={<VolumeX     className="w-3 h-3" />}     label="Vol −"  onClick={() => sendKey(phone.serial, 25,  "Vol −",  onLog)} />
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
        <div className="border-t border-border/50" />
        <SetupStep n={4} title="Enable the SECOND USB debugging toggle (MIUI/Xiaomi)" body={<>In <strong>Settings → Developer Options</strong>, also turn on <strong>"USB debugging (Security settings)"</strong> — a separate toggle from step 2. It requires signing into a Mi account and a reboot. Without it, taps/keys silently fail and the phone mirror can't stream real video (it falls back to slow screenshots).</>} />
      </div>
    </div>
  );
}

// ─── Automation settings panel (right column, per device) ────────────────────

interface AutomationSettingsData {
  enabled: boolean;
  actionDelayMin: number;
  actionDelayMax: number;
  likePercentMin: number;
  likePercentMax: number;
  feedScrollMin: number;
  feedScrollMax: number;
}

const AUTOMATION_DEFAULTS: AutomationSettingsData = {
  enabled: false, actionDelayMin: 5, actionDelayMax: 10, likePercentMin: 3, likePercentMax: 5, feedScrollMin: 5, feedScrollMax: 10,
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

  // Loaded settings (including `enabled`) come from the server per phone —
  // used to detect real user edits vs. the initial load, so autosave never
  // fires before the fetch resolves.
  const hydratedRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Snapshot of what's actually persisted server-side — lets autosave skip
  // firing a no-op POST right after hydration (when `settings` merely
  // mirrors what was just loaded) and only save on real user edits.
  const lastSavedRef = useRef<string>(JSON.stringify(AUTOMATION_DEFAULTS));

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

  // While the master toggle is on, repeatedly run a Check-Feed cycle
  // (random scroll count from the configured range, honoring the delay and
  // like-percentage settings) back-to-back until the toggle is switched
  // off or the phone disconnects.
  useEffect(() => {
    if (!phone || !settings.enabled) { setRunning(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const serial = phone.serial;

    const runCycle = async () => {
      if (cancelled) return;
      const s = settingsRef.current;
      const min = Math.max(1, Math.min(s.feedScrollMin, s.feedScrollMax));
      const max = Math.max(s.feedScrollMin, s.feedScrollMax);
      const count = Math.floor(Math.random() * (max - min + 1)) + min;
      setRunning(true);
      onLog?.(`Tool active → ${count} downward scrolls`);
      try {
        const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/check-feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            count,
            delayMinSec: s.actionDelayMin,
            delayMaxSec: s.actionDelayMax,
            likePercentMin: s.likePercentMin,
            likePercentMax: s.likePercentMax,
          }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body?.ok) onLog?.(`Cycle failed — ${body?.error ?? r.status}`);
      } catch (e: any) {
        onLog?.(`Cycle failed — ${e?.message ?? "network error"}`);
      }
      if (cancelled) return;
      const s2 = settingsRef.current;
      const gapSec = s2.actionDelayMin + Math.random() * Math.max(0, s2.actionDelayMax - s2.actionDelayMin);
      timer = setTimeout(runCycle, Math.round(gapSec * 1000));
    };

    runCycle();
    return () => { cancelled = true; if (timer) clearTimeout(timer); setRunning(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.serial, settings.enabled]);

  return { settings, setSettings, loading, saveError, running };
}

function AutomationSettingsPanel({
  phone, settings, setSettings, loading, saveError, running,
}: {
  phone: UsbPhone | null;
  settings: AutomationSettingsData;
  setSettings: React.Dispatch<React.SetStateAction<AutomationSettingsData>>;
  loading: boolean;
  saveError: string | null;
  running: boolean;
}) {
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
      <div>
        <h2 className="text-lg font-bold text-foreground">Human Session Tool</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {phone.manufacturer ? `${phone.manufacturer} ` : ""}{phone.model ?? phone.serial}
        </p>
      </div>

      {/* Master toggle — turns the whole tool on/off. Everything below is
          just configuration for what happens while it's active. */}
      <div className="flex items-center justify-between bg-card border border-border rounded-xl p-5">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {settings.enabled ? (running ? "Running" : "Active") : "Disabled"}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {settings.enabled ? "Automatically scrolling and liking on this phone" : "Tool is idle"}
          </div>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => setSettings(s => ({ ...s, enabled }))}
          disabled={loading}
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="grid grid-cols-2 gap-5">
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
            <Label className="text-sm text-muted-foreground">Delay between actions (seconds)</Label>
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
        </div>

        <div className="space-y-3">
          <Label className="text-sm text-muted-foreground">Like this % of viewed posts</Label>
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

        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      </div>
    </div>
  );
}

function AccountSettingsPanel({ phone }: { phone: UsbPhone | null }) {
  const [account, setAccount] = useState<{ username: string; password: string }>({ username: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef<string>(JSON.stringify({ username: "", password: "" }));

  useEffect(() => {
    hydratedRef.current = false;
    if (!phone) { setAccount({ username: "", password: "" }); return; }
    let active = true;
    setLoading(true);
    fetch(`/api/mobile/devices/${encodeURIComponent(phone.serial)}/account`)
      .then(r => r.json())
      .then(d => {
        if (!active) return;
        const loaded = d && d.username ? { username: d.username, password: d.password ?? "" } : { username: "", password: "" };
        lastSavedRef.current = JSON.stringify(loaded);
        setAccount(loaded);
      })
      .catch(() => { /* keep blank */ })
      .finally(() => { if (active) { setLoading(false); hydratedRef.current = true; } });
    return () => { active = false; };
  }, [phone?.serial]);

  useEffect(() => {
    if (!phone || !hydratedRef.current) return;
    if (!account.username.trim() || !account.password.trim()) return; // wait for both fields before saving
    const serial = phone.serial;
    const toSaveStr = JSON.stringify(account);
    if (toSaveStr === lastSavedRef.current) return;
    const t = setTimeout(() => {
      fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: toSaveStr,
      })
        .then(async r => {
          const body = await r.json().catch(() => null);
          if (!r.ok || !body?.ok) { setSaveError(body?.error ?? `Server rejected the account (${r.status})`); return; }
          lastSavedRef.current = toSaveStr;
          setSaveError(null);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        })
        .catch((e: any) => setSaveError(e?.message ?? "Couldn't reach the server"));
    }, 600);
    return () => clearTimeout(t);
  }, [account, phone?.serial]);

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

      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Instagram username</Label>
          <Input
            value={account.username}
            onChange={e => setAccount(a => ({ ...a, username: e.target.value }))}
            placeholder="username"
            disabled={loading}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Password</Label>
          <div className="flex items-center gap-2">
            <Input
              type={showPassword ? "text" : "password"}
              value={account.password}
              onChange={e => setAccount(a => ({ ...a, password: e.target.value }))}
              placeholder="password"
              disabled={loading}
              autoComplete="off"
            />
            <Button type="button" variant="secondary" onClick={() => setShowPassword(s => !s)}>
              {showPassword ? "Hide" : "Show"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved automatically as you type — linked to this phone (serial {phone.serial}).
        </p>
        {saved && <p className="text-xs text-green-500">Saved</p>}
        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      </div>
    </div>
  );
}

function LogPanel({ lines, onClear }: { lines: string[]; onClear: () => void }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [lines.length]);

  return (
    <div className="h-full flex flex-col p-6">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-lg font-bold text-foreground">Log</h2>
        <Button type="button" variant="secondary" onClick={onClear} disabled={lines.length === 0}>
          Clear
        </Button>
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

  // Owned here (not inside the tab-conditional panel) so the run-loop keeps
  // going in the background no matter which right-panel tab is active.
  const automation = useAutomationSettings(slots[0], addLog);

  // Drop any previously-learned aspect ratio when the connected device
  // changes (or disconnects) — otherwise a stale ratio from the last phone
  // can briefly letterbox the next one before its first frame arrives.
  useEffect(() => { setPhoneDims(null); }, [activeSerial]);

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
            <div className="w-1/2 h-full flex items-center justify-center p-4 min-h-0">
              {/* Aspect ratio is set from the phone's real reported resolution
                  once known (falls back to 9/16 before the first frame
                  arrives), so the canvas's object-fit: contain never has to
                  letterbox — the shell fits the actual screen exactly instead
                  of leaving black bars on either side. */}
              <div
                className="h-full"
                style={{
                  maxWidth: "100%",
                  aspectRatio: phoneDims ? `${phoneDims.w} / ${phoneDims.h}` : "9 / 16",
                }}
              >
                {slots.map((phone, i) => (
                  <PhoneSlot
                    key={phone?.serial ?? `empty-${i}`}
                    phone={phone}
                    idx={i}
                    onLog={addLog}
                    onDimensions={(w, h) => setPhoneDims({ w, h })}
                    live={!!(phone && (liveOn[phone.serial] || automation.settings.enabled))}
                    onPower={() => { if (phone) setLiveOn(s => ({ ...s, [phone.serial]: true })); }}
                  />
                ))}
              </div>
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
                    loading={automation.loading}
                    saveError={automation.saveError}
                    running={automation.running}
                  />
                )}
                {activeTab === "log"     && <LogPanel lines={logLines} onClear={() => setLogLines([])} />}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
