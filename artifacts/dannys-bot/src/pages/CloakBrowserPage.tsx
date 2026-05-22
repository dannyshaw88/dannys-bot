import { useState, useEffect, useRef, useCallback } from "react";
import { useProxies } from "@/hooks/use-proxies";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, ArrowRight, RotateCw, Globe, Power, PowerOff, PenLine } from "lucide-react";

const FRAME_W = 1280;
const FRAME_H = 820;
const WS_PATH = "/api/cloak/stream";

type Status = "idle" | "launching" | "connected" | "error";

interface ManualProxy {
  host: string;
  port: string;
  username: string;
  password: string;
  protocol: string;
}

export function CloakBrowserPage() {
  const { data: proxies = [] } = useProxies();
  const [selectedProxy, setSelectedProxy] = useState<string>("none");
  const [startUrl, setStartUrl] = useState("https://www.instagram.com/accounts/emailsignup/");
  const [status, setStatus] = useState<Status>("idle");
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [isOpen, setIsOpen] = useState(false);
  const [urlBarVal, setUrlBarVal] = useState("");
  const [frameSize, setFrameSize] = useState({ w: FRAME_W, h: FRAME_H });
  const [manual, setManual] = useState<ManualProxy>({
    host: "", port: "", username: "", password: "", protocol: "http",
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isManual = selectedProxy === "manual";

  const connectWS = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`);
    wsRef.current = ws;

    ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "frame") {
          const { width, height } = msg;
          setFrameSize({ w: width, h: height });
          const img = new Image();
          img.onload = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;
            ctx.drawImage(img, 0, 0);
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === "status") {
          if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
          setIsOpen(msg.open);
          setStatus(msg.open ? "connected" : "idle");
          setStatusMsg(msg.open ? "Connected" : "Ready");
          setUrlBarVal(msg.url ?? "");
        } else if (msg.type === "url") {
          setUrlBarVal(msg.url ?? "");
        } else if (msg.type === "error") {
          if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
          setIsOpen(false);
          setStatus("error");
          setStatusMsg(msg.message ?? "Launch failed");
        }
      } catch {}
    });

    ws.addEventListener("error", () => {
      setStatus("error");
      setStatusMsg("WebSocket connection failed");
    });

    ws.addEventListener("close", () => {
      wsRef.current = null;
    });
  }, []);

  useEffect(() => {
    connectWS();
    return () => {
      wsRef.current?.close();
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    };
  }, [connectWS]);

  const sendWS = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const handleOpen = useCallback(async () => {
    setStatus("launching");
    setStatusMsg("Launching…");

    // Timeout guard — if no WS status after 90 s, show error
    launchTimerRef.current = setTimeout(() => {
      setStatus("error");
      setStatusMsg("Launch timed out — check server logs");
    }, 90_000);

    let proxyPayload: { proxyId?: number; manualProxy?: object } = {};
    if (isManual) {
      if (!manual.host || !manual.port) {
        if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
        setStatus("error");
        setStatusMsg("Enter a proxy host and port");
        return;
      }
      proxyPayload.manualProxy = {
        host: manual.host,
        port: Number(manual.port),
        username: manual.username || undefined,
        password: manual.password || undefined,
        protocol: manual.protocol,
      };
    } else if (selectedProxy !== "none") {
      proxyPayload.proxyId = Number(selectedProxy);
    }

    try {
      const res = await fetch("/api/cloak/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: startUrl, ...proxyPayload }),
      });
      if (!res.ok) {
        if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
        const body = await res.json().catch(() => ({}));
        setStatus("error");
        setStatusMsg((body as any).message ?? "Server error");
      }
    } catch {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
      setStatus("error");
      setStatusMsg("Could not reach server");
    }
  }, [isManual, manual, selectedProxy, startUrl]);

  const handleClose = useCallback(async () => {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    await fetch("/api/cloak/close", { method: "POST", credentials: "include" });
    setIsOpen(false);
    setStatus("idle");
    setStatusMsg("Ready");
    setUrlBarVal("");
  }, []);

  const getCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - rect.left) * (frameSize.w / rect.width)),
        y: Math.round((e.clientY - rect.top) * (frameSize.h / rect.height)),
      };
    },
    [frameSize],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => sendWS({ type: "mousemove", ...getCoords(e) }),
    [getCoords, sendWS],
  );
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
      sendWS({ type: "mousedown", ...getCoords(e), button });
    },
    [getCoords, sendWS],
  );
  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
      sendWS({ type: "mouseup", ...getCoords(e), button });
    },
    [getCoords, sendWS],
  );
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      sendWS({ type: "scroll", deltaX: e.deltaX, deltaY: e.deltaY });
    },
    [sendWS],
  );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { e.preventDefault(); sendWS({ type: "keydown", key: e.key }); },
    [sendWS],
  );
  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => { e.preventDefault(); sendWS({ type: "keyup", key: e.key }); },
    [sendWS],
  );
  const handleNavigate = useCallback(
    (raw: string) => {
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      sendWS({ type: "navigate", url });
      setUrlBarVal(url);
    },
    [sendWS],
  );

  const badgeVariant: Record<Status, "secondary" | "outline" | "default" | "destructive"> = {
    idle: "secondary",
    launching: "outline",
    connected: "default",
    error: "destructive",
  };

  return (
    <AppLayout>
      <div className="h-full flex flex-col gap-3 pb-2">
        <div>
          <h1 className="text-2xl font-bold">CloakBrowser</h1>
          <p className="text-sm text-muted-foreground">
            Stealth Chromium for account creation testing — routes through your selected proxy.
          </p>
        </div>

        {/* Controls row */}
        <div className="flex items-end gap-3 flex-wrap">
          {/* Proxy source */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Proxy</Label>
            <Select value={selectedProxy} onValueChange={setSelectedProxy} disabled={isOpen}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="No proxy (direct)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No proxy (direct)</SelectItem>
                {proxies.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.host}:{p.port}
                    {p.username ? ` (${p.username})` : ""}
                  </SelectItem>
                ))}
                <SelectItem value="manual">
                  <span className="flex items-center gap-1.5">
                    <PenLine className="w-3.5 h-3.5" />
                    Enter manually…
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Start URL */}
          <div className="flex flex-col gap-1 flex-1 min-w-0">
            <Label className="text-xs text-muted-foreground">Start URL</Label>
            <Input
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://www.instagram.com/accounts/emailsignup/"
              disabled={isOpen}
            />
          </div>

          {/* Status + Open/Close */}
          <div className="flex items-center gap-2 pb-0.5">
            <Badge variant={badgeVariant[status]} className="max-w-xs truncate">
              {statusMsg}
            </Badge>
            {!isOpen ? (
              <Button onClick={handleOpen} disabled={status === "launching"} className="gap-2">
                <Power className="w-4 h-4" />
                Open
              </Button>
            ) : (
              <Button onClick={handleClose} variant="destructive" className="gap-2">
                <PowerOff className="w-4 h-4" />
                Close
              </Button>
            )}
          </div>
        </div>

        {/* Manual proxy entry fields */}
        {isManual && !isOpen && (
          <div className="flex items-end gap-2 flex-wrap p-3 bg-muted/30 border border-border rounded-lg">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Protocol</Label>
              <Select
                value={manual.protocol}
                onValueChange={(v) => setManual((m) => ({ ...m, protocol: v }))}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
              <Label className="text-xs text-muted-foreground">Host</Label>
              <Input
                placeholder="proxy.example.com"
                value={manual.host}
                onChange={(e) => setManual((m) => ({ ...m, host: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1 w-24">
              <Label className="text-xs text-muted-foreground">Port</Label>
              <Input
                placeholder="8080"
                value={manual.port}
                onChange={(e) => setManual((m) => ({ ...m, port: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
              <Label className="text-xs text-muted-foreground">Username (optional)</Label>
              <Input
                placeholder="user"
                value={manual.username}
                onChange={(e) => setManual((m) => ({ ...m, username: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
              <Label className="text-xs text-muted-foreground">Password (optional)</Label>
              <Input
                type="password"
                placeholder="••••••"
                value={manual.password}
                onChange={(e) => setManual((m) => ({ ...m, password: e.target.value }))}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        {/* Browser panel */}
        {isOpen ? (
          <div className="flex-1 flex flex-col border border-border rounded-lg overflow-hidden min-h-0">
            <div className="flex items-center gap-1.5 px-2 py-1.5 bg-card border-b border-border shrink-0">
              <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => sendWS({ type: "back" })} title="Back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => sendWS({ type: "forward" })} title="Forward">
                <ArrowRight className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => sendWS({ type: "reload" })} title="Reload">
                <RotateCw className="w-4 h-4" />
              </Button>
              <div className="flex-1 flex items-center gap-2 bg-background border border-border rounded px-2.5 py-1">
                <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  className="flex-1 bg-transparent text-sm outline-none"
                  value={urlBarVal}
                  onChange={(e) => setUrlBarVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleNavigate(urlBarVal);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  spellCheck={false}
                  placeholder="https://"
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-neutral-950 flex items-start justify-start min-h-0">
              <canvas
                ref={canvasRef}
                className="cursor-default"
                style={{ display: "block", maxWidth: "100%", imageRendering: "auto" }}
                tabIndex={0}
                onMouseMove={handleMouseMove}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onWheel={handleWheel}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                onContextMenu={(e) => e.preventDefault()}
                onClick={(e) => (e.currentTarget as HTMLCanvasElement).focus()}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center border border-dashed border-border rounded-lg">
            <div className="text-center text-muted-foreground">
              <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
              {status === "error" ? (
                <>
                  <p className="text-sm text-destructive font-medium">Launch failed</p>
                  <p className="text-xs mt-1 max-w-sm opacity-80">{statusMsg}</p>
                  <p className="text-xs mt-2 opacity-50">Check server logs for details</p>
                </>
              ) : status === "launching" ? (
                <>
                  <p className="text-sm">Launching CloakBrowser…</p>
                  <p className="text-xs mt-1 opacity-60">First launch downloads ~200 MB stealth binary</p>
                </>
              ) : (
                <>
                  <p className="text-sm">Select a proxy and click Open to launch CloakBrowser</p>
                  <p className="text-xs mt-1 opacity-60">First launch downloads the stealth Chromium binary (~200 MB)</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
