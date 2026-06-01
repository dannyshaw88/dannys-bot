import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Play, Square, Trash2, Copy, Download, RefreshCw, Wifi, Signal, ChevronRight, Circle, Copy as CopyIcon } from "lucide-react";

interface LocalAdapter {
  ip: string;
  name: string;
  likely: boolean;
}

interface StatusData {
  running: boolean;
  port: number;
  localIps: string[];
  adapters: LocalAdapter[];
  publicIp: string | null;
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
  GET:     "text-emerald-700",
  POST:    "text-blue-700",
  PUT:     "text-yellow-700",
  PATCH:   "text-orange-700",
  DELETE:  "text-red-700",
  CONNECT: "text-purple-700",
  HEAD:    "text-cyan-700",
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
  if (!code) return "text-gray-400";
  if (code < 300) return "text-emerald-600";
  if (code < 400) return "text-yellow-600";
  if (code < 500) return "text-orange-600";
  return "text-red-600";
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      title="Copy"
      className="ml-1 p-0.5 rounded hover:bg-accent text-muted-foreground transition-colors"
    >
      <CopyIcon className="w-3 h-3" />
      {copied && <span className="sr-only">Copied!</span>}
    </button>
  );
}

export function TrackApiPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [filterMethod, setFilterMethod] = useState("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState("8899");
  const [selectedIp, setSelectedIp] = useState<string>("");
  const [connectionMode, setConnectionMode] = useState<"wifi" | "sim">("wifi");
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/track-api/status", { credentials: "include" });
      const data: StatusData = await res.json();
      setStatus(data);
      if (!selectedIp && data.adapters?.length > 0) {
        const preferred = data.adapters.find(a => a.likely) ?? data.adapters[0];
        setSelectedIp(preferred.ip);
      }
    } catch {}
  }, [selectedIp]);

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
    const iv = setInterval(fetchStatus, 5000);
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

  const filteredEntries = entries.filter(e => {
    const methodOk = filterMethod === "ALL" || e.method === filterMethod || (filterMethod === "CONNECT" && e.type === "connect");
    const textOk = !filter || `${e.host}${e.path}`.toLowerCase().includes(filter.toLowerCase());
    return methodOk && textOk;
  });

  const running = status?.running ?? false;
  const proxyHost = connectionMode === "sim" ? (status?.publicIp ?? null) : selectedIp;

  return (
    <AppLayout>
      <div className="flex flex-col gap-4 h-[calc(100vh-80px)]">

        {/* ── Header row ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Track API</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">Intercept iPhone Instagram traffic via proxy — see every endpoint hit in real time.</p>
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
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium">PC network adapters — pick your WiFi one:</p>
                <div className="flex flex-col gap-1.5">
                  {(status?.adapters ?? []).map(adapter => (
                    <button
                      key={adapter.ip}
                      onClick={() => setSelectedIp(adapter.ip)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded border transition-colors text-left ${selectedIp === adapter.ip ? "bg-primary/10 border-primary" : "bg-muted border-border hover:border-primary"}`}
                    >
                      <span className={`font-mono text-xs font-bold ${selectedIp === adapter.ip ? "text-primary" : "text-foreground"}`}>{adapter.ip}</span>
                      <span className="text-[10px] text-muted-foreground truncate flex-1">{adapter.name}</span>
                      {adapter.likely && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">WiFi ✓</span>
                      )}
                    </button>
                  ))}
                </div>
                {(status?.adapters ?? []).filter(a => !a.likely).length > 0 && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400">Only select an IP labelled <strong>WiFi ✓</strong>. Others are virtual adapters (Hyper-V, VPN, Docker) that your phone cannot reach.</p>
                )}
              </div>
            )}
          </div>

          {/* iPhone connection panel */}
          <div className="desktop-card p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-base">📱</span>
              <span className="text-sm font-bold">iPhone Connection</span>
            </div>

            {/* Mode toggle */}
            <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
              <button
                onClick={() => setConnectionMode("wifi")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold transition-colors ${connectionMode === "wifi" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Wifi className="w-3 h-3" /> Same WiFi
              </button>
              <button
                onClick={() => setConnectionMode("sim")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold transition-colors ${connectionMode === "sim" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Signal className="w-3 h-3" /> SIM / Cellular
              </button>
            </div>

            {connectionMode === "wifi" ? (
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>Your iPhone must be on the <strong className="text-foreground">same WiFi network</strong> as this PC.</p>
                {running && selectedIp ? (
                  <div className="flex items-center gap-1 bg-muted px-2 py-1.5 rounded font-mono text-foreground text-xs">
                    <span className="text-muted-foreground">Host:</span>
                    <span className="font-bold">{selectedIp}</span>
                    <CopyButton value={selectedIp} />
                    <span className="ml-2 text-muted-foreground">Port:</span>
                    <span className="font-bold">{port}</span>
                    <CopyButton value={port} />
                  </div>
                ) : (
                  <p className="text-orange-500 text-xs">Start the proxy to see your IP address.</p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>Your iPhone uses <strong className="text-foreground">mobile data (SIM)</strong>. Your PC's port {port} must be reachable from the internet — set up port forwarding on your router.</p>
                {running ? (
                  status?.publicIp ? (
                    <div className="flex items-center gap-1 bg-muted px-2 py-1.5 rounded font-mono text-foreground text-xs">
                      <span className="text-muted-foreground">Host:</span>
                      <span className="font-bold">{status.publicIp}</span>
                      <CopyButton value={status.publicIp} />
                      <span className="ml-2 text-muted-foreground">Port:</span>
                      <span className="font-bold">{port}</span>
                      <CopyButton value={port} />
                    </div>
                  ) : (
                    <p className="text-orange-500 text-xs">Could not detect public IP. Check your internet connection.</p>
                  )
                ) : (
                  <p className="text-orange-500 text-xs">Start the proxy first.</p>
                )}
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-2 text-amber-800 dark:text-amber-300">
                  <strong>Router setup required:</strong> Forward TCP port <span className="font-mono">{port}</span> to this PC's local IP in your router settings. Your iPhone's SIM traffic will then reach the proxy.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── iPhone setup guide ── */}
        <IPhoneSetupGuide running={running} port={port} proxyHost={proxyHost} connectionMode={connectionMode} />

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
            className="flex-1 overflow-y-auto bg-white border border-black font-mono text-[11px] leading-relaxed p-2 min-h-0"
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
              setAutoScroll(atBottom);
            }}
          >
            {filteredEntries.length === 0 ? (
              <div className="text-gray-400 italic p-4">
                {running
                  ? "Waiting for iPhone traffic… Configure your iPhone's WiFi proxy settings, then open Instagram."
                  : "Start the proxy first, then configure your iPhone to route its traffic through it."}
              </div>
            ) : (
              filteredEntries.map(e => (
                <div key={e.id} className="flex items-baseline gap-2 hover:bg-gray-50 px-1 rounded group">
                  <span className="text-gray-500 shrink-0 w-[90px]">{formatTs(e.ts)}</span>
                  <span className={`w-[58px] shrink-0 font-bold ${METHOD_COLORS[e.method] ?? "text-gray-700"}`}>{e.method}</span>
                  <span className="text-black">{e.host}</span>
                  {e.path && <span className="text-gray-600">{e.path}</span>}
                  {e.status && <span className={`ml-auto shrink-0 ${statusColor(e.status)}`}>{e.status}</span>}
                  {e.durationMs != null && <span className="text-gray-400 shrink-0 text-[10px]">{e.durationMs}ms</span>}
                  {e.size != null && <span className="text-gray-400 shrink-0 text-[10px]">{formatSize(e.size)}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function IPhoneSetupGuide({
  running,
  port,
  proxyHost,
  connectionMode,
}: {
  running: boolean;
  port: string;
  proxyHost: string | null;
  connectionMode: "wifi" | "sim";
}) {
  const [open, setOpen] = useState(false);
  const hostDisplay = proxyHost ?? "<PC_IP>";

  return (
    <div className="desktop-card shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full px-4 py-3 text-sm font-semibold hover:bg-accent/30 transition-colors rounded-[inherit]"
      >
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? "rotate-90" : ""}`} />
        <span>📱 iPhone Setup Guide</span>
        {!running && <span className="ml-auto text-xs text-orange-500 font-normal">Start the proxy first</span>}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 text-sm">

          {/* Step-by-step iOS proxy setup */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {connectionMode === "wifi" ? "WiFi Proxy Setup on iPhone" : "SIM / Cellular Proxy Setup on iPhone"}
            </p>

            {connectionMode === "wifi" ? (
              <>
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded p-2.5 text-red-800 dark:text-red-300 text-xs">
                  <strong>⚠ Phone loses internet after setting proxy?</strong> Windows Firewall is blocking the connection. Fix it first (Step 2 below) — this is the #1 cause.
                </div>
                <ol className="space-y-2 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">1</span>
                    <span>In the <strong className="text-foreground">Proxy Control</strong> panel above, click <strong className="text-foreground">Start Proxy</strong>. Then pick the IP labelled <strong className="text-foreground">WiFi ✓</strong> — avoid any Hyper-V / VPN / Docker IPs.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-red-500/15 text-red-500 flex items-center justify-center font-bold text-[10px]">2</span>
                    <div className="space-y-1">
                      <span className="text-foreground font-semibold">Allow the proxy through Windows Firewall</span>
                      <p>Press <strong className="text-foreground">Win + R</strong>, type <code className="bg-muted px-1 rounded font-mono text-foreground">wf.msc</code>, press Enter. In the left panel click <strong className="text-foreground">Inbound Rules → New Rule</strong>. Choose <strong className="text-foreground">Port</strong>, TCP, enter <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code>, allow the connection, apply to all profiles, name it <em>Equinox Proxy</em>.</p>
                      <p className="text-muted-foreground">Or run this one-liner in an <strong className="text-foreground">Admin PowerShell</strong>:</p>
                      <div className="flex items-center gap-1 bg-zinc-900 text-green-400 px-2 py-1.5 rounded font-mono text-[10px] break-all">
                        <span>netsh advfirewall firewall add rule name="Equinox Proxy" dir=in action=allow protocol=TCP localport={port}</span>
                        <CopyButton value={`netsh advfirewall firewall add rule name="Equinox Proxy" dir=in action=allow protocol=TCP localport=${port}`} />
                      </div>
                    </div>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">3</span>
                    <span>Make sure your iPhone is connected to the <strong className="text-foreground">same WiFi network</strong> as this PC.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">4</span>
                    <span>On your iPhone go to <strong className="text-foreground">Settings → Wi-Fi</strong> and tap the <strong className="text-foreground">ⓘ</strong> next to your connected network.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">5</span>
                    <span>Scroll down to <strong className="text-foreground">HTTP Proxy</strong> → tap <strong className="text-foreground">Configure Proxy</strong> → select <strong className="text-foreground">Manual</strong>.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">6</span>
                    <div>
                      <span>Set <strong className="text-foreground">Server</strong> to </span>
                      <code className="bg-muted px-1 rounded font-mono text-foreground">{hostDisplay}</code>
                      <span> and <strong className="text-foreground">Port</strong> to </span>
                      <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code>
                      <span>. Leave Authentication off.</span>
                    </div>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">7</span>
                    <span>Tap <strong className="text-foreground">Save</strong> in the top-right corner.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">8</span>
                    <span>Open <strong className="text-foreground">Instagram</strong> on your iPhone and browse normally — traffic appears in the log instantly. Instagram uses HTTPS, so entries show as <strong className="text-foreground">CONNECT</strong> lines (e.g. <code className="bg-muted px-1 rounded font-mono">i.instagram.com:443</code>).</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-500 flex items-center justify-center font-bold text-[10px]">✓</span>
                    <span>When done, go back to <strong className="text-foreground">Settings → Wi-Fi → ⓘ → Configure Proxy → Off</strong> to remove the proxy from your iPhone.</span>
                  </li>
                </ol>
              </>
            
            ) : (
              <ol className="space-y-2 text-xs text-muted-foreground">
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">1</span>
                  <span>On your router, set up <strong className="text-foreground">port forwarding</strong>: forward external TCP port <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code> to this PC's local IP address.</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">2</span>
                  <span>Turn <strong className="text-foreground">WiFi off</strong> on your iPhone so it uses SIM data only (Settings → Wi-Fi → toggle off).</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">3</span>
                  <span>On your iPhone go to <strong className="text-foreground">Settings → Mobile Data → Mobile Data Options → Mobile Data Network</strong> (or <strong className="text-foreground">Cellular → Cellular Data Options → Cellular Data Network</strong> in some regions).</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">4</span>
                  <div>
                    <span>Under the <strong className="text-foreground">Personal Hotspot</strong> or <strong className="text-foreground">LTE/4G</strong> section, scroll to <strong className="text-foreground">Proxy</strong> and enter Server: </span>
                    <code className="bg-muted px-1 rounded font-mono text-foreground">{hostDisplay}</code>
                    <span> Port: </span>
                    <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code>.
                  </div>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">5</span>
                  <span>Alternatively, use a <strong className="text-foreground">VPN / profile</strong> that routes all traffic through your proxy — see apps like <strong className="text-foreground">Shadowrocket</strong> or <strong className="text-foreground">Quantumult X</strong> (App Store).</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">6</span>
                  <span>Open <strong className="text-foreground">Instagram</strong> on your iPhone — all traffic will appear in the log below.</span>
                </li>
              </ol>
            )}
          </div>

          {/* HTTPS note */}
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong>HTTPS note:</strong> Instagram uses HTTPS for all API calls. This proxy logs the destination hostname for every HTTPS connection (e.g. <code className="font-mono">CONNECT i.instagram.com:443</code>) but not the path inside the encrypted tunnel. To see full paths like <code className="font-mono">/api/v1/feed/timeline/</code>, you need a MITM proxy with a trusted CA certificate installed on your iPhone — use <strong>mitmproxy</strong> or <strong>Charles Proxy</strong> and trust their root cert in iPhone Settings → General → About → Certificate Trust Settings.
          </div>
        </div>
      )}
    </div>
  );
}
