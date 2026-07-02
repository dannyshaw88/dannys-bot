import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link, useLocation, useSearch } from "wouter";
import { useProfile, useUpdateProfile, useUpdateAccountStatus, useProfiles, useCreatorProfiles, useMoveToAccounts } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import { SessionLogPanel } from "@/components/tools/SessionLogPanel";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { TrustScoreBadge, getTrustScore, getTrustLevels } from "@/components/TrustScoreBadge";
import * as Tabs from "@radix-ui/react-tabs";
import { 
  Settings, Shield, User, Lock, Globe, Zap, Instagram, Activity, Monitor,
  CheckCircle2, XCircle, Loader2, ShieldCheck,
  Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, ChevronDown, ChevronLeft, ChevronRight,
  Tag, Calendar, FileText, Server, X, Clock, Copy, Search, UserCircle,
  UserPlus, MessageSquare, RefreshCw, Users, BarChart2,
  AlertTriangle, ShieldAlert, WifiOff, UserMinus, Camera, Eye, Smartphone, Cookie, PlusCircle, Trash2,
  Battery, BatteryCharging, Wifi, Cpu, MapPin, Fingerprint
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useProxies, useUpdateProxy } from "@/hooks/use-proxies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumField } from "@/components/ui/num-field";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { shouldWarnForNewAccount, recordLoginEvent } from "@/lib/ipLoginTracker";
import { LoginRateLimitDialog } from "@/components/LoginRateLimitDialog";
import type { AccountStatus } from "@shared/schema";
import { ACCOUNT_STATUSES } from "@shared/schema";
import { userAgents } from "@shared/userAgents";
import { UaPickerDropdown } from "@/components/ui/ua-picker";
import type { UaEntry } from "@/components/ui/ua-picker";

const STATUS_META: Record<AccountStatus, { label: string; icon: React.ElementType; pill: string; dot: string }> = {
  pending:            { label: "Pending",           icon: Clock,       pill: "bg-slate-50  text-slate-600  border-slate-200",  dot: "bg-slate-400"  },
  verifying:          { label: "Verifying",         icon: Loader2,     pill: "bg-blue-50   text-blue-600   border-blue-200",   dot: "bg-blue-400"   },
  valid:              { label: "Valid",             icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200",  dot: "bg-green-500"  },
  banned:             { label: "Banned",            icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  captcha:            { label: "Captcha",           icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  locked:             { label: "Account Locked",    icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  email_confirmation: { label: "Email Confirm",     icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  phone_verification: { label: "Phone Verify",      icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  "2fa_verification": { label: "2FA Verify",        icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  stopped:              { label: "Stopped",            icon: PowerOff,      pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  logged_out:           { label: "Logged Out",         icon: LogOut,        pill: "bg-yellow-50 text-yellow-700 border-yellow-200",  dot: "bg-yellow-500" },
  bad_password:         { label: "Incorrect Password", icon: KeyRound,      pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  action_blocked:       { label: "Action Blocked",     icon: Ban,           pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  action_required:      { label: "Action Required",    icon: AlertTriangle, pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  post_deleted:         { label: "Post Deleted",       icon: AlertTriangle, pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  account_disabled:     { label: "Account Disabled",    icon: UserMinus,     pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  api_block:            { label: "API Block",          icon: ShieldAlert,   pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  captcha_disabled:     { label: "Captcha Disabled",   icon: ScanFace,      pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  compromised:          { label: "Compromised",        icon: ShieldAlert,   pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  email_verification:   { label: "Email Verify",       icon: Mail,          pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  phone_validation:     { label: "Phone Valid.",       icon: Phone,         pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  invalid_credentials:  { label: "Invalid Creds",      icon: KeyRound,      pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  no_internet:          { label: "No Internet",        icon: WifiOff,       pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  password_reset:       { label: "Password Reset",     icon: RefreshCw,     pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  temporary_locked:     { label: "Temp. Locked",       icon: Lock,          pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  scrape_warning:       { label: "Scrape Warning",     icon: AlertTriangle, pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  suspended:            { label: "Confirm Your Human",  icon: ScanFace,      pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  confirm_human:        { label: "Confirm Your Human",  icon: ScanFace,      pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  selfie_verification:  { label: "Selfie Verify",      icon: Camera,        pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  own_phone_verification: { label: "Own Phone Verify", icon: Phone,         pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  email_connection:     { label: "Email Connect",      icon: Mail,          pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  upload:               { label: "Upload",             icon: AlertTriangle, pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  review:               { label: "Review",             icon: Eye,           pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  resuming:             { label: "Resuming",           icon: RefreshCw,     pill: "bg-yellow-50 text-yellow-700 border-yellow-200",  dot: "bg-yellow-500" },
  automated_behaviour_detected: { label: "Auto Behav.", icon: ShieldAlert, pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
};

// ── Per-account stealth fingerprint decoder ───────────────────────────────────
// Replicates the djb2 + LCG PRNG call sequence from applyStealthScripts so the
// UI can show what device identity Instagram sees for each account.
function _fpDjb2(ua: string): number {
  let s = 5381;
  for (let i = 0; i < ua.length; i++) s = (((s << 5) + s) ^ ua.charCodeAt(i)) >>> 0;
  return s || 1;
}
interface FingerprintValues {
  device: string; sw: number; sh: number; dpr: number; mem: number; cores: number;
  batteryPct: number; charging: boolean; connType: string; downlink: number; timezone: string;
  rtt: number; chargeOrDischargeTime: number;
}
function computeFingerprint(ua: string, apiUA?: string | null): FingerprintValues {
  let s = _fpDjb2(ua);
  const r  = () => { s = ((Math.imul(1664525, s) + 1013904223) >>> 0); return s / 0x100000000; };
  const rI = (lo: number, hi: number) => { const v = lo + Math.round(r() * (hi - lo)); return v; };
  const rp = <T extends unknown>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];

  const PROF = [
    [360, 808,  3.0,   8,  8, "Pixel 9 Pro"   ],
    [411, 914,  2.625, 8,  9, "Pixel 8a"      ],
    [411, 914,  2.625, 8,  9, "Pixel 8"       ],
    [360, 780,  3.0,   8, 10, "Samsung S24"   ],
    [360, 780,  3.0,   8,  8, "Samsung S22"   ],
    [393, 851,  2.75,  8,  8, "OnePlus 12"    ],
    [412, 915,  2.625, 8,  8, "OnePlus 10 Pro"],
    [412, 900,  2.70,  8,  8, "Moto Edge"     ],
    [393, 873,  2.75,  8,  8, "Xiaomi 14"     ],
    [393, 873,  2.75,  8,  8, "Sony Xperia 1V"],
    [393, 868,  2.75,  8,  8, "OPPO Find X6"  ],
    [360, 780,  3.0,   8,  8, "Samsung A54"   ],
  ] as const;
  const _profPick = rp(PROF);                                    // call 1 — always advance PRNG
  let sw = +_profPick[0], sh = +_profPick[1], dpr = +_profPick[2];
  let mem = +_profPick[3], cores = +_profPick[4], device = _profPick[5] as string;
  // Override with exact specs derived from the API UA when available.
  // API UA format: "SDK/OS; DPIdpi; PHYSWxPHYSH; Manufacturer; Model; Codename; Chipset; Locale"
  if (apiUA) {
    const _m = apiUA.match(/;\s*(\d+)dpi;\s*(\d+)x(\d+);[^;]*;([^;]*);[^;]*;([^;]*)/);
    if (_m) {
      const _dpi = +_m[1], _pW = +_m[2], _pH = +_m[3];
      dpr    = Math.round(_dpi / 160 * 10000) / 10000;
      sw     = Math.round(_pW / dpr);
      sh     = Math.round(_pH / dpr);
      mem    = 8;
      // Only Tensor G3 (Pixel 8 / 8 Pro / 8a) has 9 cores — match on model name
      // so the logic works for both "gs202" and "Tensor G4" chipset string formats.
      cores  = /;\s*Pixel 8[^9]/i.test(apiUA) ? 9 : /exynos2400/i.test(apiUA) ? 10 : 8;
      device = _m[4].trim();
    }
  }

  const batteryPct = Math.round((0.60 + r() * 0.39) * 100);    // call 2
  const charging   = r() > 0.35;                                // call 3
  const chargeOrDischargeTime = charging ? rI(0, 3600) : rI(1800, 28800); // call 4

  const connType = rp(["Wi-Fi", "Wi-Fi", "Wi-Fi", "Cellular"] as const); // call 5
  const downlink = Math.round(2 + r() * 98);                    // call 6
  const rtt      = rI(10, 150);                                  // call 7

  // Derive timezone from the machine's actual locale rather than picking
  // randomly from a pool — a random pool can show a timezone that directly
  // contradicts the account's proxy country, which Instagram cross-checks.
  // Intl gives the real local timezone (e.g. "Europe/London" → "London").
  const _tzRaw = Intl.DateTimeFormat().resolvedOptions().timeZone;  // call 8 (advance PRNG slot)
  void rp(["x"] as const);
  const timezone = _tzRaw.split("/").pop()?.replace(/_/g, " ") ?? "Unknown"; // "America/New_York" → "New York"

  return { device, sw, sh, dpr, mem, cores, batteryPct, charging, connType, downlink, timezone, rtt, chargeOrDischargeTime };
}

function parseActiveTimerSlots(start: string | null | undefined, end: string | null | undefined): { start: string; end: string }[] {
  if (start) {
    try {
      const parsed = JSON.parse(start);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return [{ start: start || "09:00", end: end || "22:00" }];
}

function GroupCombobox({ value, groups, onChange }: { value: string; groups: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Show all groups when the dropdown first opens; only filter as the user types.
  const filtered = filterText
    ? groups.filter(g => g.toLowerCase().includes(filterText.toLowerCase()))
    : groups;

  useEffect(() => {
    if (!open) { setFilterText(""); return; }
    setFilterText("");
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="max-w-[20%] relative" ref={ref}>
      <Input
        className="h-8 text-xs font-bold pr-7 border-black"
        placeholder="No group"
        value={value || ""}
        onFocus={() => setOpen(true)}
        onChange={e => { onChange(e.target.value); setFilterText(e.target.value); setOpen(true); }}
        onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (filtered.length > 0 || !filterText) && (
        <div className="absolute z-50 top-full left-0 right-0 mt-0.5 bg-popover border border-border rounded-md shadow-md overflow-hidden">
          {filtered.length === 0 && !filterText ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No groups yet — type to create one</div>
          ) : (
            <>
              {filtered.map(group => (
                <button
                  key={group}
                  type="button"
                  className={`w-full text-left px-3 py-1.5 text-xs font-bold hover:bg-muted/60 ${group === value ? "text-primary" : "text-foreground"}`}
                  onMouseDown={e => { e.preventDefault(); onChange(group); setFilterText(""); setOpen(false); }}
                >
                  {group}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}


export function ProfileDetailsPage() {
  const params = useParams();
  const profileId = Number(params.id);
  
  const { data: profile, isLoading: profileLoading } = useProfile(profileId);
  const { data: tools, isLoading: toolsLoading } = useTools(profileId);
  const { data: proxies } = useProxies();
  const updateProfileMutation = useUpdateProfile();
  const updateAccountStatusMutation = useUpdateAccountStatus();
  const updateProxyMutation = useUpdateProxy();
  const moveToAccountsMutation = useMoveToAccounts();
  const { toast } = useToast();

  const { openWindow } = useBrowserWindows();

  const { data: automationProfiles } = useProfiles();
  const { data: creatorProfilesList } = useCreatorProfiles();
  const allProfiles = profile?.creatorMode ? creatorProfilesList : automationProfiles;

  const [formData, setFormData] = useState<any>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "pending" | "ok" | "fail">("idle");
  const [resetDeviceConfirmOpen, setResetDeviceConfirmOpen] = useState(false);
  const [loginWarnState, setLoginWarnState] = useState<{
    proxyDisplay: string;
    minutesAgo: number;
    bypassProxy: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [pendingUa, setPendingUa] = useState<UaEntry | null>(null);
  const [uaChangeConfirmOpen, setUaChangeConfirmOpen] = useState(false);
  const [showFingerprintPreview, setShowFingerprintPreview] = useState(false);
  const [showAccountDetails, setShowAccountDetails] = useState(true);
  const [showProfileSync, setShowProfileSync] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedProfileIdRef = useRef<number | null>(null);
  const preStoppedStatusRef = useRef<string>("pending");
  // Tracks the tags value the user has explicitly set in this session (null = not changed by user).
  // Used so auto-saves triggered by other field edits never send a stale formData.tags
  // that was initialized from a cached (pre-group-assignment) profile snapshot.
  const userTagsRef = useRef<string | null>(null);

  const [linkedHostPort, setLinkedHostPort] = useState("");
  const [linkedUsername, setLinkedUsername] = useState("");
  const [linkedPassword, setLinkedPassword] = useState("");

  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [humanCopyOpen, setHumanCopyOpen] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [totpCode, setTotpCode] = useState<string | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpCopied, setTotpCopied] = useState(false);

  const [cookieInput, setCookieInput] = useState("");
  const [cookieInjectStatus, setCookieInjectStatus] = useState<"idle" | "injecting" | "ok" | "error">("idle");
  const [clearCookiesStatus, setClearCookiesStatus] = useState<"idle" | "clearing" | "ok" | "error">("idle");


  const handleInjectCookies = async () => {
    const raw = cookieInput.trim();
    if (!raw) return;
    if (!raw.includes("sessionid=")) {
      toast({ title: "Invalid cookies", description: "Cookie string must contain sessionid.", variant: "destructive" });
      return;
    }
    setCookieInjectStatus("injecting");
    try {
      const res = await fetch(`/api/profiles/${profileId}/inject-cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: raw }),
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).message ?? "Failed");
      }
      setCookieInjectStatus("ok");
      setCookieInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      toast({
        title: "Cookies injected",
        description: "Session cookies saved to database and browser cookie file. Open the embedded browser or run Verify Credentials to activate the session.",
      });
      setTimeout(() => setCookieInjectStatus("idle"), 4000);
    } catch (err: any) {
      setCookieInjectStatus("error");
      toast({ title: "Injection failed", description: err?.message ?? "Could not save cookies.", variant: "destructive" });
      setTimeout(() => setCookieInjectStatus("idle"), 3000);
    }
  };

  const generateTotp = async (secret: string) => {
    setTotpCode(null); setTotpError(null);
    try {
      const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      const cleaned = secret.toUpperCase().replace(/\s+/g, "").replace(/=/g, "");
      let bits = 0, val = 0;
      const bytes: number[] = [];
      for (const ch of cleaned) {
        const idx = b32.indexOf(ch);
        if (idx < 0) continue;
        val = (val << 5) | idx; bits += 5;
        if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
      }
      if (!bytes.length) { setTotpError("Invalid secret"); return; }
      const key = await crypto.subtle.importKey(
        "raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
      );
      const counter = Math.floor(Date.now() / 1000 / 30);
      const buf = new Uint8Array(8);
      let c = counter;
      for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
      const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
      const offset = hmac[19] & 0xf;
      const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1_000_000;
      const codeStr = code.toString().padStart(6, "0");
      setTotpCode(codeStr);
      navigator.clipboard.writeText(codeStr).catch(() => {});
      setTotpCopied(true);
      setTimeout(() => setTotpCopied(false), 10000);
    } catch { setTotpError("Failed to generate"); }
  };
  const [location, navigate] = useLocation();
  const search = useSearch();
  const activeTab = new URLSearchParams(search).get("tab") ?? "settings";
  const fromTrustScoreId = new URLSearchParams(search).get("fromTrustScore") ?? null;
  const fromTrustScoreLevel = fromTrustScoreId
    ? getTrustLevels().find(l => l.id === fromTrustScoreId) ?? null
    : null;

  // Keyboard shortcuts — number keys 1-7 switch tabs (blocked when typing in inputs)
  useEffect(() => {
    const creatorMode = !!profile?.creatorMode;
    const tabMap: Record<string, string> = creatorMode
      ? { "1": "settings" }
      : { "1": "settings", "2": "human-session", "3": "session-log" };
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tab = tabMap[e.key];
      if (tab) {
        e.preventDefault();
        navigate(`/profiles/${profileId}?tab=${tab}`);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [profileId, navigate, profile?.creatorMode]);

  const ACCOUNT_COPY_GROUPS: CopyOptionGroup[] = [
    {
      label: "Organisation",
      options: [
        { key: "group", label: "Group", description: "Assign the same group as this account" },
      ],
    },
    {
      label: "API & Performance",
      options: [
        { key: "apiLimits", label: "API Limits & Control", description: "Min/max calls and interval settings" },
        { key: "loginRandomEndpoints", label: "Fire Random Endpoints at Login", description: "Fire random endpoints to each login sequence — enabled state and min/max endpoint count merged into each target's existing API limits without overwriting their rate settings" },
        { key: "loginMakePostChance", label: "Chance of Making a Post", description: "Enabled state, min/max % chance — merged into each target's existing API limits without overwriting their rate settings" },
        { key: "variationSettings", label: "Variation %", description: "Enabled state, lower/upper chance % and seconds — merged into each target's existing API limits without overwriting their rate settings" },
        { key: "momentumSettings", label: "Momentum", description: "Enabled state, chance % and spread % — merged into each target's existing API limits without overwriting their rate settings" },
        { key: "attentionDrift", label: "Attention Drift", description: "Enabled state, chance % and min/max minutes — merged into each target's existing API limits without overwriting their rate settings" },
        { key: "fatigueSettings", label: "Fatigue", description: "Enabled state, strength % and ramp calls — merged into each target's existing API limits without overwriting their rate settings" },
      ],
    },
    {
      label: "Scheduling",
      options: [
        { key: "activeTimer", label: "Active Timer", description: "Enabled state, start & end times" },
      ],
    },
    {
      label: "Profile Sync",
      options: [
        { key: "profileSync", label: "Profile Sync", description: "Auto sync toggle, interval and HikerAPI option" },
      ],
    },
    {
      label: "Browser Actions",
      options: [
        { key: "followViaBrowser", label: "Do Actions Via Browser — Follows", description: "Use the embedded browser in the background for follow actions instead of the mobile API" },
      ],
    },
  ];

  const [syncNowStatus, setSyncNowStatus] = useState<"idle" | "syncing" | "done" | "fail">("idle");
  const [timingInfo, setTimingInfo] = useState<string | null>(null);
  const handleSyncNow = async () => {
    setSyncNowStatus("syncing");
    try {
      const res = await fetch(`/api/profiles/${profileId}/sync`, { method: "POST" });
      if (res.ok) {
        setSyncNowStatus("done");
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
        toast({ title: "Profile synced", description: "Follower and post counts updated." });
      } else {
        setSyncNowStatus("fail");
        toast({ title: "Sync failed", description: "Could not retrieve stats from Instagram.", variant: "destructive" });
      }
    } catch {
      setSyncNowStatus("fail");
      toast({ title: "Sync failed", description: "Network error.", variant: "destructive" });
    } finally {
      setTimeout(() => setSyncNowStatus("idle"), 3000);
    }
  };

  // When viewing a TrustScore template profile, scope pickers to other templates only.
  // When viewing a regular account, exclude all templates (existing behaviour).
  const currentIsTemplate = profile?.isTemplate === true;
  const otherProfiles = allProfiles?.filter(p => {
    if (p.id === profileId || p.locked) return false;
    return currentIsTemplate ? p.isTemplate === true : !p.isTemplate;
  }) ?? [];
  const hasOtherProfiles = (allProfiles?.filter(p => {
    if (p.id === profileId) return false;
    return currentIsTemplate ? p.isTemplate === true : !p.isTemplate;
  }) ?? []).length > 0;

  const handleAccountCopy = async (targetIds: number[], expandedKeys: string[]) => {
    if (!formData) return;
    const patch: Record<string, any> = {};
    if (expandedKeys.includes("group")) patch.tags = formData.tags ?? "";
    if (expandedKeys.includes("apiLimits")) patch.apiLimits = formData.apiLimits;
    if (expandedKeys.includes("activeTimer")) {
      patch.activeTimerEnabled = formData.activeTimerEnabled;
      patch.activeTimerStart = formData.activeTimerStart;
      patch.activeTimerEnd = formData.activeTimerEnd;
    }
    if (expandedKeys.includes("profileSync")) {
      patch.syncEnabled = formData.syncEnabled;
      patch.syncIntervalMin = formData.syncIntervalMin;
      patch.syncIntervalMax = formData.syncIntervalMax;
      patch.syncUseHiker = formData.syncUseHiker;
    }
    if (expandedKeys.includes("followViaBrowser")) {
      patch.followViaBrowser = formData.followViaBrowser ?? false;
    }

    // loginRandomEndpoints is stored inside apiLimits JSON.
    // Copy only the three loginRandom* fields, merging into each target's existing
    // apiLimits so their rate limit settings are never overwritten.
    const needsLimitsMerge =
      (expandedKeys.includes("loginRandomEndpoints") || expandedKeys.includes("loginMakePostChance") || expandedKeys.includes("variationSettings") || expandedKeys.includes("momentumSettings") || expandedKeys.includes("attentionDrift") || expandedKeys.includes("fatigueSettings"))
      && !expandedKeys.includes("apiLimits");

    if (needsLimitsMerge) {
      const srcLimits = formData.apiLimits as any;
      await Promise.all(targetIds.map(async (id) => {
        const target = allProfiles?.find(p => p.id === id);
        const existing = (target?.apiLimits as any) ?? {};
        const merged: Record<string, any> = { ...existing };
        if (expandedKeys.includes("loginRandomEndpoints")) {
          merged.loginRandomEndpointsEnabled = srcLimits.loginRandomEndpointsEnabled ?? false;
          merged.loginRandomEndpointsMin     = srcLimits.loginRandomEndpointsMin ?? 1;
          merged.loginRandomEndpointsMax     = srcLimits.loginRandomEndpointsMax ?? 5;
        }
        if (expandedKeys.includes("loginMakePostChance")) {
          merged.loginMakePostChanceEnabled = srcLimits.loginMakePostChanceEnabled ?? false;
          merged.loginMakePostChanceMin     = srcLimits.loginMakePostChanceMin ?? 5;
          merged.loginMakePostChanceMax     = srcLimits.loginMakePostChanceMax ?? 10;
        }
        if (expandedKeys.includes("variationSettings")) {
          merged.variationEnabled         = srcLimits.variationEnabled ?? false;
          // Use new Min/Max field names; fall back to old single-value names for
          // accounts that still have the legacy schema in the DB.
          merged.variationLowerChanceMin  = srcLimits.variationLowerChanceMin  ?? srcLimits.variationLowerChance  ?? 10;
          merged.variationLowerChanceMax  = srcLimits.variationLowerChanceMax  ?? srcLimits.variationLowerChance  ?? 10;
          merged.variationLowerSecsMin    = srcLimits.variationLowerSecsMin    ?? srcLimits.variationLowerSecs    ?? 20;
          merged.variationLowerSecsMax    = srcLimits.variationLowerSecsMax    ?? srcLimits.variationLowerSecs    ?? 30;
          merged.variationUpperChanceMin  = srcLimits.variationUpperChanceMin  ?? srcLimits.variationUpperChance  ?? 10;
          merged.variationUpperChanceMax  = srcLimits.variationUpperChanceMax  ?? srcLimits.variationUpperChance  ?? 10;
          merged.variationUpperSecsMin    = srcLimits.variationUpperSecsMin    ?? srcLimits.variationUpperSecs    ?? 45;
          merged.variationUpperSecsMax    = srcLimits.variationUpperSecsMax    ?? srcLimits.variationUpperSecs    ?? 60;
        }
        if (expandedKeys.includes("momentumSettings")) {
          merged.momentumEnabled = srcLimits.momentumEnabled ?? false;
          merged.momentumChance  = srcLimits.momentumChance ?? 70;
          merged.momentumSpread  = srcLimits.momentumSpread ?? 20;
        }
        if (expandedKeys.includes("attentionDrift")) {
          merged.attentionDriftEnabled  = srcLimits.attentionDriftEnabled ?? false;
          merged.attentionDriftChance   = srcLimits.attentionDriftChance ?? 5;
          merged.attentionDriftMinMins  = srcLimits.attentionDriftMinMins ?? 5;
          merged.attentionDriftMaxMins  = srcLimits.attentionDriftMaxMins ?? 15;
        }
        if (expandedKeys.includes("fatigueSettings")) {
          merged.fatigueEnabled    = srcLimits.fatigueEnabled ?? false;
          merged.fatigueStrength   = srcLimits.fatigueStrength ?? 50;
          merged.fatigueRampCalls  = srcLimits.fatigueRampCalls ?? 30;
        }
        const r = await fetch(`/api/profiles/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiLimits: merged }),
          credentials: "include",
        });
        if (!r.ok) throw new Error(`Failed to update profile ${id}`);
      }));
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      targetIds.forEach(id => {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles/:id", id] });
      });
      toast({ title: "Settings copied", description: `Applied to ${targetIds.length} account${targetIds.length === 1 ? "" : "s"}.` });
      return;
    }

    if (Object.keys(patch).length === 0) {
      toast({ title: "Nothing to copy", description: "No settings were selected.", variant: "destructive" });
      return;
    }

    const res = await fetch("/api/profiles/bulk-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: targetIds, patch }),
      credentials: "include",
    });
    if (!res.ok) {
      let detail = "Bulk update failed";
      try { const j = await res.clone().json(); if (j?.message) detail = j.message; } catch { /* ignore */ }
      throw new Error(detail);
    }
    // Invalidate both the list queries AND each target's individual profile cache.
    // The list uses key ["/api/profiles", "automation"|"creator"] — a ["/api/profiles"]
    // prefix invalidation covers both. The individual profile page uses
    // ["/api/profiles/:id", id] — a different prefix, so it must be invalidated separately;
    // without this, navigating to a target account after copying shows stale settings.
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    targetIds.forEach(id => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles/:id", id] });
    });
    toast({ title: "Settings copied", description: `Applied to ${targetIds.length} account${targetIds.length === 1 ? "" : "s"}.` });
  };

  useEffect(() => {
    if (profile && loadedProfileIdRef.current !== profile.id) {
      loadedProfileIdRef.current = profile.id;
      if (profile.accountStatus === "valid" && !profile.credentialsDirty) {
        setVerifyStatus("ok");
      }
      setFormData({
        username: profile.username,
        password: profile.password,
        email: profile.email || "",
        proxyHost: profile.proxyHost || "",
        proxyPort: profile.proxyPort?.toString() || "",
        proxyUsername: profile.proxyUsername || "",
        proxyPassword: profile.proxyPassword || "",
        useHomeIp: profile.useHomeIp ?? false,
        userAgentApi: profile.userAgentApi || "",
        userAgentEmbedded: profile.userAgentEmbedded || "",
        apiLimits: (profile.apiLimits as any) || {
          requestsMin: 1,
          requestsMax: 1,
          everySecondsMin: 1,
          everySecondsMax: 30000,
          loginRandomEndpointsEnabled: false,
          loginRandomEndpointsMin: 1,
          loginRandomEndpointsMax: 5,
        },
        // Account details
        accountLabel: profile.accountLabel || "",
        tags: profile.tags || "",
        dateOfBirth: profile.dateOfBirth || "",
        notes: profile.notes || "",
        // Security
        phoneNumber: profile.phoneNumber || "",
        twoFASecretKey: profile.twoFASecretKey || "",
        backupCodes: profile.backupCodes || "",
        // Email validation
        emailValidationUsername: profile.emailValidationUsername || "",
        emailValidationPassword: profile.emailValidationPassword || "",
        emailValidationPop3Server: profile.emailValidationPop3Server || "",
        emailValidationPort: profile.emailValidationPort || "",
        // Active timer
        activeTimerEnabled: profile.activeTimerEnabled ?? false,
        activeTimerStart: profile.activeTimerStart || "09:00",
        activeTimerEnd: profile.activeTimerEnd || "22:00",
        // Profile sync
        syncEnabled: profile.syncEnabled ?? false,
        syncIntervalMin: profile.syncIntervalMin ?? 60,
        syncIntervalMax: profile.syncIntervalMax ?? 120,
        syncUseHiker: profile.syncUseHiker ?? false,
        // Browser actions
        followViaBrowser: profile.followViaBrowser ?? false,

      });
    }
  }, [profile]);


  // Auto-save: fires 800ms after the last field change
  const scheduleAutoSave = useCallback((data: any) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("saving");
    saveTimerRef.current = setTimeout(() => {
      updateProfileMutation.mutate(
        { id: profileId, ...data, proxyPort: data.proxyPort ? Number(data.proxyPort) : null },
        {
          onSuccess: () => {
            setSaveStatus("saved");
            queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
            setTimeout(() => setSaveStatus("idle"), 2000);
          },
          onError: () => setSaveStatus("idle"),
        }
      );
    }, 800);
  }, [profileId, updateProfileMutation]);

  useEffect(() => {
    const linked = proxies?.find(p => p.id === profile?.proxyId);
    if (linked) {
      setLinkedHostPort(`${linked.host}:${linked.port}`);
      setLinkedUsername(linked.username ?? "");
      setLinkedPassword(linked.password ?? "");
    }
  }, [profile?.proxyId, proxies]);

  const saveLinkedField = useCallback((field: "hostPort" | "username" | "password") => {
    const linked = proxies?.find(p => p.id === profile?.proxyId);
    if (!linked) return;
    let data: Record<string, string | number | null> = {};
    if (field === "hostPort") {
      const parts = linkedHostPort.split(":");
      const host = parts.slice(0, -1).join(":").trim();
      const port = parseInt(parts[parts.length - 1], 10);
      if (!host || isNaN(port)) {
        toast({ title: "Invalid format", description: "Use host:port format", variant: "destructive" });
        setLinkedHostPort(`${linked.host}:${linked.port}`);
        return;
      }
      data = { host, port };
    } else if (field === "username") {
      data = { username: linkedUsername || null };
    } else {
      data = { password: linkedPassword || null };
    }
    updateProxyMutation.mutate({ id: linked.id, data });
  }, [linkedHostPort, linkedUsername, linkedPassword, profile?.proxyId, proxies, updateProxyMutation, toast]);

  const saveManualProxyField = useCallback(() => {
    if (!formData || profile?.proxyId) return;
    updateProfileMutation.mutate({
      id: profileId,
      proxyHost: formData.proxyHost || null,
      proxyPort: formData.proxyPort ? Number(formData.proxyPort) : null,
      proxyUsername: formData.proxyUsername || null,
      proxyPassword: formData.proxyPassword || null,
    });
  }, [formData, profile?.proxyId, profileId, updateProfileMutation]);

  const updateField = (patch: any) => {
    const next = { ...formData, ...patch };
    setFormData(next);
    // Track explicit user changes to tags so that saves triggered by other
    // field edits don't accidentally clobber the group with a stale formData.tags.
    if ("tags" in patch) {
      userTagsRef.current = patch.tags;
    }
    // When saving, resolve tags: prefer what the user explicitly typed this session,
    // then the live server value, then whatever is in formData (fallback only).
    const resolvedTags = userTagsRef.current !== null
      ? userTagsRef.current
      : (profile?.tags ?? formData?.tags ?? "");
    scheduleAutoSave({ ...next, tags: resolvedTags });
    // Reset verify badge whenever credentials change
    if ("username" in patch || "password" in patch) setVerifyStatus("idle");
  };

  const _executeVerify = async (bypassProxy = false) => {
    setVerifyStatus("pending");
    const host: string | null = profile?.proxyHost ?? null;
    const port: number | null = profile?.proxyPort ?? null;
    const patchList = (old: any) =>
      Array.isArray(old) ? old.map((p: any) => p.id === profileId ? { ...p, accountStatus: "verifying" } : p) : old;
    queryClient.setQueryData(["/api/profiles"], patchList);
    queryClient.setQueryData(["/api/profiles", "automation"], patchList);
    queryClient.setQueryData(["/api/profiles", "creator"], patchList);
    queryClient.setQueryData(["/api/profiles", profileId], (old: any) =>
      old ? { ...old, accountStatus: "verifying" } : old
    );
    const url = `/api/profiles/${profileId}/verify${bypassProxy ? "?bypassProxy=true" : ""}`;
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (res.status === 429) {
        toast({ title: "Verification In Progress", description: "Already verifying this account please wait for it to finish." });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        return;
      }
      if (data.ok) {
        // Only record a login event on a successful verify — failed attempts must not
        // count against the IP rate limit window or future verifies would show a false warning.
        recordLoginEvent(host, port, profileId);
        setVerifyStatus("ok");
        toast({ title: "Credentials Verified", description: data.message });
      } else {
        setVerifyStatus("fail");
        const suffix = bypassProxy ? " (tested without proxy proxy may be the issue)" : "";
        toast({ title: "Verification Failed", description: data.message + suffix, variant: "destructive" });
      }
    } catch {
      setVerifyStatus("fail");
      toast({ title: "Error", description: "Could not reach server.", variant: "destructive" });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    }
  };

  const handleVerify = (bypassProxy = false) => {
    const host: string | null = profile?.proxyHost ?? null;
    const port: number | null = profile?.proxyPort ?? null;
    if (host && !bypassProxy && shouldWarnForNewAccount(host, port, profileId)) {
      setLoginWarnState({
        proxyDisplay: port ? `${host}:${port}` : host,
        minutesAgo: 0,
        bypassProxy,
        onConfirm: () => { setLoginWarnState(null); _executeVerify(bypassProxy); },
      });
      return;
    }
    _executeVerify(bypassProxy);
  };

  const handleResetDeviceIds = async () => {
    const uaRes = await fetch("/api/profiles/suggest-ua", { credentials: "include" });
    const randomUA = uaRes.ok ? await uaRes.json() : { api: "", embedded: "" };
    try {
      await fetch(`/api/profiles/${profileId}/reset-device-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAgentApi: randomUA.api, userAgentEmbedded: randomUA.embedded }),
      });
      await fetch(`/api/browser/${profileId}/wipe`, { method: "POST" }).catch(() => {});
      setFormData((prev: any) => ({ ...prev, userAgentApi: randomUA.api, userAgentEmbedded: randomUA.embedded }));
      setVerifyStatus("idle");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
      toast({ title: "Device IDs Reset", description: "New device fingerprint assigned. EB session cleared." });
    } catch {
      toast({ title: "Error", description: "Failed to reset device IDs.", variant: "destructive" });
    }
  };

  const handleUaDeviceSelect = (ua: UaEntry) => {
    setPendingUa(ua);
    setUaChangeConfirmOpen(true);
  };

  const handleUaChangeConfirm = async () => {
    if (!pendingUa) return;
    try {
      await fetch(`/api/profiles/${profileId}/reset-device-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAgentApi: pendingUa.api, userAgentEmbedded: pendingUa.embedded }),
      });
      await fetch(`/api/browser/${profileId}/wipe`, { method: "POST" }).catch(() => {});
      setFormData((prev: any) => ({
        ...prev,
        userAgentApi: pendingUa!.api,
        userAgentEmbedded: pendingUa!.embedded,
      }));
      setVerifyStatus("idle");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      toast({
        title: "Device Changed",
        description: "New device fingerprint assigned. Session cleared — re-verify to reactivate.",
      });
    } catch {
      toast({ title: "Error", description: "Failed to change device.", variant: "destructive" });
    } finally {
      setPendingUa(null);
      setUaChangeConfirmOpen(false);
    }
  };

  const handleClearCookies = async () => {
    setClearCookiesStatus("clearing");
    try {
      const res = await fetch(`/api/profiles/${profileId}/clear-session-cookies`, { method: "POST" });
      if (res.ok) {
        setClearCookiesStatus("ok");
        setVerifyStatus("idle");
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        toast({ title: "Cookies Cleared", description: "Session cookies wiped. Account set to Pending." });
        setTimeout(() => setClearCookiesStatus("idle"), 2500);
      } else {
        setClearCookiesStatus("error");
        setTimeout(() => setClearCookiesStatus("idle"), 3000);
      }
    } catch {
      setClearCookiesStatus("error");
      setTimeout(() => setClearCookiesStatus("idle"), 3000);
    }
  };

  if ((profileLoading && !profile) || (toolsLoading && !tools)) {
    return <AppLayout><div className="p-8 text-muted-foreground">Loading profile...</div></AppLayout>;
  }

  if (!profile || !formData) {
    return <AppLayout><div className="p-8 text-destructive">Profile not found.</div></AppLayout>;
  }

  const canVerify = formData.username.trim().length > 0 && formData.password.trim().length > 0;

  const getTool = (type: string) => tools?.find(t => t.type === type);

  // Profile switcher helpers — when viewing a template, only show other templates; else only show non-templates
  const sortedProfiles = [...(allProfiles ?? [])].filter(p =>
    currentIsTemplate ? p.isTemplate === true : !p.isTemplate
  ).sort((a, b) =>
    (a.accountLabel || a.username).toLowerCase().localeCompare((b.accountLabel || b.username).toLowerCase())
  );
  const switcherProfiles = profileSearch.trim()
    ? sortedProfiles.filter(p => {
        const q = profileSearch.toLowerCase();
        return (p.username ?? "").toLowerCase().includes(q) || (p.accountLabel ?? "").toLowerCase().includes(q);
      })
    : sortedProfiles;
  const currentIdx  = sortedProfiles.findIndex(p => p.id === profileId);
  const prevProfile = currentIdx > 0 ? sortedProfiles[currentIdx - 1] : null;
  const nextProfile = currentIdx < sortedProfiles.length - 1 ? sortedProfiles[currentIdx + 1] : null;

  return (
    <AppLayout>
      <Tabs.Root value={activeTab} onValueChange={(tab) => navigate(`/profiles/${profileId}?tab=${tab}`)} className="w-full">
        <div className="w-full">
          <div className="flex items-center gap-4 mb-3">
            <div className="flex-1 space-y-1">
              {/* Row 1 — Trust Score breadcrumb (shown only when arriving from Trust Scores tab) */}
              {fromTrustScoreLevel && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground pb-0.5">
                  <button
                    onClick={() => navigate("/tools")}
                    className="flex items-center gap-1 hover:text-primary transition-colors"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    <span>Trust Scores</span>
                  </button>
                  <span className="text-muted-foreground/40">/</span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold"
                    style={{ background: fromTrustScoreLevel.bg, border: `1px solid ${fromTrustScoreLevel.border}`, color: fromTrustScoreLevel.text, fontSize: 11 }}
                  >
                    {(() => { const Icon = fromTrustScoreLevel.icon; return <Icon size={10} color={fromTrustScoreLevel.text} fill={fromTrustScoreLevel.text} strokeWidth={2} />; })()}
                    {fromTrustScoreLevel.label}
                  </span>
                  <span className="text-muted-foreground/40 ml-1">Template Account</span>
                </div>
              )}
              {/* Row 2 — status pill + account picker + trustscore + nav links */}
              <div className="flex items-center gap-1 flex-wrap">
                {(() => {
                  const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
                  const meta = STATUS_META[acctStatus] ?? STATUS_META.pending;
                  const Icon = meta.icon;
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          title={profile.statusMessage || undefined}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full border cursor-pointer hover:opacity-80 transition-opacity ${meta.pill}`}
                        >
                          <Icon className="w-3 h-3" />
                          {meta.label}
                          <ChevronDown className="w-3 h-3 ml-0.5 opacity-60" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-52 p-1">
                        {ACCOUNT_STATUSES.map(s => {
                          const m = STATUS_META[s] ?? STATUS_META.pending;
                          const I = m.icon;
                          return (
                            <DropdownMenuItem
                              key={s}
                              onClick={() => updateAccountStatusMutation.mutate({ id: profileId, accountStatus: s })}
                              className={`flex items-center gap-2 cursor-pointer px-3 py-2 rounded-md text-sm font-medium ${s === acctStatus ? "bg-accent" : ""}`}
                            >
                              <I className="w-3.5 h-3.5" />
                              {m.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                })()}
                <TrustScoreBadge profileId={profileId} />
                <button
                  onClick={() => prevProfile && navigate(`/profiles/${prevProfile.id}?tab=${activeTab}`)}
                  disabled={!prevProfile}
                  title={prevProfile ? (prevProfile.accountLabel || prevProfile.username) : undefined}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <DropdownMenu onOpenChange={open => { if (!open) setProfileSearch(""); }}>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent transition-colors">
                      <Instagram className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-2xl font-bold tracking-tight text-foreground">
                        {profile.accountLabel || profile.username}
                      </span>
                      <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[400px] p-0">
                    <div className="flex items-center gap-2 px-3 py-2 border-b">
                      <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <input
                        value={profileSearch}
                        onChange={e => setProfileSearch(e.target.value)}
                        placeholder="Search profiles…"
                        className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                        autoFocus
                      />
                      {profileSearch && (
                        <button onClick={() => setProfileSearch("")} className="text-muted-foreground hover:text-foreground">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                      {switcherProfiles.length === 0 ? (
                        <div className="px-3 py-4 text-center text-sm text-muted-foreground">No profiles found</div>
                      ) : switcherProfiles.map(p => {
                        const tsId = getTrustScore(p.id);
                        const tsLevel = tsId ? getTrustLevels().find(l => l.id === tsId) : null;
                        return (
                          <DropdownMenuItem
                            key={p.id}
                            onClick={() => navigate(`/profiles/${p.id}?tab=${activeTab}`)}
                            className={`flex items-center gap-2.5 cursor-pointer px-3 py-2 ${p.id === profileId ? "bg-accent" : ""}`}
                          >
                            <Instagram className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <span className={`flex-1 truncate text-sm ${p.id === profileId ? "font-semibold" : ""}`}>
                              {p.accountLabel || p.username}{(p.tags ?? "").trim() ? ` - ${(p.tags ?? "").trim()}` : ""}
                            </span>
                            {tsLevel && (
                              <span
                                className="flex items-center gap-1 rounded-full px-1.5 py-0.5 shrink-0"
                                style={{ background: "#1AD2F2" }}
                              >
                                <tsLevel.icon size={9} color="#fff" fill="#fff" strokeWidth={2} />
                                <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                                  {tsLevel.label}
                                </span>
                              </span>
                            )}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  onClick={() => nextProfile && navigate(`/profiles/${nextProfile.id}?tab=${activeTab}`)}
                  disabled={!nextProfile}
                  title={nextProfile ? (nextProfile.accountLabel || nextProfile.username) : undefined}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* ── Horizontal tool tab bar — always visible ── */}
          {!profile?.creatorMode && (
            <div className="flex items-center gap-0 border-b border-border mb-4 overflow-x-auto [&::-webkit-scrollbar]:h-0 [scrollbar-width:none]">
              {([
                { value: "settings",      label: "ACCOUNT SETTINGS",  icon: Settings    },
                { value: "human-session", label: "HUMAN SESSION TOOL", icon: Fingerprint },
              ] as { value: string; label: string; icon: React.ElementType }[]).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => navigate(`/profiles/${profileId}?tab=${value}`)}
                  className={[
                    "flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold transition-all border-b-2 whitespace-nowrap shrink-0",
                    activeTab === value
                      ? "text-primary border-primary"
                      : "text-[#1D4ED8] border-transparent hover:border-border",
                  ].join(" ")}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  {label}
                </button>
              ))}
              {/* Action buttons — inline after HUMAN SESSION TOOL */}
              <div className="flex items-center border-l border-border/50">
                <button
                  onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded || "")}
                  className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold text-[#1D4ED8] border-b-2 border-transparent hover:border-border whitespace-nowrap shrink-0 transition-all"
                >
                  <Monitor className="w-3.5 h-3.5 shrink-0" />
                  BROWSER
                </button>
                <Link
                  href="/"
                  onClick={() => sessionStorage.setItem("dashboard:profileId", String(profile.id))}
                  className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold text-[#1D4ED8] border-b-2 border-transparent hover:border-border whitespace-nowrap shrink-0 transition-all"
                >
                  <BarChart2 className="w-3.5 h-3.5 shrink-0" />
                  DASH
                </Link>
                <Link
                  href={`/stats?profileId=${profileId}&tab=metrics`}
                  className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold text-[#1D4ED8] border-b-2 border-transparent hover:border-border whitespace-nowrap shrink-0 transition-all"
                >
                  <Activity className="w-3.5 h-3.5 shrink-0" />
                  METRICS
                </Link>
                <button
                  onClick={() => navigate(`/profiles/${profileId}?tab=session-log`)}
                  className={[
                    "flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold transition-all border-b-2 whitespace-nowrap shrink-0",
                    activeTab === "session-log"
                      ? "text-primary border-primary"
                      : "text-[#1D4ED8] border-transparent hover:border-border",
                  ].join(" ")}
                >
                  <Activity className="w-3.5 h-3.5 shrink-0" />
                  SESSION LOG
                </button>
                <button
                  className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-bold text-[#1D4ED8] border-b-2 border-transparent hover:border-border whitespace-nowrap shrink-0 transition-all"
                  onClick={() => {
                    if (activeTab === "human-session" && getTool('human_sessions')) {
                      setHumanCopyOpen(true);
                    } else {
                      setCopyDialogOpen(true);
                    }
                  }}
                >
                  <Copy className="w-3.5 h-3.5 shrink-0" />
                  COPY SETTINGS
                </button>
              </div>
            </div>
          )}

        <Tabs.Content value="settings" className="outline-none animate-in fade-in duration-300">
          <CopySettingsDialog
            open={copyDialogOpen}
            onOpenChange={setCopyDialogOpen}
            title="Copy Account Settings"
            profiles={otherProfiles}
            optionGroups={ACCOUNT_COPY_GROUPS}
            onCopy={handleAccountCopy}
            sharedTargetsStorageKey="copyDialog:shared:targets"
          />

          <div className="flex gap-6 items-start">
          <div className="flex-1 min-w-0">

          {/* Group — top row */}
          <div className="pb-2">
            <div className="flex items-center gap-3">
              <GroupCombobox
                value={formData.tags || ""}
                groups={Array.from(new Set((allProfiles ?? []).map(p => (p.tags ?? "").trim()).filter(Boolean))).sort()}
                onChange={val => updateField({ tags: val })}
              />
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap shrink-0">Group</Label>
            </div>
          </div>

          {/* Account Label */}
          <div className="space-y-2 pb-2">
            <div className="flex items-center gap-3">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Account Name
              </Label>
              {profile?.creatorMode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2 h-8 text-xs text-sky-600 border-sky-400/50 hover:text-sky-700 hover:border-sky-500/70 hover:bg-sky-500/5"
                  disabled={moveToAccountsMutation.isPending}
                  onClick={() => moveToAccountsMutation.mutate(profileId, {
                    onSuccess: () => {
                      toast({ title: "Moved to Accounts", description: "This account is now ready for automation." });
                      window.location.href = "/profiles";
                    }
                  })}
                >
                  <Users className="w-3.5 h-3.5" />
                  {moveToAccountsMutation.isPending ? "Moving…" : "Move to Accounts"}
                </Button>
              )}
              <div className="flex items-center gap-1.5 ml-1">
                <Switch
                  checked={profile?.accountStatus !== "stopped"}
                  disabled={updateAccountStatusMutation.isPending}
                  onCheckedChange={checked => {
                    if (!checked) {
                      preStoppedStatusRef.current = profile?.accountStatus ?? "pending";
                      updateAccountStatusMutation.mutate({ id: profileId, accountStatus: "stopped" });
                    } else {
                      updateAccountStatusMutation.mutate({ id: profileId, accountStatus: preStoppedStatusRef.current });
                    }
                  }}
                />
                <span className="text-[10px] text-muted-foreground select-none">
                  {profile?.accountStatus === "stopped" ? "Stopped" : "Active"}
                </span>
              </div>
            </div>
            <div className="max-w-[34%]">
              <Input
                placeholder="e.g. @Account1"
                value={formData.accountLabel}
                onChange={e => updateField({ accountLabel: e.target.value })}
              />
            </div>
          </div>

          <div>
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2 border-b border-border">
                <CardTitle className="flex items-center gap-2"><User className="w-5 h-5 text-primary" /> Instagram Login Information</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 space-y-4 pt-3">
                <div className="space-y-4">
                  {/* Credentials + verify */}
                  <div className="space-y-3">
                    <div className="flex items-end gap-3">
                      <div className="space-y-1.5 flex-1 max-w-[260px]">
                        <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Instagram className="w-3.5 h-3.5" /> Username</Label>
                        <Input
                          value={formData.username}
                          onChange={e => updateField({ username: e.target.value })}
                          data-testid="input-username"
                        />
                      </div>
                      <div className="space-y-1.5 flex-1 max-w-[260px]">
                        <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Lock className="w-3.5 h-3.5" /> Password</Label>
                        <PasswordInput
                          value={formData.password}
                          onChange={e => updateField({ password: e.target.value })}
                          data-testid="input-password"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><KeyRound className="w-3.5 h-3.5" /> 2FA Secret Key</Label>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Input
                          className="max-w-[370px]"
                          placeholder=""
                          value={formData.twoFASecretKey}
                          onChange={e => { updateField({ twoFASecretKey: e.target.value }); setTotpCode(null); setTotpError(null); }}
                          data-testid="input-2fa-secret"
                        />
                        <button
                          type="button"
                          disabled={!formData.twoFASecretKey?.trim()}
                          onClick={() => generateTotp(formData.twoFASecretKey)}
                          className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold bg-muted hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {totpCopied ? `Copied! ${totpCode}` : "Generate Code"}
                        </button>
                        <span className="text-border text-lg select-none">|</span>
                        <button
                          type="button"
                          onClick={() => setResetDeviceConfirmOpen(true)}
                          disabled={updateProfileMutation.isPending}
                          className="flex items-center gap-1.5 text-xs text-foreground font-bold hover:text-foreground/70 transition-colors disabled:opacity-50 text-left shrink-0"
                        >
                          <Smartphone className="w-3.5 h-3.5 shrink-0" />
                          Reset Device IDs
                        </button>
                        <span className="text-border text-lg select-none">|</span>
                        {(() => {
                          const cookies: string = (profile as any).igApiCookies ?? "";
                          const hasSession = cookies.split(";").some(s => {
                            const [k, v] = s.trim().split("=");
                            return k?.toLowerCase() === "sessionid" && (v?.length ?? 0) > 5;
                          });
                          return (
                            <span className="inline-flex items-center gap-2 shrink-0">
                              {hasSession ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
                                  <Cookie className="w-3 h-3" />
                                  Session Cookie: <span className="font-bold">Passed</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600">
                                  <Cookie className="w-3 h-3" />
                                  Session Cookie: <span className="font-bold">Not set</span>
                                </span>
                              )}
                              <button
                                type="button"
                                disabled={clearCookiesStatus === "clearing"}
                                onClick={async () => {
                                  setClearCookiesStatus("clearing");
                                  try {
                                    const res = await fetch(`/api/profiles/${profile.id}/clear-session-cookies`, { method: "POST" });
                                    if (res.ok) { setClearCookiesStatus("ok"); setTimeout(() => setClearCookiesStatus("idle"), 2500); }
                                    else setClearCookiesStatus("error");
                                  } catch { setClearCookiesStatus("error"); }
                                }}
                                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 font-semibold border border-border rounded px-1.5 py-0.5 hover:border-destructive/50"
                              >
                                {clearCookiesStatus === "clearing" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                {clearCookiesStatus === "ok" ? "Cleared" : clearCookiesStatus === "clearing" ? "Clearing…" : "Clear Cookies"}
                              </button>
                            </span>
                          );
                        })()}
                        {totpError && <span className="text-xs text-destructive">{totpError}</span>}
                      </div>
                    </div>

                    {/* Verify Account + Fire Random Endpoints — same row */}
                    {canVerify && (
                      <div className="flex items-center gap-4 flex-wrap">
                        {/* Verify button */}
                        <div className="w-[200px] shrink-0">
                          {verifyStatus === "ok" ? (
                            <div
                              data-testid="status-logged-in"
                              className="h-9 flex items-center justify-center gap-2 rounded-md border border-green-500 bg-green-50 text-green-700 font-medium text-sm cursor-default select-none"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              Logged In
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant={verifyStatus === "fail" ? "outline" : "default"}
                              className={`w-full h-9 gap-2 transition-all ${
                                verifyStatus === "fail"
                                  ? "border-destructive text-destructive bg-destructive/5 hover:bg-destructive/10"
                                  : "bg-sky-400 hover:bg-sky-500 text-white border-0"
                              }`}
                              onClick={() => handleVerify(false)}
                              disabled={verifyStatus === "pending" || profile.accountStatus === "verifying"}
                              data-testid="button-verify-credentials"
                            >
                              {(verifyStatus === "pending" || profile.accountStatus === "verifying") && <Loader2 className="w-4 h-4 animate-spin" />}
                              {verifyStatus === "fail" && profile.accountStatus !== "verifying" && <XCircle className="w-4 h-4" />}
                              {verifyStatus === "idle" && profile.accountStatus !== "verifying" && <ShieldCheck className="w-4 h-4" />}
                              {(verifyStatus === "pending" || profile.accountStatus === "verifying") ? "Verifying…"
                                : verifyStatus === "fail" ? "Retry Verification"
                                : "Verify Account"}
                            </Button>
                          )}
                        </div>
                        {/* Fire Unique Endpoints on Login — all controls on one row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              id={`loginRandomEndpointsEnabled-${profile.id}`}
                              checked={!!(formData.apiLimits as any).loginRandomEndpointsEnabled}
                              onChange={e => updateField({ apiLimits: { ...formData.apiLimits, loginRandomEndpointsEnabled: e.target.checked } })}
                              className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                            />
                            <Label htmlFor={`loginRandomEndpointsEnabled-${profile.id}`} className="text-xs font-medium cursor-pointer whitespace-nowrap">Fire Unique Endpoints on Login</Label>
                          </div>
                          {(formData.apiLimits as any).loginRandomEndpointsEnabled && (
                            <>
                              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min</span>
                              <Input
                                type="number"
                                min={1}
                                max={17}
                                className="h-7 text-xs w-14"
                                value={(formData.apiLimits as any).loginRandomEndpointsMin ?? 1}
                                onChange={e => updateField({ apiLimits: { ...formData.apiLimits, loginRandomEndpointsMin: Math.max(1, Number(e.target.value)) } })}
                              />
                              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max</span>
                              <Input
                                type="number"
                                min={1}
                                max={17}
                                className="h-7 text-xs w-14"
                                value={(formData.apiLimits as any).loginRandomEndpointsMax ?? 5}
                                onChange={e => {
                                  const v = Math.max(1, Number(e.target.value));
                                  const min = (formData.apiLimits as any).loginRandomEndpointsMin ?? 1;
                                  updateField({ apiLimits: { ...formData.apiLimits, loginRandomEndpointsMax: Math.max(min, v) } });
                                }}
                              />
                              <span className="text-border/60 select-none">·</span>
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  id={`loginMakePostChanceEnabled-${profile.id}`}
                                  checked={!!(formData.apiLimits as any).loginMakePostChanceEnabled}
                                  onChange={e => updateField({ apiLimits: { ...formData.apiLimits, loginMakePostChanceEnabled: e.target.checked } })}
                                  className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                                />
                                <Label htmlFor={`loginMakePostChanceEnabled-${profile.id}`} className="text-xs font-medium cursor-pointer whitespace-nowrap">Chance of Making a Post</Label>
                              </div>
                              {(formData.apiLimits as any).loginMakePostChanceEnabled && (
                                <>
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min %</span>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    className="h-7 text-xs w-14"
                                    value={(formData.apiLimits as any).loginMakePostChanceMin ?? 5}
                                    onChange={e => updateField({ apiLimits: { ...formData.apiLimits, loginMakePostChanceMin: Math.max(0, Math.min(100, Number(e.target.value))) } })}
                                  />
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max %</span>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    className="h-7 text-xs w-14"
                                    value={(formData.apiLimits as any).loginMakePostChanceMax ?? 10}
                                    onChange={e => {
                                      const v = Math.max(0, Math.min(100, Number(e.target.value)));
                                      const min = (formData.apiLimits as any).loginMakePostChanceMin ?? 5;
                                      updateField({ apiLimits: { ...formData.apiLimits, loginMakePostChanceMax: Math.max(min, v) } });
                                    }}
                                  />
                                  <p className="text-[10px] text-muted-foreground whitespace-nowrap">per verify</p>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Proxy Settings */}
                    <div className="pt-3 border-t border-border mt-3">
                      <div className="flex flex-col gap-0">
                        <div className="w-full space-y-3">
                          <h4 className="text-sm font-bold flex items-center gap-2"><Globe className="w-4 h-4 text-primary" /> Proxy Settings</h4>
                          {(() => {
                            const linked = proxies?.find(p => p.id === profile.proxyId);
                            if (linked) {
                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Input
                                      value={linkedHostPort}
                                      onChange={e => setLinkedHostPort(e.target.value)}
                                      onBlur={() => saveLinkedField("hostPort")}
                                      onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                      className="text-sm h-8 w-48 shrink-0"
                                      placeholder="host:port"
                                    />
                                    <Input
                                      value={linkedUsername}
                                      onChange={e => setLinkedUsername(e.target.value)}
                                      onBlur={() => saveLinkedField("username")}
                                      onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                      placeholder="username"
                                      className="text-sm h-8 w-32 shrink-0"
                                    />
                                    <Input
                                      value={linkedPassword}
                                      onChange={e => setLinkedPassword(e.target.value)}
                                      onBlur={() => saveLinkedField("password")}
                                      onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                      placeholder="password"
                                      className="text-sm h-8 w-32 shrink-0"
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 px-2 shrink-0"
                                      onClick={() => updateProfileMutation.mutate({ id: profileId, proxyId: null })}
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div className="space-y-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Input
                                    value={formData.proxyHost && formData.proxyPort ? `${formData.proxyHost}:${formData.proxyPort}` : formData.proxyHost || ""}
                                    onChange={e => {
                                      const val = e.target.value;
                                      const lastColon = val.lastIndexOf(":");
                                      if (lastColon !== -1) {
                                        updateField({ proxyHost: val.slice(0, lastColon), proxyPort: val.slice(lastColon + 1) });
                                      } else {
                                        updateField({ proxyHost: val, proxyPort: "" });
                                      }
                                    }}
                                    onBlur={saveManualProxyField}
                                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                    placeholder="host:port"
                                    className="text-sm h-8 w-48 shrink-0 font-mono"
                                  />
                                  <Input
                                    value={formData.proxyUsername}
                                    onChange={e => updateField({ proxyUsername: e.target.value })}
                                    onBlur={saveManualProxyField}
                                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                    placeholder="username"
                                    className="text-sm h-8 w-32 shrink-0"
                                  />
                                  <Input
                                    value={formData.proxyPassword}
                                    onChange={e => updateField({ proxyPassword: e.target.value })}
                                    onBlur={saveManualProxyField}
                                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                    placeholder="password"
                                    className="text-sm h-8 w-32 shrink-0"
                                  />
                                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-muted-foreground whitespace-nowrap shrink-0">
                                    <input
                                      type="checkbox"
                                      checked={!!formData.useHomeIp}
                                      onChange={e => {
                                        updateField({ useHomeIp: e.target.checked });
                                        updateProfileMutation.mutate({ id: profileId, useHomeIp: e.target.checked });
                                      }}
                                      className="w-3.5 h-3.5 rounded accent-primary"
                                    />
                                    Use Home IP
                                  </label>
                                </div>
                                {proxies && proxies.length > 0 && (
                                  <select
                                    className="h-7 w-full max-w-sm rounded border border-dashed border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer hover:border-primary/50 transition-colors"
                                    value=""
                                    onChange={e => {
                                      if (e.target.value) updateProfileMutation.mutate({ id: profileId, proxyId: Number(e.target.value) });
                                    }}
                                  >
                                    <option value="">+ Assign to proxy from Proxy Manager…</option>
                                    {proxies.map(p => (
                                      <option key={p.id} value={p.id}>{p.host}:{p.port}{p.username ? ` (${p.username})` : ""}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                        <div className="w-full space-y-3 pt-4 mt-3 border-t border-border">
                          {/* Row 1: Title + Test Timing */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="text-sm font-bold flex items-center gap-2 shrink-0"><Zap className="w-4 h-4 text-yellow-500" /> API Limits &amp; Control</h4>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-xs px-2 whitespace-nowrap shrink-0"
                              onClick={() => {
                                const minCalls = Math.max(1, formData.apiLimits.requestsMin || 1);
                                const maxCalls = Math.max(minCalls, formData.apiLimits.requestsMax || 1);
                                const toMs = (v: number) => (v < 1000 ? v * 1000 : v);
                                const rawMin = Math.max(0, formData.apiLimits.everySecondsMin || 0);
                                const rawMax = Math.max(rawMin, formData.apiLimits.everySecondsMax || 0);
                                const minMs = toMs(rawMin);
                                const maxMs = toMs(rawMax);
                                const calls = Math.floor(Math.random() * (maxCalls - minCalls + 1)) + minCalls;
                                const windowMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
                                const delayMs = Math.max(0, Math.floor(windowMs / Math.max(1, calls)));
                                const fmt = (v: number) => v >= 60000 ? `${(v / 60000).toFixed(1)}m` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
                                setTimingInfo(`${calls} call${calls !== 1 ? "s" : ""} every ${fmt(delayMs)}`);
                              }}
                            >
                              Test Timing
                            </Button>
                            {timingInfo && <span className="text-[10px] text-green-600 font-semibold whitespace-nowrap">{timingInfo}</span>}
                          </div>
                          {/* Row 2: Min / Max / Min (ms) / Max (ms) + Variation % — all on the same row, center-aligned */}
                          <div className="flex flex-wrap gap-x-2 gap-y-1 items-center">
                            <div className="flex flex-col items-center space-y-1">
                              <NumField min={0} className="h-7 text-xs w-[52px]" value={formData.apiLimits.requestsMin ?? 0} onChange={v => updateField({ apiLimits: {...formData.apiLimits, requestsMin: v} })} />
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min</Label>
                            </div>
                            <div className="flex flex-col items-center space-y-1">
                              <NumField min={0} className="h-7 text-xs w-[52px]" value={formData.apiLimits.requestsMax ?? 0} onChange={v => updateField({ apiLimits: {...formData.apiLimits, requestsMax: Math.max(v, formData.apiLimits.requestsMin ?? 0)} })} />
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max</Label>
                            </div>
                            <div className="flex flex-col items-center space-y-1">
                              <NumField min={0} className="h-7 text-xs w-[80px]" value={formData.apiLimits.everySecondsMin ?? 0} onChange={v => updateField({ apiLimits: {...formData.apiLimits, everySecondsMin: v} })} />
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min (ms)</Label>
                            </div>
                            <div className="flex flex-col items-center space-y-1">
                              <NumField min={0} className="h-7 text-xs w-[80px]" value={formData.apiLimits.everySecondsMax ?? 0} onChange={v => updateField({ apiLimits: {...formData.apiLimits, everySecondsMax: Math.max(v, formData.apiLimits.everySecondsMin ?? 0)} })} />
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max (ms)</Label>
                            </div>
                            {/* Variation % — checkbox on same row; expanded fields wrap below if needed */}
                            <div className="flex items-center ml-1">
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-bold shrink-0">
                                      <input type="checkbox" checked={!!(formData.apiLimits as any).variationEnabled} onChange={e => updateField({ apiLimits: { ...formData.apiLimits, variationEnabled: e.target.checked } })} className="h-3.5 w-3.5 accent-primary cursor-pointer" />
                                      Variation %
                                    </label>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[300px] whitespace-normal leading-snug">
                                    <p className="font-semibold mb-1">Variation %</p>
                                    <p>Occasionally spikes calls above or below your normal delay range to break up rhythm.</p>
                                    <p className="mt-1.5 opacity-80 italic">e.g. 10% chance, +30–60 s above max — roughly 1 in 10 calls adds an extra 30–60 second pause on top of the normal window.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                            {!!(formData.apiLimits as any).variationEnabled && (
                              <div className="flex items-end gap-1 flex-wrap">
                                <div className="flex items-end gap-1">
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationLowerChanceMin ?? (formData.apiLimits as any).variationLowerChance ?? 10} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationLowerChanceMin: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min %</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3">–</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationLowerChanceMax ?? (formData.apiLimits as any).variationLowerChance ?? 10} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationLowerChanceMax: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max %</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3 mx-0.5">-</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationLowerSecsMin ?? (formData.apiLimits as any).variationLowerSecs ?? 20} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationLowerSecsMin: v } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min secs</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3">–</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationLowerSecsMax ?? (formData.apiLimits as any).variationLowerSecs ?? 30} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationLowerSecsMax: v } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max secs</Label>
                                  </div>
                                </div>
                                <div className="flex items-end gap-1">
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationUpperChanceMin ?? (formData.apiLimits as any).variationUpperChance ?? 10} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationUpperChanceMin: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min %</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3">–</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationUpperChanceMax ?? (formData.apiLimits as any).variationUpperChance ?? 10} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationUpperChanceMax: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max %</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3 mx-0.5">+</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationUpperSecsMin ?? (formData.apiLimits as any).variationUpperSecs ?? 45} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationUpperSecsMin: v } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min secs</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground pb-3">–</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).variationUpperSecsMax ?? (formData.apiLimits as any).variationUpperSecs ?? 60} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, variationUpperSecsMax: v } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max secs</Label>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                          {/* Row 3: Momentum + Attention Drift + Fatigue — all on one row */}
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1.5 border-t border-border/40 items-end">
                            {/* Momentum */}
                            <div className="flex flex-col items-start space-y-0.5">
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-bold shrink-0 h-6">
                                      <input type="checkbox" checked={!!(formData.apiLimits as any).momentumEnabled} onChange={e => updateField({ apiLimits: { ...formData.apiLimits, momentumEnabled: e.target.checked } })} className="h-3.5 w-3.5 accent-primary cursor-pointer" />
                                      Momentum
                                    </label>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[300px] whitespace-normal leading-snug">
                                    <p className="font-semibold mb-1">Momentum</p>
                                    <p>Pulls each call's delay toward the previous one — creating natural bursts of fast calls and slow-down plateaus, like a human who gets into a rhythm.</p>
                                    <p className="mt-1.5 opacity-80 italic">e.g. 70% Chance, 20% Spread — 70% of the time the next delay stays within ±20% of the last one instead of picking a fresh random value.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block">&nbsp;</Label>
                            </div>
                            {!!(formData.apiLimits as any).momentumEnabled && (
                              <>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={0} max={100} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).momentumChance ?? 70} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, momentumChance: Math.min(100, v) } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Chance %</Label>
                                </div>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={0} max={100} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).momentumSpread ?? 20} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, momentumSpread: Math.min(100, v) } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Spread %</Label>
                                </div>
                              </>
                            )}
                            {/* Separator */}
                            <span className="text-muted-foreground/30 text-xs select-none pb-[14px]">|</span>
                            {/* Attention Drift */}
                            <div className="flex flex-col items-start space-y-0.5">
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-bold shrink-0 h-6">
                                      <input type="checkbox" checked={!!(formData.apiLimits as any).attentionDriftEnabled} onChange={e => updateField({ apiLimits: { ...formData.apiLimits, attentionDriftEnabled: e.target.checked } })} className="h-3.5 w-3.5 accent-primary cursor-pointer" />
                                      Attention Drift
                                    </label>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[300px] whitespace-normal leading-snug">
                                    <p className="font-semibold mb-1">Attention Drift</p>
                                    <p>Simulates a human stepping away from the keyboard — randomly inserts a multi-minute gap into the call schedule, then resumes normally.</p>
                                    <p className="mt-1.5 opacity-80 italic">e.g. 5–8% Chance, 5–10 Min — roughly 1 in 15 calls triggers a 5–10 minute pause before the next call fires.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block">&nbsp;</Label>
                            </div>
                            {!!(formData.apiLimits as any).attentionDriftEnabled && (
                              <>
                                <div className="flex items-center gap-1">
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).attentionDriftChanceMin ?? (formData.apiLimits as any).attentionDriftChance ?? 3} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, attentionDriftChanceMin: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min %</Label>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground mb-3.5">–</span>
                                  <div className="flex flex-col items-center space-y-0.5">
                                    <NumField min={0} max={100} className="h-6 text-xs w-[48px]" value={(formData.apiLimits as any).attentionDriftChanceMax ?? (formData.apiLimits as any).attentionDriftChance ?? 5} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, attentionDriftChanceMax: Math.min(100, v) } })} />
                                    <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max %</Label>
                                  </div>
                                </div>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={0} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).attentionDriftMinMins ?? 5} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, attentionDriftMinMins: v } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Min Mins</Label>
                                </div>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={0} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).attentionDriftMaxMins ?? 15} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, attentionDriftMaxMins: Math.max(v, (formData.apiLimits as any).attentionDriftMinMins ?? 5) } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Max Mins</Label>
                                </div>
                              </>
                            )}
                            {/* Separator */}
                            <span className="text-muted-foreground/30 text-xs select-none pb-[14px]">|</span>
                            {/* Fatigue */}
                            <div className="flex flex-col items-start space-y-0.5">
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-bold shrink-0 h-6">
                                      <input type="checkbox" checked={!!(formData.apiLimits as any).fatigueEnabled} onChange={e => updateField({ apiLimits: { ...formData.apiLimits, fatigueEnabled: e.target.checked } })} className="h-3.5 w-3.5 accent-primary cursor-pointer" />
                                      Fatigue
                                    </label>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[300px] whitespace-normal leading-snug">
                                    <p className="font-semibold mb-1">Fatigue</p>
                                    <p>Gradually slows calls over a ramp period then speeds back up — mimics a human tiring and recovering in waves.</p>
                                    <p className="mt-1.5 opacity-80 italic">e.g. 50% Strength, 30 Ramp Calls — over the first 30 calls the delay rises up to 50% toward the max, then falls back to normal over the next 30, repeating continuously.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block">&nbsp;</Label>
                            </div>
                            {!!(formData.apiLimits as any).fatigueEnabled && (
                              <>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={0} max={100} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).fatigueStrength ?? 50} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, fatigueStrength: Math.min(100, v) } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Strength %</Label>
                                </div>
                                <div className="flex flex-col items-center space-y-0.5">
                                  <NumField min={1} className="h-6 text-xs w-[60px]" value={(formData.apiLimits as any).fatigueRampCalls ?? 30} onChange={v => updateField({ apiLimits: { ...formData.apiLimits, fatigueRampCalls: Math.max(1, v) } })} />
                                  <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground block text-center">Ramp Calls</Label>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <AlertDialog open={resetDeviceConfirmOpen} onOpenChange={setResetDeviceConfirmOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset Device IDs?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will assign a new random device fingerprint (User Agent, Device ID, UUID) to this account and set its status to Pending. Instagram may require a fresh verification after this change.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleResetDeviceIds}>Reset</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* ── Device Fingerprint ── */}
                  <div className="pt-4 border-t border-border mt-4 space-y-4">
                    <h4 className="text-sm font-bold flex items-center gap-2"><Shield className="w-4 h-4 text-primary" /> Device Fingerprint</h4>

                    {/* Computed identity chips — derived from the embedded UA seed */}
                    {formData.userAgentEmbedded && (() => {
                      const fp = computeFingerprint(formData.userAgentEmbedded, formData.userAgentApi);
                      const battColor = fp.batteryPct > 25 ? "text-green-600" : fp.batteryPct > 5 ? "text-amber-600" : "text-red-600";
                      const battBar   = fp.batteryPct > 25 ? "bg-green-400"  : fp.batteryPct > 5 ? "bg-amber-400"  : "bg-red-400";
                      const Chip = ({ icon: Icon, label, value, iconCls }: { icon: React.ElementType; label: string; value: string; iconCls?: string }) => (
                        <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 text-xs">
                          <Icon className={`w-3 h-3 shrink-0 ${iconCls ?? "text-slate-500"}`} />
                          <span className="text-slate-400 font-medium">{label}</span>
                          <span className="font-semibold text-slate-700">{value}</span>
                        </div>
                      );
                      return (
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-1.5">
                            <Chip icon={Smartphone}  label="Device"  value={fp.device}                                              iconCls="text-indigo-500" />
                            <Chip icon={Monitor}     label="Screen"  value={`${fp.sw}×${fp.sh} @${fp.dpr}x`}                       iconCls="text-slate-500"  />
                            <Chip icon={Cpu}         label="CPU"     value={`${fp.cores} cores`}                                    iconCls="text-orange-500" />
                            <Chip icon={Server}      label="RAM"     value={`${fp.mem} GB`}                                         iconCls="text-purple-500" />
                            <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 text-xs">
                              {fp.charging
                                ? <BatteryCharging className="w-3 h-3 shrink-0 text-green-500" />
                                : <Battery className={`w-3 h-3 shrink-0 ${battColor}`} />}
                              <span className="text-slate-400 font-medium">Battery</span>
                              <div className="w-12 h-1 rounded-full bg-slate-200 overflow-hidden mx-0.5">
                                <div className={`h-full rounded-full ${battBar}`} style={{ width: `${fp.batteryPct}%` }} />
                              </div>
                              <span className={`font-semibold ${battColor}`}>{fp.batteryPct}%{fp.charging ? " ⚡" : ""}</span>
                            </div>
                            <Chip icon={Wifi}        label={fp.connType} value={`${fp.downlink} Mbps`}                              iconCls="text-blue-500"   />
                            <Chip icon={MapPin}      label="TZ"      value={fp.timezone}                                             iconCls="text-teal-500"   />
                          </div>
                        </div>
                      );
                    })()}

                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block">API User Agent</label>
                      <UaPickerDropdown
                        value={formData.userAgentApi ?? ""}
                        onSelect={handleUaDeviceSelect}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block">
                        Embedded Browser Agent
                        <span className="ml-2 text-[9px] font-normal text-muted-foreground/60 normal-case tracking-normal">(auto-matched when picking a device)</span>
                      </label>
                      <input
                        className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        style={{ width: `${Math.max(22, (formData.userAgentEmbedded || "Browser-like User Agent...").length + 6)}ch` }}
                        value={formData.userAgentEmbedded}
                        onChange={e => updateField({ userAgentEmbedded: e.target.value })}
                        placeholder="Browser-like User Agent..."
                      />
                    </div>

                    {/* ── Browser Fingerprint Preview ── */}
                    {formData.userAgentEmbedded && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setShowFingerprintPreview(v => !v)}
                          className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-primary transition-colors select-none"
                        >
                          <Fingerprint className="w-3.5 h-3.5 text-primary" />
                          Browser Fingerprint Preview
                          <span className="text-[10px] text-slate-400 font-normal normal-case ml-1">— what the Leak Tool measures</span>
                          <span className="ml-auto text-[10px]">{showFingerprintPreview ? "▲" : "▼"}</span>
                        </button>
                      </div>
                    )}
                    {formData.userAgentEmbedded && showFingerprintPreview && (() => {
                      const fp = computeFingerprint(formData.userAgentEmbedded, formData.userAgentApi);
                      const isMob = formData.userAgentEmbedded.includes("Mobile") && formData.userAgentEmbedded.includes("Android");

                      const fmtTime = (secs: number, isCharging: boolean) => {
                        if (isCharging && secs === 0) return "Full";
                        if (!isCharging && secs >= 86400) return "∞";
                        const h = Math.floor(secs / 3600);
                        const m = Math.floor((secs % 3600) / 60);
                        return h > 0 ? `${h}h ${m}m` : `${m}m`;
                      };

                      const Row = ({ label, value, muted }: { label: string; value: string; muted?: boolean }) => (
                        <div className="flex items-center justify-between py-[3px]">
                          <span className="text-[11px] text-slate-400">{label}</span>
                          <span className={`text-[11px] font-semibold ${muted ? "text-slate-400" : "text-slate-700"}`}>{value}</span>
                        </div>
                      );

                      const Pass = ({ label }: { label: string }) => (
                        <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded px-2 py-1">
                          <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
                          <span className="text-[11px] font-semibold text-green-700">{label}</span>
                        </div>
                      );

                      const battColor = fp.batteryPct > 25 ? "text-green-600" : fp.batteryPct > 5 ? "text-amber-600" : "text-red-600";

                      return (
                        <div className="border border-slate-200 rounded-lg overflow-hidden mt-2">
                          <div className="grid grid-cols-2 divide-x divide-slate-100">
                            {/* Screen & Hardware */}
                            <div className="px-3 py-2 space-y-0">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1"><Monitor className="w-3 h-3" /> Screen &amp; Hardware</p>
                              <Row label="Touch Points" value={isMob ? "10" : "0"} />
                              <Row label="Platform" value={isMob ? "Linux armv8l" : "Win32"} />
                              <Row label="Color Depth" value="24 bit" />
                              <Row label="Orientation" value={isMob ? "Portrait (0°)" : "Landscape (0°)"} />
                              <Row label="Available" value={`${fp.sw}×${fp.sh - (isMob ? 30 : 40)}`} />
                            </div>
                            {/* Battery */}
                            <div className="px-3 py-2 space-y-0">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1"><Battery className="w-3 h-3" /> Battery API</p>
                              <Row label="Level" value={`${fp.batteryPct}%${fp.charging ? " ⚡" : ""}`} />
                              <Row label="Charging" value={fp.charging ? "Yes" : "No"} />
                              <Row
                                label={fp.charging ? "Time to Full" : "Time Remaining"}
                                value={fmtTime(fp.chargeOrDischargeTime, fp.charging)}
                              />
                              <Row label={fp.charging ? "Discharging Time" : "Charging Time"} value="∞" muted />
                            </div>
                            {/* Network */}
                            <div className="px-3 py-2 space-y-0">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1"><Wifi className="w-3 h-3" /> Network Info</p>
                              <Row label="Type" value={fp.connType} />
                              <Row label="Effective Type" value="4G" />
                              <Row label="Downlink" value={`${fp.downlink} Mbps`} />
                              <Row label="RTT" value={`${fp.rtt} ms`} />
                              <Row label="Save Data" value="No" />
                            </div>
                            {/* Protections */}
                            <div className="px-3 py-2">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Stealth Protections</p>
                              <div className="flex flex-wrap gap-1.5">
                                <Pass label="WebRTC Blocked" />
                                <Pass label="Canvas Protected" />
                                <Pass label="Audio Protected" />
                                <Pass label="webdriver Hidden" />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── UA device-change confirmation dialog ── */}
                    <AlertDialog open={uaChangeConfirmOpen} onOpenChange={setUaChangeConfirmOpen}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Change Device?</AlertDialogTitle>
                          <AlertDialogDescription className="space-y-2">
                            <span className="block">
                              Switching to <strong>{pendingUa ? (() => { const p = pendingUa.api.split("; "); return `${p[3] ?? ""} ${p[4] ?? ""}`; })() : ""}</strong> will:
                            </span>
                            <ul className="list-disc pl-5 space-y-1 text-sm">
                              <li>Reset all Device IDs (UUID, Phone ID, Advertising ID)</li>
                              <li>Log you out of the current embedded browser session</li>
                              <li>Clear all stored cookies for this account</li>
                            </ul>
                            <span className="block pt-1">
                              The account will be set to <strong>Pending</strong> and will need to be re-verified before automation resumes.
                            </span>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel onClick={() => setPendingUa(null)}>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={handleUaChangeConfirm}>
                            Yes, Change Device
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>

                  {/* ── Do Actions Via Browser ── */}
                  <div className="space-y-3 pt-4 border-t border-border mt-4">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-primary" />
                      <h4 className="text-sm font-bold">Do Actions Via Browser</h4>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      When enabled, the selected actions use the embedded browser in the background
                      instead of the mobile API. The browser is never shown and closes immediately
                      after each action completes.
                    </p>
                    <div className="flex items-center gap-3 py-1">
                      <Switch
                        checked={!!formData.followViaBrowser}
                        onCheckedChange={checked => updateField({ followViaBrowser: checked })}
                        className="data-[state=checked]:bg-green-500"
                      />
                      <div>
                        <p className="text-xs font-semibold">Follows</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Navigate to the target's profile page and click the Follow button</p>
                      </div>
                    </div>
                  </div>

                  {/* ── Active Timer ── */}
                  <div className="space-y-4 pt-4 border-t border-border mt-4">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-primary" />
                      <h4 className="text-sm font-bold">Active Timer</h4>
                      <Switch
                        checked={!!formData.activeTimerEnabled}
                        onCheckedChange={checked => updateField({ activeTimerEnabled: checked })}
                      />
                    </div>
                    {formData.activeTimerEnabled ? (
                      <div className="space-y-3">
                        {parseActiveTimerSlots(formData.activeTimerStart, formData.activeTimerEnd).map((slot, i, arr) => (
                          <div key={i} className="flex items-center gap-2">
                            <div className="space-y-1 flex-1">
                              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Start</Label>
                              <Input
                                type="time"
                                value={slot.start}
                                onChange={e => {
                                  const slots = arr.map((s, j) => j === i ? { ...s, start: e.target.value } : s);
                                  updateField({ activeTimerStart: slots.length === 1 ? slots[0].start : JSON.stringify(slots), activeTimerEnd: slots[0].end });
                                }}
                              />
                            </div>
                            <div className="space-y-1 flex-1">
                              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">End</Label>
                              <Input
                                type="time"
                                value={slot.end}
                                onChange={e => {
                                  const slots = arr.map((s, j) => j === i ? { ...s, end: e.target.value } : s);
                                  updateField({ activeTimerStart: slots.length === 1 ? slots[0].start : JSON.stringify(slots), activeTimerEnd: slots[0].end });
                                }}
                              />
                            </div>
                            {arr.length > 1 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const slots = arr.filter((_, j) => j !== i);
                                  updateField({ activeTimerStart: slots.length === 1 ? slots[0].start : JSON.stringify(slots), activeTimerEnd: slots[0].end });
                                }}
                                className="mt-5 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                                title="Remove this window"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            const existing = parseActiveTimerSlots(formData.activeTimerStart, formData.activeTimerEnd);
                            const slots = [...existing, { start: "09:00", end: "22:00" }];
                            updateField({ activeTimerStart: JSON.stringify(slots), activeTimerEnd: slots[0].end });
                          }}
                          className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                        >
                          <PlusCircle className="w-3.5 h-3.5" /> Add time window
                        </button>
                        <p className="text-xs text-muted-foreground">
                          The account only runs automation tasks within these windows. Outside all windows it stays dormant.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground -mt-1">
                        Enable to restrict automation to specific hours of the day.
                      </p>
                    )}
                  </div>
                  
                </div>
              </CardContent>
            </Card>

          </div>

          {/* ── Second row: Account Details + Security + Email Validation ── */}
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setShowAccountDetails(v => !v)}
              className="flex items-center gap-2 w-full px-0 py-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors select-none border-b border-border mb-0"
            >
              <Tag className="w-4 h-4 text-primary" />
              Account Details, Security &amp; Email Validation
              <span className="ml-auto text-xs font-normal">{showAccountDetails ? "▲ Collapse" : "▼ Expand"}</span>
            </button>
          </div>
          {showAccountDetails && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">

            {/* Account Details */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><UserCircle className="w-4 h-4 text-primary" /> Account Details</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Tags</Label>
                  <Input
                    placeholder="e.g. fitness, en, tier1"
                    value={formData.tags}
                    onChange={e => updateField({ tags: e.target.value })}
                    data-testid="input-tags"
                  />
                  <p className="text-[11px] text-muted-foreground">Comma-separated labels for grouping accounts.</p>
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Mail className="w-3.5 h-3.5" /> Instagram Email</Label>
                  <Input
                    type="email"
                    placeholder="account@email.com"
                    value={formData.email}
                    onChange={e => updateField({ email: e.target.value })}
                    data-testid="input-email"
                  />
                  <p className="text-[11px] text-muted-foreground">Email address associated with this Instagram account (for reference).</p>
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Calendar className="w-3.5 h-3.5" /> Date of Birth</Label>
                  <Input
                    placeholder="MM/DD/YYYY"
                    value={formData.dateOfBirth}
                    onChange={e => updateField({ dateOfBirth: e.target.value })}
                    data-testid="input-date-of-birth"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Security */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="w-4 h-4 text-primary" /> Security</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 space-y-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Phone className="w-3.5 h-3.5" /> Phone Number</Label>
                  <Input
                    placeholder="+1 555 000 0000"
                    value={formData.phoneNumber}
                    onChange={e => updateField({ phoneNumber: e.target.value })}
                    data-testid="input-phone-number"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Backup Codes</Label>
                  <textarea
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none font-mono"
                    rows={1}
                    placeholder="One code per line…"
                    value={formData.backupCodes}
                    onChange={e => updateField({ backupCodes: e.target.value })}
                    data-testid="input-backup-codes"
                  />
                </div>

                {/* ── Cookie Injection ── */}
                <div className="pt-3 border-t border-border space-y-2">
                  <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    <Cookie className="w-3.5 h-3.5" /> Inject Session Cookies
                  </Label>
                  <textarea
                    rows={1}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-[11px] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none font-mono"
                    placeholder="sessionid=...;ds_user_id=...;mid=..."
                    value={cookieInput}
                    onChange={e => { setCookieInput(e.target.value); if (cookieInjectStatus !== "idle") setCookieInjectStatus("idle"); }}
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!cookieInput.trim() || cookieInjectStatus === "injecting"}
                      onClick={handleInjectCookies}
                      className="h-7 text-xs px-3"
                    >
                      {cookieInjectStatus === "injecting"
                        ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Injecting…</>
                        : <><Cookie className="w-3 h-3 mr-1.5" />Inject Cookies</>}
                    </Button>
                    {cookieInjectStatus === "ok" && (
                      <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Injected
                      </span>
                    )}
                    {cookieInjectStatus === "error" && (
                      <span className="flex items-center gap-1 text-xs text-destructive font-medium">
                        <XCircle className="w-3.5 h-3.5" /> Failed
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Email Validation */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><Server className="w-4 h-4 text-primary" /> Email Validation</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Email Username</Label>
                  <Input
                    placeholder="recovery@mail.com"
                    value={formData.emailValidationUsername}
                    onChange={e => updateField({ emailValidationUsername: e.target.value })}
                    data-testid="input-email-val-user"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Email Password</Label>
                  <PasswordInput
                    placeholder="Email account password"
                    value={formData.emailValidationPassword}
                    onChange={e => updateField({ emailValidationPassword: e.target.value })}
                    data-testid="input-email-val-pass"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">POP3 Server</Label>
                    <Input
                      placeholder="pop.mail.com"
                      value={formData.emailValidationPop3Server}
                      onChange={e => updateField({ emailValidationPop3Server: e.target.value })}
                      data-testid="input-email-val-server"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Port</Label>
                    <Input
                      placeholder="995"
                      value={formData.emailValidationPort}
                      onChange={e => updateField({ emailValidationPort: e.target.value })}
                      data-testid="input-email-val-port"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

          </div>
          )}

          {/* ── Profile Sync ── */}
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setShowProfileSync(v => !v)}
              className="flex items-center gap-2 w-full px-0 py-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors select-none border-b border-border mb-0"
            >
              <RefreshCw className="w-4 h-4 text-primary" />
              Profile Sync
              <span className="ml-auto text-xs font-normal">{showProfileSync ? "▲ Collapse" : "▼ Expand"}</span>
            </button>
            <div className="mb-4" />
          </div>
          {showProfileSync && (
          <div className="mt-4">
            {/* Single row: sync controls left, stat cards right */}
            <div className="flex items-center gap-3 flex-wrap">

              <Switch
                checked={!!formData?.syncEnabled}
                onCheckedChange={v => updateField({ syncEnabled: v })}
              />
              <span className="text-xs font-semibold whitespace-nowrap">Auto Sync</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  value={formData?.syncIntervalMin ?? 60}
                  onChange={e => updateField({ syncIntervalMin: Math.min(Number(e.target.value), formData?.syncIntervalMax ?? Infinity) })}
                  className="h-6 text-xs w-11 px-1"
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <Input
                  type="number"
                  min={1}
                  value={formData?.syncIntervalMax ?? 120}
                  onChange={e => updateField({ syncIntervalMax: Math.max(Number(e.target.value), formData?.syncIntervalMin ?? 0) })}
                  className="h-6 text-xs w-11 px-1"
                />
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">min</span>
              </div>
              <div className="w-px h-4 bg-border mx-1" />
              <Checkbox
                id="syncUseHikerCard"
                checked={!!formData?.syncUseHiker}
                onCheckedChange={v => updateField({ syncUseHiker: !!v })}
              />
              <Label htmlFor="syncUseHikerCard" className="text-xs cursor-pointer whitespace-nowrap">HikerAPI</Label>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs px-2 gap-1"
                disabled={syncNowStatus === "syncing"}
                onClick={handleSyncNow}
              >
                {syncNowStatus === "syncing" && <Loader2 className="w-3 h-3 animate-spin" />}
                {syncNowStatus === "done" && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                {syncNowStatus === "fail" && <XCircle className="w-3 h-3 text-destructive" />}
                {syncNowStatus === "idle" && <RefreshCw className="w-3 h-3" />}
                {syncNowStatus === "syncing" ? "Syncing…" : syncNowStatus === "done" ? "Synced!" : syncNowStatus === "fail" ? "Failed" : "Sync Now"}
              </Button>
              <div className="w-px h-4 bg-border mx-1" />
              {/* Stat cards inline */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg py-1 px-2.5 border border-border">
                  <Users className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="text-xs font-bold">{profile?.followersCount != null ? profile.followersCount.toLocaleString() : "—"}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Followers</span>
                </div>
                <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg py-1 px-2.5 border border-border">
                  <UserPlus className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                  <span className="text-xs font-bold">{profile?.followingCount != null ? profile.followingCount.toLocaleString() : "—"}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Following</span>
                </div>
                <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg py-1 px-2.5 border border-border">
                  <BarChart2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                  <span className="text-xs font-bold">{profile?.postsCount != null ? profile.postsCount.toLocaleString() : "—"}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Posts</span>
                </div>
                {profile?.lastSyncedAt && (
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    · Last synced: {new Date(profile.lastSyncedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>
          )}
          <div className="border-t border-border mt-3" />
          </div>{/* end flex-1 left column */}

          {/* ── Notes — far right, aligned from Group row ── */}
          <div className="w-[429px] shrink-0">
            <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
              <FileText className="w-3.5 h-3.5" /> Notes
            </Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              placeholder="Any notes about this account…"
              rows={10}
              value={formData.notes}
              onChange={e => updateField({ notes: e.target.value })}
              data-testid="input-notes"
            />

          </div>

          </div>{/* end outer flex row */}
        </Tabs.Content>

        <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
          {getTool('human_sessions')
            ? <HumanSessionPanel
                key={getTool('human_sessions')!.id}
                tool={getTool('human_sessions')!}
                profile={profile}
                copyOpen={humanCopyOpen}
                onCopyOpenChange={setHumanCopyOpen}
                followTool={getTool('follow') ?? undefined}
                unfollowTool={getTool('unfollow') ?? undefined}
                contactTool={getTool('contact') ?? undefined}
                overrideProfiles={currentIsTemplate ? otherProfiles : undefined}
              />
            : <p className="text-sm text-muted-foreground py-8">Human sessions tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="session-log" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <SessionLogPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>


        </div>
      </Tabs.Root>

      {loginWarnState && (
        <LoginRateLimitDialog
          open
          proxyDisplay={loginWarnState.proxyDisplay}
          minutesAgo={loginWarnState.minutesAgo}
          onCancel={() => setLoginWarnState(null)}
          onContinue={loginWarnState.onConfirm}
        />
      )}
    </AppLayout>
  );
}
