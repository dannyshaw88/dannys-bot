import { useState, useRef, useCallback, useEffect } from "react";
import { UaPickerDropdown, type UaEntry } from "@/components/ui/ua-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import {
  Ghost, ShieldCheck, Globe, Cpu,
  Loader2, ChevronDown, ChevronUp, Wifi, WifiOff, Plus,
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

export interface SavedProxy {
  id: number;
  name: string | null;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  proxyType?: string | null;
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

export type BrowserState = "closed" | "opening" | "open" | "resetting";

export function StatusChip({ state }: { state: BrowserState }) {
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

// ── Field action buttons ────────────────────────────────────────────────────────

function FieldActions({ value, isOpen, onType }: { value: string; isOpen: boolean; onType: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex gap-1 shrink-0">
      <button
        type="button"
        onClick={onType}
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

// ── XY Range field ─────────────────────────────────────────────────────────────

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

// ── Main Panel ─────────────────────────────────────────────────────────────────

// ── Step progress estimator ────────────────────────────────────────────────────
// Estimates 0-100% done for the active step from server relay log lines.
// Returns null when there is not enough data yet to show a number.

function calcStepProgress(
  log: string[],
  stepName: string,
  settings: {
    websitesMin: number; websitesMax: number; websitesCount: number;
    youtubeMin: number; youtubeMax: number;
  },
): number | null {
  if (log.length === 0) return null;
  const joined = "\n" + log.join("\n") + "\n";

  if (stepName === "Visiting Sites") {
    if (joined.includes("✅ Website warm-up complete")) return 100;
    // The server relay emits the actual site count it picked — use that as the total.
    const startMatch = joined.match(/Warm-up: visiting (\d+) website/);
    const total = startMatch
      ? parseInt(startMatch[1], 10)
      : Math.max(1, Math.ceil((settings.websitesMin + settings.websitesMax) / 2));
    const done = log.filter(l => l.includes("🌐 Warm-up: navigating to")).length;
    if (done === 0 || total === 0) return null;
    return Math.min(99, Math.round((done / total) * 100));
  }

  if (stepName === "YouTube Warm-up") {
    if (joined.includes("✅ YouTube warm-up complete")) return 100;
    // Server emits "watching video X/N" — parse the most recent occurrence.
    const all = [...joined.matchAll(/watching video (\d+)\/(\d+)/g)];
    if (all.length > 0) {
      const last = all[all.length - 1];
      const cur = parseInt(last[1], 10);
      const total = parseInt(last[2], 10);
      if (total > 0) return Math.min(99, Math.round((cur / total) * 100));
    }
    // Fallback before the per-video line appears: count "watching video" starts.
    const done = log.filter(l => l.includes("📺 YouTube warm-up: watching video ")).length;
    if (done === 0) return null;
    const total = Math.max(1, Math.ceil((settings.youtubeMin + settings.youtubeMax) / 2));
    return Math.min(99, Math.round((done / total) * 100));
  }

  if (stepName === "Instagram Signup") {
    if (joined.includes("✅ Signup flow complete")) return 100;
    // Fixed ordered list of milestone strings the server relays — in chronological order.
    const milestones = [
      "[mobile-setup]",
      "Navigating to https://www.instagram.com/",
      "Checking for cookie banner",
      "[step2]",
      "Waiting for verification code",
      "[step2] Tapping",
      "Typing DOB",
      "Typing name",
      "Typing username",
    ];
    const reached = milestones.filter(m => joined.includes(m)).length;
    if (reached === 0) return null;
    return Math.min(99, Math.round((reached / milestones.length) * 100));
  }

  return null;
}

interface GhostBrowserPanelProps {
  slot: number;
  proxies: SavedProxy[];
}

export function GhostBrowserPanel({ slot, proxies }: GhostBrowserPanelProps) {
  // Each slot has its own localStorage namespace so tabs don't share field data
  const _LS_KEY = `ghost-browser-fields-v2-s${slot}`;
  const _lsLoad = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(_LS_KEY) ?? "{}"); } catch { return {}; }
  };
  const _ls = _lsLoad();

  // Proxy
  const [proxySelection, setProxySelection] = useState<ProxySelection>(() => {
    try {
      const raw = _ls.proxySelection;
      if (raw) {
        const parsed = JSON.parse(raw) as ProxySelection;
        if (parsed && (parsed.kind === "none" || parsed.kind === "manual" || parsed.kind === "saved")) return parsed;
      }
    } catch {}
    return { kind: "none" };
  });
  const [manualHost, setManualHost]         = useState(() => _ls.manualHost ?? "");
  const [manualPort, setManualPort]         = useState(() => _ls.manualPort ?? "");
  const [manualUser, setManualUser]         = useState(() => _ls.manualUser ?? "");
  const [manualPass, setManualPass]         = useState(() => _ls.manualPass ?? "");

  // Device
  const [selectedUA, setSelectedUA] = useState<UaEntry>(() => randomUA());
  const [activeUA, setActiveUA]     = useState<UaEntry>(selectedUA);

  // Browser
  const [browserState, setBrowserState]         = useState<BrowserState>("closed");
  const [activeProxyLabel, setActiveProxyLabel] = useState<string>("");

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

  // YouTube warm-up fields
  const [youtubeVideosMin, setYoutubeVideosMin]     = useState(() => _ls.youtubeVideosMin ?? "1");
  const [youtubeVideosMax, setYoutubeVideosMax]     = useState(() => _ls.youtubeVideosMax ?? "3");
  const [youtubeWatchMin, setYoutubeWatchMin]       = useState(() => _ls.youtubeWatchMin ?? "2");
  const [youtubeWatchMax, setYoutubeWatchMax]       = useState(() => _ls.youtubeWatchMax ?? "5");
  const [skipWarmup, setSkipWarmup]                 = useState(() => (_ls.skipWarmup ?? "false") === "true");
  const [skipYoutubePercentMin, setSkipYoutubePercentMin] = useState(() => _ls.skipYoutubePercentMin ?? "0");
  const [skipYoutubePercentMax, setSkipYoutubePercentMax] = useState(() => _ls.skipYoutubePercentMax ?? "0");

  // Scheduler fields
  const [runEveryMin, setRunEveryMin]             = useState(() => _ls.runEveryMin ?? "5");
  const [runEveryMax, setRunEveryMax]             = useState(() => _ls.runEveryMax ?? "10");
  const [execAfterRunsMin, setExecAfterRunsMin]   = useState(() => _ls.execAfterRunsMin ?? "5");
  const [execAfterRunsMax, setExecAfterRunsMax]   = useState(() => _ls.execAfterRunsMax ?? "10");

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
  const [signupLog, setSignupLog]         = useState<string[]>([]);
  const signupPollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const signupLogRef     = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const imapAutoPollRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Add to Equinox
  const [addedToEquinox, setAddedToEquinox]   = useState(false);
  const [addingToEquinox, setAddingToEquinox] = useState(false);

  // Code-wait countdown
  const [codeWaitSecs, setCodeWaitSecs] = useState(0);
  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOpen = browserState === "open";
  const generatedUsername = usernameSpin.trim() ? resolveSpintax(usernameSpin) : "";

  // ── Persist form fields ───────────────────────────────────────────────────────
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
        youtubeVideosMin, youtubeVideosMax,
        youtubeWatchMin, youtubeWatchMax,
        skipWarmup: String(skipWarmup),
        skipYoutubePercentMin, skipYoutubePercentMax,
        runEveryMin, runEveryMax,
        execAfterRunsMin, execAfterRunsMax,
        proxySelection: JSON.stringify(proxySelection),
        manualHost, manualPort, manualUser, manualPass,
      }));
    } catch {}
  }, [
    usernameSpin, password, dob, bioSpin,
    emailAddr, emailPass, imapHost, imapPort, imapSecure,
    websitesToVisit, websitesMin, websitesMax,
    internalLinksMin, internalLinksMax,
    timeOnSiteMin, timeOnSiteMax, timeOnLinksMin, timeOnLinksMax,
    youtubeVideosMin, youtubeVideosMax, youtubeWatchMin, youtubeWatchMax,
    skipWarmup, skipYoutubePercentMin, skipYoutubePercentMax,
    runEveryMin, runEveryMax, execAfterRunsMin, execAfterRunsMax,
    proxySelection, manualHost, manualPort, manualUser, manualPass,
  ]);

  // ── Browser status check ──────────────────────────────────────────────────────
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const statusData = await fetch(`/api/signup/browser/status?slot=${slot}`).then(r => r.json()).catch(() => ({ running: false }));
        setBrowserState(prev => {
          if ((statusData as any).running && prev === "closed") return "open";
          return prev;
        });
      } catch {}
    };
    checkStatus();
    const poll = setInterval(checkStatus, 5000);
    return () => clearInterval(poll);
  }, [slot]);

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

  // Auto-IMAP: when signup is waiting for a code and IMAP creds are filled, poll automatically
  useEffect(() => {
    const hasImap = imapHost.trim() && emailAddr.trim() && emailPass.trim();
    if (codePending && signupRunning && hasImap) {
      const doPoll = async () => {
        setFetchCodeMsg("Checking IMAP for verification code…");
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
            setFetchCodeMsg(`✅ Auto-fetched: ${j.code} — submitting…`);
            await fetch("/api/signup/browser/ghost-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: j.code, slot }),
            }).catch(() => {});
            setCodePending(false);
            if (imapAutoPollRef.current) { clearInterval(imapAutoPollRef.current); imapAutoPollRef.current = null; }
          } else {
            setFetchCodeMsg(`No code yet — retrying every 12s… (${j.error ?? "not found"})`);
          }
        } catch (err: any) {
          setFetchCodeMsg(`IMAP check failed: ${err?.message ?? "error"} — retrying…`);
        }
      };
      doPoll(); // immediate first attempt
      imapAutoPollRef.current = setInterval(doPoll, 12_000);
    } else {
      if (imapAutoPollRef.current) { clearInterval(imapAutoPollRef.current); imapAutoPollRef.current = null; }
    }
    return () => { if (imapAutoPollRef.current) { clearInterval(imapAutoPollRef.current); imapAutoPollRef.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codePending, signupRunning, imapHost, emailAddr, emailPass, imapPort, imapSecure, slot]);

  // On mount: check if a signup is already running for this slot (user may have navigated away).
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/signup/browser/ghost-signup-status?slot=${slot}`);
        const j = await r.json() as any;
        if (j.running && !j.done) {
          if (Array.isArray(j.log) && j.log.length > 0) setSignupLog(j.log);
          if (j.msg) setSignupStatus(j.msg);
          if (j.msg?.includes("Waiting for verification code")) setCodePending(true);
          setSignupRunning(true);
        }
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  // Auto-scroll signup log to bottom whenever it grows (only if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrolledUpRef.current && signupLogRef.current) {
      signupLogRef.current.scrollTop = signupLogRef.current.scrollHeight;
    }
  }, [signupLog]);

  const handleLogScroll = useCallback(() => {
    const el = signupLogRef.current;
    if (!el) return;
    const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 20;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // Poll signup status
  useEffect(() => {
    if (!signupRunning) {
      if (signupPollRef.current) { clearInterval(signupPollRef.current); signupPollRef.current = null; }
      return;
    }
    signupPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/signup/browser/ghost-signup-status?slot=${slot}`);
        const j = await r.json() as any;
        if (Array.isArray(j.log)) setSignupLog(j.log);
        if (j.msg) {
          setSignupStatus(j.msg);
          if (j.msg.includes("Waiting for verification code")) setCodePending(true);
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
  }, [signupRunning, slot]);

  const resolvedProxy = (() => {
    if (proxySelection.kind === "saved") {
      const p = proxies.find(x => x.id === proxySelection.id);
      if (p) return { host: p.host, port: p.port, username: p.username ?? undefined, password: p.password ?? undefined, proxyType: p.proxyType ?? "http" };
    }
    if (proxySelection.kind === "manual") {
      const host = manualHost.trim();
      const port = parseInt(manualPort, 10);
      if (host && port > 0 && port <= 65535) {
        return { host, port, username: manualUser.trim() || undefined, password: manualPass.trim() || undefined, proxyType: "http" };
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

  const typeIntoField = (text: string) => {
    fetch(`/api/signup/browser/input?slot=${slot}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fill", text }),
    }).catch(() => {});
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
        slot,
        userAgent: selectedUA.api,
        proxyHost: resolvedProxy?.host,
        proxyPort: resolvedProxy?.port,
        proxyUsername: resolvedProxy?.username,
        proxyPassword: resolvedProxy?.password,
        proxyType: resolvedProxy?.proxyType,
        fingerprint,
        initialUrl: firstWebsiteUrl(),
      }),
    }).catch(() => {});
    setBrowserState("open");
  };

  const handleClose = async () => {
    await fetch(`/api/signup/browser/close?slot=${slot}`, { method: "POST" }).catch(() => {});
    setBrowserState("closed");
    setSignupRunning(false);
    setSignupStatus("");
  };

  const handleFresh = async () => {
    setBrowserState("resetting");
    await fetch(`/api/signup/browser/close?slot=${slot}`, { method: "POST" }).catch(() => {});
    await fetch(`/api/signup/browser/reset?slot=${slot}`, { method: "POST" }).catch(() => {});
    setSelectedUA(randomUA());
    setPassword(generatePassword());
    setDob(generateDob());
    setFingerprint(generateGhostFingerprint());
    setFetchCodeMsg("");
    setManualCode("");
    setSignupStatus("");
    setSignupRunning(false);
    setSignupLog([]);
    userScrolledUpRef.current = false;
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
          body: JSON.stringify({ code: j.code, slot }),
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
      body: JSON.stringify({ code: manualCode.trim(), slot }),
    }).catch(() => {});
    setFetchCodeMsg(`✅ Code ${manualCode.trim()} submitted to signup flow`);
    setCodePending(false);
  };

  // Stop a running signup
  const handleStopSignup = async () => {
    try {
      await fetch("/api/signup/browser/ghost-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
    } catch {}
    if (imapAutoPollRef.current) { clearInterval(imapAutoPollRef.current); imapAutoPollRef.current = null; }
    setSignupRunning(false);
    setCodePending(false);
    setFetchCodeMsg("");
    setSignupStatus("🛑 Stopped by user.");
    setSignupLog(prev => [...prev, "🛑 Stopped by user."]);
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
      try {
        await fetch("/api/signup/browser/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slot,
            userAgent: selectedUA.api,
            proxyHost: resolvedProxy?.host,
            proxyPort: resolvedProxy?.port,
            proxyUsername: resolvedProxy?.username,
            proxyPassword: resolvedProxy?.password,
            proxyType: resolvedProxy?.proxyType,
            fingerprint,
            initialUrl: firstWebsiteUrl(),
          }),
        });
      } catch {
        // IPC error opening browser — do not proceed
        setSignupStatus("⚠ Failed to open browser (IPC error). Try again.");
        setBrowserState("closed");
        return;
      }
      setBrowserState("open");
      // Give Electron enough time to register the browser in its EB map before
      // calling ghost-signup. A 1.5 s delay was too short when browser setup
      // took 3+ seconds — the IPC call would return { ok: false } immediately.
      await new Promise(r => setTimeout(r, 3000));
    }

    setSignupRunning(true);
    setSignupStatus("Starting automated signup…");
    setCodePending(false);
    setFetchCodeMsg("");

    const websiteUrls = websitesToVisit
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.startsWith("http"));

    const signupPayload = {
      slot,
      email: emailAddr.trim(),
      username: uname,
      password: password.trim(),
      dob: dob.trim(),
      skipWarmup,
      websitesToVisit: skipWarmup ? [] : websiteUrls,
      websitesMin: skipWarmup ? 0 : (parseInt(websitesMin, 10) || 1),
      websitesMax: skipWarmup ? 0 : (parseInt(websitesMax, 10) || 3),
      internalLinksMin: skipWarmup ? 0 : (parseInt(internalLinksMin, 10) || 2),
      internalLinksMax: skipWarmup ? 0 : (parseInt(internalLinksMax, 10) || 5),
      timeOnSiteMin: skipWarmup ? 0 : (parseInt(timeOnSiteMin, 10) || 1),
      timeOnSiteMax: skipWarmup ? 0 : (parseInt(timeOnSiteMax, 10) || 3),
      timeOnLinksMin: skipWarmup ? 0 : (parseInt(timeOnLinksMin, 10) || 1),
      timeOnLinksMax: skipWarmup ? 0 : (parseInt(timeOnLinksMax, 10) || 2),
      youtubeVideosMin: skipWarmup ? 0 : (parseInt(youtubeVideosMin, 10) || 1),
      youtubeVideosMax: skipWarmup ? 0 : (parseInt(youtubeVideosMax, 10) || 3),
      youtubeWatchMin: skipWarmup ? 0 : (parseInt(youtubeWatchMin, 10) || 2),
      youtubeWatchMax: skipWarmup ? 0 : (parseInt(youtubeWatchMax, 10) || 5),
    };

    try {
      const r = await fetch("/api/signup/browser/ghost-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signupPayload),
      });
      const j = await r.json() as any;
      if (!j.ok) {
        // "Not open" means the browser didn't register in time — wait and retry once
        if (typeof j.error === "string" && j.error.toLowerCase().includes("not open")) {
          setSignupStatus("Browser registering… retrying in 3 s");
          await new Promise(r => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/signup/browser/ghost-signup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(signupPayload),
            });
            const j2 = await r2.json() as any;
            if (!j2.ok) {
              setSignupStatus(`⚠ ${j2.error ?? "Failed to start signup after retry"}`);
              setSignupRunning(false);
            }
          } catch (err2: any) {
            setSignupStatus(`⚠ ${err2?.message ?? "Error on retry"}`);
            setSignupRunning(false);
          }
        } else {
          setSignupStatus(`⚠ ${j.error ?? "Failed to start signup"}`);
          setSignupRunning(false);
        }
      }
    } catch (err: any) {
      setSignupStatus(`⚠ ${err?.message ?? "Error"}`);
      setSignupRunning(false);
    }
  };

  // Add to Equinox — sends all session data (cookies, proxy, UA, DOB, fingerprint)
  const handleAddToEquinox = async () => {
    const uname = (generatedUsername || usernameSpin).trim();
    if (!uname || !password.trim()) return;
    setAddingToEquinox(true);
    try {
      // Fetch cookies harvested from the ghost browser session at signup completion
      let igApiCookies: string | undefined;
      try {
        const cr = await fetch(`/api/signup/browser/ghost-cookies?slot=${slot}`);
        const cj = await cr.json() as any;
        if (cj.cookies && typeof cj.cookies === "string" && cj.cookies.includes("sessionid=")) {
          igApiCookies = cj.cookies;
        }
      } catch {}

      // Build proxy fields — prefer proxyId for saved proxies so Equinox links to the proxy manager entry
      const proxyFields: Record<string, any> = {};
      if (proxySelection.kind === "saved") {
        proxyFields.proxyId = proxySelection.id;
      } else if (proxySelection.kind === "manual" && resolvedProxy) {
        proxyFields.proxyHost     = resolvedProxy.host;
        proxyFields.proxyPort     = resolvedProxy.port;
        proxyFields.proxyUsername = resolvedProxy.username;
        proxyFields.proxyPassword = resolvedProxy.password;
      }

      const r = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username:                 uname,
          password:                 password.trim(),
          email:                    emailAddr.trim() || undefined,
          // Correct field names that match the DB schema
          userAgentApi:             activeUA.api,
          userAgentEmbedded:        activeUA.embedded,
          // DOB, fingerprint, IMAP email validation
          dateOfBirth:              dob.trim() || undefined,
          ebFingerprint:            JSON.stringify(fingerprint),
          emailValidationUsername:  emailAddr.trim() || undefined,
          emailValidationPassword:  emailPass.trim() || undefined,
          emailValidationPop3Server: imapHost.trim() || undefined,
          emailValidationPort:      imapPort.trim() || undefined,
          // Session cookies from ghost browser (if signup completed)
          igApiCookies:             igApiCookies,
          ...proxyFields,
        }),
      });
      if (r.ok || r.status === 201 || r.status === 200) {
        setAddedToEquinox(true);
        setTimeout(() => setAddedToEquinox(false), 3000);
      }
    } catch {}
    setAddingToEquinox(false);
  };

  const activeDeviceLabel = parseDeviceLabel(activeUA.api);

  return (
    <>
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

      {/* Body: settings left, placeholder box right */}
      <div className="flex gap-3" style={{ height: "calc(100vh - 196px)" }}>

        {/* ── Left: Controls Panel ── */}
        <div className="w-[840px] shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">

          {/* ── ROW 1: Proxy | Device Identity | Fingerprint ── */}
          <div className="grid grid-cols-3 gap-2">

            {/* Proxy */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Proxy</p>
              </div>
              <ProxySelect proxies={proxies} value={proxySelection} onChange={setProxySelection} />
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
            </div>

            {/* Device Identity */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Device Identity</p>
              </div>
              <UaPickerDropdown value={selectedUA.api} onSelect={setSelectedUA} />
            </div>

            {/* Fingerprint */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fingerprint</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setFingerprint(generateGhostFingerprint())}
                    className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    Spin
                  </button>
                  <button
                    type="button"
                    onClick={() => setFingerprintExpanded(v => !v)}
                    className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1"
                  >
                    {fingerprintExpanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground truncate" title={fingerprint.webglRenderer}>
                GPU: {fingerprint.webglRenderer}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Canvas noise: {fingerprint.canvasNoise} · Font seed: {fingerprint.fontSeed}
              </p>
              {fingerprintExpanded && (
                <div className="space-y-0.5 text-[10px] text-muted-foreground border-t border-border pt-1.5 mt-1">
                  <p>Audio noise: {fingerprint.audioNoise}</p>
                  <p>Speech: {FP_SPEECH_PROFILES[fingerprint.speechProfile]}</p>
                  <p className="font-mono text-[9px]">Video ID: {fingerprint.mediaVideoId}</p>
                  <p className="font-mono text-[9px]">Audio ID: {fingerprint.mediaAudioId}</p>
                </div>
              )}
            </div>
          </div>

          {/* ── ROW 1b: Scheduler ── */}
          <div className="desktop-card p-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-cyan-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">Scheduler</p>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipWarmup}
                  onChange={e => setSkipWarmup(e.target.checked)}
                  className="w-3.5 h-3.5 accent-cyan-500 shrink-0"
                />
                <span className="text-[10px] font-medium text-muted-foreground">Skip Warmup</span>
              </label>
            </div>
            <div className="flex gap-4 flex-wrap items-center">
              <XYField label="Run Every (minutes)" min={runEveryMin} max={runEveryMax} onMin={setRunEveryMin} onMax={setRunEveryMax} />
              <XYField label="Execute Signup After (runs)" min={execAfterRunsMin} max={execAfterRunsMax} onMin={setExecAfterRunsMin} onMax={setExecAfterRunsMax} />
            </div>
          </div>

          {!skipWarmup && (
            <>
          {/* ── ROW 2: Website warm-up URL list ── */}
          <div className="desktop-card p-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Warm-up Websites</p>
            </div>
            <textarea
              rows={5}
              className="flex w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
              placeholder={"https://example.com\nhttps://news.ycombinator.com"}
              value={websitesToVisit}
              onChange={e => setWebsitesToVisit(e.target.value)}
              spellCheck={false}
            />
          </div>

          {/* ── ROW 3: Website warm-up XY fields ── */}
          <div className="desktop-card p-2.5">
            <div className="flex gap-4 flex-wrap">
              <XYField label="Websites to Visit" min={websitesMin} max={websitesMax} onMin={setWebsitesMin} onMax={setWebsitesMax} />
              <XYField label="Internal Links per Site" min={internalLinksMin} max={internalLinksMax} onMin={setInternalLinksMin} onMax={setInternalLinksMax} />
              <XYField label="Time Spent on Website (minutes)" min={timeOnSiteMin} max={timeOnSiteMax} onMin={setTimeOnSiteMin} onMax={setTimeOnSiteMax} />
              <XYField label="Spent Time on Internal Links (minutes)" min={timeOnLinksMin} max={timeOnLinksMax} onMin={setTimeOnLinksMin} onMax={setTimeOnLinksMax} />
            </div>
          </div>

          {/* ── ROW 3b: YouTube warm-up ── */}
          <div className="desktop-card p-2.5 flex items-center">
            <div className="flex gap-4 flex-wrap items-center w-full">
              <div className="flex items-center gap-1.5 shrink-0 self-center">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#FF0000" }}>
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                </svg>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">YouTube Warm-Up</p>
              </div>
              <XYField label="Videos to Watch" min={youtubeVideosMin} max={youtubeVideosMax} onMin={setYoutubeVideosMin} onMax={setYoutubeVideosMax} />
              <XYField label="Minutes per Video" min={youtubeWatchMin} max={youtubeWatchMax} onMin={setYoutubeWatchMin} onMax={setYoutubeWatchMax} />
              <XYField label="Skip YouTube %" min={skipYoutubePercentMin} max={skipYoutubePercentMax} onMin={setSkipYoutubePercentMin} onMax={setSkipYoutubePercentMax} />
            </div>
          </div>
            </>
          )}

          {/* ── ROW 4: Username | Password | DOB | Bio Spin ── */}
          <div className="desktop-card p-2.5">
            <div className="grid grid-cols-2 gap-2">

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
                  <FieldActions value={generatedUsername || resolveSpintax(usernameSpin || "user")} isOpen={isOpen} onType={() => typeIntoField(generatedUsername || resolveSpintax(usernameSpin || "user"))} />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground font-medium">Password</p>
                  <button type="button" onClick={() => setPassword(generatePassword())} className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                    <RefreshCw className="w-2.5 h-2.5" />
                    Spin
                  </button>
                </div>
                <div className="flex gap-1">
                  <Input value={password} onChange={e => setPassword(e.target.value)} className="h-7 text-xs font-mono flex-1 min-w-0" spellCheck={false} autoComplete="off" />
                  <FieldActions value={password} isOpen={isOpen} onType={() => typeIntoField(password)} />
                </div>
              </div>

              {/* DOB */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-2.5 h-2.5 text-cyan-500" />
                    <p className="text-[10px] text-muted-foreground font-medium">DOB (DD/MM/YYYY)</p>
                  </div>
                  <button type="button" onClick={() => setDob(generateDob())} className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                    <RefreshCw className="w-2.5 h-2.5" />
                    Spin
                  </button>
                </div>
                <Input value={dob} onChange={e => setDob(e.target.value)} placeholder="DD/MM/YYYY" className="h-7 text-xs font-mono placeholder:font-sans" spellCheck={false} autoComplete="off" />
              </div>

              {/* Bio Spin */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Bio Spin</p>
                <div className="flex gap-1">
                  <Input value={bioSpin} onChange={e => setBioSpin(e.target.value)} placeholder="{Photographer|Artist} 📸" className="h-7 text-xs font-mono placeholder:font-sans flex-1 min-w-0" spellCheck={false} autoComplete="off" />
                  <FieldActions value={bioSpin ? resolveSpintax(bioSpin) : ""} isOpen={isOpen} onType={() => typeIntoField(bioSpin ? resolveSpintax(bioSpin) : "")} />
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
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Email Address</p>
                <div className="flex gap-1">
                  <Input value={emailAddr} onChange={e => setEmailAddr(e.target.value)} placeholder="user@example.com" className="h-7 text-xs flex-1 min-w-0" type="email" autoComplete="off" />
                  <FieldActions value={emailAddr} isOpen={isOpen} onType={() => typeIntoField(emailAddr)} />
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">Email Password</p>
                </div>
                <Input value={emailPass} onChange={e => setEmailPass(e.target.value)} placeholder="Email account password" className="h-7 text-xs font-mono placeholder:font-sans" type="password" autoComplete="off" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Server className="w-2.5 h-2.5 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">IMAP Host</p>
                </div>
                <Input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="imap.gmail.com" className="h-7 text-xs flex-1" spellCheck={false} autoComplete="off" />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Port</p>
                <div className="flex gap-1">
                  <Input value={imapPort} onChange={e => setImapPort(e.target.value)} placeholder="993" className="h-7 text-xs flex-1" autoComplete="off" />
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

          {/* ── ROW 6: Verification Code ── */}
          <div className="desktop-card p-2.5">
            <div className="flex gap-2 items-end">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Verification Code</p>
                </div>
                <Input value={manualCode} onChange={e => setManualCode(e.target.value)} placeholder="000000" className="h-7 text-xs font-mono w-28" maxLength={8} autoComplete="off" />
              </div>
              <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={handleSubmitCode} disabled={!manualCode.trim()}>
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
              {fetchCodeMsg && (
                <span className={cn("text-[10px] ml-1", fetchCodeMsg.startsWith("✅") ? "text-green-600" : "text-amber-600")}>
                  {fetchCodeMsg}
                </span>
              )}
            </div>
            {codePending && signupRunning && codeWaitSecs > 0 && (
              <p className="text-[10px] text-cyan-600 mt-1">Waiting for verification code… {codeWaitSecs}s</p>
            )}
          </div>

          {/* ── ROW 7: Action Buttons ── */}
          <div className="desktop-card p-2.5">
            <div className="flex gap-2 justify-start">
              <Button
                className={cn(
                  "gap-2 text-xs font-semibold tracking-wide uppercase w-[200px]",
                  signupRunning
                    ? "bg-red-500 hover:bg-red-600 text-white border-0"
                    : browserState === "opening"
                    ? "bg-amber-500 hover:bg-amber-600 text-white border-0"
                    : "bg-cyan-500 hover:bg-cyan-600 text-white border-0"
                )}
                onClick={signupRunning ? handleStopSignup : handleCreateAccount}
                disabled={browserState === "opening" || browserState === "resetting" || (!signupRunning && (!usernameSpin.trim() || !password.trim() || !emailAddr.trim() || !dob.trim()))}
              >
                {signupRunning
                  ? <><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</>
                  : browserState === "opening"
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Opening…</>
                  : <><Ghost className="w-3.5 h-3.5" />Create Account</>}
              </Button>

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

          {/* Signup log — always visible when running, or when there are entries */}
          {(signupRunning || signupLog.length > 0) && (() => {
            const steps = skipWarmup
              ? ["Instagram Signup"]
              : ["Visiting Sites", "YouTube Warm-up", "Instagram Signup"];
            const s = signupStatus.toLowerCase();
            const cur = skipWarmup ? 0
              : s.includes("youtube") ? 1
              : (s.includes("instagram") || s.includes("signup") || s.includes("creating") || s.includes("registration")) ? 2
              : 0;
            const websitesCount = websitesToVisit.split("\n").filter(u => u.trim().startsWith("http")).length;
            const progressSettings = {
              websitesMin: parseInt(websitesMin, 10) || 1,
              websitesMax: parseInt(websitesMax, 10) || 3,
              websitesCount,
              youtubeMin: parseInt(youtubeVideosMin, 10) || 0,
              youtubeMax: parseInt(youtubeVideosMax, 10) || 0,
            };
            return (
            <div className="desktop-card border border-border">
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border bg-muted/30">
                <div className="flex items-center gap-1.5">
                  {signupRunning && <Loader2 className="w-3 h-3 animate-spin text-cyan-500" />}
                  {signupRunning ? (
                    <div className="flex items-center gap-1.5">
                      {steps.map((step, i) => {
                        const isDone   = i < cur;
                        const isActive = i === cur;
                        // Compute progress for every stage:
                        // • completed stages → always 100 (log has the done marker)
                        // • active stage     → live % from log lines
                        // • future stages    → null (not started yet)
                        const pct = (isDone || isActive)
                          ? calcStepProgress(signupLog, step, progressSettings)
                          : null;
                        const displayPct = isDone && (pct === null || pct < 100) ? 100 : pct;
                        return (
                        <span key={i} className="flex items-center gap-1.5">
                          <span className={cn(
                            "text-[10px] font-semibold flex items-center gap-1",
                            isDone   ? "text-green-600 dark:text-green-400"
                            : isActive ? "text-cyan-600 dark:text-cyan-400"
                            : "text-muted-foreground/30"
                          )}>
                            Step {i + 1}: {step}
                            {displayPct !== null && (
                              <span className={cn(
                                "inline-flex items-center px-1 py-0 rounded text-[9px] font-bold tabular-nums leading-4",
                                isDone
                                  ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300"
                                  : "bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300"
                              )}>
                                {displayPct}%
                              </span>
                            )}
                          </span>
                          {i < steps.length - 1 && <span className="text-muted-foreground/25 text-[10px] select-none">›</span>}
                        </span>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Signup Log</p>
                  )}
                </div>
                {!signupRunning && (
                  <button type="button" onClick={() => setSignupLog([])} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                    Clear
                  </button>
                )}
              </div>
              <div ref={signupLogRef} onScroll={handleLogScroll} className="overflow-y-auto px-2.5 py-2 space-y-1" style={{ maxHeight: 300 }}>
                {signupLog.length === 0 && signupRunning && (
                  <p className="text-[10px] text-muted-foreground/50 italic">Starting…</p>
                )}
                {signupLog.map((line, i) => (
                  <p key={i} className={cn(
                    "text-[10px] leading-relaxed break-words whitespace-pre-wrap",
                    line.startsWith("✅") ? "text-green-600 dark:text-green-400"
                    : line.includes("⚠") || line.toLowerCase().includes("error") ? "text-amber-600 dark:text-amber-400"
                    : line.startsWith("🛑") ? "text-red-500"
                    : "text-foreground/80"
                  )}>
                    {line}
                  </p>
                ))}
              </div>
            </div>
          );
          })()}

        </div>

        {/* ── Right: Placeholder box ── */}
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center bg-muted/10 rounded-lg border border-border overflow-hidden">
          <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
            <div className="w-20 h-20 rounded-3xl bg-muted/60 flex items-center justify-center">
              <Ghost className="w-10 h-10 text-muted-foreground/50" />
            </div>
            <div className="space-y-1.5 max-w-xs">
              <p className="text-base font-semibold text-foreground">
                {isOpen ? "Browser running" : "Browser not started"}
              </p>
              <p className="text-sm text-muted-foreground">
                {isOpen
                  ? `Browser window is open${activeProxyLabel ? ` · ${activeProxyLabel}` : ""}.`
                  : "Fill in your account details, then click Create Account to launch the browser."}
              </p>
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
