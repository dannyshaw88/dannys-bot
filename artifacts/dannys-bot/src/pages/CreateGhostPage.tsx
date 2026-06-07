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
  CheckCircle2, Mail, Lock, Server, Calendar, MessageSquare,
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
  const age = Math.floor(Math.random() * 22) + 18; // 18–39
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

  // ── localStorage persistence for form fields ────────────────────────────────
  // Reads saved values on first render so restarts don't wipe the form.
  const _LS_KEY = "ghost-browser-fields-v1";
  const _lsLoad = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(_LS_KEY) ?? "{}"); } catch { return {}; }
  };
  const _ls = _lsLoad();

  // Account fields
  const [usernameSpin, setUsernameSpin] = useState(() => _ls.usernameSpin ?? "");
  const [password, setPassword]         = useState(() => _ls.password ?? generatePassword());
  const [bioSpin, setBioSpin]           = useState(() => _ls.bioSpin ?? "");

  // Email / IMAP fields
  const [emailAddr, setEmailAddr]   = useState(() => _ls.emailAddr   ?? "");
  const [emailPass, setEmailPass]   = useState(() => _ls.emailPass   ?? "");
  const [imapHost, setImapHost]     = useState(() => _ls.imapHost    ?? "");
  const [imapPort, setImapPort]     = useState(() => _ls.imapPort    ?? "993");
  const [imapSecure, setImapSecure] = useState(() => (_ls.imapSecure ?? "true") === "true");

  // Verification code
  const [manualCode, setManualCode]       = useState("");
  const [fetchingCode, setFetchingCode]   = useState(false);
  const [fetchCodeMsg, setFetchCodeMsg]   = useState("");
  const [codePending, setCodePending]     = useState(false);

  // DOB
  const [dob, setDob] = useState(() => _ls.dob ?? generateDob());

  // Ghost fingerprint — regenerated on every Nuke Environment
  const [fingerprint, setFingerprint]                 = useState<GhostFingerprint>(() => generateGhostFingerprint());
  const [fingerprintExpanded, setFingerprintExpanded] = useState(false);

  // Signup automation
  const [signupRunning, setSignupRunning] = useState(false);
  const [signupStatus, setSignupStatus]   = useState("");
  const signupPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Add to Equinox
  const [addedToEquinox, setAddedToEquinox]   = useState(false);
  const [addingToEquinox, setAddingToEquinox] = useState(false);

  // Code-wait countdown timer (counts up from 0, shown when codePending)
  const [codeWaitSecs, setCodeWaitSecs] = useState(0);
  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOpen = browserState === "open";
  const generatedUsername = usernameSpin.trim() ? resolveSpintax(usernameSpin) : "";

  // ── Persist form fields to localStorage whenever they change ─────────────
  useEffect(() => {
    try {
      localStorage.setItem(_LS_KEY, JSON.stringify({
        usernameSpin, password, dob, bioSpin,
        emailAddr, emailPass, imapHost, imapPort,
        imapSecure: String(imapSecure),
      }));
    } catch {}
  }, [usernameSpin, password, dob, bioSpin, emailAddr, emailPass, imapHost, imapPort, imapSecure]);

  // ── Browser status check (mount + continuous poll) ────────────────────────
  // Run once on mount, then every 5 s so the "Ghost Browser is not open"
  // indicator stays accurate even if the browser was opened/closed externally
  // (e.g. after a software restart or a Nuke Environment reset).
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const [elData, statusData] = await Promise.all([
          fetch("/api/is-electron").then(r => r.json()).catch(() => ({ electron: false })),
          fetch("/api/signup/browser/status").then(r => r.json()).catch(() => ({ running: false })),
        ]);
        setIsNative(!!(elData as any).electron);
        setBrowserState(prev => {
          // The poll ONLY auto-discovers a browser that's already open
          // (e.g. after an app restart).  It must NEVER set the state to
          // "closed" — the fire-and-forget /eb/open call returns before
          // openEbWindow registers the window in ebMap, so the first few
          // polls after clicking "Open Browser" legitimately return
          // running:false even though the window is visible.  Treating
          // running:false as "closed" is what caused the regression.
          // Only handleClose / handleFresh should ever set "closed".
          if ((statusData as any).running && prev === "closed") return "open";
          return prev;
        });
      } catch {}
    };
    checkStatus();
    const poll = setInterval(checkStatus, 5000);
    return () => clearInterval(poll);
  }, []);

  // Code-wait timer — starts counting when codePending, resets when done
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

  // Poll signup status while automation is running
  useEffect(() => {
    if (!signupRunning) {
      if (signupPollRef.current) { clearInterval(signupPollRef.current); signupPollRef.current = null; }
      return;
    }
    signupPollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/signup/browser/ghost-signup-status");
        const j = await r.json() as any;
        if (j.msg) setSignupStatus(j.msg);
        if (j.msg && (j.msg.startsWith("✅") || j.msg.includes("error") || j.msg.includes("⚠"))) {
          // Done or error — stop spinning, but don't stop polling in case more msgs come
        }
        if (j.done) {
          setSignupRunning(false);
        }
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

  // IMAP: fetch verification code from email inbox
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
        // Auto-submit to the signup flow
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

  // Submit manual code to the running signup flow
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

  // Create Account — opens the browser if needed, then runs the full signup flow
  const handleCreateAccount = async () => {
    const uname = (generatedUsername || usernameSpin).trim();
    if (!uname || !password.trim() || !emailAddr.trim() || !dob.trim()) {
      setSignupStatus("⚠ Fill in username, password, email, and DOB before creating an account.");
      return;
    }

    // Open the browser first if it's not already running
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
        }),
      }).catch(() => {});
      setBrowserState("open");
      // Give the browser a moment to fully initialise before starting signup
      await new Promise(r => setTimeout(r, 1500));
    }

    setSignupRunning(true);
    setSignupStatus("Starting automated signup…");
    setCodePending(false);
    setFetchCodeMsg("");

    try {
      const r = await fetch("/api/signup/browser/ghost-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailAddr.trim(),
          username: uname,
          password: password.trim(),
          dob: dob.trim(),
        }),
      });
      const j = await r.json() as any;
      if (!j.ok) {
        setSignupStatus(`⚠ ${j.error ?? "Failed to start signup"}`);
        setSignupRunning(false);
      } else {
        setCodePending(true);
      }
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

          {/* Account Fields + Actions */}
          <div className="desktop-card p-2.5 space-y-1.5">

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

            {/* Password — directly under username */}
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

            {/* DOB */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-cyan-500" />
                  <p className="text-[10px] text-muted-foreground font-medium">Date of Birth (DD/MM/YYYY)</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDob(generateDob())}
                  className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  title="Generate random 18+ DOB"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  Random
                </button>
              </div>
              <Input
                value={dob}
                onChange={e => setDob(e.target.value)}
                placeholder="DD/MM/YYYY"
                className="h-8 text-xs font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {/* Email section */}
            <div className="pt-1 space-y-1.5 border-t border-border/50">
              <div className="flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Email / IMAP</p>
              </div>

              {/* Email address */}
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium">Email Address</p>
                <div className="flex gap-1">
                  <Input
                    value={emailAddr}
                    onChange={e => setEmailAddr(e.target.value)}
                    placeholder="user@example.com"
                    className="h-8 text-xs flex-1 min-w-0"
                    type="email"
                    autoComplete="off"
                  />
                  <FieldActions value={emailAddr} isOpen={isOpen} />
                </div>
              </div>

              {/* Email password */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Lock className="w-3 h-3 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">Email Password</p>
                </div>
                <Input
                  value={emailPass}
                  onChange={e => setEmailPass(e.target.value)}
                  placeholder="Email account password"
                  className="h-7 text-xs font-mono"
                  type="password"
                  autoComplete="off"
                />
              </div>

              {/* IMAP Settings */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Server className="w-3 h-3 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">IMAP Settings</p>
                </div>
                <div className="flex gap-1">
                  <Input
                    value={imapHost}
                    onChange={e => setImapHost(e.target.value)}
                    placeholder="imap.gmail.com"
                    className="h-7 text-xs flex-1 min-w-0"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Input
                    value={imapPort}
                    onChange={e => setImapPort(e.target.value)}
                    placeholder="993"
                    className="h-7 text-xs w-14"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setImapSecure(s => !s)}
                    title={imapSecure ? "TLS enabled" : "TLS disabled"}
                    className={cn(
                      "h-7 px-1.5 rounded-md border text-[10px] font-medium transition-colors shrink-0",
                      imapSecure
                        ? "border-green-400 text-green-700 bg-green-50 dark:bg-green-950/30"
                        : "border-border text-muted-foreground bg-muted/30"
                    )}
                  >
                    TLS
                  </button>
                </div>
              </div>

              {/* Verification code + fetch */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Key className="w-3 h-3 text-muted-foreground" />
                  <p className="text-[10px] text-muted-foreground font-medium">Verification Code</p>
                </div>
                <div className="flex gap-1">
                  <Input
                    value={manualCode}
                    onChange={e => setManualCode(e.target.value)}
                    placeholder="6-digit code (manual fallback)"
                    className="h-8 text-xs font-mono flex-1 min-w-0"
                    maxLength={8}
                    autoComplete="off"
                  />
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-7 text-[10px] gap-1 border-cyan-300 text-cyan-700 hover:bg-cyan-50 hover:border-cyan-400 dark:text-cyan-400"
                    onClick={handleFetchCode}
                    disabled={fetchingCode || !imapHost.trim() || !emailAddr.trim() || !emailPass.trim()}
                    title="Connect via IMAP and extract the Instagram code from your inbox"
                  >
                    {fetchingCode ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                    Fetch from IMAP
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-7 text-[10px] gap-1"
                    onClick={handleSubmitCode}
                    disabled={!manualCode.trim()}
                    title="Submit the code you typed to the running signup flow"
                  >
                    <MessageSquare className="w-3 h-3" />
                    Submit Code
                  </Button>
                </div>
                {fetchCodeMsg && (
                  <p className={cn(
                    "text-[10px]",
                    fetchCodeMsg.startsWith("✅") ? "text-green-600" : "text-amber-600"
                  )}>
                    {fetchCodeMsg}
                  </p>
                )}
              </div>
            </div>

            {/* Bio Spin */}
            <div className="pt-1 space-y-1 border-t border-border/50">
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

            {/* Signup status + code-pending message */}
            {(signupStatus || (codePending && signupRunning)) && (
              <div className="pt-1 border-t border-border/50 space-y-1.5">
                {signupStatus && (
                  <div className={cn(
                    "rounded-md border px-2 py-1.5 text-[10px] leading-relaxed",
                    signupStatus.startsWith("✅")
                      ? "border-green-300 bg-green-50 text-green-700 dark:bg-green-950/30"
                      : signupStatus.includes("⚠") || signupStatus.includes("error")
                      ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30"
                      : "border-cyan-200 bg-cyan-50/50 text-cyan-800 dark:bg-cyan-950/20"
                  )}>
                    {signupRunning && <Loader2 className="w-2.5 h-2.5 animate-spin inline mr-1" />}
                    {signupStatus}
                  </div>
                )}
              </div>
            )}

            {/* Action buttons — Create Account, Nuke Environment, Close Browser */}
            <div className="pt-1 border-t border-border/50 space-y-1.5">
              {/* Create Account — opens browser then runs full signup */}
              <Button
                className={cn(
                  "w-full gap-2 text-xs",
                  signupRunning || browserState === "opening"
                    ? "bg-amber-500 hover:bg-amber-600 text-white border-0"
                    : "bg-cyan-500 hover:bg-cyan-600 text-white border-0"
                )}
                onClick={handleCreateAccount}
                disabled={signupRunning || browserState === "opening" || browserState === "resetting" || !usernameSpin.trim() || !password.trim() || !emailAddr.trim() || !dob.trim()}
                title="Opens the browser and runs the full signup flow automatically"
              >
                {signupRunning
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Running…</>
                  : browserState === "opening"
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Opening Browser…</>
                  : <><Ghost className="w-3.5 h-3.5" />Create Account</>}
              </Button>

              {/* Nuke Environment — always clickable, even while signup is running */}
              <Button
                variant="outline"
                className="w-full gap-2 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-400"
                onClick={handleFresh}
                disabled={browserState === "opening" || browserState === "resetting"}
                title="Wipes all cookies, cache, localStorage, picks a new device identity, and regenerates DOB"
              >
                {browserState === "resetting"
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Nuking…</>
                  : <><NukeIcon className="w-4 h-4" />Nuke Environment</>}
              </Button>

              {/* Close Browser — only shown when browser is open */}
              {isOpen && (
                <Button variant="outline" className="w-full gap-2 text-xs" onClick={handleClose} disabled={signupRunning}>
                  <WifiOff className="w-3.5 h-3.5" />
                  Close Browser
                </Button>
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
                title="Save this account (username, password, email, UA) to Equinox accounts"
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
                  Fill in your account details, then click <span className="font-medium">Create Account</span> to launch the browser and run the signup automatically.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
