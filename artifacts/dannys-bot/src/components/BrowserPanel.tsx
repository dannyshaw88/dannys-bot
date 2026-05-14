import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, ArrowRight, RotateCw, Home, Globe, Shield,
  Trash2, Loader2, WifiOff, LogIn, CheckCircle2, AlertCircle, MonitorPlay, X, Upload, Phone, Mail, KeyRound,
} from "lucide-react";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";

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

function nowTs() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

export function BrowserPanel({ profileId, userAgent, username }: BrowserPanelProps) {
  const { windows, clearPendingUrl } = useBrowserWindows();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const addressFocusedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<SSEStatus>("idle");
  const statusRef = useRef<SSEStatus>("idle");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const hasReceivedFirstFrameRef = useRef(false);
  const [isFrozen, setIsFrozen] = useState(false);

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
    if (statusRef.current !== "connected") return;
    fetch(`/api/browser/${profileId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }, [profileId]);

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
      const x = Math.round((e.clientX - rect.left) * (BROWSER_W / rect.width));
      const y = Math.round((e.clientY - rect.top) * (BROWSER_H / rect.height));
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

  // ── SSE connection lifecycle ──────────────────────────────────────────────
  const connect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStatusSafe("connecting");
    setIsFrozen(false);
    setErrorMsg(null);
    setIsLoading(true);
    setWaitingFirstFrame(true);
    hasReceivedFirstFrameRef.current = false;

    const es = new EventSource(`/api/browser/${profileId}/stream`);
    esRef.current = es;

    es.onopen = () => {
      setStatusSafe("connected");
      setIsLoading(false); // clear the loading flag set during connect()
    };

    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        switch (msg.type) {
          case "frame":
            drawFrame(msg.data);
            lastFrameTimeRef.current = Date.now();
            if (!hasReceivedFirstFrameRef.current) {
              hasReceivedFirstFrameRef.current = true;
              setWaitingFirstFrame(false);
            }
            setIsFrozen(false);
            if (msg.url && msg.url !== "about:blank" && !addressFocusedRef.current) {
              setAddressBar(msg.url);
              if (msg.url.includes("instagram.com/accounts/login") || msg.url.includes("instagram.com/login")) {
                setLoginState(prev => prev === "ok" ? "idle" : prev);
              }
            }
            break;
          case "loading":
            setIsLoading(msg.loading);
            break;
          case "urlChange":
            if (msg.url && msg.url !== "about:blank" && !addressFocusedRef.current) setAddressBar(msg.url);
            if (msg.url && (msg.url.includes("instagram.com/accounts/login") || msg.url.includes("instagram.com/login"))) {
              setLoginState(prev => prev === "ok" ? "idle" : prev);
            }
            break;
          case "error":
            setErrorMsg(msg.message ?? "Unknown error");
            setStatusSafe("error");
            setIsLoading(false);
            es.close();
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
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setIsLoading(false);
      if (statusRef.current !== "error") {
        setStatusSafe("idle");
        reconnectTimerRef.current = setTimeout(() => {
          if (statusRef.current === "idle") connect();
        }, 3000);
      }
    };
  }, [profileId, setStatusSafe, appendLog]);

  useEffect(() => () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  useEffect(() => { connect(); }, [connect]);

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
  // no new frame arrives for 60 s, flag as frozen.
  // hasReceivedFirstFrameRef prevents false "frozen" during Chrome's startup window
  // (the SSE stream opens before Chrome has launched, so there's a gap before first frame).
  useEffect(() => {
    if (status !== "connected") { setIsFrozen(false); return; }
    lastFrameTimeRef.current = Date.now();
    const timer = setInterval(() => {
      if (
        statusRef.current === "connected" &&
        hasReceivedFirstFrameRef.current &&
        Date.now() - lastFrameTimeRef.current > 60000
      ) {
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
  const drawFrame = (base64: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, BROWSER_W, BROWSER_H);
    img.src = `data:image/jpeg;base64,${base64}`;
  };

  const scale = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (BROWSER_W / r.width)),
      y: Math.round((e.clientY - r.top)  * (BROWSER_H / r.height)),
    };
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
    const { x, y } = scale(e);
    send({ type: "click", x, y });
    canvasRef.current?.focus();
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (status !== "connected") return;
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
      await fetch(`/api/browser/${profileId}/session`, { method: "DELETE" });
      setLoginState("idle");
      setTimeout(connect, 800);
    } catch {
      console.error("Could not clear session.");
    }
  };

  const doLogin = () => {
    if (loginState === "running") {
      setLoginState("idle");
      return;
    }
    setLoginLog([]);
    setLoginState("running");
    appendLog("Starting auto-login…", "step");
    fetch(`/api/browser/${profileId}/login`, { method: "POST" }).catch(() => {
      setLoginState("fail");
      appendLog("Could not reach server", "fail");
      setTimeout(() => setLoginState("idle"), 4000);
    });
  };

  const lastEntry = loginLog[loginLog.length - 1];
  const statusColor = { idle: "text-slate-400", connecting: "text-amber-500", connected: "text-green-600", error: "text-red-500" }[status];
  const statusDot   = { idle: "bg-slate-300", connecting: "bg-amber-400 animate-pulse", connected: "bg-green-500 animate-pulse", error: "bg-red-500" }[status];
  const statusLabel = { idle: "Not started", connecting: "Starting browser…", connected: "Browser active", error: "Error" }[status];
  const connected   = status === "connected";

  return (
    <div className="flex flex-col h-full bg-background rounded-xl border border-border overflow-hidden shadow-sm">

      {/* Isolation banner */}
      <div className="flex items-center gap-2 px-4 py-2 bg-background border-b border-border/60 text-xs shrink-0">
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
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-background shrink-0">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => send({ type: "back" })}    disabled={!connected} title="Back">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => send({ type: "forward" })} disabled={!connected} title="Forward">
          <ArrowRight className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          onClick={() => { setIsLoading(true); send({ type: "reload" }); }} disabled={!connected} title="Refresh">
          {isLoading && connected ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <RotateCw className="w-4 h-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          onClick={() => { setIsLoading(true); send({ type: "navigate", url: "https://www.instagram.com/" }); }}
          disabled={!connected} title="Home">
          <Home className="w-4 h-4" />
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
            loginState === "ok"      ? "border-green-400 text-green-700 bg-green-50 cursor-default pointer-events-none" :
            loginState === "fail"    ? "border-red-300 text-red-700 bg-red-50" :
            loginState === "running" ? "border-blue-400 text-blue-700 bg-blue-50 hover:bg-blue-100" :
            "border-primary/40 text-primary hover:bg-primary/5"
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

        <button
          type="button"
          onClick={() => generateTotp((code) => send({ type: "type", text: code }))}
          disabled={!connected}
          title="Generate a live 2FA/TOTP code, copy to clipboard, and paste into the browser"
          className={`h-8 px-3 rounded-md border text-xs font-semibold transition-colors shrink-0 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
            totpCopied  ? "border-green-400 text-green-700 bg-green-50" :
            totpNoKey   ? "border-red-300 text-red-700 bg-red-50" :
            "border-border bg-muted hover:bg-accent"
          }`}
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
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive gap-1 shrink-0"
          onClick={clearSession} disabled={!connected} title="Clear session">
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </Button>
        <div
          title={openedAt ? `Browser open for ${elapsedLabel}` : "Browser not yet connected"}
          className={`h-8 px-2.5 flex items-center rounded-md border text-xs font-mono font-semibold shrink-0 tabular-nums transition-colors ${
            openedAt ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground"
          }`}
        >
          {openedAt ? elapsedLabel : "--:--"}
        </div>
      </div>

      {/* Tab strip visible when 2+ tabs are open */}
      {tabs.length > 1 && (
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
                {tab.url ? new URL(tab.url).hostname.replace("www.", "") || `Tab ${i + 1}` : `Tab ${i + 1}`}
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

      {/* Collapsed log toggle */}
      {!showLog && (loginLog.length > 0 || consoleLogs.length > 0) && (
        <button
          onClick={() => setShowLog(true)}
          className="shrink-0 px-4 py-1 text-[11px] text-slate-500 bg-slate-950 border-b border-slate-800 hover:text-slate-300 text-left"
        >
          Debug panel ({loginLog.length} login steps · {consoleLogs.length} console) F12
        </button>
      )}

      {/* Loading bar */}
      {isLoading && connected && (
        <div className="h-0.5 bg-muted shrink-0 overflow-hidden">
          <div className="h-full bg-primary animate-pulse w-full opacity-60" />
        </div>
      )}

      {/* Viewport */}
      <div className="flex-1 relative bg-white min-h-0 overflow-hidden flex items-center justify-center">

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
            <p className="text-xs text-red-500 max-w-xs text-center font-medium">{errorMsg}</p>
            <button
              onClick={() => navigator.clipboard?.writeText(errorMsg ?? "").catch(() => {})}
              className="text-[10px] text-slate-400 hover:text-slate-600 underline"
            >
              Copy error
            </button>
            <Button onClick={connect} variant="outline" size="sm">Retry</Button>
          </div>
        )}

        <canvas
          ref={canvasRef}
          width={BROWSER_W}
          height={BROWSER_H}
          className="outline-none"
          style={{
            display: connected ? "block" : "none",
            maxWidth: "100%",
            maxHeight: "100%",
            width: "auto",
            height: "auto",
            aspectRatio: `${BROWSER_W} / ${BROWSER_H}`,
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
    </div>
  );
}
