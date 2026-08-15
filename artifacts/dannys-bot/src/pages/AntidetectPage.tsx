import { useState, useRef, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, ArrowRight, RotateCw, Globe, Play, Square,
  Loader2, Shield, WifiOff, ExternalLink,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

const BROWSER_W = 1280;
const BROWSER_H = 760;

const DETECTION_TESTS = [
  { label: "PixelScan",     url: "https://pixelscan.net" },
  { label: "BotSannysoft",  url: "https://bot.sannysoft.com" },
  { label: "CreepJS",       url: "https://abrahamjuliot.github.io/creepjs/" },
  { label: "Fingerprint.io",url: "https://fingerprint.com/products/bot-detection/" },
  { label: "F.io Demo",     url: "https://fingerprintjs.github.io/fingerprintjs/" },
  { label: "Instagram",     url: "https://www.instagram.com/" },
];

type ConnState = "idle" | "connecting" | "connected" | "error";

export function AntidetectPage() {
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["/api/antidetect/status"],
    queryFn: () => fetch("/api/antidetect/status").then(r => r.json()) as Promise<{
      running: boolean; proxyLabel?: string; startedAt?: number; url?: string;
    }>,
    refetchInterval: 3000,
  });

  const [proxyHost, setProxyHost]         = useState("");
  const [proxyPort, setProxyPort]         = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [startUrl, setStartUrl]           = useState("https://pixelscan.net");
  const [addressBar, setAddressBar]       = useState("https://pixelscan.net");
  const [launching, setLaunching] = useState(false);
  const [stopping,  setStopping]  = useState(false);
  const [connState, setConnState] = useState<ConnState>("idle");
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null);
  const [waitingFrame, setWaitingFrame] = useState(true);

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef      = useRef<WebSocket | null>(null);
  const connRef    = useRef<ConnState>("idle");
  const pendingBitmapRef = useRef<ImageBitmap | null>(null);
  const rafIdRef   = useRef<number | null>(null);

  const setConn = useCallback((s: ConnState) => { connRef.current = s; setConnState(s); }, []);

  // ── Canvas RAF loop ───────────────────────────────────────────────────────
  const scheduleRaf = useCallback(() => {
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const bmp = pendingBitmapRef.current;
      const canvas = canvasRef.current;
      if (bmp && canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        pendingBitmapRef.current = null;
      }
    });
  }, []);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Auto-reconnect when WS drops while session is still running ───────────
  const scheduleReconnect = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(async () => {
      retryTimerRef.current = null;
      try {
        const s = await fetch("/api/antidetect/status").then(r => r.json());
        if (s.running && connRef.current !== "connected") connectWS();
      } catch {}
    }, 2000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── WebSocket connection ──────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    // Detach old WS silently — must null handlers BEFORE close() so onclose
    // doesn't fire and schedule another reconnect (the infinite loop bug)
    if (wsRef.current) {
      const old = wsRef.current;
      wsRef.current = null;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try { old.close(); } catch {}
    }
    setConn("connecting");
    setErrorMsg(null);
    setWaitingFrame(true);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/antidetect/stream`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen  = () => {};
    ws.onclose = () => {
      setConn("idle");
      scheduleReconnect();
    };
    ws.onerror = () => {
      setConn("idle");
      scheduleReconnect();
    };
    ws.onmessage = async (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const blob = new Blob([evt.data], { type: "image/jpeg" });
        const bmp  = await createImageBitmap(blob);
        pendingBitmapRef.current?.close();
        pendingBitmapRef.current = bmp;
        setWaitingFrame(false);
        scheduleRaf();
        return;
      }
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "screencast_started") setConn("connected");
        if (msg.type === "error") { setConn("error"); setErrorMsg(msg.message); }
        if (msg.type === "tabsUpdated" && msg.tabs?.[0]?.url) {
          setAddressBar(msg.tabs[0].url);
        }
      } catch {}
    };
  }, [setConn, scheduleRaf, scheduleReconnect]);

  const connect = connectWS;

  const disconnect = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setConn("idle");
  }, [setConn]);

  // ── Connect when session starts; disconnect when it stops ─────────────────
  useEffect(() => {
    if (status?.running && connState === "idle") connectWS();
    if (!status?.running && (connState === "connected" || connState === "connecting")) disconnect();
  }, [status?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Launch / Stop ─────────────────────────────────────────────────────────
  const launch = async () => {
    if (!proxyHost || !proxyPort) return;
    setLaunching(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/antidetect/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxyHost,
          proxyPort:     Number(proxyPort),
          proxyUsername: proxyUsername || undefined,
          proxyPassword: proxyPassword || undefined,
          startUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || "Launch failed"); return; }
      await refetchStatus();
      setTimeout(() => connect(), 500);
    } catch (err: any) {
      setErrorMsg(err?.message || "Launch failed");
    } finally {
      setLaunching(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    disconnect();
    try { await fetch("/api/antidetect/close", { method: "POST" }); } catch {}
    await refetchStatus();
    setStopping(false);
  };

  // ── Input sender — goes over the open WS for guaranteed ordering ─────────
  const sendInput = useCallback((msg: object) => {
    if (connRef.current !== "connected") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }, []);

  // ── Canvas interaction ────────────────────────────────────────────────────
  // object-fit:contain letterboxes the canvas — getBoundingClientRect() returns the
  // full CSS box, so we must subtract the letterbox offset before scaling.
  const toCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const containerAspect = rect.width / rect.height;
    const contentAspect  = BROWSER_W / BROWSER_H;
    let contentW = rect.width, contentH = rect.height, offsetX = 0, offsetY = 0;
    if (contentAspect > containerAspect) {
      // wider content → letterboxed top & bottom
      contentH = rect.width / contentAspect;
      offsetY  = (rect.height - contentH) / 2;
    } else {
      // taller content → pillarboxed left & right
      contentW = rect.height * contentAspect;
      offsetX  = (rect.width - contentW) / 2;
    }
    return {
      x: Math.round((e.clientX - rect.left - offsetX) * (BROWSER_W / contentW)),
      y: Math.round((e.clientY - rect.top  - offsetY) * (BROWSER_H / contentH)),
    };
  };

  // Focus the hidden textarea so all keyboard input is captured reliably
  // (canvas.focus() is unreliable inside nested iframes — this is the noVNC pattern)
  const focusKeyboard = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.value = "\u200B"; // sentinel zero-width space
    ta.focus({ preventScroll: true });
  }, []);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvasCoords(e);
    sendInput({ type: "click", x, y });
    focusKeyboard();
  };

  const onCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvasCoords(e);
    sendInput({ type: "mousemove", x, y });
  }, [sendInput]);

  // Hidden textarea keyboard handlers ─────────────────────────────────────
  const SPECIAL_KEYS = new Set([
    "Enter","Backspace","Delete","Tab","Escape",
    "ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
    "Home","End","PageUp","PageDown",
    "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  ]);

  const onTextareaInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const text = ta.value.replace("\u200B", ""); // strip sentinel
    if (text) sendInput({ type: "type", text });
    ta.value = "\u200B"; // reset to sentinel
  }, [sendInput]);

  const onTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Paste — read OS clipboard and type it directly
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text) sendInput({ type: "type", text });
      }).catch(() => {});
      return;
    }
    // Special keys: send as keydown and block default so they don't alter textarea
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      sendInput({ type: "keydown", key: e.key });
      return;
    }
    // Ctrl/⌘ combos (select-all, copy, cut, undo…): send as keydown
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
      e.preventDefault();
      sendInput({ type: "keydown", key: e.key, ctrl: e.ctrlKey, meta: e.metaKey });
      return;
    }
    // Modifier keys: track down/up for Shift combos, etc.
    if (["Shift","Control","Alt","Meta"].includes(e.key)) {
      sendInput({ type: "keydown", key: e.key });
      return;
    }
    // Printable chars: let them land in the textarea so onInput fires with the delta
  }, [sendInput]);

  const onTextareaKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Only send keyup for modifiers (special keys use press() on server which handles its own keyup)
    if (["Shift","Control","Alt","Meta"].includes(e.key)) {
      sendInput({ type: "keyup", key: e.key });
    }
  }, [sendInput]);

  // scroll — same letterbox-aware coord transform as toCanvasCoords
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const containerAspect = rect.width / rect.height;
      const contentAspect  = BROWSER_W / BROWSER_H;
      let contentW = rect.width, contentH = rect.height, offsetX = 0, offsetY = 0;
      if (contentAspect > containerAspect) {
        contentH = rect.width / contentAspect;
        offsetY  = (rect.height - contentH) / 2;
      } else {
        contentW = rect.height * contentAspect;
        offsetX  = (rect.width - contentW) / 2;
      }
      sendInput({
        type: "scroll",
        x: Math.round((e.clientX - rect.left - offsetX) * (BROWSER_W / contentW)),
        y: Math.round((e.clientY - rect.top  - offsetY) * (BROWSER_H / contentH)),
        deltaX: e.deltaX, deltaY: e.deltaY,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [sendInput]);

  // ── Navigate (address bar Enter) ──────────────────────────────────────────
  const navigate = (url: string) => {
    let u = url.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
    setAddressBar(u);
    sendInput({ type: "navigate", url: u });
  };

  const isRunning = status?.running ?? false;

  return (
    <AppLayout>
      <div className="flex flex-col h-screen overflow-hidden bg-background">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="border-b border-border px-4 py-3 flex items-center gap-3 shrink-0">
          <Shield className="w-5 h-5 text-[#1AD2F2]" />
          <span className="font-bold text-base tracking-tight">Antidetect Browser</span>
          <span className="text-xs text-muted-foreground ml-1">
            puppeteer-extra + stealth — compare with the regular EB
          </span>
          {isRunning && (
            <span className="ml-auto text-xs text-muted-foreground">
              Proxy: <span className="font-mono text-foreground">{status?.proxyLabel}</span>
            </span>
          )}
        </div>

        {/* ── Controls bar ───────────────────────────────────────────────── */}
        <div className="border-b border-border px-4 py-2 flex items-center gap-2 shrink-0 bg-muted/30 flex-wrap">
          {!isRunning ? (
            <>
              {/* Proxy entry fields */}
              <Input
                value={proxyHost}
                onChange={e => setProxyHost(e.target.value)}
                placeholder="Proxy host"
                className="h-8 text-xs w-36 font-mono"
              />
              <Input
                value={proxyPort}
                onChange={e => setProxyPort(e.target.value.replace(/\D/g, ""))}
                placeholder="Port"
                className="h-8 text-xs w-16 font-mono"
                maxLength={5}
              />
              <Input
                value={proxyUsername}
                onChange={e => setProxyUsername(e.target.value)}
                placeholder="Username"
                className="h-8 text-xs w-28"
              />
              <Input
                value={proxyPassword}
                onChange={e => setProxyPassword(e.target.value)}
                placeholder="Password"
                type="password"
                className="h-8 text-xs w-28"
              />

              <div className="w-px h-5 bg-border mx-1" />

              {/* Start URL */}
              <Input
                value={startUrl}
                onChange={e => setStartUrl(e.target.value)}
                placeholder="Start URL…"
                className="h-8 text-xs w-48 font-mono"
              />

              {/* Quick tests */}
              <div className="flex items-center gap-1">
                {DETECTION_TESTS.slice(0, 4).map(t => (
                  <button
                    key={t.url}
                    onClick={() => setStartUrl(t.url)}
                    className="text-[10px] px-2 py-1 rounded border border-border hover:bg-accent transition-colors"
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <Button
                onClick={launch}
                disabled={!proxyHost || !proxyPort || launching}
                size="sm"
                className="h-8 bg-[#1AD2F2] hover:bg-[#13b8d6] text-black font-semibold ml-auto"
              >
                {launching
                  ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Launching…</>
                  : <><Play className="w-3 h-3 mr-1.5" /> Launch</>}
              </Button>
            </>
          ) : (
            <>
              {/* Navigation controls */}
              <button
                onClick={() => sendInput({ type: "back" })}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => sendInput({ type: "forward" })}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="Forward"
              >
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => sendInput({ type: "reload" })}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="Reload"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              {/* Address bar */}
              <form
                className="flex-1 max-w-xl"
                onSubmit={e => { e.preventDefault(); navigate(addressBar); }}
              >
                <div className="relative">
                  <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    value={addressBar}
                    onChange={e => setAddressBar(e.target.value)}
                    className="w-full h-8 pl-7 pr-3 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-[#1AD2F2]"
                    spellCheck={false}
                  />
                </div>
              </form>

              {/* Quick nav */}
              <div className="flex items-center gap-1">
                {DETECTION_TESTS.map(t => (
                  <button
                    key={t.url}
                    onClick={() => navigate(t.url)}
                    className="text-[10px] px-1.5 py-1 rounded border border-border hover:bg-accent transition-colors flex items-center gap-0.5"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                    {t.label}
                  </button>
                ))}
              </div>

              <Button
                onClick={stop}
                disabled={stopping}
                size="sm"
                variant="outline"
                className="h-8 ml-auto border-red-300 text-red-600 hover:bg-red-50"
              >
                {stopping
                  ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Stopping…</>
                  : <><Square className="w-3 h-3 mr-1.5" /> Stop</>}
              </Button>
            </>
          )}
        </div>

        {/* ── Browser canvas area ─────────────────────────────────────────── */}
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden">
          {!isRunning ? (
            <div className="text-center space-y-4 px-8">
              <Shield className="w-16 h-16 mx-auto text-[#1AD2F2]/40" />
              <p className="text-muted-foreground text-sm">
                Select a proxy and click <strong>Launch</strong> to start the antidetect browser.
              </p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Uses <strong>puppeteer-extra + stealth plugin</strong> — patches WebGL fingerprinting,
                navigator.plugins, media codecs, and 20+ other detection vectors beyond the regular EB.
                Navigate to a detection test site to compare scores.
              </p>
              {errorMsg && (
                <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-3 py-2 max-w-sm mx-auto">
                  {errorMsg}
                </p>
              )}
            </div>
          ) : (
            <div className="relative w-full h-full">
              {/* Connection overlay */}
              {connState !== "connected" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                  {connState === "connecting" ? (
                    <div className="text-center space-y-3">
                      <Loader2 className="w-8 h-8 animate-spin text-[#1AD2F2] mx-auto" />
                      <p className="text-white text-sm">Connecting to browser…</p>
                    </div>
                  ) : connState === "idle" ? (
                    <div className="text-center space-y-3">
                      <Loader2 className="w-8 h-8 animate-spin text-[#1AD2F2]/50 mx-auto" />
                      <p className="text-white/70 text-sm">Reconnecting…</p>
                      <Button size="sm" onClick={connectWS} className="bg-[#1AD2F2] text-black">
                        Reconnect now
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center space-y-3">
                      <WifiOff className="w-8 h-8 text-red-400 mx-auto" />
                      <p className="text-white text-sm">{errorMsg || "Stream disconnected"}</p>
                      <Button size="sm" onClick={connectWS} className="bg-[#1AD2F2] text-black">
                        Reconnect
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* First-frame spinner */}
              {connState === "connected" && waitingFrame && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
                  <Loader2 className="w-8 h-8 animate-spin text-[#1AD2F2]" />
                </div>
              )}

              {/* Hidden textarea — noVNC pattern for reliable keyboard capture inside nested iframes */}
              <textarea
                ref={textareaRef}
                aria-hidden="true"
                style={{ position: "absolute", top: -9999, left: -9999, opacity: 0, pointerEvents: "none", width: 1, height: 1, resize: "none" }}
                tabIndex={-1}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onInput={onTextareaInput}
                onKeyDown={onTextareaKeyDown}
                onKeyUp={onTextareaKeyUp}
              />

              <canvas
                ref={canvasRef}
                width={BROWSER_W}
                height={BROWSER_H}
                className="w-full h-full object-contain cursor-default"
                onClick={onCanvasClick}
                onMouseMove={onCanvasMouseMove}
                onContextMenu={e => e.preventDefault()}
              />
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
