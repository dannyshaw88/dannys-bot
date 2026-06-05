import { useState, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { BrowserPanel } from "@/components/BrowserPanel";
import { UaPickerDropdown, type UaEntry } from "@/components/ui/ua-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import {
  Ghost, ShieldCheck, Globe, Monitor, Cpu,
  Loader2, ChevronDown, ChevronUp, Wifi, WifiOff, AlertTriangle, Plus, ExternalLink, ClipboardPaste, Copy, RefreshCw,
  PlayCircle, UserPlus, Phone, Smartphone, Key, CheckCircle2,
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

// ── Ghost Fingerprint ──────────────────────────────────────────────────────────

interface GhostFingerprint {
  webglVendor:    string;
  webglRenderer:  string;
  canvasNoise:    number;
  audioNoise:     number;
  mediaVideoId:   string;
  mediaAudioId:   string;
  mediaSpeakerId: string;
  fontSeed:       number;
  speechProfile:  number;
}

const FP_GPUS = [
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 750" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 735" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 730" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 720" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 710" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 660" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 650" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 642L" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 619" },
  { vendor: "ARM",                         renderer: "Mali-G920 MC10" },
  { vendor: "ARM",                         renderer: "Mali-G720 MC12" },
  { vendor: "ARM",                         renderer: "Mali-G715 MC11" },
  { vendor: "ARM",                         renderer: "Mali-G710 MC10" },
  { vendor: "ARM",                         renderer: "Mali-G615 MC6" },
  { vendor: "ARM",                         renderer: "Mali-G610 MC6" },
  { vendor: "ARM",                         renderer: "Mali-G610 MC4" },
  { vendor: "ARM",                         renderer: "Mali-G68 MC4" },
  { vendor: "Google",                      renderer: "Tensor G4" },
  { vendor: "Google",                      renderer: "Tensor G3" },
  { vendor: "Google",                      renderer: "Tensor G2" },
];


const FP_SPEECH_PROFILES = [
  "US English only",
  "US + UK English",
  "English + German",
  "English + Spanish",
  "English + Hindi + Italian",
  "English + Portuguese",
  "English + Mandarin",
  "English + Indonesian",
];

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateGhostFingerprint(): GhostFingerprint {
  const gpu = FP_GPUS[Math.floor(Math.random() * FP_GPUS.length)];
  const canvasNoise = Math.floor(Math.random() * 253) + 2;
  const audioNoise  = parseFloat((Math.random() * 0.0000008 + 0.0000001).toFixed(10));
  return {
    webglVendor:    gpu.vendor,
    webglRenderer:  gpu.renderer,
    canvasNoise,
    audioNoise,
    mediaVideoId:   randHex(16),
    mediaAudioId:   randHex(16),
    mediaSpeakerId: randHex(16),
    fontSeed:       Math.floor(Math.random() * 99) + 1,
    speechProfile:  Math.floor(Math.random() * 8),
  };
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
                {p.name ? p.name : `${p.host}:${p.port}`}
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

// ── 5sim countries ─────────────────────────────────────────────────────────────

const FIVESIM_COUNTRIES = [
  { value: "russia",      label: "Russia" },
  { value: "ukraine",     label: "Ukraine" },
  { value: "kazakhstan",  label: "Kazakhstan" },
  { value: "indonesia",   label: "Indonesia" },
  { value: "philippines", label: "Philippines" },
  { value: "india",       label: "India" },
  { value: "brazil",      label: "Brazil" },
  { value: "vietnam",     label: "Vietnam" },
  { value: "myanmar",     label: "Myanmar" },
  { value: "cambodia",    label: "Cambodia" },
  { value: "nigeria",     label: "Nigeria" },
  { value: "pakistan",    label: "Pakistan" },
  { value: "bangladesh",  label: "Bangladesh" },
  { value: "ghana",       label: "Ghana" },
  { value: "kenya",       label: "Kenya" },
  { value: "egypt",       label: "Egypt" },
  { value: "colombia",    label: "Colombia" },
  { value: "mexico",      label: "Mexico" },
  { value: "thailand",    label: "Thailand" },
  { value: "malaysia",    label: "Malaysia" },
];

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
  const [bioSpin, setBioSpin]           = useState("");
  const [password, setPassword]         = useState(() => generatePassword());

  // Ghost fingerprint — regenerated on every Nuke Environment
  const [fingerprint, setFingerprint]             = useState<GhostFingerprint>(() => generateGhostFingerprint());
  const [fingerprintExpanded, setFingerprintExpanded] = useState(false);

  // 5sim
  const [fiveSimToken, setFiveSimToken]   = useState(() => localStorage.getItem("ghost_5sim_token") ?? "");
  const [fiveSimCountry, setFiveSimCountry] = useState("russia");
  const [fiveSimOrderId, setFiveSimOrderId] = useState<number | null>(null);
  const [fiveSimPhone, setFiveSimPhone]   = useState("");
  const [fiveSimCode, setFiveSimCode]     = useState("");
  const [fiveSimStatus, setFiveSimStatus] = useState<"idle" | "buying" | "waiting" | "got_code" | "cancelled" | "error">("idle");
  const [fiveSimError, setFiveSimError]   = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Add to Equinox
  const [addedToEquinox, setAddedToEquinox] = useState(false);
  const [addingToEquinox, setAddingToEquinox] = useState(false);

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

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const resolvedProxy = (() => {
    if (proxySelection.kind === "saved") {
      const p = proxies.find(x => x.id === proxySelection.id);
      if (p) return { host: p.host, port: p.port, username: p.username ?? undefined, password: p.password ?? undefined, proxyType: (p as any).proxyType ?? "http" };
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
        proxyType: (resolvedProxy as any)?.proxyType,
        fingerprint,
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
    setFingerprint(generateGhostFingerprint());
    setBrowserState("closed");
  };

  // 5sim helpers
  const save5SimToken = (val: string) => {
    setFiveSimToken(val);
    localStorage.setItem("ghost_5sim_token", val);
  };

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const handleBuyNumber = async () => {
    if (!fiveSimToken.trim()) { setFiveSimError("Enter your 5sim API token first"); return; }
    setFiveSimStatus("buying");
    setFiveSimError("");
    setFiveSimPhone("");
    setFiveSimCode("");
    setFiveSimOrderId(null);
    try {
      const r = await fetch("/api/fivesim/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: fiveSimCountry, operator: "any", apiKey: fiveSimToken.trim() }),
      });
      const json = await r.json();
      if (!json.ok) { setFiveSimStatus("error"); setFiveSimError(json.error ?? "Failed to buy number"); return; }
      const order = json.data;
      setFiveSimOrderId(order.id);
      setFiveSimPhone(order.phone ?? "");
      setFiveSimStatus("waiting");
      pollRef.current = setInterval(async () => {
        try {
          const pr = await fetch(`/api/fivesim/check/${order.id}?apiKey=${encodeURIComponent(fiveSimToken.trim())}`);
          const pj = await pr.json();
          if (!pj.ok) return;
          const d = pj.data;
          if (d.status === "RECEIVED" || (d.sms && d.sms.length > 0)) {
            const sms = d.sms?.[0];
            if (sms?.code || sms?.text) {
              stopPoll();
              setFiveSimCode(sms.code ?? sms.text ?? "");
              setFiveSimStatus("got_code");
            }
          } else if (d.status === "CANCEL" || d.status === "BANNED") {
            stopPoll();
            setFiveSimStatus("cancelled");
          }
        } catch {}
      }, 5000);
    } catch (err) {
      setFiveSimStatus("error");
      setFiveSimError(String(err));
    }
  };

  const handleCancelNumber = async () => {
    stopPoll();
    if (fiveSimOrderId && fiveSimToken) {
      fetch(`/api/fivesim/cancel/${fiveSimOrderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: fiveSimToken.trim() }),
      }).catch(() => {});
    }
    setFiveSimStatus("idle");
    setFiveSimPhone("");
    setFiveSimCode("");
    setFiveSimOrderId(null);
  };

  const handleFinishNumber = async () => {
    stopPoll();
    if (fiveSimOrderId && fiveSimToken) {
      fetch(`/api/fivesim/finish/${fiveSimOrderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: fiveSimToken.trim() }),
      }).catch(() => {});
    }
    setFiveSimStatus("idle");
    setFiveSimPhone("");
    setFiveSimCode("");
    setFiveSimOrderId(null);
  };

  const handleAddToEquinox = async () => {
    const uname = (generatedUsername || usernameSpin).trim();
    if (!uname || !password.trim()) return;
    setAddingToEquinox(true);
    try {
      const r = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: uname, password: password.trim() }),
      });
      if (r.ok || r.status === 201) {
        setAddedToEquinox(true);
        setTimeout(() => setAddedToEquinox(false), 3000);
      }
    } catch {}
    setAddingToEquinox(false);
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
        <div className="w-[280px] shrink-0 flex flex-col gap-2 overflow-y-auto">

          {/* Proxy Card */}
          <div className="desktop-card p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proxy</p>
            </div>

            <ProxySelect proxies={proxies as SavedProxy[]} value={proxySelection} onChange={setProxySelection} />

            {proxySelection.kind === "manual" && (
              <div className="space-y-1 pt-0.5">
                <div className="flex gap-1">
                  <Input value={manualHost} onChange={e => setManualHost(e.target.value)} placeholder="host or IP" className="h-7 text-xs flex-1" />
                  <Input value={manualPort} onChange={e => setManualPort(e.target.value)} placeholder="port" className="h-7 text-xs w-16" />
                </div>
                <div className="flex gap-1">
                  <Input value={manualUser} onChange={e => setManualUser(e.target.value)} placeholder="username (opt)" className="h-7 text-xs flex-1" />
                  <Input value={manualPass} onChange={e => setManualPass(e.target.value)} placeholder="password (opt)" className="h-7 text-xs flex-1" type="password" />
                </div>
              </div>
            )}

            {isOpen && (
              <p className="text-[10px] text-muted-foreground">
                Active: <span className="font-mono">{activeProxyLabel}</span>
              </p>
            )}
          </div>

          {/* Device Identity */}
          <div className="desktop-card p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Device Identity</p>
            </div>
            <UaPickerDropdown
              value={selectedUA.api}
              onSelect={setSelectedUA}
            />
            {isOpen && (
              <p className="text-[10px] text-muted-foreground">
                Active: <span className="font-medium">{activeDeviceLabel}</span>
              </p>
            )}
          </div>

          {/* Fingerprint — collapsed by default */}
          <div className="desktop-card p-2.5">
            <button
              type="button"
              onClick={() => setFingerprintExpanded(e => !e)}
              className="flex items-center gap-2 w-full"
            >
              <Cpu className="w-4 h-4 text-cyan-500 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex-1 text-left">Fingerprint</p>
              {fingerprintExpanded
                ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                : <Plus className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
            {fingerprintExpanded && (
              <div className="space-y-1 pt-0.5 border-t border-border/50 mt-1.5">
                {([
                  ["WebGL GPU",     `${fingerprint.webglRenderer}`],
                  ["Canvas Seed",   String(fingerprint.canvasNoise)],
                  ["Audio Noise",   fingerprint.audioNoise.toFixed(10)],
                  ["Font Seed",     `${fingerprint.fontSeed} / 99`],
                  ["Speech",        FP_SPEECH_PROFILES[fingerprint.speechProfile] ?? `Profile ${fingerprint.speechProfile}`],
                  ["Video Device",  fingerprint.mediaVideoId.slice(0, 14) + "…"],
                  ["Audio Input",   fingerprint.mediaAudioId.slice(0, 14) + "…"],
                  ["Speaker Out",   fingerprint.mediaSpeakerId.slice(0, 14) + "…"],
                ] as [string, string][]).map(([label, val]) => (
                  <div key={label} className="flex items-start justify-between gap-2 pt-0.5">
                    <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
                    <span className="text-[10px] font-mono text-foreground text-right break-all">{val}</span>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground/60 pt-1">
                  Regenerates automatically on Nuke Environment.
                </p>
              </div>
            )}
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
                  : <><Ghost className="w-4 h-4" />Open Browser</>}
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

            {/* Bio Spin */}
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground font-medium">Bio Spin</p>
              <div className="flex gap-1">
                <Input
                  value={bioSpin}
                  onChange={e => setBioSpin(e.target.value)}
                  placeholder="{Photographer|Artist|Creator} 📸"
                  className="h-8 text-xs font-mono flex-1 min-w-0"
                  spellCheck={false}
                  autoComplete="off"
                />
                <FieldActions value={bioSpin ? resolveSpintax(bioSpin) : ""} isOpen={isOpen} />
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

            {/* 5sim */}
            <div className="pt-1 space-y-1.5 border-t border-border/50">
              <div className="flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">5sim SMS</p>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">API Token</p>
                <Input
                  value={fiveSimToken}
                  onChange={e => save5SimToken(e.target.value)}
                  placeholder="5sim API token"
                  className="h-7 text-xs font-mono"
                  type="password"
                  autoComplete="off"
                />
              </div>

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Country</p>
                <select
                  value={fiveSimCountry}
                  onChange={e => setFiveSimCountry(e.target.value)}
                  className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {FIVESIM_COUNTRIES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              {fiveSimStatus === "idle" || fiveSimStatus === "error" || fiveSimStatus === "cancelled" ? (
                <Button
                  size="sm"
                  className="w-full h-7 text-xs gap-1.5 bg-cyan-500 hover:bg-cyan-600 text-white border-0"
                  onClick={handleBuyNumber}
                  disabled={!fiveSimToken.trim()}
                >
                  <Phone className="w-3 h-3" />
                  Get Number
                </Button>
              ) : null}

              {fiveSimStatus === "buying" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Purchasing number…
                </div>
              )}

              {(fiveSimStatus === "waiting" || fiveSimStatus === "got_code") && fiveSimPhone && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-muted-foreground font-medium">Phone Number</p>
                  </div>
                  <div className="flex gap-1">
                    <div className="flex-1 h-7 rounded-md border border-input bg-muted/30 px-2 flex items-center">
                      <span className="text-xs font-mono text-foreground">{fiveSimPhone}</span>
                    </div>
                    <FieldActions value={fiveSimPhone} isOpen={isOpen} />
                  </div>
                </div>
              )}

              {fiveSimStatus === "waiting" && (
                <div className="flex items-center gap-2 text-xs text-amber-600">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Waiting for SMS…
                  <button
                    type="button"
                    onClick={handleCancelNumber}
                    className="ml-auto text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {fiveSimStatus === "got_code" && fiveSimCode && (
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground font-medium">SMS Code</p>
                  <div className="flex gap-1">
                    <div className="flex-1 h-7 rounded-md border border-green-400 bg-green-50 dark:bg-green-950/30 px-2 flex items-center gap-1.5">
                      <Key className="w-3 h-3 text-green-600 shrink-0" />
                      <span className="text-xs font-mono font-semibold text-green-700 dark:text-green-400">{fiveSimCode}</span>
                    </div>
                    <FieldActions value={fiveSimCode} isOpen={isOpen} />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-7 text-xs gap-1.5 border-green-300 text-green-700 hover:bg-green-50"
                    onClick={handleFinishNumber}
                  >
                    <CheckCircle2 className="w-3 h-3" />
                    Finish &amp; Release Number
                  </Button>
                </div>
              )}

              {fiveSimError && (
                <p className="text-[10px] text-red-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {fiveSimError}
                </p>
              )}
            </div>

            {/* Add to Equinox */}
            <div className="pt-1 border-t border-border/50">
              <Button
                variant="outline"
                className={cn(
                  "w-full gap-2 text-xs",
                  addedToEquinox
                    ? "border-green-400 text-green-700 bg-green-50 hover:bg-green-50"
                    : "border-cyan-300 text-cyan-700 hover:bg-cyan-50 hover:border-cyan-400 dark:text-cyan-400"
                )}
                onClick={handleAddToEquinox}
                disabled={addingToEquinox || !usernameSpin.trim() || !password.trim()}
                title="Save this username and password as a new Equinox account"
              >
                {addingToEquinox
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Adding…</>
                  : addedToEquinox
                  ? <><CheckCircle2 className="w-3.5 h-3.5" />Added to Equinox!</>
                  : <><UserPlus className="w-3.5 h-3.5" />Add to Equinox</>}
              </Button>
            </div>
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
                  Configure your proxy and device identity, then click <span className="font-medium">Open Browser</span> to launch a clean, isolated session.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
