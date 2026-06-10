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
  Loader2, ChevronDown, ChevronUp, Wifi, WifiOff, Plus, ExternalLink,
  ClipboardPaste, Copy, RefreshCw, UserPlus, Key,
  CheckCircle2, Mail, Lock, Server, Calendar, MessageSquare, Link,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Icons ──────────────────────────────────────────────────────────────────────

function NukeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="12" cy="12" r="2.5"/>
      <path d="M10.25 8.97 A3.5 3.5 0 0 1 13.75 8.97 L16.5 4.21 A9 9 0 0 0 7.5 4.21 Z"/>
      <path d="M15.5 12 A3.5 3.5 0 0 1 13.75 15.03 L16.5 19.79 A9 9 0 0 0 21 12 Z"/>
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

function generateDob(): string {
  const age = Math.floor(Math.random() * 22) + 18;
  const now = new Date();
  const year = now.getFullYear() - age;
  const month = Math.floor(Math.random() * 12) + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = Math.floor(Math.random() * daysInMonth) + 1;
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
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
        className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <Globe className="w-3 h-3 shrink-0 text-muted-foreground" />
          {label
            ? <span className="truncate text-left">{label}</span>
            : <span className="text-muted-foreground">No proxy (direct)</span>}
        </span>
        <ChevronDown className={`ml-1.5 w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-lg max-h-52 overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => pick({ kind: "none" })}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent ${value.kind === "none" ? "text-primary font-medium bg-accent/40" : "text-foreground"}`}
          >
            <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
            No proxy (direct)
          </button>
          {proxies.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-muted-foreground text-center">No proxies saved in Proxy Manager.</p>
          )}
          {proxies.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick({ kind: "saved", id: p.id })}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent ${value.kind === "saved" && value.id === p.id ? "text-primary font-medium bg-accent/40" : "text-foreground"}`}
            >
              <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate text-left">{p.name ? p.name : `${p.host}:${p.port}`}</span>
            </button>
          ))}
          <div className="border-t border-border mt-1 pt-1">
            <button
              type="button"
              onClick={() => pick({ kind: "manual" })}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent ${value.kind === "manual" ? "text-primary font-medium bg-accent/40" : "text-cyan-600 dark:text-cyan-400"}`}
            >
              <Plus className="w-3 h-3 shrink-0" />
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

// ── Field action buttons (Type into browser + Copy to clipboard) ───────────────

function FieldActions({ value, isOpen }: { value: string; isOpen: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleType = () => {
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
        onClick={handleType}
        disabled={!isOpen || !value}
        title={isOpen ? "Type into active browser field" : "Open browser first"}
        className={cn(
          "flex items-center gap-1 px-1.5 h-7 rounded-md border border-input text-[10px] font-medium transition-colors",
          isOpen && value
            ? "bg-muted/50 text-muted-foreground hover:bg-cyan-50 hover:text-cyan-700 hover:border-cyan-400 dark:hover:bg-cyan-950/40"
            : "bg-muted/30 text-muted-foreground/40 cursor-not-allowed"
        )}
      >
        <ClipboardPaste className="w-2.5 h-2.5" />
        Type
      </button>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!value}
        title="Copy to clipboard"
        className={cn(
          "flex items-center gap-1 px-1.5 h-7 rounded-md border border-input bg-muted/50 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
          copied && "text-green-600 border-green-400"
        )}
      >
        <Copy className="w-2.5 h-2.5" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ── XY Range field (two 3-digit inputs with dash between) ─────────────────────

function XYField({
  min, max, onMin, onMax, label,
}: { min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void; label: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
      <div className="flex items-center gap-1">
        <Input
          value={min}
          onChange={e => onMin(e.target.value.replace(/\D/g, "").slice(0, 3))}
          placeholder="Min"
          className="h-7 text-xs w-16 text-center font-mono"
        />
        <span className="text-muted-foreground text-xs">–</span>
        <Input
          value={max}
          onChange={e => onMax(e.target.value.replace(/\D/g, "").slice(0, 3))}
          placeholder="Max"
          className="h-7 text-xs w-16 text-center font-mono"
        />
      </div>
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

  // ── localStorage persistence ────────────────────────────────────────────────
  const _LS_KEY = "ghost-browser-fields-v2";
  const _lsLoad = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(_LS_KEY) ?? "{}"); } catch { return {}; }
  };
  const _ls = _lsLoad();

  // Account fields
  const [usernameSpin, setUsernameSpin] = useState(() => _ls.usernameSpin ?? "");
  const [password, setPassword]         = useState(() => _ls.password ?? generatePassword());
  const [bioSpin, setBioSpin]           = useState(() => _ls.bioSpin ?? "");
  const [dob, setDob]                   = useState(() => _ls.dob ?? generateDob());

  // Email / IMAP fields
  const [emailAddr, setEmailAddr]   = useState(() => _ls.emailAddr   ?? "");
  const [emailPass, setEmailPass]   = useState(() => _ls.emailPass   ?? "");
  const [imapHost, setImapHost]     = useState(() => _ls.imapHost    ?? "");
  const [imapPort, setImapPort]     = useState(() => _ls.imapPort    ?? "993");
  const [imapSecure, setImapSecure] = useState(() => (_ls.imapSecure ?? "true") === "true");

  // Website warmup fields
  const [websitesToVisit, setWebsitesToVisit]       = useState(() => _ls.websitesToVisit ?? "");
  const [websitesMin, setWebsitesMin]               = useState(() => _ls.websitesMin ?? "1");
  const [websitesMax, setWebsitesMax]               = useState(() => _ls.websitesMax ?? "3");
  const [internalLinksMin, setInternalLinksMin]     = useState(() => _ls.internalLinksMin ?? "2");
  const [internalLinksMax, setInternalLinksMax]     = useState(() => _ls.internalLinksMax ?? "5");
  const [timeOnSiteMin, setTimeOnSiteMin]           = useState(() => _ls.timeOnSiteMin ?? "1");
  const [timeOnSiteMax, setTimeOnSiteMax]           = useState(() => _ls.timeOnSiteMax ?? "3");
  const [timeOnLinksMin, setTimeOnLinksMin]         = useState(() => _ls.timeOnLinksMin ?? "1");
  const [timeOnLinksMax, setTimeOnLinksMax]         = useState(() => _ls.timeOnLinksMax ?? "2");

  // Verification code
  const [manualCode, setManualCode]       = useState("");
  const [fetchingCode, setFetchingCode]   = useState(false);
  const [fetchCodeMsg, setFetchCodeMsg]   = useState("");
  const [codePending, setCodePending]     = useState(false);

  // Ghost fingerprint
  const [fingerprint, setFingerprint]                 = useState<GhostFingerprint>(() => generateGhostFingerprint());
  const [fingerprintExpanded, setFingerprintExpanded] = useState(false);

  // Signup automation
  const [signupRunning, setSignupRunning] = useState(false);
  const [signupStatus, setSignupStatus]   = useState("");
  const signupPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Add to Equinox
  const [addedToEquinox, setAddedToEquinox]   = useState(false);
  const [addingToEquinox, setAddingToEquinox] = useState(false);

  // Code-wait countdown
  const [codeWaitSecs, setCodeWaitSecs] = useState(0);
  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOpen = browserState === "open";
  const generatedUsername = usernameSpin.trim() ? resolveSpintax(usernameSpin) : "";

  // ── Persist form fields ────────────────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(_LS_KEY, JSON.stringify({
        usernameSpin, password, dob, bioSpin,
        emailAddr, emailPass, imapHost, imapPort,
        imapSecure: String(imapSecure),
        websitesToVisit, websitesMin, websitesMax,
        internalLinksMin, internalLinksMax,
        timeOnSiteMin, timeOnSiteMax,
        timeOnLinksMin, timeOnLinksMax,
      }));
    } catch {}
  }, [
    usernameSpin, password, dob, bioSpin,
    emailAddr, emailPass, imapHost, imapPort, imapSecure,
    websitesToVisit, websitesMin, websitesMax,
    internalLinksMin, internalLinksMax,
    timeOnSiteMin, timeOnSiteMax, timeOnLinksMin, timeOnLinksMax,
  ]);

  // ── Browser status check ───────────────────────────────────────────────────
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const [elData, statusData] = await Promise.all([
          fetch("/api/is-electron").then(r => r.json()).catch(() => ({ electron: false })),
          fetch("/api/signup/browser/status").then(r => r.json()).catch(() => ({ running: false })),
        ]);
        setIsNative(!!(elData as any).electron);
        setBrowserState(prev => {
          if ((statusData as any).running && prev === "closed") return "open";
          return prev;
        });
      } catch {}
    };
    checkStatus();
    const poll = setInterval(checkStatus, 5000);
    return () => clearInterval(poll);
  }, []);

  // Code-wait timer
  useEffect(() => {
    if (codePending && signupRunning) {
      setCodeWaitSecs(0);
      codeTimerRef.current = setInterval(() => setCodeWaitSecs(s => s + 1), 1000);
    } else {
      if (codeTimerRef.current) { clearInterval(codeTimerRef.current); codeTimerRef.current = null; }
      setCodeWaitSecs(0);
    }
    return () => { if (codeTimerRef.current) clearInterval(codeTimerRef.current); };
  }, [codePending, signupRunning]);

  // Poll signup status
  useEffect(() => {
    if (!signupRunning) {
      if (signupPollRef.current) { clearInterval(signupPollRef.current); signupPollRef.current = null; }
      return;
    }
    signupPollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/signup/browser/ghost-signup-status");
        const j = await r.json() as any;
        if (j.msg) {
          setSignupStatus(j.msg);
          // When the backend reaches step 4 (email verification), show the
          // code input UI.  This is the ONLY place codePending becomes true.
          if (j.msg.includes("Waiting for verification code")) setCodePending(true);
          // Remove any visited URL from the website list
          setWebsitesToVisit(prev => {
            const urls = prev.split("\n").map(s => s.trim()).filter(Boolean);
            const remaining = urls.filter(url => !j.msg.includes(url));
            if (remaining.length === urls.length) return prev;
            return remaining.join("\n");
          });
        }
        if (j.done) setSignupRunning(false);
      } catch {}
    }, 2000);
    return () => {
      if (signupPollRef.current) clearInterval(signupPollRef.current);
    };
  }, [signupRunning]);

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

  const firstWebsiteUrl = (): string | undefined => {
    const urls = websitesToVisit.split("\n").map(s => s.trim()).filter(s => s.startsWith("http"));
    return urls[0];
  };

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
        initialUrl: firstWebsiteUrl(),
      }),
    }).catch(() => {});
    setBrowserState("open");
  };

  const handleClose = async () => {
    await fetch("/api/signup/browser/close", { method: "POST" }).catch(() => {});
    setBrowserState("closed");
    setSignupRunning(false);
    setSignupStatus("");
  };

  const handleFresh = async () => {
    setBrowserState("resetting");
    await fetch("/api/signup/browser/close", { method: "POST" }).catch(() => {});
    await fetch("/api/signup/browser/reset", { method: "POST" }).catch(() => {});
    setSelectedUA(randomUA());
    setPassword(generatePassword());
    setDob(generateDob());
    setFingerprint(generateGhostFingerprint());
    setFetchCodeMsg("");
    setManualCode("");
    setSignupStatus("");
    setSignupRunning(false);
    setBrowserState("closed");
  };

  // IMAP: fetch verification code
  const handleFetchCode = async () => {
    if (!imapHost.trim() || !emailAddr.trim() || !emailPass.trim()) {
      setFetchCodeMsg("⚠ Fill in email address, email password, and IMAP host first.");
      return;
    }
    setFetchingCode(true);
    setFetchCodeMsg("Connecting to IMAP…");
    try {
      const r = await fetch("/api/imap/fetch-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: imapHost.trim(),
          port: parseInt(imapPort, 10) || 993,
          secure: imapSecure,
          email: emailAddr.trim(),
          password: emailPass.trim(),
        }),
      });
      const j = await r.json() as any;
      if (j.ok && j.code) {
        setManualCode(j.code);
        setFetchCodeMsg(`✅ Got code: ${j.code}`);
        await fetch("/api/signup/browser/ghost-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: j.code }),
        }).catch(() => {});
        setCodePending(false);
      } else {
        setFetchCodeMsg(`⚠ ${j.error ?? "No code found in recent emails"}`);
      }
    } catch (err: any) {
      setFetchCodeMsg(`⚠ ${err?.message ?? "IMAP error"}`);
    }
    setFetchingCode(false);
  };

  // Submit manual code
  const handleSubmitCode = async () => {
    if (!manualCode.trim()) return;
    await fetch("/api/signup/browser/ghost-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: manualCode.trim() }),
    }).catch(() => {});
    setFetchCodeMsg(`✅ Code ${manualCode.trim()} submitted to signup flow`);
    setCodePending(false);
  };

  // Create Account — visits websites first, then runs signup
  const handleCreateAccount = async () => {
    const uname = (generatedUsername || usernameSpin).trim();
    if (!uname || !password.trim() || !emailAddr.trim() || !dob.trim()) {
      setSignupStatus("⚠ Fill in username, password, email, and DOB before creating an account.");
      return;
    }

    if (!isOpen) {
      if (!manualValid) {
        setSignupStatus("⚠ Fix proxy settings before opening browser.");
        return;
      }
      setBrowserState("opening");
      setSignupStatus("Opening browser…");
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
          initialUrl: firstWebsiteUrl(),
        }),
      }).catch(() => {});
      setBrowserState("open");
      await new Promise(r => setTimeout(r, 1500));
    }

    setSignupRunning(true);
    setSignupStatus("Starting automated signup…");
    setCodePending(false);
    setFetchCodeMsg("");

    // Parse websites list
    const websiteUrls = websitesToVisit
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.startsWith("http"));

    try {
      const r = await fetch("/api/signup/browser/ghost-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailAddr.trim(),
          username: uname,
          password: password.trim(),
          dob: dob.trim(),
          websitesToVisit: websiteUrls,
          websitesMin: parseInt(websitesMin, 10) || 1,
          websitesMax: parseInt(websitesMax, 10) || 3,
          internalLinksMin: parseInt(internalLinksMin, 10) || 2,
          internalLinksMax: parseInt(internalLinksMax, 10) || 5,
          timeOnSiteMin: parseInt(timeOnSiteMin, 10) || 1,
          timeOnSiteMax: parseInt(timeOnSiteMax, 10) || 3,
          timeOnLinksMin: parseInt(timeOnLinksMin, 10) || 1,
          timeOnLinksMax: parseInt(timeOnLinksMax, 10) || 2,
        }),
      });
      const j = await r.json() as any;
      if (!j.ok) {
        setSignupStatus(`⚠ ${j.error ?? "Failed to start signup"}`);
        setSignupRunning(false);
      }
      // Do NOT set codePending here — the signup runs in the background.
      // codePending is set by the poll loop when the backend relay message
      // actually reaches "Waiting for verification code" (step 4 of signup).
    } catch (err: any) {
      setSignupStatus(`⚠ ${err?.message ?? "Error"}`);
      setSignupRunning(false);
    }
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
        body: JSON.stringify({
          username: uname,
          password: password.trim(),
          email: emailAddr.trim() || undefined,
          userAgent: activeUA.api,
          embeddedUserAgent: activeUA.embedded,
        }),
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

      {/* Body: settings left, phone right */}
      <div className="flex gap-3" style={{ height: "calc(100vh - 170px)" }}>

        {/* ── Left: Wide Controls Panel ── */}
        <div className="w-[840px] shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">

          {/* ── ROW 1: Proxy | Device Identity | Fingerprint ── */}
          <div className="grid grid-cols-3 gap-2">

            {/* Proxy */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Proxy</p>
              </div>
              <ProxySelect proxies={proxies as SavedProxy[]} value={proxySelection} onChange={setProxySelection} />
              {proxySelection.kind === "manual" && (
                <div className="space-y-1 pt-0.5">
                  <div className="flex gap-1">
                    <Input value={manualHost} onChange={e => setManualHost(e.target.value)} placeholder="host or IP" className="h-7 text-xs flex-1" />
                    <Input value={manualPort} onChange={e => setManualPort(e.target.value)} placeholder="port" className="h-7 text-xs w-14" />
                  </div>
                  <div className="flex gap-1">
                    <Input value={manualUser} onChange={e => setManualUser(e.target.value)} placeholder="user (opt)" className="h-7 text-xs flex-1" />
                    <Input value={manualPass} onChange={e => setManualPass(e.target.value)} placeholder="pass (opt)" className="h-7 text-xs flex-1" type="password" />
                  </div>
                </div>
              )}
              {isOpen && (
                <p className="text-[10px] text-muted-foreground">Active: <span className="font-mono">{activeProxyLabel}</span></p>
              )}
            </div>

            {/* Device Identity */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Device Identity</p>
              </div>
              <UaPickerDropdown value={selectedUA.api} onSelect={setSelectedUA} />
              {isOpen && (
                <p className="text-[10px] text-muted-foreground">Active: <span className="font-medium">{activeDeviceLabel}</span></p>
              )}
            </div>

            {/* Fingerprint */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fingerprint</p>
              </div>
              <button
                type="button"
                onClick={() => setFingerprintExpanded(e => !e)}
                className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-sm transition-colors hover:bg-accent/60"
              >
                <span className="text-xs text-muted-foreground">
                  {fingerprintExpanded ? "Hide details" : "Show details"}
                </span>
                {fingerprintExpanded
                  ? <ChevronUp className="w-3 h-3 text-muted-foreground" />
                  : <Plus className="w-3 h-3 text-muted-foreground" />}
              </button>
              {fingerprintExpanded && (
                <div className="space-y-1 pt-0.5 border-t border-border/50 mt-1.5">
                  {([
                    ["WebGL GPU",   `${fingerprint.webglRenderer}`],
                    ["Canvas Seed", String(fingerprint.canvasNoise)],
                    ["Audio Noise", fingerprint.audioNoise.toFixed(10)],
                    ["Font Seed",   `${fingerprint.fontSeed} / 99`],
                    ["Speech",      FP_SPEECH_PROFILES[fingerprint.speechProfile] ?? `Profile ${fingerprint.speechProfile}`],
                    ["Video Dev",   fingerprint.mediaVideoId.slice(0, 12) + "…"],
                    ["Audio In",    fingerprint.mediaAudioId.slice(0, 12) + "…"],
                    ["Speaker Out", fingerprint.mediaSpeakerId.slice(0, 12) + "…"],
                  ] as [string, string][]).map(([label, val]) => (
                    <div key={label} className="flex items-start justify-between gap-2 pt-0.5">
                      <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
                      <span className="text-[10px] font-mono text-foreground text-right break-all">{val}</span>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground/60 pt-1">Regenerates on Nuke Environment.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── ROW 2: Websites textarea only ── */}
          <div className="desktop-card p-2.5">
            <div className="flex items-center gap-1.5 mb-2">
              <Link className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Website Warm-Up (visits before signup)</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground font-medium">Websites to Visit</p>
              <textarea
                value={websitesToVisit}
                onChange={e => setWebsitesToVisit(e.target.value)}
                placeholder={"https://example.com\nhttps://another-site.com\nhttps://thirdsite.org"}
                rows={5}
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs font-mono placeholder:font-sans placeholder:text-muted-foreground shadow-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                spellCheck={false}
              />
              <p className="text-[10px] text-muted-foreground/70">One URL per line. Ghost Browser visits in random order before signup. First URL loads on open.</p>
            </div>
          </div>

          {/* ── ROW 3: All 4 XY range fields side by side ── */}
          <div className="desktop-card p-2.5">
            <div className="flex gap-4 flex-wrap">
              <XYField
                label="Websites to Visit"
                min={websitesMin} max={websitesMax}
                onMin={setWebsitesMin} onMax={setWebsitesMax}
              />
              <XYField
                label="Internal Links per Site"
                min={internalLinksMin} max={internalLinksMax}
                onMin={setInternalLinksMin} onMax={setInternalLinksMax}
              />
              <XYField
                label="Time Spent on Website (minutes)"
                min={timeOnSiteMin} max={timeOnSiteMax}
                onMin={setTimeOnSiteMin} onMax={setTimeOnSiteMax}
              />
              <XYField
                label="Spent Time on Internal Links (minutes)"
                min={timeOnLinksMin} max={timeOnLinksMax}
                onMin={setTimeOnLinksMin} onMax={setTimeOnLinksMax}
              />
            </div>
          </div>

          {/* ── ROW 4: Username | Password | DOB | Bio Spin ── */}
          <div className="desktop-card p-2.5">
            <div className="grid grid-cols-4 gap-2">

              {/* Username Spin */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Username Spin</p>
                <div className="flex gap-1">
                  <Input
                    value={usernameSpin}
                    onChange={e => setUsernameSpin(e.target.value)}
                    placeholder="{john|jane}.{smith}{1|23}"
                    className="h-7 text-xs font-mono placeholder:font-sans flex-1 min-w-0"
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
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    Spin
                  </button>
                </div>
                <div className="flex gap-1">
                  <Input
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="h-7 text-xs font-mono flex-1 min-w-0"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldActions value={password} isOpen={isOpen} />
                </div>
              </div>

              {/* DOB */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-2.5 h-2.5 text-cyan-500" />
                    <p className="text-[10px] text-muted-foreground font-medium">DOB (DD/MM/YYYY)</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDob(generateDob())}
                    className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    Spin
                  </button>
                </div>
                <Input
                  value={dob}
                  onChange={e => setDob(e.target.value)}
                  placeholder="DD/MM/YYYY"
                  className="h-7 text-xs font-mono placeholder:font-sans"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              {/* Bio Spin */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Bio Spin</p>
                <div className="flex gap-1">
                  <Input
                    value={bioSpin}
                    onChange={e => setBioSpin(e.target.value)}
                    placeholder="{Photographer|Artist} 📸"
                    className="h-7 text-xs font-mono placeholder:font-sans flex-1 min-w-0"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldActions value={bioSpin ? resolveSpintax(bioSpin) : ""} isOpen={isOpen} />
                </div>
              </div>
            </div>
          </div>

          {/* ── ROW 5: Email | Email Password | IMAP | Port ── */}
          <div className="desktop-card p-2.5">
            <div className="flex items-center gap-1.5 mb-2">
              <Mail className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Email / IMAP</p>
            </div>
            <div className="grid grid-cols-4 gap-2">

              {/* Email Address */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Email Address</p>
                <div className="flex gap-1">
                  <Input
                    value={emailAddr}
                    onChange={e => setEmailAddr(e.target.value)}
                    placeholder="user@example.com"
                    className="h-7 text-xs flex-1 min-w-0"
                    type="email"
                    autoComplete="off"
                  />
                  <FieldActions value={emailAddr} isOpen={isOpen} />
                </div>
              </div>

              {/* Email Password */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">Email Password</p>
                </div>
                <Input
                  value={emailPass}
                  onChange={e => setEmailPass(e.target.value)}
                  placeholder="Email account password"
                  className="h-7 text-xs font-mono placeholder:font-sans"
                  type="password"
                  autoComplete="off"
                />
              </div>

              {/* IMAP Host */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Server className="w-2.5 h-2.5 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">IMAP Host</p>
                </div>
                <Input
                  value={imapHost}
                  onChange={e => setImapHost(e.target.value)}
                  placeholder="imap.gmail.com"
                  className="h-7 text-xs flex-1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              {/* IMAP Port + TLS */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Port</p>
                <div className="flex gap-1">
                  <Input
                    value={imapPort}
                    onChange={e => setImapPort(e.target.value)}
                    placeholder="993"
                    className="h-7 text-xs flex-1"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setImapSecure(s => !s)}
                    title={imapSecure ? "TLS enabled" : "TLS disabled"}
                    className={cn(
                      "h-7 px-2 rounded-md border text-[10px] font-medium transition-colors shrink-0",
                      imapSecure
                        ? "border-green-400 text-green-700 bg-green-50 dark:bg-green-950/30"
                        : "border-border text-muted-foreground bg-muted/30"
                    )}
                  >
                    TLS
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── ROW 6: Verification Code | Submit Code | Fetch IMAP ── */}
          <div className="desktop-card p-2.5">
            <div className="flex items-center gap-1.5 mb-2">
              <Key className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Verification Code</p>
            </div>
            <div className="flex gap-2 items-end">
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Code (6-digit)</p>
                <Input
                  value={manualCode}
                  onChange={e => setManualCode(e.target.value)}
                  placeholder="000000"
                  className="h-7 text-xs font-mono w-28"
                  maxLength={8}
                  autoComplete="off"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] gap-1"
                onClick={handleSubmitCode}
                disabled={!manualCode.trim()}
              >
                <MessageSquare className="w-3 h-3" />
                Submit Code
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] gap-1 border-cyan-300 text-cyan-700 hover:bg-cyan-50 hover:border-cyan-400 dark:text-cyan-400"
                onClick={handleFetchCode}
                disabled={fetchingCode || !imapHost.trim() || !emailAddr.trim() || !emailPass.trim()}
              >
                {fetchingCode ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                Fetch IMAP
              </Button>
            </div>
            {fetchCodeMsg && (
              <p className={cn(
                "text-[10px] mt-1.5",
                fetchCodeMsg.startsWith("✅") ? "text-green-600" : "text-amber-600"
              )}>
                {fetchCodeMsg}
              </p>
            )}
            {codePending && signupRunning && codeWaitSecs > 0 && (
              <p className="text-[10px] text-cyan-600 mt-1">
                Waiting for verification code… {codeWaitSecs}s
              </p>
            )}
          </div>

          {/* ── ROW 7: CREATE ACCOUNT | ADD TO EQUINOX | NUKE ENVIRONMENT ── */}
          <div className="desktop-card p-2.5">
            <div className="flex gap-2 justify-start">

              {/* CREATE ACCOUNT */}
              <Button
                className={cn(
                  "gap-2 text-xs font-semibold tracking-wide uppercase w-[200px]",
                  signupRunning || browserState === "opening"
                    ? "bg-amber-500 hover:bg-amber-600 text-white border-0"
                    : "bg-cyan-500 hover:bg-cyan-600 text-white border-0"
                )}
                onClick={handleCreateAccount}
                disabled={signupRunning || browserState === "opening" || browserState === "resetting" || !usernameSpin.trim() || !password.trim() || !emailAddr.trim() || !dob.trim()}
              >
                {signupRunning
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Running…</>
                  : browserState === "opening"
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Opening…</>
                  : <><Ghost className="w-3.5 h-3.5" />Create Account</>}
              </Button>

              {/* ADD TO EQUINOX */}
              <Button
                variant="outline"
                className={cn(
                  "gap-2 text-xs font-semibold tracking-wide uppercase w-[200px]",
                  addedToEquinox
                    ? "border-green-400 text-green-700 bg-green-50 hover:bg-green-50"
                    : "border-cyan-300 text-cyan-700 hover:bg-cyan-50 hover:border-cyan-400 dark:text-cyan-400"
                )}
                onClick={handleAddToEquinox}
                disabled={addingToEquinox || !usernameSpin.trim() || !password.trim()}
              >
                {addingToEquinox
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Adding…</>
                  : addedToEquinox
                  ? <><CheckCircle2 className="w-3.5 h-3.5" />Added to Equinox!</>
                  : <><UserPlus className="w-3.5 h-3.5" />Add to Equinox</>}
              </Button>

              {/* NUKE ENVIRONMENT */}
              <Button
                variant="outline"
                className="gap-2 text-xs font-semibold tracking-wide uppercase border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-400 w-[200px]"
                onClick={handleFresh}
                disabled={browserState === "opening" || browserState === "resetting"}
              >
                {browserState === "resetting"
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Nuking…</>
                  : <><NukeIcon className="w-4 h-4" />Nuke Environment</>}
              </Button>
            </div>

          </div>

          {/* Signup status bar — below the action buttons */}
          {signupStatus && (
            <div className={cn(
              "rounded-md border px-3 py-2 text-xs leading-relaxed",
              signupStatus.startsWith("✅")
                ? "border-green-300 bg-green-50 text-green-700 dark:bg-green-950/30"
                : signupStatus.includes("⚠") || signupStatus.includes("error")
                ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30"
                : "border-cyan-200 bg-cyan-50/50 text-cyan-800 dark:bg-cyan-950/20"
            )}>
              {signupRunning && <Loader2 className="w-3 h-3 animate-spin inline mr-1.5" />}
              {signupStatus}
            </div>
          )}

        </div>

        {/* ── Right: Phone frame (absolute right of viewport) ── */}
        <div className="flex-1 min-w-0 flex flex-col items-end justify-center bg-muted/10 rounded-lg border border-border overflow-hidden">

          {isOpen && isNative ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8 w-full">
              <div className="w-20 h-20 rounded-3xl bg-green-50 dark:bg-green-950/40 flex items-center justify-center">
                <Monitor className="w-10 h-10 text-green-600" />
              </div>
              <div className="space-y-1.5 max-w-xs">
                <p className="text-base font-semibold text-foreground">Browser is open</p>
                <p className="text-sm text-muted-foreground">
                  The Ghost Browser is running as its own window on the right side of your screen.
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

          ) : !isOpen ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8 w-full">
              <div className="w-20 h-20 rounded-3xl bg-muted/60 flex items-center justify-center">
                <Ghost className="w-10 h-10 text-muted-foreground/50" />
              </div>
              <div className="space-y-1.5 max-w-xs">
                <p className="text-base font-semibold text-foreground">Browser not started</p>
                <p className="text-sm text-muted-foreground">
                  Fill in your account details, then click <span className="font-medium">Create Account</span> to launch the browser — it will visit your warm-up websites first, then run the signup automatically.
                </p>
              </div>
            </div>

          ) : (
            /* ── Phone shell (absolute right edge) ── */
            <div className="h-full flex items-center justify-end py-3 pr-2">
              {/* Phone body — Pixel 8 proportions */}
              <div
                className="relative flex-shrink-0"
                style={{ aspectRatio: "393/851", height: "calc(100% - 8px)", maxHeight: "100%" }}
              >
                {/* Outer bezel */}
                <div className="absolute inset-0 rounded-[2.2rem] bg-[#1c1c1e] shadow-2xl ring-1 ring-white/5" />

                {/* Power button */}
                <div className="absolute right-[-3px] top-[28%] h-[9%] w-[3px] rounded-r bg-[#2e2e30]" />
                {/* Volume up */}
                <div className="absolute left-[-3px] top-[22%] h-[6%] w-[3px] rounded-l bg-[#2e2e30]" />
                {/* Volume down */}
                <div className="absolute left-[-3px] top-[31%] h-[9%] w-[3px] rounded-l bg-[#2e2e30]" />

                {/* Inner screen */}
                <div className="absolute inset-[3%] rounded-[1.7rem] overflow-hidden bg-black flex flex-col">

                  {/* Android status bar */}
                  <div className="shrink-0 flex items-center justify-between px-4 bg-black text-white" style={{ height: "4%" }}>
                    <span className="text-[10px] font-semibold tabular-nums">
                      {new Date().getHours().toString().padStart(2,"0")}:{new Date().getMinutes().toString().padStart(2,"0")}
                    </span>
                    <div className="flex items-center gap-1">
                      <svg className="w-2.5 h-2.5 text-white fill-current" viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
                      <svg className="w-2.5 h-2.5 text-white fill-current" viewBox="0 0 24 24"><path d="M17 4h3v16h-3V4zM5 14h3v6H5v-6zm6-5h3v11h-3V9z"/></svg>
                      <svg className="w-3 h-2.5 text-white fill-current" viewBox="0 0 24 16"><rect x="0" y="2" width="20" height="12" rx="2" ry="2" stroke="currentColor" strokeWidth="1.5" fill="none"/><rect x="20" y="5" width="3" height="6" rx="1" fill="currentColor"/><rect x="1.5" y="3.5" width="14" height="9" rx="1" fill="currentColor"/></svg>
                    </div>
                  </div>

                  {/* Camera punch-hole */}
                  <div className="shrink-0 flex justify-center bg-black" style={{ height: "2.5%" }}>
                    <div className="w-3 h-3 rounded-full bg-[#111] border border-[#2a2a2a] self-center" />
                  </div>

                  {/* Browser stream */}
                  <div className="flex-1 overflow-hidden min-h-0">
                    <BrowserPanel
                      profileId={0}
                      userAgent={activeUA.embedded}
                      username="ghost"
                      streamUrl="/api/signup/browser/stream"
                      inputUrl="/api/signup/browser/input"
                      forceStream={true}
                      browserWidth={393}
                      browserHeight={851}
                      noToolbar={true}
                    />
                  </div>

                  {/* Home indicator */}
                  <div className="shrink-0 flex justify-center items-center bg-black" style={{ height: "2.5%" }}>
                    <div className="w-[32%] h-[3px] rounded-full bg-white/30" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
