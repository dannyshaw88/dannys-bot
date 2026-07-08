import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronLeft, ChevronRight, RefreshCw, Compass, Globe, Shield,
  Trash2, Loader2, WifiOff, LogIn, CheckCircle2, AlertCircle, MonitorPlay, X, Upload, Phone, Mail, KeyRound, Plus, ShieldAlert, Sparkles, Download,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { recordLoginEvent } from "@/lib/ipLoginTracker";

function cleanLoginError(msg: string): string {
  const m = (msg ?? "").toLowerCase();
  if (m.includes("incorrect") || m.includes("wrong password") || m.includes("bad_password")) return "Incorrect password";
  if (m.includes("checkpoint") || m.includes("challenge_required")) return "Checkpoint required";
  if (m.includes("two_factor") || m.includes("2fa") || m.includes("otp") || m.includes("verification code")) return "2FA code required";
  if (m.includes("rate") || m.includes("too many") || m.includes("flood")) return "Rate limited try again later";
  if (m.includes("disabled") || m.includes("banned") || m.includes("suspended")) return "Account disabled";
  if (m.includes("timeout") || m.includes("timed out")) return "Login timed out";
  if (m.includes("network") || m.includes("connect") || m.includes("unreachable")) return "Network error";
  if (m.includes("proxy")) return "Proxy error";
  if (m.includes("not found") || m.includes("no user")) return "Account not found";
  return "Login failed";
}

interface BrowserPanelProps {
  profileId: number;
  userAgent: string;
  username: string;
  /** When true, renders as a fixed-height panel inside a page (no h-full). */
  embedded?: boolean;
  /** Override the WebSocket stream URL (default: /api/browser/:profileId/stream). */
  streamUrl?: string;
  /** Override the input POST URL (default: /api/browser/:profileId/input). */
  inputUrl?: string;
  /** Force canvas stream mode even in Electron (use for server-side Puppeteer streams like signup browser). */
  forceStream?: boolean;
  /** Called for every non-binary WS message (after internal handling). Use to receive signupStep / signupPaused / signupDone events. */
  onMessage?: (msg: any) => void;
  /** Override canvas/stream width in CSS pixels (default 1280). */
  browserWidth?: number;
  /** Override canvas/stream height in CSS pixels (default 760). */
  browserHeight?: number;
  /** Hide the isolation banner and address-bar toolbar (use when embedding inside a phone frame). */
  noToolbar?: boolean;
  /** Proxy host for this profile — used by the IP login rate limit warning. */
  proxyHost?: string | null;
  /** Proxy port for this profile — used together with proxyHost for the rate limit key. */
  proxyPort?: number | null;
}

type SSEStatus = "idle" | "connecting" | "connected" | "error";
type LoginState = "idle" | "running" | "ok" | "fail";

interface LogEntry {
  ts: string;
  text: string;
  kind: "step" | "ok" | "fail" | "error";
}

interface ConsoleEntry {
  ts: string;
  level: string;
  text: string;
}

interface TabInfo {
  url: string;
}

const BROWSER_W = 1280;
const BROWSER_H = 760;
const MOBILE_W  = 393;
const MOBILE_H  = 851;

function nowTs() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

// Detect Electron native EB mode (window.electronAPI exposed by preload)
const IS_ELECTRON = typeof (window as any).electronAPI !== "undefined";

export function BrowserPanel({ profileId, userAgent, username, embedded, streamUrl, inputUrl, forceStream, onMessage, browserWidth, browserHeight, noToolbar, proxyHost, proxyPort }: BrowserPanelProps) {
  const bW = browserWidth ?? BROWSER_W;
  const bH = browserHeight ?? BROWSER_H;
  const bWRef = useRef(bW);
  const bHRef = useRef(bH);
  bWRef.current = bW;
  bHRef.current = bH;
  const { windows, clearPendingUrl } = useBrowserWindows();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const esRef = useRef<WebSocket | null>(null);
  const addressFocusedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<SSEStatus>("idle");
  const statusRef = useRef<SSEStatus>("idle");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonically-increasing counter, incremented on every connect() call.
  // Every ws.onclose and reconnect timer captures its own generation number;
  // stale callbacks bail out if the counter has moved on, preventing multiple
  // parallel reconnect loops from fighting each other.
  const wsGenRef = useRef(0);
  const firstFrameFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const hasReceivedFirstFrameRef = useRef(false);
  const [isFrozen, setIsFrozen] = useState(false);
  // Ref mirror of isFrozen — lets the onmessage handler skip calling setIsFrozen(false)
  // when it's already false, avoiding 80+ redundant React state updates per second.
  const isFrozenRef = useRef(false);
  // Binary frame pipeline: JPEG arrives → createImageBitmap (off-thread) → RAF draw.
  // pendingBitmapRef holds the latest decoded bitmap; RAF drains it once per paint.
  const pendingBitmapRef = useRef<ImageBitmap | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const setStatusSafe = useCallback((s: SSEStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [addressBar, setAddressBar] = useState("https://www.instagram.com/");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [loginLog, setLoginLog] = useState<LogEntry[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const [totpCode, setTotpCode] = useState<string | null>(null);
  const [totpCopied, setTotpCopied] = useState(false);
  const [totpNoKey, setTotpNoKey] = useState(false);
  const cachedTwoFASecretRef = useRef<string | null | undefined>(undefined);
  const [showLog, setShowLog] = useState(false);
  const [logTab, setLogTab] = useState<"login" | "console">("login");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [pendingNavUrl, setPendingNavUrl] = useState<string | null>(null);
  const [waitingFirstFrame, setWaitingFirstFrame] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [fileChooserPending, setFileChooserPending] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0);
  const [aiResult, setAiResult] = useState<{ imageBase64: string; fileName: string; metadata: { make: string; model: string; shotAt: string; iso: number } } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // F12 on the canvas toggles the log panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F12") {
        e.preventDefault();
        setShowLog(prev => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const appendLog = useCallback((text: string, kind: LogEntry["kind"] = "step") => {
    setLoginLog(prev => [...prev, { ts: nowTs(), text, kind }]);
  }, []);

  const generateTotp = useCallback(async (onCode?: (code: string) => void) => {
    setTotpNoKey(false);
    let secret = cachedTwoFASecretRef.current;
    if (secret === undefined) {
      try {
        const res = await fetch(`/api/profiles/${profileId}`);
        const p = await res.json();
        secret = (p.twoFASecretKey as string | null) ?? null;
        cachedTwoFASecretRef.current = secret;
      } catch { return; }
    }
    if (!secret?.trim()) { setTotpNoKey(true); setTimeout(() => setTotpNoKey(false), 3000); return; }
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
      if (!bytes.length) { setTotpNoKey(true); setTimeout(() => setTotpNoKey(false), 3000); return; }
      const key = await crypto.subtle.importKey(
        "raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
      );
      const counter = Math.floor(Date.now() / 1000 / 30);
      const buf = new Uint8Array(8);
      let c = counter;
      for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
      const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
      const offset = hmac[19] & 0xf;
      const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1_000_000;
      const codeStr = code.toString().padStart(6, "0");
      setTotpCode(codeStr);
      navigator.clipboard.writeText(codeStr).catch(() => {});
      setTotpCopied(true);
      onCode?.(codeStr);
      setTimeout(() => { setTotpCopied(false); setTotpCode(null); }, 4000);
    } catch { setTotpNoKey(true); setTimeout(() => setTotpNoKey(false), 3000); }
  }, [profileId]);

  // Auto-scroll log to bottom on new entries
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [loginLog]);

  // ── Input sender: POST to /api/browser/:id/input ─────────────────────────
  const send = useCallback((msg: object) => {
    // Electron mode: commands always go to the native window — no WS required.
    // Puppeteer mode: require an active WebSocket connection.
    if (!(IS_ELECTRON && !forceStream) && statusRef.current !== "connected") return;
    const url = (IS_ELECTRON && !forceStream)
      ? `/api/profiles/${profileId}/eb-input`
      : (inputUrl ?? `/api/browser/${profileId}/input`);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }, [profileId, inputUrl, forceStream]);

  // ── Non-passive wheel listener (throttled) ───────────────────────────────
  // Wheel events fire at up to 60/s on a trackpad. Each one was spawning a
  // separate fetch → 2 Puppeteer CDP commands (move + wheel) that queue serially,
  // jamming the CDP pipeline and blocking screenshots → the "frozen" scroll.
  // Fix: accumulate all deltas in an 80 ms window and send one batched scroll,
  // capping scroll throughput at ~12/s regardless of device scroll speed.
  const scrollBufRef = useRef<{ x: number; y: number; dX: number; dY: number } | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (bWRef.current / rect.width));
      const y = Math.round((e.clientY - rect.top) * (bHRef.current / rect.height));
      if (scrollBufRef.current) {
        scrollBufRef.current.dX += e.deltaX;
        scrollBufRef.current.dY += e.deltaY;
        scrollBufRef.current.x = x;
        scrollBufRef.current.y = y;
      } else {
        scrollBufRef.current = { x, y, dX: e.deltaX, dY: e.deltaY };
      }
      if (!scrollTimerRef.current) {
        scrollTimerRef.current = setTimeout(() => {
          scrollTimerRef.current = null;
          if (!scrollBufRef.current) return;
          const { x, y, dX, dY } = scrollBufRef.current;
          scrollBufRef.current = null;
          send({ type: "scroll", x, y, deltaX: dX, deltaY: dY * 3 });
        }, 80);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      if (scrollTimerRef.current) { clearTimeout(scrollTimerRef.current); scrollTimerRef.current = null; }
      scrollBufRef.current = null;
    };
  }, [send]);

  // ── WebSocket connection lifecycle ────────────────────────────────────────
  // WebSocket connections use a separate socket pool in Chromium and do NOT count
  // against the 6-connection-per-origin HTTP/1.1 limit. This means 10+ EBs can
  // be open simultaneously without the click POST requests (sent via HTTP) being
  // queued behind the frame streams. With SSE, 5+ EBs saturated the pool and
  // clicks never reached the server — hence the "login button does nothing" bug.
  const connect = useCallback(() => {
    // Electron mode: no Puppeteer / WebSocket stream. Mark as "connected"
    // immediately so all toolbar buttons are enabled. URL updates come from polling.
    // Exception: forceStream=true means a server-side Puppeteer browser is streaming
    // even inside Electron (e.g. signup browser) — fall through to WebSocket path.
    if (IS_ELECTRON && !forceStream) {
      setStatusSafe("connected");
      return;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current) {
      (esRef.current as WebSocket).close();
      esRef.current = null;
    }
    // Stamp this connection attempt with a unique generation number.
    // All callbacks created below capture `myGen`; they bail out immediately
    // if wsGenRef.current has advanced past it, meaning a newer connect() call
    // already took over.  This prevents stale onclose events (from WSes that
    // were closed by a later connect()) from scheduling phantom reconnects that
    // fight the active connection in an infinite loop.
    const myGen = ++wsGenRef.current;
    if (firstFrameFallbackRef.current) {
      clearTimeout(firstFrameFallbackRef.current);
      firstFrameFallbackRef.current = null;
    }
    setStatusSafe("connecting");
    setIsFrozen(false);
    setErrorMsg(null);
    setIsLoading(true);
    setWaitingFirstFrame(true);
    hasReceivedFirstFrameRef.current = false;

    // Safety net: if Chrome only ever sends blank frames (e.g. very slow proxy),
    // dismiss the overlay after 45 s so the user isn't stuck staring at the spinner.
    firstFrameFallbackRef.current = setTimeout(() => {
      if (!hasReceivedFirstFrameRef.current) {
        hasReceivedFirstFrameRef.current = true;
        setWaitingFirstFrame(false);
      }
    }, 45000);

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const resolvedStreamUrl = streamUrl ?? `/api/browser/${profileId}/stream`;
    const ws = new WebSocket(`${wsProto}//${window.location.host}${resolvedStreamUrl}`);
    // Binary frames carry raw JPEG bytes (no base64/JSON wrapping).
    // All other messages are still JSON text frames.
    ws.binaryType = "blob";
    esRef.current = ws as any;

    ws.onopen = () => {
      setStatusSafe("connected");
      setIsLoading(false);
    };

    ws.onmessage = (evt) => {
      // ── Binary frame = raw JPEG from screencast ──────────────────────────
      // The server sends Buffer (raw JPEG) for every screencast frame.
      // Receiving it as a Blob and piping through createImageBitmap() keeps
      // JPEG decode off the renderer main thread entirely.  A requestAnimationFrame
      // gate then batches all draws to one per paint cycle, dropping intermediate
      // frames if they arrive faster than the display refreshes.
      if (evt.data instanceof Blob) {
        lastFrameTimeRef.current = Date.now();
        // Only flip state (→ React re-render) when actually transitioning out of frozen.
        if (isFrozenRef.current) { isFrozenRef.current = false; setIsFrozen(false); }
        // Any blob frame — even a blank/white checkpoint page — counts as first frame.
        // This ensures the "Starting browser…" overlay always clears the moment Chrome
        // renders anything, including Instagram lock/challenge pages.
        if (!hasReceivedFirstFrameRef.current) {
          hasReceivedFirstFrameRef.current = true;
          setWaitingFirstFrame(false);
          if (firstFrameFallbackRef.current) {
            clearTimeout(firstFrameFallbackRef.current);
            firstFrameFallbackRef.current = null;
          }
        }
        createImageBitmap(evt.data).then(bitmap => {
          // Keep only the latest bitmap; discard any not-yet-drawn older one.
          pendingBitmapRef.current?.close();
          pendingBitmapRef.current = bitmap;
          // Schedule one canvas draw per animation frame — skip if already scheduled.
          if (rafIdRef.current === null) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = null;
              const bmp = pendingBitmapRef.current;
              if (!bmp) return;
              pendingBitmapRef.current = null;
              const canvas = canvasRef.current;
              if (!canvas) { bmp.close(); return; }
              const ctx = canvas.getContext("2d");
              if (!ctx) { bmp.close(); return; }
              ctx.drawImage(bmp, 0, 0, bWRef.current, bHRef.current);
              bmp.close();
            });
          }
        }).catch(() => {});
        return;
      }

      // ── Text frame = JSON for all other message types ────────────────────
      try {
        const msg = JSON.parse(evt.data as string);
        switch (msg.type) {
          case "loading":
            setIsLoading(msg.loading);
            break;
          case "urlChange":
            if (msg.url && msg.url !== "about:blank" && !addressFocusedRef.current) setAddressBar(msg.url);
            if (msg.url && (msg.url.includes("instagram.com/accounts/login") || msg.url.includes("instagram.com/login"))) {
              setLoginState(prev => prev === "ok" ? "idle" : prev);
            }
            break;
          case "screencast_started":
            // Server confirmed the CDP screencast pipeline is active (either
            // initial start or a silent-stream restart). Clear both the
            // "Loading…" overlay and the "Browser appears frozen" overlay —
            // Chrome is alive and frames will arrive shortly.
            // Also reset the stale-frame timer so the frozen detector doesn't
            // fire again immediately after the restart.
            lastFrameTimeRef.current = Date.now();
            isFrozenRef.current = false;
            setIsFrozen(false);
            if (!hasReceivedFirstFrameRef.current) {
              hasReceivedFirstFrameRef.current = true;
              setWaitingFirstFrame(false);
              if (firstFrameFallbackRef.current) {
                clearTimeout(firstFrameFallbackRef.current);
                firstFrameFallbackRef.current = null;
              }
            }
            break;
          case "launching":
            // Server confirmed it received the open request and is launching Chrome.
            // Keep waitingFirstFrame=true (spinner stays) but update the overlay
            // label so the user sees meaningful feedback instead of a blank spinner.
            setWaitingFirstFrame(true);
            break;
          case "error":
            setErrorMsg(msg.message ?? "Unknown error");
            setStatusSafe("error");
            setIsLoading(false);
            ws.close();
            esRef.current = null;
            break;
          case "loginStatus": {
            const text = msg.message ?? "";
            const isErr = text.startsWith("⚠") || text.startsWith("Error");
            appendLog(text, isErr ? "error" : "step");
            break;
          }
          case "loginDone":
            if (msg.ok) {
              recordLoginEvent(proxyHost, proxyPort);
              setLoginState("ok");
              appendLog(msg.message || "Done", "ok");
            } else {
              // Only show the red button when Instagram itself rejected the login
              // (wrong password, checkpoint, 2FA, disabled, etc.). Technical failures
              // that happen after a successful auth — screenshot timeout, session capture
              // error, network blip — should NOT brand the button red.
              const em = (msg.message ?? "").toLowerCase();
              const isInstagramErr =
                em.includes("incorrect") || em.includes("bad_password") ||
                em.includes("checkpoint") || em.includes("challenge_required") ||
                em.includes("two_factor") || em.includes("2fa") ||
                em.includes("disabled") || em.includes("banned") ||
                em.includes("not found") || em.includes("no user") ||
                em.includes("rate") || em.includes("flood") ||
                em.includes("feedback_required") || em.includes("proxy") ||
                em.includes("login failed") || em.includes("bad credentials");
              if (isInstagramErr) {
                setLoginState("fail");
                appendLog(msg.message || "Login failed", "fail");
                setTimeout(() => setLoginState("idle"), 12000);
              } else {
                setLoginState("idle");
                appendLog(msg.message || "Login flow ended", "step");
              }
            }
            break;
          case "fileChooserNeeded":
            setFileChooserPending(true);
            break;
          case "consoleLog": {
            const entry: ConsoleEntry = { ts: nowTs(), level: msg.level ?? "log", text: msg.text ?? "" };
            setConsoleLogs(prev => [...prev.slice(-199), entry]);
            break;
          }
          case "tabsUpdate":
            setTabs(msg.tabs ?? []);
            setActiveTab(msg.active ?? 0);
            break;
          case "replaced":
            // Server is closing this WS because a newer connection has taken
            // over the same EB session.  Advance wsGenRef so the upcoming
            // onclose handler sees a generation mismatch and bails instead of
            // scheduling a phantom reconnect that would fight the new WS.
            wsGenRef.current++;
            break;
          case "already-connected":
            // Server rejected this WS because the session already has an open
            // connection from another connect() call.  There is nothing to
            // reconnect to — bail so we don't keep hammering the server.
            wsGenRef.current++;
            break;
        }
        try { onMessage?.(msg); } catch {}
      } catch {}
    };

    ws.onclose = () => {
      // Generation guard: bail if a newer connect() call has already taken over.
      // This handles two failure modes:
      //   1. connect() closes the old WS and immediately sets esRef to the new one;
      //      the old onclose fires asynchronously and must not clobber the new ref.
      //   2. Two stale onclose callbacks from an earlier reconnect loop both fire
      //      after a server restart; only the one whose generation matches the
      //      current counter should schedule a reconnect — the others are silently
      //      dropped, breaking the multi-loop cascade.
      if (wsGenRef.current !== myGen) return;
      esRef.current = null;
      setIsLoading(false);
      if (statusRef.current !== "error") {
        setStatusSafe("idle");
        reconnectTimerRef.current = setTimeout(() => {
          // Double-check generation inside the timer too: if connect() was called
          // from somewhere else before this timer fired, skip the extra reconnect.
          if (wsGenRef.current !== myGen) return;
          if (statusRef.current === "idle") connect();
        }, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [profileId, streamUrl, forceStream, setStatusSafe, appendLog]);

  useEffect(() => () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    // Cancel any in-flight RAF and release the pending ImageBitmap GPU resource.
    if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    pendingBitmapRef.current?.close();
    pendingBitmapRef.current = null;
  }, []);

  useEffect(() => { connect(); }, [connect]);

  // ── Electron mode: poll native window state for address bar updates ───────
  useEffect(() => {
    if (!IS_ELECTRON || forceStream) return;
    const poll = async () => {
      try {
        const r = await fetch(`/api/profiles/${profileId}/eb-state`);
        const data: { open: boolean; url: string } = await r.json();
        if (data.url && data.url !== "about:blank" && !addressFocusedRef.current) {
          setAddressBar(data.url);
        }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [profileId]);

  // Track how long the EB has been open (since first connection)
  useEffect(() => {
    if (status === "connected" && openedAt === null) {
      setOpenedAt(Date.now());
      setElapsedSecs(0);
    }
    if (status !== "connected" && status !== "connecting") {
      // Reset timer when browser fully disconnects (not just reconnecting)
    }
  }, [status, openedAt]);

  useEffect(() => {
    if (openedAt === null) return;
    const interval = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - openedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [openedAt]);

  const elapsedLabel = useMemo(() => {
    const h = Math.floor(elapsedSecs / 3600);
    const m = Math.floor((elapsedSecs % 3600) / 60);
    const s = elapsedSecs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [elapsedSecs]);

  // Stale-frame detector: if connected AND at least one frame was received but then
  // no new frame arrives for 10 minutes, flag as frozen.
  // A 10-minute threshold means an idle browser (e.g. waiting for user input on a
  // cookie banner or login form) will never trigger this overlay during normal use.
  // hasReceivedFirstFrameRef prevents false "frozen" during Chrome's startup window
  // (the SSE stream opens before Chrome has launched, so there's a gap before first frame).
  useEffect(() => {
    if (status !== "connected") { isFrozenRef.current = false; setIsFrozen(false); return; }
    lastFrameTimeRef.current = Date.now();
    const timer = setInterval(() => {
      if (
        statusRef.current === "connected" &&
        hasReceivedFirstFrameRef.current &&
        Date.now() - lastFrameTimeRef.current > 600000
      ) {
        isFrozenRef.current = true;
        setIsFrozen(true);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const entry = windows.find(w => w.profileId === profileId);
    if (!entry?.pendingUrl) return;
    const url = entry.pendingUrl;
    clearPendingUrl(profileId);
    if (statusRef.current === "connected") {
      setAddressBar(url);
      setIsLoading(true);
      send({ type: "navigate", url });
    } else {
      setPendingNavUrl(url);
    }
  }, [windows, profileId, clearPendingUrl, send]);

  useEffect(() => {
    if (status !== "connected" || !pendingNavUrl) return;
    const url = pendingNavUrl;
    setPendingNavUrl(null);
    setAddressBar(url);
    setIsLoading(true);
    send({ type: "navigate", url });
  }, [status, pendingNavUrl, send]);

  // ── Canvas rendering ──────────────────────────────────────────────────────
  // Frame drawing is handled by the binary ws.onmessage path above:
  // Blob → createImageBitmap (off-thread) → requestAnimationFrame → drawImage.

  const scale = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (bWRef.current / r.width)),
      y: Math.round((e.clientY - r.top)  * (bHRef.current / r.height)),
    };
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
    const { x, y } = scale(e);
    send({ type: "click", x, y });
    canvasRef.current?.focus();
  };

  const lastMouseMoveRef = useRef<number>(0);
  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
    const now = Date.now();
    if (now - lastMouseMoveRef.current < 50) return;
    lastMouseMoveRef.current = now;
    const { x, y } = scale(e);
    send({ type: "mousemove", x, y });
  };

  // Fetches whatever text is selected in the remote browser, then writes it
  // to the local Windows clipboard.  Called after sending a Ctrl+C or Ctrl+X
  // keycombo to give the remote browser ~100 ms to process the selection.
  const copySelectionToClipboard = useCallback(async () => {
    await new Promise(r => setTimeout(r, 100));
    try {
      const res = await fetch(`/api/browser/${profileId}/selection`);
      const { text } = await res.json() as { text: string };
      if (text) await navigator.clipboard.writeText(text);
    } catch {}
  }, [profileId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
    e.preventDefault();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "v") {
      navigator.clipboard.readText().then(text => {
        if (text) send({ type: "type", text });
      }).catch(() => {});
      return;
    }
    if (ctrl && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      send({ type: "keycombo", modifier: "Control", key: e.key.toLowerCase() });
      copySelectionToClipboard();
      return;
    }
    if (ctrl) {
      const k = e.key.toLowerCase();
      if (k.length === 1) send({ type: "keycombo", modifier: "Control", key: k });
      return;
    }
    const special: Record<string, string> = {
      Enter: "Enter", Backspace: "Backspace", Tab: "Tab", Escape: "Escape",
      ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
      ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
      Delete: "Delete", Home: "Home", End: "End",
      " ": "Space",
    };
    if (special[e.key]) {
      send({ type: "keydown", key: special[e.key] });
    } else if (e.key.length === 1) {
      send({ type: "type", text: e.key });
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) send({ type: "type", text });
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (status !== "connected") return;
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const ctxPaste = async () => {
    setCtxMenu(null);
    if (status !== "connected") return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) send({ type: "type", text });
    } catch {
      // Clipboard access denied nothing to do
    }
  };

  const ctxCopy = useCallback(async () => {
    setCtxMenu(null);
    send({ type: "keycombo", modifier: "Control", key: "c" });
    await copySelectionToClipboard();
  }, [send, copySelectionToClipboard]);

  const ctxCut = useCallback(async () => {
    setCtxMenu(null);
    send({ type: "keycombo", modifier: "Control", key: "x" });
    await copySelectionToClipboard();
  }, [send, copySelectionToClipboard]);

  const ctxSelectAll = () => {
    setCtxMenu(null);
    send({ type: "keycombo", modifier: "Control", key: "a" });
  };

  const onAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let url = addressBar.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = `https://${url}`;
    setIsLoading(true);
    send({ type: "navigate", url });
  };

  const clearSession = async () => {
    try {
      if (IS_ELECTRON) {
        // Clear cookies from the EB session partition via the profile wipe endpoint
        await fetch(`/api/profiles/${profileId}/wipe-eb-session`, { method: "POST" });
      } else {
        await fetch(`/api/browser/${profileId}/session`, { method: "DELETE" });
        setTimeout(connect, 800);
      }
      setLoginState("idle");
    } catch {
      console.error("Could not clear session.");
    }
  };

  const _doLoginCore = () => {
    setLoginLog([]);
    setLoginState("running");
    setLogTab("login");
    appendLog("Starting auto-login…", "step");
    if (IS_ELECTRON) {
      // Electron mode: eb-auto-login returns a synchronous {ok, message} result.
      fetch(`/api/profiles/${profileId}/eb-auto-login`, { method: "POST" })
        .then(r => r.json())
        .then((data: { ok: boolean; message: string }) => {
          if (data.ok) {
            recordLoginEvent(proxyHost, proxyPort);
            setLoginState("ok");
            appendLog(data.message || "Login successful", "ok");
          } else {
            setLoginState("fail");
            appendLog(data.message || "Login failed", "fail");
            setTimeout(() => setLoginState("idle"), 12000);
          }
        })
        .catch(() => {
          setLoginState("fail");
          appendLog("Could not reach server", "fail");
          setTimeout(() => setLoginState("idle"), 4000);
        });
    } else {
      // Non-Electron mode: fire-and-forget; result comes back via WebSocket messages.
      fetch(`/api/browser/${profileId}/login`, { method: "POST" }).catch(() => {
        setLoginState("fail");
        appendLog("Could not reach server", "fail");
        setTimeout(() => setLoginState("idle"), 4000);
      });
    }
  };

  const doLogin = () => {
    if (loginState === "running") {
      setLoginState("idle");
      return;
    }
    _doLoginCore();
  };


  const lastEntry = loginLog[loginLog.length - 1];
  const statusColor = { idle: "text-slate-400", connecting: "text-amber-500", connected: "text-green-600", error: "text-red-500" }[status];
  const statusDot   = { idle: "bg-slate-300", connecting: "bg-amber-400 animate-pulse", connected: "bg-green-500 animate-pulse", error: "bg-red-500" }[status];
  const statusLabel = { idle: "Not started", connecting: "Starting browser…", connected: "Browser active", error: "Error" }[status];
  const connected   = status === "connected";

  return (
    <div className={`flex flex-col bg-background rounded-xl border border-border overflow-hidden shadow-sm ${embedded ? "" : "h-full"}`}>

      {/* Isolation banner */}
      {!noToolbar && <div className="flex items-center gap-2 px-4 py-2 bg-background border-b border-border/60 text-xs shrink-0">
        <Shield className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-muted-foreground truncate">
          Isolated session · <span className="font-semibold text-foreground">@{username}</span>
          {" · "}
          <span className="font-mono text-[10px]">{(userAgent ?? "").slice(0, 60) || "No UA set"}</span>
        </span>
        <span className={`ml-auto flex items-center gap-1.5 font-medium shrink-0 ${statusColor}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusLabel}
        </span>
      </div>}

      {/* Toolbar */}
      {!noToolbar && <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-background shrink-0">
        <button
          onClick={() => { send({ type: "newTab" }); setTimeout(() => send({ type: "navigate", url: "https://www.google.com/" }), 300); }}
          disabled={!connected}
          className="flex items-center justify-center h-10 w-10 rounded-md hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title="Open new tab (Google)"
        >
          <Plus className="w-5 h-5" />
        </button>
        <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={() => send({ type: "back" })}    disabled={!connected} title="Back">
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={() => send({ type: "forward" })} disabled={!connected} title="Forward">
          <ChevronRight className="w-5 h-5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-12 w-12 shrink-0"
          onClick={() => { setIsLoading(true); send({ type: "reload" }); }} disabled={!connected} title="Refresh">
          {isLoading && connected ? <Loader2 className="w-6 h-6 animate-spin text-primary" /> : <RefreshCw className="w-6 h-6" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-12 w-12 shrink-0"
          onClick={() => { setIsLoading(true); send({ type: "navigate", url: "https://www.instagram.com/" }); }}
          disabled={!connected} title="Home (Instagram)">
          <Compass className="w-6 h-6" />
        </Button>

        <form onSubmit={onAddressSubmit} className="flex-1 min-w-0">
          <div className="relative">
            <Globe className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={addressBar}
              onChange={e => setAddressBar(e.target.value)}
              onFocus={() => { addressFocusedRef.current = true; }}
              onBlur={() => { addressFocusedRef.current = false; }}
              className="pl-8 h-8 text-sm font-mono bg-muted/50 border-muted focus:bg-background"
              placeholder="https://www.instagram.com/"
              disabled={!connected}
            />
          </div>
        </form>

        <Button
          variant="outline"
          size="sm"
          className={`h-8 px-3 text-xs gap-1.5 shrink-0 font-semibold transition-colors ${
            loginState === "ok"      ? "cursor-default pointer-events-none opacity-70" :
            ""
          }`}
          onClick={loginState === "ok" ? undefined : doLogin}
          disabled={!connected}
          title={
            loginState === "ok"      ? "Logged in" :
            loginState === "running" ? "Logging in…" :
            "Auto-fill credentials and login"
          }
          data-testid="button-browser-login"
        >
          {loginState === "running" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
           loginState === "ok"      ? <CheckCircle2 className="w-3.5 h-3.5" /> :
           loginState === "fail"    ? <AlertCircle className="w-3.5 h-3.5" /> :
                                      <LogIn className="w-3.5 h-3.5" />}
          {loginState === "running" ? "Logging In" :
           loginState === "ok"      ? "Logged In" :
                                      "Login"}
        </Button>

        {/* On the first (Instagram) tab show the usual tools.
            On any additional tab show email provider quick-nav buttons instead. */}
        {activeTab === 0 ? (
          <>
            <button
              type="button"
              onClick={() => generateTotp((code) => send({ type: "fill2fa", code }))}
              disabled={!connected}
              title="Generate a live 2FA code, paste it into the 2FA field on screen, and auto-click Continue"
              className="h-8 px-3 rounded-md border border-border bg-muted text-xs font-semibold transition-colors shrink-0 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent text-foreground"
            >
              {totpCopied ? `✓ ${totpCode}` : totpNoKey ? "No 2FA key" : "2FA Code"}
            </button>

            <Button
              variant="ghost" size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
              disabled={!connected}
              title="Type the pre-filled phone number from Settings"
              onClick={async () => {
                try {
                  const res = await fetch("/api/settings");
                  const s = await res.json();
                  const num = (s.preFilledPhoneNumber ?? "").trim();
                  if (num) send({ type: "type", text: num });
                } catch {}
              }}
            >
              <Phone className="w-3.5 h-3.5" /> Phone Number
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
              disabled={!connected}
              title="Type the email validation username into the focused field"
              onClick={async () => {
                try {
                  const res = await fetch(`/api/profiles/${profileId}`);
                  const p = await res.json();
                  const val = (p.emailValidationUsername ?? "").trim();
                  if (val) send({ type: "type", text: val });
                } catch {}
              }}
            >
              <Mail className="w-3.5 h-3.5" /> Email Account
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
              disabled={!connected}
              title="Type the email validation password into the focused field"
              onClick={async () => {
                try {
                  const res = await fetch(`/api/profiles/${profileId}`);
                  const p = await res.json();
                  const val = (p.emailValidationPassword ?? "").trim();
                  if (val) send({ type: "type", text: val });
                } catch {}
              }}
            >
              <KeyRound className="w-3.5 h-3.5" /> Email Password
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-8 px-2 text-xs text-green-500 hover:text-green-400 hover:bg-green-500/10 gap-1 shrink-0 font-semibold"
              disabled={!connected}
              title="Run an in-app leak test — checks IP, WebRTC, WebDriver, Canvas, Audio, WebGL and more"
              onClick={() => {
                // Puppeteer's page.goto() needs an absolute URL — use the
                // Replit proxy hostname with the API port injected at build time.
                const { protocol, hostname } = window.location;
                const apiOrigin = `${protocol}//${hostname}:${__API_PORT__}`;
                const url = `${apiOrigin}/api/browser/leaks?profileId=${profileId}`;
                send({ type: "navigate", url });
              }}
            >
              <ShieldAlert className="w-3.5 h-3.5" /> Leak Check
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-8 px-2 text-xs text-purple-500 hover:text-purple-400 hover:bg-purple-500/10 gap-1 shrink-0 font-semibold"
              title="Generate an AI selfie photo — realistic, no watermarks, with randomised camera EXIF metadata"
              onClick={() => { setAiModalOpen(true); setAiResult(null); setAiError(null); }}
            >
              <Sparkles className="w-3.5 h-3.5" /> AI Image
            </Button>
            <label
              className={`inline-flex items-center gap-1 h-8 px-2 text-xs rounded-md transition-colors shrink-0 ${connected ? "text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer" : "text-muted-foreground opacity-50 cursor-not-allowed pointer-events-none"}`}
              title="Upload a file to the browser"
            >
              <Upload className="w-3.5 h-3.5" /> Upload
              <input
                type="file"
                accept="image/*,video/*,*/*"
                className="sr-only"
                disabled={!connected}
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = "";
                  const reader = new FileReader();
                  reader.onload = async ev => {
                    const base64 = (ev.target?.result as string)?.split(",")[1];
                    if (!base64) return;
                    await fetch(`/api/browser/${profileId}/files`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ fileName: file.name, data: base64 }),
                    }).catch(() => {});
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </>
        ) : (
          /* Extra-tab toolbar: email provider shortcuts */
          <>
            {[
              { label: "Hotmail", url: "https://www.hotmail.com" },
              { label: "OP.pl",   url: "https://www.op.pl"      },
              { label: "GMX",     url: "https://www.gmx.com"    },
            ].map(({ label, url }) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs font-semibold shrink-0 gap-1"
                disabled={!connected}
                title={`Go to ${url}`}
                onClick={() => { setAddressBar(url); setIsLoading(true); send({ type: "navigate", url }); }}
              >
                <Mail className="w-3.5 h-3.5" />
                {label}
              </Button>
            ))}
          </>
        )}
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive gap-1 shrink-0"
          onClick={clearSession} title="Clear session">
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </Button>
        {IS_ELECTRON && !forceStream && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2 text-xs gap-1 shrink-0"
            disabled={!connected}
            title="Bring the native browser window to the front"
            onClick={() => (window as any).electronAPI?.focusBrowserWindow?.(profileId)}
          >
            <MonitorPlay className="w-3.5 h-3.5" /> Bring to Front
          </Button>
        )}
        <div
          title={openedAt ? `Browser open for ${elapsedLabel}` : "Browser not yet connected"}
          className={`h-8 px-2.5 flex items-center rounded-md border text-xs font-mono font-semibold shrink-0 tabular-nums transition-colors ${
            openedAt ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground"
          }`}
        >
          {openedAt ? elapsedLabel : "--:--"}
        </div>
      </div>}

      {/* Tab strip — always visible once browser is running */}
      {!noToolbar && (connected || tabs.length > 0) && (
        <div className="flex items-center gap-0.5 px-2 pt-1 border-b border-border bg-muted/20 shrink-0 overflow-x-auto">
          {tabs.map((tab, i) => (
            <div
              key={i}
              className={`group flex items-center gap-1 px-2 py-1 rounded-t text-xs max-w-[160px] cursor-pointer select-none transition-colors ${
                i === activeTab
                  ? "bg-background border border-b-background border-border font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              onClick={() => send({ type: "switchTab", index: i })}
            >
              <span className="truncate flex-1">
                {tab.url ? (() => { try { return new URL(tab.url).hostname.replace("www.", "") || `Tab ${i + 1}`; } catch { return `Tab ${i + 1}`; } })() : `Tab ${i + 1}`}
              </span>
              {tabs.length > 1 && (
                <button
                  onClick={e => { e.stopPropagation(); send({ type: "closeTab", index: i }); }}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0 ml-0.5"
                  title="Close tab"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Debug panel (F12) shows login log + browser console */}
      {showLog && (
        <div className="shrink-0 border-b border-border bg-slate-950 text-xs">
          {/* Panel header with tabs */}
          <div className="flex items-center border-b border-slate-800">
            <button
              onClick={() => setLogTab("login")}
              className={`px-3 py-1 font-mono font-semibold tracking-wide uppercase text-[10px] transition-colors ${logTab === "login" ? "text-slate-200 border-b-2 border-primary" : "text-slate-500 hover:text-slate-300"}`}
            >
              Login {loginLog.length > 0 ? `(${loginLog.length})` : ""}
            </button>
            <button
              onClick={() => setLogTab("console")}
              className={`px-3 py-1 font-mono font-semibold tracking-wide uppercase text-[10px] transition-colors ${logTab === "console" ? "text-slate-200 border-b-2 border-primary" : "text-slate-500 hover:text-slate-300"}`}
            >
              Console {consoleLogs.length > 0 ? `(${consoleLogs.length})` : ""}
            </button>
            <div className="ml-auto flex items-center gap-2 pr-2">
              {loginState === "running" && <Loader2 className="w-3 h-3 animate-spin text-amber-400" />}
              {loginState === "ok"      && <CheckCircle2 className="w-3 h-3 text-green-400" />}
              {loginState === "fail"    && <AlertCircle className="w-3 h-3 text-red-400" />}
              <button onClick={() => setShowLog(false)} className="text-slate-500 hover:text-slate-300" title="Hide (F12)">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Login tab */}
          {logTab === "login" && (
            <>
              <div className="max-h-36 overflow-y-auto px-3 py-1.5 space-y-0.5 font-mono">
                {loginLog.length === 0 ? (
                  <div className="text-slate-600 italic py-1">No login activity yet click "Fill Credentials" to start.</div>
                ) : loginLog.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-slate-600 shrink-0 select-none">{e.ts}</span>
                    <span className={e.kind === "ok" ? "text-green-400" : e.kind === "fail" ? "text-red-400" : e.kind === "error" ? "text-amber-400" : "text-slate-300"}>
                      {e.kind === "ok" ? "✓ " : e.kind === "fail" ? "✗ " : e.kind === "error" ? "⚠ " : "· "}{e.text}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
              {loginState === "running" && lastEntry && (
                <div className="px-3 py-1 border-t border-slate-800 text-amber-300 truncate">{lastEntry.text}</div>
              )}
            </>
          )}

          {/* Console tab */}
          {logTab === "console" && (
            <div className="max-h-36 overflow-y-auto px-3 py-1.5 space-y-0.5 font-mono">
              {consoleLogs.length === 0 ? (
                <div className="text-slate-600 italic py-1">No browser console output yet.</div>
              ) : consoleLogs.map((e, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-slate-600 shrink-0 select-none">{e.ts}</span>
                  <span className={`shrink-0 text-[9px] uppercase font-bold ${e.level === "error" ? "text-red-400" : e.level === "warn" ? "text-amber-400" : e.level === "info" ? "text-blue-400" : "text-slate-500"}`}>{e.level}</span>
                  <span className={`break-all ${e.level === "error" ? "text-red-300" : e.level === "warn" ? "text-amber-300" : "text-slate-300"}`}>{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}


      {/* Loading bar */}
      {isLoading && connected && (
        <div className="h-0.5 bg-muted shrink-0 overflow-hidden">
          <div className="h-full bg-primary animate-pulse w-full opacity-60" />
        </div>
      )}

      {/* Viewport */}
      <div className="flex-1 relative bg-white min-h-0 overflow-hidden flex items-center justify-center">

        {/* ── Electron native EB mode — viewport shows info; toolbar above has all controls ── */}
        {IS_ELECTRON && !forceStream ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 select-none">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
              <MonitorPlay className="w-6 h-6 text-primary" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-semibold text-foreground">Native browser window</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Instagram is open in a dedicated OS window — no streaming delay, no canvas lag.
                Use the toolbar above to navigate, login, fill 2FA, type phone numbers, etc.
              </p>
            </div>
            {connected && loginLog.length > 0 && (
              <div className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 space-y-0.5 max-h-28 overflow-y-auto font-mono text-xs">
                {loginLog.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground shrink-0 select-none">{e.ts}</span>
                    <span className={e.kind === "ok" ? "text-green-600" : e.kind === "fail" ? "text-red-500" : e.kind === "error" ? "text-amber-500" : "text-foreground"}>
                      {e.kind === "ok" ? "✓ " : e.kind === "fail" ? "✗ " : e.kind === "error" ? "⚠ " : "· "}{e.text}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        ) : (
          <>
            {status === "idle" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
                <MonitorPlay className="w-10 h-10 text-slate-400" />
                <p className="text-sm font-medium text-foreground">Browser disconnected</p>
                {errorMsg ? (
                  <div className="flex flex-col items-center gap-2 max-w-sm">
                    <p className="text-xs text-red-500 text-center font-medium">Last error: {errorMsg}</p>
                    <button
                      onClick={() => navigator.clipboard?.writeText(errorMsg ?? "").catch(() => {})}
                      className="text-[10px] text-slate-400 hover:text-slate-600 underline"
                    >
                      Copy error
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Reconnecting in a moment…</p>
                )}
                <Button onClick={connect} variant="outline" size="sm">Connect now</Button>
              </div>
            )}

            {status === "connecting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Starting browser…</p>
              </div>
            )}

            {status === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
                <WifiOff className="w-10 h-10 text-red-400" />
                <p className="text-sm font-medium text-foreground">Browser failed to start</p>
                <Button onClick={connect} variant="outline" size="sm">Retry</Button>
              </div>
            )}

            <canvas
              ref={canvasRef}
              width={bW}
              height={bH}
              className="outline-none"
              style={{
                display: connected ? "block" : "none",
                maxWidth: "100%",
                maxHeight: "100%",
                width: "auto",
                height: "auto",
                aspectRatio: `${bW} / ${bH}`,
                cursor: "default",
                touchAction: "none",
              }}
              tabIndex={0}
              onClick={onCanvasClick}
              onMouseMove={onCanvasMouseMove}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onContextMenu={onContextMenu}
            />

            {/* First-frame overlay — connected but Chrome hasn't rendered anything yet */}
            {connected && waitingFirstFrame && !isFrozen && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <p className="text-sm font-medium text-foreground">Starting browser…</p>
                <p className="text-xs text-muted-foreground">Loading Instagram, please wait</p>
              </div>
            )}

            {/* Frozen overlay — no frame received for 60 s while connected */}
            {isFrozen && connected && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80 z-20 backdrop-blur-sm">
                <Loader2 className="w-8 h-8 text-slate-300 animate-spin" />
                <p className="text-sm font-semibold text-white">Browser appears frozen</p>
                <p className="text-xs text-slate-400 text-center max-w-xs">The page stopped sending frames. If it just logged in or navigated to a new page, give it more time — Instagram can be slow to load.</p>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5 border-slate-500 text-slate-200 hover:bg-slate-700" onClick={() => { lastFrameTimeRef.current = Date.now(); setIsFrozen(false); }}>
                    Keep Waiting
                  </Button>
                  <Button size="sm" variant="destructive" onClick={clearSession} className="gap-1.5">
                    <Trash2 className="w-3.5 h-3.5" /> Clear &amp; Reset
                  </Button>
                </div>
              </div>
            )}

            {/* Right-click context menu */}
            {ctxMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
                <div
                  className="fixed z-50 min-w-[120px] rounded-md border border-border bg-popover shadow-md py-1 text-sm"
                  style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                  <button onClick={ctxCut}       className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground">Cut</button>
                  <button onClick={ctxCopy}      className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground">Copy</button>
                  <button onClick={ctxPaste}     className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground">Paste</button>
                  <div className="my-1 border-t border-border" />
                  <button onClick={ctxSelectAll} className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground">Select All</button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* File chooser overlay requires a real user click so the browser allows the file picker */}
      {fileChooserPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-background rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <MonitorPlay className="w-5 h-5 text-primary shrink-0" />
              <h3 className="text-base font-semibold">File Upload Requested</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              The page is asking you to choose a file. Click the button below to open your file browser.
            </p>
            <label className="cursor-pointer w-full">
              <div className="w-full flex items-center justify-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                Browse Files…
              </div>
              <input
                type="file"
                accept="image/*,video/*,*/*"
                className="sr-only"
                onChange={async e => {
                  setFileChooserPending(false);
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async ev => {
                    const base64 = (ev.target?.result as string)?.split(",")[1];
                    if (!base64) return;
                    await fetch(`/api/browser/${profileId}/files`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ fileName: file.name, data: base64 }),
                    }).catch(() => {});
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setFileChooserPending(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── AI Selfie Generator ─────────────────────────────────────── */}
      <Dialog open={aiModalOpen} onOpenChange={setAiModalOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="w-4 h-4 text-purple-500" />
              AI Selfie Generator
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              Generates a realistic smartphone selfie with randomised camera EXIF metadata (phone model, date, ISO). No AI watermarks or detectable AI artifacts.
            </p>
            <Button
              className="w-full gap-2 bg-purple-600 hover:bg-purple-700 text-white"
              size="sm"
              disabled={aiLoading}
              onClick={async () => {
                setAiLoading(true);
                setAiElapsed(0);
                setAiError(null);
                setAiResult(null);
                const timer = setInterval(() => setAiElapsed(s => s + 1), 1000);
                try {
                  const res = await fetch(`/api/ai/generate-selfie`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                  const data = await res.json();
                  if (!res.ok) { setAiError(data.error ?? "Generation failed"); }
                  else { setAiResult(data); }
                } catch (e: any) {
                  setAiError(e?.message ?? "Network error");
                } finally {
                  clearInterval(timer);
                  setAiLoading(false);
                }
              }}
            >
              {aiLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating… {aiElapsed}s</> : <><Sparkles className="w-3.5 h-3.5" /> Generate Selfie</>}
            </Button>

            {aiError && (
              <div className="text-[11px] text-destructive bg-destructive/10 rounded p-2 break-words">{aiError}</div>
            )}

            {aiResult && (
              <div className="space-y-2">
                <img
                  src={`data:image/jpeg;base64,${aiResult.imageBase64}`}
                  alt="Generated selfie"
                  className="w-full rounded-lg border border-border object-contain max-h-72"
                />
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  <div>📱 {aiResult.metadata.make} {aiResult.metadata.model}</div>
                  <div>📅 {new Date(aiResult.metadata.shotAt).toLocaleDateString()} · ISO {aiResult.metadata.iso}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm" variant="outline" className="flex-1 gap-1 text-xs"
                    onClick={() => {
                      const link = document.createElement("a");
                      link.href = `data:image/jpeg;base64,${aiResult.imageBase64}`;
                      link.download = aiResult.fileName;
                      link.click();
                    }}
                  >
                    <Download className="w-3.5 h-3.5" /> Save
                  </Button>
                  <Button
                    size="sm" className="flex-1 gap-1 text-xs bg-gradient-to-r from-pink-500 to-orange-400 hover:from-pink-600 hover:to-orange-500 text-white border-0"
                    disabled={!connected}
                    title={connected ? "Upload this selfie to the active Instagram file chooser" : "Open Instagram in the browser first"}
                    onClick={async () => {
                      try {
                        await fetch(`/api/browser/${profileId}/files`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ fileName: aiResult.fileName, data: aiResult.imageBase64 }),
                        });
                        setAiModalOpen(false);
                      } catch {}
                    }}
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload to Instagram
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
