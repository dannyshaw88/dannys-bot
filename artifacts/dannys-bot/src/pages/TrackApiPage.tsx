import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Play, Square, Trash2, Copy, Download, RefreshCw, Wifi, Signal, ChevronRight, Circle, Copy as CopyIcon, ShieldCheck, AlertTriangle } from "lucide-react";

interface LocalAdapter {
  ip: string;
  name: string;
  likely: boolean;
}

interface StatusData {
  running: boolean;
  port: number;
  mitm: boolean;
  localIps: string[];
  adapters: LocalAdapter[];
  publicIp: string | null;
  entryCount: number;
  caCertReady: boolean;
}

interface LogEntry {
  id: number;
  ts: string;
  method: string;
  host: string;
  path: string;
  label: string | null;
  status: number | null;
  durationMs: number | null;
  type: "http" | "connect" | "https";
  size: number | null;
}

const METHOD_COLORS: Record<string, string> = {
  GET:     "text-emerald-600",
  POST:    "text-blue-600",
  PUT:     "text-yellow-600",
  PATCH:   "text-orange-600",
  DELETE:  "text-red-600",
  CONNECT: "text-purple-500",
  HEAD:    "text-cyan-600",
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
  const [hideConnectTunnels, setHideConnectTunnels] = useState(true);
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

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/track-api/ws`);
    wsRef.current = ws;
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "snapshot") {
          setEntries(msg.entries ?? []);
        } else if (msg.type === "entry") {
          setEntries(prev => {
            const next = [...prev, msg.entry];
            return next.length > 2000 ? next.slice(-2000) : next;
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
        body: JSON.stringify({ port: parseInt(port, 10), mitm: true }),
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
    const text = filteredEntries.map(e => {
      const label = e.label ? ` [${e.label}]` : "";
      return `${formatTs(e.ts)}  ${e.method.padEnd(7)}  ${e.host}${e.path}${label}${e.status ? `  ${e.status}` : ""}${e.durationMs != null ? `  ${e.durationMs}ms` : ""}`;
    }).join("\n");
    navigator.clipboard.writeText(text);
  };

  const exportLogs = () => {
    const text = filteredEntries.map(e => {
      const label = e.label ? ` [${e.label}]` : "";
      return `${e.ts}  ${e.method.padEnd(7)}  ${e.host}${e.path}${label}${e.status ? `  ${e.status}` : ""}${e.durationMs != null ? `  ${e.durationMs}ms` : ""}${e.size != null ? `  ${formatSize(e.size)}` : ""}`;
    }).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `track-api-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredEntries = entries.filter(e => {
    if (hideConnectTunnels && e.type === "connect") return false;
    const methodOk = filterMethod === "ALL" || e.method === filterMethod;
    const textOk = !filter || `${e.host}${e.path}${e.label ?? ""}`.toLowerCase().includes(filter.toLowerCase());
    return methodOk && textOk;
  });

  const running = status?.running ?? false;
  const proxyHost = connectionMode === "sim" ? (status?.publicIp ?? null) : selectedIp;
  const caCertReady = status?.caCertReady ?? false;
  const igCount = filteredEntries.filter(e => e.type === "https").length;

  return (
    <AppLayout>
      <div className="flex flex-col gap-4 h-[calc(100vh-80px)]">

        {/* ── Header row ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Track API</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">Intercept iPhone Instagram traffic — see every endpoint hit in real time.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border ${running ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" : "bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700"}`}>
              <Circle className={`w-2 h-2 fill-current ${running ? "text-emerald-500" : "text-zinc-400"}`} />
              {running ? `Running on :${status?.port}` : "Stopped"}
            </div>
            {running && (
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold border bg-sky-500/10 text-sky-600 border-sky-500/30">
                <ShieldCheck className="w-3 h-3" /> MITM Active
              </div>
            )}
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
              </div>
            )}
          </div>

          {/* iPhone connection panel */}
          <div className="desktop-card p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-base">📱</span>
              <span className="text-sm font-bold">iPhone Connection</span>
            </div>
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
                <p>Your iPhone uses <strong className="text-foreground">mobile data (SIM)</strong>. Your PC's port {port} must be reachable from the internet.</p>
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
                    <p className="text-orange-500 text-xs">Could not detect public IP.</p>
                  )
                ) : (
                  <p className="text-orange-500 text-xs">Start the proxy first.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── iPhone setup guide ── */}
        <IPhoneSetupGuide running={running} port={port} proxyHost={proxyHost} connectionMode={connectionMode} caCertReady={caCertReady} />

        {/* ── Log viewer ── */}
        <div className="flex-1 desktop-card flex flex-col overflow-hidden min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">
            <span className="text-xs font-bold text-muted-foreground">{filteredEntries.length} entries</span>
            {igCount > 0 && (
              <span className="text-xs text-sky-600 font-semibold">{igCount} Instagram calls</span>
            )}
            <div className="flex-1 min-w-[120px] max-w-xs">
              <input
                type="text"
                placeholder="Filter host/path/label…"
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
              {["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "CONNECT"].map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={hideConnectTunnels} onChange={e => setHideConnectTunnels(e.target.checked)} className="w-3 h-3" />
              Hide tunnels
            </label>
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
            className="flex-1 overflow-y-auto bg-white dark:bg-zinc-950 font-mono text-[11px] leading-relaxed p-2 min-h-0"
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
              setAutoScroll(atBottom);
            }}
          >
            {filteredEntries.length === 0 ? (
              <div className="text-gray-400 italic p-4">
                {running
                  ? "Waiting for iPhone traffic… Configure your iPhone's WiFi proxy settings and install the CA certificate, then open Instagram."
                  : "Start the proxy first, then follow the setup guide above."}
              </div>
            ) : (
              filteredEntries.map(e => (
                <div
                  key={e.id}
                  className={`flex items-baseline gap-2 hover:bg-gray-50 dark:hover:bg-zinc-900 px-1 rounded group ${e.type === "https" && e.label ? "bg-sky-50/40 dark:bg-sky-950/20" : ""}`}
                >
                  <span className="text-gray-400 shrink-0 w-[90px]">{formatTs(e.ts)}</span>
                  <span className={`w-[52px] shrink-0 font-bold ${METHOD_COLORS[e.method] ?? "text-gray-700"}`}>{e.method}</span>
                  <span className={`shrink-0 ${e.type === "https" ? "text-sky-700 dark:text-sky-400" : "text-gray-700 dark:text-gray-300"}`}>{e.host}</span>
                  {e.path && <span className="text-gray-500 dark:text-gray-400 truncate">{e.path}</span>}
                  {e.label && (
                    <span className="shrink-0 ml-1 px-1.5 py-0 rounded text-[10px] font-bold bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                      {e.label}
                    </span>
                  )}
                  {e.status != null && e.status > 0 && <span className={`ml-auto shrink-0 ${statusColor(e.status)}`}>{e.status}</span>}
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
  caCertReady,
}: {
  running: boolean;
  port: string;
  proxyHost: string | null;
  connectionMode: "wifi" | "sim";
  caCertReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hostDisplay = proxyHost ?? "<PC_IP>";

  const downloadCaCert = () => {
    window.open("/api/track-api/ca-cert", "_blank");
  };

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
        <div className="px-5 pb-5 space-y-5 text-sm">

          {/* MITM explanation banner */}
          <div className="flex items-start gap-3 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 rounded-lg p-3 text-xs text-sky-800 dark:text-sky-300">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong>How it works:</strong> The proxy intercepts your iPhone's HTTPS traffic using a custom CA certificate you install on your phone. Once trusted, it can decrypt Instagram API calls and show you exact endpoints like <code className="bg-sky-100 dark:bg-sky-900 px-1 rounded font-mono">Follow User</code>, <code className="bg-sky-100 dark:bg-sky-900 px-1 rounded font-mono">Timeline Feed</code>, etc. in real time.
            </div>
          </div>

          {/* Step 1 — Download & install CA cert */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-orange-500/15 text-orange-500 flex items-center justify-center font-bold text-[10px]">1</span>
              Install the CA Certificate on iPhone (one time only)
            </p>

            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-2.5 text-xs text-amber-800 dark:text-amber-300">
              <strong>⚠ Required for HTTPS decryption.</strong> Without this, Instagram traffic stays encrypted and only hostnames are logged. You only need to do this once — the certificate is saved permanently.
            </div>

            <ol className="space-y-2 text-xs text-muted-foreground">
              <li className="flex gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">A</span>
                <div className="space-y-1">
                  <span>Click the button below to download the CA certificate file.</span>
                  <div>
                    <button
                      onClick={downloadCaCert}
                      disabled={!caCertReady && !running}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      Download equinox-track-api-ca.crt
                    </button>
                    {!running && <span className="ml-2 text-orange-500">Start the proxy first to generate the cert.</span>}
                  </div>
                </div>
              </li>
              <li className="flex gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">B</span>
                <span>AirDrop the <code className="bg-muted px-1 rounded font-mono text-foreground">.crt</code> file to your iPhone, or email it to yourself and open it on the iPhone. iOS will prompt: <em>"Profile Downloaded"</em> — tap <strong className="text-foreground">Close</strong>.</span>
              </li>
              <li className="flex gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">C</span>
                <span>On iPhone go to <strong className="text-foreground">Settings → General → VPN & Device Management</strong>. Tap the <strong className="text-foreground">Equinox Track API CA</strong> profile → tap <strong className="text-foreground">Install</strong> → enter your passcode → tap <strong className="text-foreground">Install</strong> again.</span>
              </li>
              <li className="flex gap-2">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">D</span>
                <span>Go to <strong className="text-foreground">Settings → General → About → Certificate Trust Settings</strong>. Under <em>Enable Full Trust For Root Certificates</em>, toggle <strong className="text-foreground">Equinox Track API CA</strong> to <span className="text-emerald-600 font-bold">ON</span>. Tap Continue when warned.</span>
              </li>
            </ol>
          </div>

          {/* Step 2 — Proxy setup */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">2</span>
              {connectionMode === "wifi" ? "Configure WiFi Proxy on iPhone" : "Configure SIM Proxy on iPhone"}
            </p>

            {connectionMode === "wifi" ? (
              <>
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded p-2.5 text-red-800 dark:text-red-300 text-xs">
                  <strong>⚠ Phone loses internet after setting proxy?</strong> Windows Firewall is blocking port {port}. Run this in Admin PowerShell:
                  <div className="flex items-center gap-1 mt-1 bg-zinc-900 text-green-400 px-2 py-1.5 rounded font-mono text-[10px] break-all">
                    <span>netsh advfirewall firewall add rule name="Equinox Proxy" dir=in action=allow protocol=TCP localport={port}</span>
                    <CopyButton value={`netsh advfirewall firewall add rule name="Equinox Proxy" dir=in action=allow protocol=TCP localport=${port}`} />
                  </div>
                </div>
                <ol className="space-y-2 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">1</span>
                    <span>Make sure your iPhone is on the <strong className="text-foreground">same WiFi</strong> as this PC. Start the proxy above and pick the IP labelled <strong className="text-foreground">WiFi ✓</strong>.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">2</span>
                    <span>On iPhone: <strong className="text-foreground">Settings → Wi-Fi → ⓘ</strong> next to your network → <strong className="text-foreground">Configure Proxy → Manual</strong>.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">3</span>
                    <div>
                      Set <strong className="text-foreground">Server</strong> to <code className="bg-muted px-1 rounded font-mono text-foreground">{hostDisplay}</code> and <strong className="text-foreground">Port</strong> to <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code>. Tap <strong className="text-foreground">Save</strong>.
                    </div>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center font-bold text-[10px]">✓</span>
                    <span>Open Instagram — API calls appear in the log below with labelled endpoints. When done, go back and set <strong className="text-foreground">Configure Proxy → Off</strong>.</span>
                  </li>
                </ol>
              </>
            ) : (
              <ol className="space-y-2 text-xs text-muted-foreground">
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">1</span>
                  <span>On your router, forward external TCP port <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code> to this PC's local IP.</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">2</span>
                  <span>Turn <strong className="text-foreground">WiFi off</strong> on iPhone so it uses SIM only.</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold text-[10px]">3</span>
                  <div>
                    iPhone → <strong className="text-foreground">Settings → Mobile Data → APNs</strong> or use an app like <strong className="text-foreground">Shadowrocket</strong>: set proxy host to <code className="bg-muted px-1 rounded font-mono text-foreground">{hostDisplay}</code> port <code className="bg-muted px-1 rounded font-mono text-foreground">{port}</code>.
                  </div>
                </li>
              </ol>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
