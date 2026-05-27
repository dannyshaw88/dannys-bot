import { useState, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { BrowserPanel } from "@/components/BrowserPanel";
import { UaPickerDropdown, type UaEntry } from "@/components/ui/ua-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import {
  Ghost, ShieldCheck, Globe, Monitor,
  Loader2, ChevronDown, Wifi, WifiOff, AlertTriangle, Plus, ExternalLink, ClipboardPaste, Copy, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Icons ──────────────────────────────────────────────────────────────────────

function NukeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="12" cy="12" r="2.5"/>
      {/* Top blade (centered at 270° SVG = up), spanning 240°–300° */}
      <path d="M10.25 8.97 A3.5 3.5 0 0 1 13.75 8.97 L16.5 4.21 A9 9 0 0 0 7.5 4.21 Z"/>
      {/* Lower-right blade (centered at 30°), spanning 0°–60° */}
      <path d="M15.5 12 A3.5 3.5 0 0 1 13.75 15.03 L16.5 19.79 A9 9 0 0 0 21 12 Z"/>
      {/* Lower-left blade (centered at 150°), spanning 120°–180° */}
      <path d="M10.25 15.03 A3.5 3.5 0 0 1 8.5 12 L3 12 A9 9 0 0 0 7.5 19.79 Z"/>
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function randomUA(): UaEntry {
  const eligible = UA_POOL.filter(e => parseInt(e.api.split("/")[0], 10) >= 34);
  const pool = eligible.length > 0 ? eligible : UA_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function parseDeviceLabel(api: string): string {
  const p = api.split("; ");
  const brand = p[3] ?? "";
  const model = p[4] ?? "";
  const android = (p[0] ?? "").split("/")[1] ?? "";
  if (brand && model) return `${brand} ${model}${android ? ` · Android ${android}` : ""}`;
  return api.length > 48 ? api.slice(0, 48) + "…" : api;
}

// Jarvee-style multilayered spintax
function resolveSpintax(template: string): string {
  let result = template;
  let prev = "";
  while (result !== prev) {
    prev = result;
    result = result.replace(/\{([^{}]*)\}/g, (_match, inner) => {
      const options = inner.split("|");
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return result.trim();
}

function generatePassword(length = 14): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*";
  const all = upper + lower + digits + special;
  const rand = (set: string) => set[Math.floor(Math.random() * set.length)];
  const chars = [rand(upper), rand(lower), rand(digits), rand(special)];
  for (let i = chars.length; i < length; i++) chars.push(rand(all));
  return chars.sort(() => Math.random() - 0.5).join("");
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface SavedProxy {
  id: number;
  name: string | null;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

type ProxySelection =
  | { kind: "none" }
  | { kind: "saved"; id: number }
  | { kind: "manual" };

// ── Proxy Dropdown ─────────────────────────────────────────────────────────────

function ProxySelect({
  proxies,
  value,
  onChange,
}: {
  proxies: SavedProxy[];
  value: ProxySelection;
  onChange: (v: ProxySelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedProxy = value.kind === "saved" ? proxies.find(p => p.id === value.id) ?? null : null;

  const close = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
  }, []);

  const toggle = () => {
    if (!open) document.addEventListener("mousedown", close);
    else document.removeEventListener("mousedown", close);
    setOpen(o => !o);
  };

  const pick = (v: ProxySelection) => {
    onChange(v);
    setOpen(false);
    document.removeEventListener("mousedown", close);
  };

  const label = value.kind === "saved" && selectedProxy
    ? selectedProxy.name ?? `${selectedProxy.host}:${selectedProxy.port}`
    : value.kind === "manual"
    ? "Custom proxy"
    : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          {label
            ? <span className="truncate text-left">{label}</span>
            : <span className="text-muted-foreground">No proxy (direct)</span>}
        </span>
        <ChevronDown className={`ml-2 w-4 h-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-lg max-h-60 overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => pick({ kind: "none" })}
            className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${value.kind === "none" ? "text-primary font-medium bg-accent/40" : "text-foreground"}`}
          >
            <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            No proxy (direct)
          </button>
          {proxies.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground text-center">No proxies saved in Proxy Manager.</p>
          )}
          {proxies.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick({ kind: "saved", id: p.id })}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${value.kind === "saved" && value.id === p.id ? "text-primary font-medium bg-accent/40" : "text-foreground"}`}
            >
              <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="truncate text-left">
                {p.name
                  ? <><span className="font-medium">{p.name}</span> <span className="text-muted-foreground text-xs">{p.host}:{p.port}</span></>
                  : `${p.host}:${p.port}`}
              </span>
            </button>
          ))}
          <div className="border-t border-border mt-1 pt-1">
            <button
              type="button"
              onClick={() => pick({ kind: "manual" })}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${value.kind === "manual" ? "text-primary font-medium bg-accent/40" : "text-cyan-600 dark:text-cyan-400"}`}
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              Add Proxy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Status chip ────────────────────────────────────────────────────────────────

type BrowserState = "closed" | "opening" | "open" | "resetting";

function StatusChip({ state }: { state: BrowserState }) {
  const map = {
    closed:    { icon: WifiOff,  label: "Browser closed",  cls: "text-muted-foreground bg-muted/60 border-border" },
    opening:   { icon: Loader2,  label: "Starting…",       cls: "text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-800" },
    open:      { icon: Wifi,     label: "Browser running", cls: "text-green-700 bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800" },
    resetting: { icon: NukeIcon, label: "Nuking session…", cls: "text-red-600 bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-800" },
  }[state];
  const Icon = map.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${map.cls}`}>
      <Icon className={`w-3 h-3 ${state === "opening" || state === "resetting" ? "animate-spin" : ""}`} />
      {map.label}
    </span>
  );
}

// ── Field action buttons (Paste into browser + Copy to clipboard) ──────────────

function FieldActions({ value, isOpen }: { value: string; isOpen: boolean }) {
  const [copied, setCopied] = useState(false);

  const handlePaste = () => {
    fetch("/api/signup/browser/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fill", text: value }),
    }).catch(() => {});
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex gap-1 shrink-0">
      <button
        type="button"
        onClick={handlePaste}
        disabled={!isOpen || !value}
        title={isOpen ? "Paste into active browser field" : "Open browser first"}
        className={cn(
          "flex items-center gap-1 px-2 h-8 rounded-md border border-input text-[10px] font-medium transition-colors",
          isOpen && value
            ? "bg-muted/50 text-muted-foreground hover:bg-cyan-50 hover:text-cyan-700 hover:border-cyan-400 dark:hover:bg-cyan-950/40"
            : "bg-muted/30 text-muted-foreground/40 cursor-not-allowed"
        )}
      >
        <ClipboardPaste className="w-3 h-3" />
        Paste
      </button>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!value}
        title="Copy to clipboard"
        className={cn(
          "flex items-center gap-1 px-2 h-8 rounded-md border border-input bg-muted/50 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
          copied && "text-green-600 border-green-400"
        )}
      >
        <Copy className="w-3 h-3" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function CreateGhostPage() {
  const { data: proxies = [] } = useProxies();

  // Proxy
  const [proxySelection, setProxySelection] = useState<ProxySelection>({ kind: "none" });
  const [manualHost, setManualHost]         = useState("");
  const [manualPort, setManualPort]         = useState("");
  const [manualUser, setManualUser]         = useState("");
  const [manualPass, setManualPass]         = useState("");

  // Device
  const [selectedUA, setSelectedUA] = useState<UaEntry>(() => randomUA());
  const [activeUA, setActiveUA]     = useState<UaEntry>(selectedUA);

  // Browser
  const [browserState, setBrowserState]         = useState<BrowserState>("closed");
  const [activeProxyLabel, setActiveProxyLabel] = useState<string>("");
  const [isNative, setIsNative]                 = useState(false);

  // Account fields
  const [usernameSpin, setUsernameSpin] = useState("");
  const [password, setPassword]         = useState(() => generatePassword());

  const isOpen = browserState === "open";

  const generatedUsername = usernameSpin.trim() ? resolveSpintax(usernameSpin) : "";

  useEffect(() => {
    Promise.all([
      fetch("/api/is-electron").then(r => r.json()).catch(() => ({ electron: false })),
      fetch("/api/signup/browser/status").then(r => r.json()).catch(() => ({ running: false })),
    ]).then(([elData, statusData]) => {
      setIsNative(!!(elData as any).electron);
      if ((statusData as any).running) setBrowserState("open");
    });
  }, []);

  const resolvedProxy = (() => {
    if (proxySelection.kind === "saved") {
      const p = proxies.find(x => x.id === proxySelection.id);
      if (p) return { host: p.host, port: p.port, username: p.username ?? undefined, password: p.password ?? undefined };
    }
    if (proxySelection.kind === "manual") {
      const host = manualHost.trim();
      const port = parseInt(manualPort, 10);
      if (host && port > 0 && port <= 65535) {
        return { host, port, username: manualUser.trim() || undefined, password: manualPass.trim() || undefined };
      }
      return undefined;
    }
    return undefined;
  })();

  const manualValid =
    proxySelection.kind !== "manual" ||
    (manualHost.trim() !== "" && /^\d+$/.test(manualPort) && parseInt(manualPort, 10) > 0 && parseInt(manualPort, 10) <= 65535);

  const hasProxy = proxySelection.kind !== "none" && resolvedProxy !== undefined;

  const handleOpen = async () => {
    if (!manualValid) return;
    setBrowserState("opening");
    setActiveUA(selectedUA);
    setActiveProxyLabel(resolvedProxy ? `${resolvedProxy.host}:${resolvedProxy.port}` : "Direct (no proxy)");
    await fetch("/api/signup/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAgent: selectedUA.api,
        proxyHost: resolvedProxy?.host,
        proxyPort: resolvedProxy?.port,
        proxyUsername: resolvedProxy?.username,
        proxyPassword: resolvedProxy?.password,
      }),
    }).catch(() => {});
    setBrowserState("open");
  };

  const handleClose = async () => {
    await fetch("/api/signup/browser/close", { method: "POST" }).catch(() => {});
    setBrowserState("closed");
  };

  const handleFresh = async () => {
    setBrowserState("resetting");
    await fetch("/api/signup/browser/close", { method: "POST" }).catch(() => {});
    await fetch("/api/signup/browser/reset", { method: "POST" }).catch(() => {});
    setSelectedUA(randomUA());
    setPassword(generatePassword());
    setBrowserState("closed");
  };

  const activeDeviceLabel = parseDeviceLabel(activeUA.api);

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <Ghost className="w-8 h-8" style={{ color: "#1AD2F2" }} />
            Ghost Browser
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Isolated embedded browser with a clean, detection-hardened environment for creating fresh Instagram accounts.
          </p>
        </div>
        <StatusChip state={browserState} />
      </div>

      {/* Body: two columns */}
      <div className="flex gap-3" style={{ height: "calc(100vh - 170px)" }}>

        {/* ── Left: Controls ── */}
        <div className="w-[272px] shrink-0 flex flex-col gap-1.5 overflow-y-auto pb-2">

          {/* Proxy */}
          <div className="desktop-card p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proxy</p>
            </div>

            <ProxySelect
              proxies={proxies}
              value={proxySelection}
              onChange={v => {
                setProxySelection(v);
                if (v.kind !== "manual") {
                  setManualHost(""); setManualPort(""); setManualUser(""); setManualPass("");
                }
              }}
            />

            {proxySelection.kind === "manual" && (
              <div className="space-y-1.5 pt-0.5">
                <div className="flex gap-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-muted-foreground mb-1">IP / Host</p>
                    <Input
                      value={manualHost}
                      onChange={e => setManualHost(e.target.value)}
                      placeholder="192.168.1.1"
                      className="h-8 text-xs font-mono"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <div className="w-[68px] shrink-0">
                    <p className="text-[10px] text-muted-foreground mb-1">Port</p>
                    <Input
                      value={manualPort}
                      onChange={e => setManualPort(e.target.value.replace(/\D/g, ""))}
                      placeholder="8080"
                      className="h-8 text-xs font-mono"
                      maxLength={5}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Username <span className="text-muted-foreground/50">(optional)</span></p>
                  <Input
                    value={manualUser}
                    onChange={e => setManualUser(e.target.value)}
                    placeholder="username"
                    className="h-8 text-xs"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Password <span className="text-muted-foreground/50">(optional)</span></p>
                  <Input
                    type="password"
                    value={manualPass}
                    onChange={e => setManualPass(e.target.value)}
                    placeholder="password"
                    className="h-8 text-xs"
                    autoComplete="off"
                  />
                </div>
                {manualHost.trim() !== "" && !manualValid && (
                  <p className="text-[10px] text-red-500 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    Enter a valid host and port (1–65535).
                  </p>
                )}
              </div>
            )}

            {!hasProxy && proxySelection.kind === "none" && (
              <p className="text-[10px] text-amber-600 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                No proxy — your real IP will be exposed.
              </p>
            )}
          </div>

          {/* Device Identity */}
          <div className="desktop-card p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Device Identity</p>
            </div>
            <UaPickerDropdown
              value={selectedUA.api}
              onSelect={ua => setSelectedUA(ua)}
            />
          </div>

          {/* Actions + Account Fields */}
          <div className="desktop-card p-2.5 space-y-1.5">
            {!isOpen ? (
              <Button
                className="w-full bg-cyan-500 hover:bg-cyan-600 text-white border-0 gap-2"
                onClick={handleOpen}
                disabled={browserState === "opening" || browserState === "resetting" || !manualValid}
              >
                {browserState === "opening"
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Starting…</>
                  : <><Ghost className="w-4 h-4" />Open Ghost Browser</>}
              </Button>
            ) : (
              <Button variant="outline" className="w-full gap-2" onClick={handleClose}>
                <WifiOff className="w-4 h-4" />
                Close Browser
              </Button>
            )}

            <Button
              variant="outline"
              className="w-full gap-2 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-400"
              onClick={handleFresh}
              disabled={browserState === "opening" || browserState === "resetting"}
              title="Wipes all cookies, cache, localStorage, and persistent data, and picks a new device identity"
            >
              {browserState === "resetting"
                ? <><Loader2 className="w-4 h-4 animate-spin" />Nuking…</>
                : <><NukeIcon className="w-4 h-4" />Nuke Environment</>}
            </Button>

            {/* Username Spin */}
            <div className="pt-0.5 space-y-1">
              <p className="text-[10px] text-muted-foreground font-medium">Username Spin</p>
              <div className="flex gap-1">
                <Input
                  value={usernameSpin}
                  onChange={e => setUsernameSpin(e.target.value)}
                  placeholder="{john|jane}.{smith|jones}{1|23|456}"
                  className="h-8 text-xs font-mono flex-1 min-w-0"
                  spellCheck={false}
                  autoComplete="off"
                />
                <FieldActions value={generatedUsername || resolveSpintax(usernameSpin || "user")} isOpen={isOpen} />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-muted-foreground font-medium">Password</p>
                <button
                  type="button"
                  onClick={() => setPassword(generatePassword())}
                  className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  title="Generate new password"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  Regenerate
                </button>
              </div>
              <div className="flex gap-1">
                <Input
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="h-8 text-xs font-mono flex-1 min-w-0"
                  spellCheck={false}
                  autoComplete="off"
                />
                <FieldActions value={password} isOpen={isOpen} />
              </div>
            </div>
          </div>

          {/* Active session info */}
          {isOpen && (
            <div className="desktop-card p-2.5 space-y-1 border-cyan-200 dark:border-cyan-800">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-600">Active Session</p>
              <p className="text-[10px] text-muted-foreground font-medium truncate">{activeDeviceLabel}</p>
              <p className="text-[10px] font-mono text-muted-foreground truncate">{activeProxyLabel}</p>
            </div>
          )}

          {/* Anti-detect — always at the bottom */}
          <div className="desktop-card p-2.5 space-y-1 mt-auto">
            <div className="flex items-center justify-center gap-2 mb-0.5">
              <ShieldCheck className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Anti-Detect</p>
            </div>
            {[
              "WebGL & Canvas fingerprint spoofed",
              "navigator.webdriver hidden",
              "Timezone matched to proxy exit IP",
              "Language & locale hardened",
              "Persistent user data directory",
              "Device UA injected at Chrome launch",
            ].map(item => (
              <div key={item} className="flex items-center justify-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <p className="text-[10px] text-muted-foreground text-center">{item}</p>
              </div>
            ))}
          </div>

        </div>

        {/* ── Right: Browser ── */}
        <div className={cn(
          "flex-1 min-w-0 rounded-lg border border-border overflow-hidden flex flex-col",
          (!isOpen || isNative) && "items-center justify-center bg-muted/20"
        )}>
          {isOpen && isNative ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
              <div className="w-20 h-20 rounded-3xl bg-green-50 dark:bg-green-950/40 flex items-center justify-center">
                <Monitor className="w-10 h-10 text-green-600" />
              </div>
              <div className="space-y-1.5 max-w-xs">
                <p className="text-base font-semibold text-foreground">Browser is open</p>
                <p className="text-sm text-muted-foreground">
                  The Ghost Browser is running as its own window. Check your taskbar to find it.
                </p>
              </div>
              <Button
                variant="outline"
                className="gap-2 border-green-300 text-green-700 hover:bg-green-50 hover:border-green-400"
                onClick={() => fetch("/api/profiles/-1/eb-input", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "navigate", url: "https://www.instagram.com/" }),
                }).catch(() => {})}
              >
                <ExternalLink className="w-4 h-4" />
                Bring Window to Front
              </Button>
            </div>
          ) : isOpen ? (
            <BrowserPanel
              profileId={0}
              userAgent={activeUA.embedded}
              username="ghost"
              streamUrl="/api/signup/browser/stream"
              inputUrl="/api/signup/browser/input"
              forceStream={true}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
              <div className="w-20 h-20 rounded-3xl bg-muted/60 flex items-center justify-center">
                <Ghost className="w-10 h-10 text-muted-foreground/50" />
              </div>
              <div className="space-y-1.5 max-w-xs">
                <p className="text-base font-semibold text-foreground">Browser not started</p>
                <p className="text-sm text-muted-foreground">
                  Configure your proxy and device identity, then click <span className="font-medium">Open Ghost Browser</span> to launch a clean, isolated session.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
