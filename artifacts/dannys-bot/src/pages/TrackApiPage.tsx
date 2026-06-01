import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Play, Square, Trash2, Copy, Download, RefreshCw, Wifi, Smartphone, ChevronRight, Circle } from "lucide-react";

interface StatusData {
  running: boolean;
  port: number;
  localIps: string[];
  adbAvailable: boolean;
  devices: { serial: string; state: string }[];
  entryCount: number;
}

interface LogEntry {
  id: number;
  ts: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  type: "http" | "connect";
  size: number | null;
}

const METHOD_COLORS: Record<string, string> = {
  GET:     "text-emerald-400",
  POST:    "text-blue-400",
  PUT:     "text-yellow-400",
  PATCH:   "text-orange-400",
  DELETE:  "text-red-400",
  CONNECT: "text-purple-400",
  HEAD:    "text-cyan-400",
};

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch { return iso; }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function statusColor(code: number | null): string {
  if (!code) return "text-zinc-500";
  if (code < 300) return "text-emerald-400";
  if (code < 400) return "text-yellow-400";
  if (code < 500) return "text-orange-400";
  return "text-red-400";
}

export function TrackApiPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [filterMethod, setFilterMethod] = useState("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState("8899");
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [selectedIp, setSelectedIp] = useState<string>("");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/track-api/status", { credentials: "include" });
      const data: StatusData = await res.json();
      setStatus(data);
      if (!selectedDevice && data.devices.length > 0) setSelectedDevice(data.devices[0].serial);
      if (!selectedIp && data.localIps.length > 0) setSelectedIp(data.localIps[0]);
    } catch {}
  }, [selectedDevice, selectedIp]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/track-api/logs", { credentials: "include" });
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    const iv = setInterval(fetchStatus, 3000);
    return () => clearInterval(iv);
  }, [fetchStatus, fetchLogs]);

  // WebSocket for live log streaming
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/track-api/ws`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "entry") {
          setEntries(prev => {
            const next = [...prev, msg.entry];
            return next.length > 1000 ? next.slice(-1000) : next;
          });
        } else if (msg.type === "clear") {
          setEntries([]);
        }
      } catch {}
    };

    return () => { ws.close(); };
  }, []);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const start = async () => {
    setLoading(true);
    try {
      await fetch("/api/track-api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ port: parseInt(port, 10) }),
      });
      await fetchStatus();
    } finally { setLoading(false); }
  };

  const stop = async () => {
    setLoading(true);
    try {
      await fetch("/api/track-api/stop", { method: "POST", credentials: "include" });
      await fetchStatus();
    } finally { setLoading(false); }
  };

  const clearLogs = async () => {
    await fetch("/api/track-api/clear", { method: "POST", credentials: "include" });
    setEntries([]);
  };

  const copyLogs = () => {
    const text = filteredEntries.map(e =>
      `${formatTs(e.ts)}  ${e.method.padEnd(7)}  ${e.host}${e.path}${e.status ? `  ${e.status}` : ""}${e.durationMs != null ? `  ${e.durationMs}ms` : ""}`
    ).join("\n");
    navigator.clipboard.writeText(text);
  };

  const exportLogs = () => {
    const text = filteredEntries.map(e =>
      `${e.ts}  ${e.method.padEnd(7)}  ${e.host}${e.path}${e.status ? `  ${e.status}` : ""}${e.durationMs != null ? `  ${e.durationMs}ms` : ""}${e.size != null ? `  ${formatSize(e.size)}` : ""}`
    ).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `track-api-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const setAdbProxy = async () => {
    if (!selectedDevice || !selectedIp) return;
    await fetch("/api/track-api/adb/set-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ serial: selectedDevice, host: selectedIp, port: parseInt(port, 10) }),
    });
    await fetchStatus();
  };

  const clearAdbProxy = async () => {
    if (!selectedDevice) return;
    await fetch("/api/track-api/adb/clear-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ serial: selectedDevice }),
    });
  };

  const filteredEntries = entries.filter(e => {
    const methodOk = filterMethod === "ALL" || e.method === filterMethod || (filterMethod === "CONNECT" && e.type === "connect");
    const textOk = !filter || `${e.host}${e.path}`.toLowerCase().includes(filter.toLowerCase());
    return methodOk && textOk;
  });

  const running = status?.running ?? false;

  return (
    <AppLayout>
      <div className="flex flex-col gap-4 h-[calc(100vh-80px)]">

        {/* ── Header row ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Track API</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">Intercept HTTP traffic from your phone via proxy — see every endpoint hit by Instagram.</p>
          </div>

          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border ${running ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" : "bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700"}`}>
              <Circle className={`w-2 h-2 fill-current ${running ? "text-emerald-500" : "text-zinc-400"}`} />
              {running ? `Running on :${status?.port}` : "Stopped"}
            </div>
            <button onClick={fetchStatus} className="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Control panel ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">

          {/* Proxy control */}
          <div className="desktop-card p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Wifi className="w-4 h-4 text-primary" />
              <span className="text-sm font-bold">Proxy Control</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10 shrink-0">Port</span>
              <input
                type="number"
                value={port}
                onChange={e => setPort(e.target.value)}
                disabled={running}
                className="w-24 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
              {!running ? (
                <button onClick={start} disabled={loading} className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-50">
                  <Play className="w-3 h-3" /> Start Proxy
                </button>
              ) : (
                <button onClick={stop} disabled={loading} className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50">
                  <Square className="w-3 h-3" /> Stop Proxy
                </button>
              )}
            </div>

            {running && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">PC IP addresses — type one of these as the proxy host on your phone:</p>
                <div className="flex flex-wrap gap-1.5">
                  {(status?.localIps ?? []).map(ip => (
                    <button
                      key={ip}
                      onClick={() => setSelectedIp(ip)}
                      className={`px-2 py-0.5 rounded font-mono text-xs border transition-colors ${selectedIp === ip ? "bg-primary/10 border-primary text-primary" : "bg-muted border-border text-foreground hover:border-primary"}`}
                    >
                      {ip}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ADB / device control */}
          <div className="desktop-card p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Smartphone className="w-4 h-4 text-primary" />
              <span className="text-sm font-bold">Android Device (ADB)</span>
              {status?.adbAvailable === false && (
                <span className="ml-auto text-[10px] text-orange-500 font-semibold">ADB not found in PATH</span>
              )}
            </div>

            {(status?.devices ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No devices detected. Connect your phone via USB with USB Debugging enabled.</p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {(status?.devices ?? []).map(d => (
                    <button
                      key={d.serial}
                      onClick={() => setSelectedDevice(d.serial)}
                      className={`px-2 py-0.5 rounded font-mono text-xs border transition-colors ${selectedDevice === d.serial ? "bg-primary/10 border-primary text-primary" : "bg-muted border-border text-foreground hover:border-primary"}`}
                    >
                      {d.serial} <span className="text-muted-foreground">({d.state})</span>
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={setAdbProxy}
                    disabled={!running || !selectedDevice || !selectedIp}
                    className="px-3 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40"
                  >
                    Set Proxy via ADB
                  </button>
                  <button
                    onClick={clearAdbProxy}
                    disabled={!selectedDevice}
                    className="px-3 py-1 text-xs font-semibold rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-40"
                  >
                    Clear Proxy
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Setup guide (collapsed by default) ── */}
        <SetupGuide running={running} port={port} selectedIp={selectedIp} />

        {/* ── Log viewer ── */}
        <div className="flex-1 desktop-card flex flex-col overflow-hidden min-h-0">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">
            <span className="text-xs font-bold text-muted-foreground">{filteredEntries.length} entries</span>
            <div className="flex-1 min-w-[120px] max-w-xs">
              <input
                type="text"
                placeholder="Filter host/path…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                className="w-full px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
            <select
              value={filterMethod}
              onChange={e => setFilterMethod(e.target.value)}
              className="px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            >
              {["ALL", "CONNECT", "GET", "POST", "PUT", "PATCH", "DELETE"].map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="w-3 h-3" />
              Auto-scroll
            </label>
            <button onClick={clearLogs} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-accent text-muted-foreground transition-colors">
              <Trash2 className="w-3 h-3" /> Clear
            </button>
            <button onClick={copyLogs} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-accent text-muted-foreground transition-colors">
              <Copy className="w-3 h-3" /> Copy
            </button>
            <button onClick={exportLogs} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-accent text-muted-foreground transition-colors">
              <Download className="w-3 h-3" /> Export
            </button>
          </div>

          {/* Log lines */}
          <div
            ref={logRef}
            className="flex-1 overflow-y-auto bg-zinc-950 font-mono text-[11px] leading-relaxed p-2 min-h-0"
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
              setAutoScroll(atBottom);
            }}
          >
            {filteredEntries.length === 0 ? (
              <div className="text-zinc-600 italic p-4">
                {running ? "Waiting for traffic… Configure your phone to use this PC as its HTTP proxy, then open Instagram." : "Start the proxy first, then configure your phone to route traffic through it."}
              </div>
            ) : (
              filteredEntries.map(e => (
                <div key={e.id} className="flex items-baseline gap-2 hover:bg-zinc-900 px-1 rounded group">
                  <span className="text-zinc-600 shrink-0 w-[84px]">{formatTs(e.ts)}</span>
                  <span className={`w-[58px] shrink-0 font-bold ${METHOD_COLORS[e.method] ?? "text-zinc-400"}`}>{e.method}</span>
                  <span className="text-zinc-300">{e.host}</span>
                  {e.path && <span className="text-zinc-500">{e.path}</span>}
                  {e.status && <span className={`ml-auto shrink-0 ${statusColor(e.status)}`}>{e.status}</span>}
                  {e.durationMs != null && <span className="text-zinc-600 shrink-0 text-[10px]">{e.durationMs}ms</span>}
                  {e.size != null && <span className="text-zinc-700 shrink-0 text-[10px]">{formatSize(e.size)}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function SetupGuide({ running, port, selectedIp }: { running: boolean; port: string; selectedIp: string }) {
  const [open, setOpen] = useState(false);
  const proxyStr = selectedIp ? `${selectedIp}:${port}` : `<YOUR_PC_IP>:${port}`;

  return (
    <div className="desktop-card shrink-0">
      <button onClick={() => setOpen(v => !v)} className="flex items-center gap-2 w-full px-4 py-3 text-sm font-semibold hover:bg-accent/30 transition-colors rounded-[inherit]">
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? "rotate-90" : ""}`} />
        Setup Guide — How to route your phone through this proxy
        {!running && <span className="ml-auto text-xs text-orange-500 font-normal">Start the proxy first</span>}
      </button>

      {open && (
        <div className="px-5 pb-4 space-y-3 text-sm">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Option A — Auto via ADB (USB cable)</p>
            <ol className="space-y-1 text-xs text-muted-foreground list-decimal list-inside">
              <li>Enable <strong>USB Debugging</strong> on your phone (Settings → Developer Options → USB Debugging)</li>
              <li>Connect your phone via USB cable and accept the "Allow USB Debugging?" prompt</li>
              <li>Start the proxy above, then click <strong>Set Proxy via ADB</strong> — this auto-configures the phone</li>
              <li>Open Instagram and browse normally — all traffic appears in the log below</li>
              <li>When done, click <strong>Clear Proxy</strong> to remove the proxy setting from the phone</li>
            </ol>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Option B — Manual WiFi proxy</p>
            <ol className="space-y-1 text-xs text-muted-foreground list-decimal list-inside">
              <li>Make sure your phone is on the <strong>same WiFi network</strong> as this PC</li>
              <li>On Android: Settings → WiFi → long-press your network → Modify → Advanced → Proxy: Manual</li>
              <li>Set <strong>Proxy hostname</strong> to <code className="bg-muted px-1 rounded font-mono text-foreground">{proxyStr.split(":")[0]}</code> and <strong>Port</strong> to <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code></li>
              <li>Open Instagram — traffic appears in the log</li>
            </ol>
          </div>

          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong>HTTPS note:</strong> Instagram uses HTTPS for all API calls. This proxy logs the destination hostname for every HTTPS connection (you will see <code className="font-mono">CONNECT i.instagram.com:443</code>) but not the actual path inside the encrypted tunnel. To see full paths like <code className="font-mono">/api/v1/feed/timeline/</code>, you need a MITM proxy (e.g. mitmproxy or Charles Proxy) with a trusted CA certificate installed on your phone, and SSL pinning bypassed (Frida/Magisk on rooted device).
          </div>
        </div>
      )}
    </div>
  );
}
