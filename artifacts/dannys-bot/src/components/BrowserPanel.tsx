import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, ArrowRight, RotateCw, Home, Globe, Shield,
  Trash2, Loader2, WifiOff, LogIn, CheckCircle2, AlertCircle, MonitorPlay, X
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";

function cleanLoginError(msg: string): string {
  const m = (msg ?? "").toLowerCase();
  if (m.includes("incorrect") || m.includes("wrong password") || m.includes("bad_password")) return "Incorrect password";
  if (m.includes("checkpoint") || m.includes("challenge_required")) return "Checkpoint required";
  if (m.includes("two_factor") || m.includes("2fa") || m.includes("otp") || m.includes("verification code")) return "2FA code required";
  if (m.includes("rate") || m.includes("too many") || m.includes("flood")) return "Rate limited — try again later";
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

const BROWSER_W = 1280;
const BROWSER_H = 760;

function nowTs() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

export function BrowserPanel({ profileId, userAgent, username }: BrowserPanelProps) {
  const { toast } = useToast();
  const { windows, clearPendingUrl } = useBrowserWindows();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const addressFocusedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<SSEStatus>("idle");
  const statusRef = useRef<SSEStatus>("idle");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setStatusSafe = useCallback((s: SSEStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [addressBar, setAddressBar] = useState("https://www.instagram.com/");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [loginLog, setLoginLog] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [pendingNavUrl, setPendingNavUrl] = useState<string | null>(null);

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

  // ── Non-passive wheel listener ────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (BROWSER_W / rect.width));
      const y = Math.round((e.clientY - rect.top) * (BROWSER_H / rect.height));
      send({ type: "scroll", x, y, deltaX: e.deltaX, deltaY: e.deltaY * 3 });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
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
    setErrorMsg(null);
    setIsLoading(true);

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
            if (msg.url && msg.url !== "about:blank" && !addressFocusedRef.current) setAddressBar(msg.url);
            break;
          case "loading":
            setIsLoading(msg.loading);
            break;
          case "urlChange":
            if (!addressFocusedRef.current) setAddressBar(msg.url);
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
              setTimeout(() => setLoginState("idle"), 8000);
            } else {
              setLoginState("fail");
              appendLog(msg.message || "Login failed", "fail");
              toast({ title: cleanLoginError(msg.message), variant: "destructive" });
              setTimeout(() => setLoginState("idle"), 12000);
            }
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
      toast({ title: "Session Cleared", description: "Cookies wiped — reconnecting with fresh browser." });
      setTimeout(connect, 800);
    } catch {
      toast({ title: "Error", description: "Could not clear session.", variant: "destructive" });
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
      <div className="flex items-center gap-2 px-4 py-2 bg-primary/5 border-b border-border/60 text-xs shrink-0">
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
            loginState === "ok"      ? "border-green-300 text-green-700 bg-green-50" :
            loginState === "fail"    ? "border-red-300 text-red-700 bg-red-50" :
            loginState === "running" ? "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100" :
            "border-primary/40 text-primary hover:bg-primary/5"
          }`}
          onClick={doLogin}
          disabled={!connected}
          title={loginState === "running" ? "Click to cancel login" : "Auto-login with stored credentials"}
          data-testid="button-browser-login"
        >
          {loginState === "running" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
           loginState === "ok"      ? <CheckCircle2 className="w-3.5 h-3.5" /> :
           loginState === "fail"    ? <AlertCircle className="w-3.5 h-3.5" /> :
                                      <LogIn className="w-3.5 h-3.5" />}
          {loginState === "running" ? "Cancel" : "Login"}
        </Button>

        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive gap-1 shrink-0"
          onClick={clearSession} disabled={!connected} title="Clear session">
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </Button>
      </div>

      {/* Login step log — shown during/after login, collapsible */}
      {showLog && loginLog.length > 0 && (
        <div className="shrink-0 border-b border-border bg-slate-950 text-xs">
          {/* Log header */}
          <div className="flex items-center justify-between px-3 py-1 border-b border-slate-800">
            <span className="text-slate-400 font-mono font-semibold tracking-wide uppercase text-[10px]">Login log</span>
            <div className="flex items-center gap-2">
              {loginState === "running" && <Loader2 className="w-3 h-3 animate-spin text-amber-400" />}
              {loginState === "ok"      && <CheckCircle2 className="w-3 h-3 text-green-400" />}
              {loginState === "fail"    && <AlertCircle className="w-3 h-3 text-red-400" />}
              <button
                onClick={() => setShowLog(false)}
                className="text-slate-500 hover:text-slate-300 ml-1"
                title="Hide log"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {/* Scrollable entries */}
          <div className="max-h-32 overflow-y-auto px-3 py-1.5 space-y-0.5 font-mono">
            {loginLog.map((e, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-slate-600 shrink-0 select-none">{e.ts}</span>
                <span className={
                  e.kind === "ok"    ? "text-green-400" :
                  e.kind === "fail"  ? "text-red-400" :
                  e.kind === "error" ? "text-amber-400" :
                  "text-slate-300"
                }>
                  {e.kind === "ok"   ? "✓ " :
                   e.kind === "fail" ? "✗ " :
                   e.kind === "error"? "⚠ " : "· "}
                  {e.text}
                </span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {/* Latest status pinned at bottom if running */}
          {loginState === "running" && lastEntry && (
            <div className="px-3 py-1 border-t border-slate-800 text-amber-300 truncate">
              {lastEntry.text}
            </div>
          )}
        </div>
      )}

      {/* Collapsed log toggle — always show hint when there are log entries */}
      {!showLog && loginLog.length > 0 && (
        <button
          onClick={() => setShowLog(true)}
          className="shrink-0 px-4 py-1 text-[11px] text-slate-500 bg-slate-950 border-b border-slate-800 hover:text-slate-300 text-left"
        >
          Login log ({loginLog.length} steps) — press F12 to open
        </button>
      )}

      {/* Loading bar */}
      {isLoading && connected && (
        <div className="h-0.5 bg-muted shrink-0 overflow-hidden">
          <div className="h-full bg-primary animate-pulse w-full opacity-60" />
        </div>
      )}

      {/* Viewport */}
      <div className="flex-1 relative bg-slate-900 min-h-0 overflow-hidden flex items-center justify-center">

        {status === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
            <MonitorPlay className="w-10 h-10 text-slate-400" />
            <p className="text-sm font-medium text-foreground">Browser disconnected</p>
            <p className="text-xs text-muted-foreground">Reconnecting in a moment…</p>
            <Button onClick={connect} variant="outline" size="sm">Connect now</Button>
          </div>
        )}

        {status === "connecting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Starting Chrome… (takes ~15 seconds first time)</p>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
            <WifiOff className="w-10 h-10 text-red-400" />
            <p className="text-sm font-medium text-foreground">Browser failed to start</p>
            <p className="text-xs text-muted-foreground max-w-xs text-center">{errorMsg}</p>
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
        />
      </div>
    </div>
  );
}
