import { useState, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { BrowserPanel } from "@/components/BrowserPanel";
import { UaPickerDropdown, type UaEntry } from "@/components/ui/ua-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import {
  Ghost, ShieldCheck, Flame, Globe, Monitor,
  Loader2, ChevronDown, Wifi, WifiOff, AlertTriangle, Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
          {/* No proxy */}
          <button
            type="button"
            onClick={() => pick({ kind: "none" })}
            className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${value.kind === "none" ? "text-primary font-medium bg-accent/40" : "text-foreground"}`}
          >
            <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            No proxy (direct)
          </button>

          {/* Saved proxies */}
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

          {/* Divider + Add Proxy */}
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
    closed:    { icon: WifiOff, label: "Browser closed",  cls: "text-muted-foreground bg-muted/60 border-border" },
    opening:   { icon: Loader2, label: "Starting…",       cls: "text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-800" },
    open:      { icon: Wifi,    label: "Browser running", cls: "text-green-700 bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800" },
    resetting: { icon: Flame,   label: "Wiping session…", cls: "text-red-600 bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-800" },
  }[state];
  const Icon = map.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${map.cls}`}>
      <Icon className={`w-3 h-3 ${state === "opening" || state === "resetting" ? "animate-spin" : ""}`} />
      {map.label}
    </span>
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
  const [browserState, setBrowserState]   = useState<BrowserState>("closed");
  const [activeProxyLabel, setActiveProxyLabel] = useState<string>("");

  const isOpen = browserState === "open";

  // On mount, check if the ghost browser is already running on the server.
  // Replit's preview panel reloads the React app frequently, which resets all
  // local state to "closed". This call restores the correct state so the
  // BrowserPanel reconnects to the live session instead of showing "not started".
  useEffect(() => {
    fetch("/api/signup/browser/status")
      .then(r => r.json())
      .then((data: { running: boolean }) => {
        if (data.running) setBrowserState("open");
      })
      .catch(() => {});
  }, []);

  // Resolve proxy config for the open call
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
    setBrowserState("closed");
  };

  const deviceLabel       = parseDeviceLabel(selectedUA.api);
  const activeDeviceLabel = parseDeviceLabel(activeUA.api);

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <Ghost className="w-8 h-8" style={{ color: "#1AD2F2" }} />
            Create a Ghost
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Isolated embedded browser with a clean, detection-hardened environment for creating fresh Instagram accounts.
          </p>
        </div>
        <StatusChip state={browserState} />
      </div>

      {/* Body: two columns */}
      <div className="flex gap-3" style={{ height: "calc(100vh - 175px)" }}>

        {/* ── Left: Controls ── */}
        <div className="w-[272px] shrink-0 flex flex-col gap-2.5 overflow-y-auto pb-2">

          {/* Proxy */}
          <div className="desktop-card p-3 space-y-2">
            <div className="flex items-center gap-2 mb-1">
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

            {/* Manual fields — shown only when "Add Proxy" is selected */}
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

            {/* Proxy status hint */}
            {!hasProxy && proxySelection.kind === "none" && (
              <p className="text-[10px] text-amber-600 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                No proxy — your real IP will be exposed.
              </p>
            )}
            {hasProxy && resolvedProxy && (
              <p className="text-[10px] text-muted-foreground font-mono truncate">
                {resolvedProxy.host}:{resolvedProxy.port}
                {resolvedProxy.username ? " · auth" : " · no auth"}
              </p>
            )}
          </div>

          {/* Device / UA */}
          <div className="desktop-card p-3 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Monitor className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Device Identity</p>
            </div>
            <UaPickerDropdown
              value={selectedUA.api}
              onSelect={ua => setSelectedUA(ua)}
            />
            <div className="rounded bg-muted/50 px-2 py-1.5 space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">Selected</p>
              <p className="text-[10px] text-foreground font-medium truncate">{deviceLabel}</p>
              <p className="text-[10px] font-mono text-muted-foreground/70 break-all leading-tight">{selectedUA.embedded}</p>
            </div>
          </div>

          {/* Anti-detect */}
          <div className="desktop-card p-3 space-y-1.5">
            <div className="flex items-center gap-2 mb-1">
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
              <div key={item} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <p className="text-[10px] text-muted-foreground">{item}</p>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="desktop-card p-3 space-y-2">
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
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={handleClose}
              >
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
                ? <><Loader2 className="w-4 h-4 animate-spin" />Starting fresh…</>
                : <><Flame className="w-4 h-4" />Start from Fresh</>}
            </Button>
            <p className="text-[10px] text-muted-foreground text-center leading-tight">
              Wipes all cookies, cache &amp; data, and picks a new device identity
            </p>
          </div>

          {/* Active session info */}
          {isOpen && (
            <div className="desktop-card p-3 space-y-1.5 border-cyan-200 dark:border-cyan-800">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-600">Active Session</p>
              <p className="text-[10px] text-muted-foreground font-medium truncate">{activeDeviceLabel}</p>
              <p className="text-[10px] font-mono text-muted-foreground truncate">{activeProxyLabel}</p>
            </div>
          )}
        </div>

        {/* ── Right: Browser ── */}
        <div className={cn(
          "flex-1 min-w-0 rounded-lg border border-border overflow-hidden flex flex-col",
          !isOpen && "items-center justify-center bg-muted/20"
        )}>
          {isOpen ? (
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
                  Choose a proxy and device, then click{" "}
                  <span className="font-medium text-foreground">Open Ghost Browser</span>{" "}
                  to launch a clean, isolated environment.
                </p>
              </div>
              <Button
                className="bg-cyan-500 hover:bg-cyan-600 text-white border-0 gap-2"
                onClick={handleOpen}
                disabled={browserState === "opening" || !manualValid}
              >
                {browserState === "opening"
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Starting…</>
                  : <><Ghost className="w-4 h-4" />Open Ghost Browser</>}
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
