import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProfiles, useCreateProfile, useDeleteProfile, useUpdateAccountStatus, useUpdateProfile } from "@/hooks/use-profiles";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents } from "@/shared/userAgents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Plus, Trash2, Instagram, Activity, ChevronDown, ChevronUp, ChevronRight, Upload, Download,
  ShieldCheck, Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, LogIn, Loader2, Globe, Clock, Monitor, Flag,
  Smartphone, FileDown, Filter, X, Settings2,
  AlertTriangle, ShieldAlert, WifiOff, RefreshCw, Lock, LockOpen, UserMinus, Camera, Eye,
  Tag, FolderOpen, Battery, BatteryCharging, Wifi, ImagePlus, UserCog, Images, BarChart2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { TrustScoreBadge, getTrustScore, getTrustLevels, setTrustScore } from "@/components/TrustScoreBadge";
import type { AccountStatus } from "@shared/schema";
import { api } from "@shared/routes";

// ── Status metadata ──────────────────────────────────────────────────────────
const STATUS_META: Record<AccountStatus, {
  label: string;
  icon: React.ElementType;
  pill: string;
}> = {
  pending:              { label: "Pending",              icon: Clock,       pill: "bg-slate-50  text-slate-600  border-slate-200"  },
  verifying:            { label: "Verifying",            icon: Loader2,     pill: "bg-blue-50   text-blue-600   border-blue-200"   },
  valid:                { label: "Valid",                icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200"  },
  banned:               { label: "Banned",               icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
  captcha:              { label: "Captcha",              icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  locked:               { label: "Account Locked",       icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
  email_confirmation:   { label: "Email Confirm",        icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  phone_verification:   { label: "Phone Verify",         icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  "2fa_verification":   { label: "2FA Verify",           icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200" },
  stopped:              { label: "Stopped",              icon: PowerOff,    pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  logged_out:           { label: "Logged Out",           icon: LogOut,      pill: "bg-orange-50 text-orange-700 border-orange-200" },
  bad_password:         { label: "Incorrect Password",    icon: KeyRound,    pill: "bg-red-50    text-red-700    border-red-200"    },
  action_blocked:       { label: "Action Blocked",       icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
  action_required:      { label: "Action Required",      icon: AlertTriangle, pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  post_deleted:         { label: "Post Deleted",         icon: Trash2,      pill: "bg-red-50    text-red-700    border-red-200"    },
  account_disabled:     { label: "Account Disabled",      icon: UserMinus,   pill: "bg-red-50    text-red-700    border-red-200"    },
  api_block:            { label: "API Block",            icon: ShieldAlert, pill: "bg-red-50    text-red-700    border-red-200"    },
  captcha_disabled:     { label: "Captcha Disabled",     icon: ScanFace,    pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  compromised:          { label: "Compromised",          icon: ShieldAlert, pill: "bg-red-50    text-red-700    border-red-200"    },
  email_verification:   { label: "Email Verify",         icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  phone_validation:     { label: "Phone Valid.",         icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  invalid_credentials:  { label: "Invalid Creds",        icon: KeyRound,    pill: "bg-red-50    text-red-700    border-red-200"    },
  no_internet:          { label: "No Internet",          icon: WifiOff,     pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  password_reset:       { label: "Password Reset",       icon: RefreshCw,   pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  temporary_locked:     { label: "Temp. Locked",         icon: Lock,        pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  scrape_warning:       { label: "Scrape Warning",       icon: AlertTriangle, pill: "bg-amber-50 text-amber-700  border-amber-200"  },
  suspended:            { label: "Confirm Your Human",    icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  confirm_human:        { label: "Confirm Your Human",    icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  selfie_verification:  { label: "Selfie Verify",        icon: Camera,      pill: "bg-purple-50 text-purple-700 border-purple-200" },
  own_phone_verification: { label: "Own Phone Verify",  icon: Smartphone,  pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  email_connection:     { label: "Email Connect",        icon: Mail,        pill: "bg-orange-50 text-orange-700 border-orange-200" },
  upload:               { label: "Upload",               icon: Upload,      pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  review:               { label: "Review",               icon: Eye,         pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  automated_behaviour_detected: { label: "Auto Behav.", icon: ShieldAlert, pill: "bg-orange-50 text-orange-700 border-orange-200" },
};

function AccountStatusBadge({ status, statusMessage }: { status: string; statusMessage?: string | null }) {
  const meta = STATUS_META[status as AccountStatus] ?? STATUS_META.pending;
  const Icon = meta.icon;
  const tooltip = status === "valid" ? undefined : (statusMessage || undefined);
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border whitespace-nowrap ${meta.pill}${tooltip ? " cursor-help" : ""}`}
    >
      <Icon className="w-2.5 h-2.5" />
      <span className="uppercase">{meta.label}</span>
    </span>
  );
}

const DEFAULT_PROFILES_COL_WIDTHS = { account: 200, status: 96, trustscore: 120, active: 56, followers: 72, following: 72, sync: 88, lastApiCall: 100, actions: 176, battery: 90, connection: 80, abd: 56, ip: 128 };
const DEFAULT_PROFILES_COL_VISIBLE = { status: true, trustscore: true, active: true, followers: true, following: true, sync: true, lastApiCall: true, actions: true, battery: false, connection: false, abd: true, ip: true };
const DEFAULT_PROFILES_COL_ORDER: (keyof typeof DEFAULT_PROFILES_COL_WIDTHS)[] = ["account", "status", "trustscore", "active", "followers", "following", "sync", "lastApiCall", "actions", "battery", "connection", "abd", "ip"];
const PROFILES_COL_LABELS: Record<keyof typeof DEFAULT_PROFILES_COL_WIDTHS, string> = {
  account: "Account", status: "Status", trustscore: "TrustScore", active: "Active", followers: "FOLLOWERS", following: "FOLLOWING", sync: "SYNC", lastApiCall: "Last API Call", actions: "Actions", battery: "Battery", connection: "Mbps", abd: "Automatic Behaviour Detected", ip: "IP:Port",
};

// ── Fingerprint PRNG — same djb2+LCG as applyStealthScripts ─────────────────
function _pageDjb2(ua: string): number {
  let s = 5381;
  for (let i = 0; i < ua.length; i++) s = (((s << 5) + s) ^ ua.charCodeAt(i)) >>> 0;
  return s || 1;
}
function _pageFingerprint(ua: string, _apiUA?: string | null): { batteryPct: number; charging: boolean; connType: string; downlink: number } {
  let s = _pageDjb2(ua);
  const r  = () => { s = ((Math.imul(1664525, s) + 1013904223) >>> 0); return s / 0x100000000; };
  const rI = (lo: number, hi: number) => { lo + Math.round(r() * (hi - lo)); };
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
  rp(PROF);                                                      // call 1 — advance past device (output ignored; battery/conn follow)
  const batteryPct = Math.round((0.60 + r() * 0.39) * 100);    // call 2
  const charging   = r() > 0.35;                                // call 3
  if (charging) rI(0, 3600); else rI(1800, 28800);             // call 4
  const connType = rp(["Wi-Fi", "Wi-Fi", "Wi-Fi", "Cellular"] as const); // call 5
  const downlink = Math.round(2 + r() * 98);                    // call 6
  return { batteryPct, charging, connType, downlink };
}

// ── Component ────────────────────────────────────────────────────────────────
export function ProfilesPage() {
  const { data: allProfilesRaw, isLoading } = useProfiles();
  const profiles = allProfilesRaw?.filter(p => !p.isTemplate);
  const createProfileMutation = useCreateProfile();
  const deleteProfileMutation = useDeleteProfile();
  const updateAccountStatus   = useUpdateAccountStatus();
  const updateProfileMutation = useUpdateProfile();
  const queryClient           = useQueryClient();
  const { data: licenseData } = useQuery<{ ok: boolean; username?: string; tier?: string; accountLimit?: number; isAdmin?: boolean }>({
    queryKey: ["/api/license/me"],
    queryFn: async () => { const r = await fetch("/api/license/me", { credentials: "include" }); return r.json(); },
    staleTime: 60_000,
  });
  const isAtLimit = !!(licenseData?.ok && !licenseData?.isAdmin && (profiles?.length ?? 0) >= (licenseData?.accountLimit ?? Infinity));
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const { toast } = useToast();
  const { openWindow, closeWindow } = useBrowserWindows();
  const { data: proxies } = useProxies();

  // Per-account in-flight tracking.
  // verifyingInProgress ref: guards against double-submit with no stale-closure risk
  // (a Set in a ref is always current — no dependency array needed).
  // verifyingIds state: drives the visual disabled/spinner state in the render.
  const verifyingInProgress = useRef(new Set<number>());
  const [verifyingIds, setVerifyingIds] = useState<Set<number>>(new Set());

  const handleVerify = useCallback(async (id: number) => {
    // Guard using the ref — always reads the live set, never stale.
    if (verifyingInProgress.current.has(id)) return;
    verifyingInProgress.current.add(id);
    setVerifyingIds(prev => { const n = new Set(prev); n.add(id); return n; });
    // Optimistically patch the local React Query cache so the status badge
    // changes to "Verifying" immediately — no PATCH request, just a cache write.
    // The finally block's invalidateQueries will overwrite this with the real
    // server value once the POST resolves.
    const patchVerifying = (old: any) =>
      Array.isArray(old) ? old.map((p: any) => p.id === id ? { ...p, accountStatus: "verifying" } : p) : old;
    queryClient.setQueriesData({ queryKey: [api.profiles.list.path] }, patchVerifying);
    queryClient.setQueryData([api.profiles.get.path, id], (old: any) =>
      old ? { ...old, accountStatus: "verifying" } : old);
    try {
      const res  = await fetch(`/api/profiles/${id}/verify`, { method: "POST", credentials: "include" });
      const data = await res.json() as { ok: boolean; message: string };
      toast({
        title: data.ok ? "Verified" : "Verification Failed",
        description: data.message,
        variant: data.ok ? "default" : "destructive",
      });
    } catch {
      toast({ title: "Error", description: "Could not reach Instagram.", variant: "destructive" });
    } finally {
      verifyingInProgress.current.delete(id);
      setVerifyingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      // Always refetch so the UI shows whatever status the server actually set.
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
    }
  }, [toast, queryClient]);

  const [profColWidths, setProfColWidths] = usePersistentSetting(
    "profiles_col_widths_px",
    DEFAULT_PROFILES_COL_WIDTHS,
    (s, d) => ({ ...d, ...s }),
  );
  const [profColVisible, setProfColVisible] = usePersistentSetting(
    "profiles_col_visible_v2",
    DEFAULT_PROFILES_COL_VISIBLE,
    (s, d) => ({ ...d, ...s }),
  );
  const [profColOrder, setProfColOrder] = usePersistentSetting<(keyof typeof DEFAULT_PROFILES_COL_WIDTHS)[]>(
    "profiles_col_order",
    DEFAULT_PROFILES_COL_ORDER,
    (s, d) => {
      const missing = d.filter(k => !s.includes(k));
      return missing.length ? [...s, ...missing] : s;
    },
  );

  // ── Daily ABD (Automated Behaviour Detected) dismissal counts ─────────────
  const [abdDailyCount, setAbdDailyCount] = useState<Record<number, number>>({});
  useEffect(() => {
    const fetchAbd = async () => {
      try {
        const r = await fetch("/api/stats/abd-daily");
        if (r.ok) setAbdDailyCount(await r.json());
      } catch { /* ignore */ }
    };
    fetchAbd();
    const t = setInterval(fetchAbd, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Last valid API call per profile ───────────────────────────────────────
  const [lastApiCallMap, setLastApiCallMap] = useState<Record<number, string>>({});
  useEffect(() => {
    const fetchLastApiCalls = async () => {
      try {
        const r = await fetch("/api/profiles/last-api-calls");
        if (r.ok) setLastApiCallMap(await r.json());
      } catch { /* ignore */ }
    };
    fetchLastApiCalls();
    const t = setInterval(fetchLastApiCalls, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Group icons (favicon/image per group, stored in localStorage) ─────────
  const [groupIcons, setGroupIcons] = useState<Record<string, string>>(() => {
    try {
      const s = localStorage.getItem("profiles:groupIcons");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const groupIconInputRef = useRef<HTMLInputElement>(null);
  const groupIconKeyRef   = useRef<string>("");

  const handleGroupIconFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const data = ev.target?.result as string;
      const key  = groupIconKeyRef.current;
      if (!data || !key) return;
      setGroupIcons(prev => {
        const next = { ...prev, [key]: data };
        try { localStorage.setItem("profiles:groupIcons", JSON.stringify(next)); } catch {}
        return next;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  const moveProfCol = (key: keyof typeof DEFAULT_PROFILES_COL_WIDTHS, dir: -1 | 1) => {
    const reorderable = profColOrder.filter(k => k !== "account" && k !== "ip");
    const idx = reorderable.indexOf(key as any);
    if (idx === -1) return;
    const next = [...reorderable];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    const fullOrder = ["account" as const, ...next, "ip" as const];
    setProfColOrder(fullOrder);
    localStorage.setItem("profiles_col_order", JSON.stringify(fullOrder));
  };
  const [manageProfileColsOpen, setManageProfileColsOpen] = useState(false);
  const manageProfileColsRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const profDragColRef = useRef<string | null>(null);
  const [profDragOverCol, setProfDragOverCol] = useState<string | null>(null);
  useScrollRestore("profiles", scrollBodyRef, !isLoading);

  const [selectedProfileIds, setSelectedProfileIds] = useState<number[]>([]);
  const isDragSelecting = useRef(false);
  const dragAddMode = useRef(true);
  const preStoppedStatus = useRef<Map<number, string>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  const [addProfilePanelOpen, setAddProfilePanelOpen] = useState(false);
  const [addProfileCount, setAddProfileCount] = useState("1");
  const [addProfileCreating, setAddProfileCreating] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [tsSubOpen, setTsSubOpen] = useState(false);
  const [tsVersion, setTsVersion] = useState(0);
  const [eqxImporting, setEqxImporting] = useState(false);
  const eqxImportRef = useRef<HTMLInputElement>(null);
  const [jarveeImporting, setJarveeImporting] = useState(false);
  const jarveeImportRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[] } | null>(null);
  const [resetDeviceConfirmOpen, setResetDeviceConfirmOpen] = useState(false);
  const [resetAndClearConfirmOpen, setResetAndClearConfirmOpen] = useState(false);
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [fixingCaptcha, setFixingCaptcha] = useState(false);
  const [fixingAbd, setFixingAbd] = useState(false);
  const [fixingAbdIds, setFixingAbdIds] = useState<Set<number>>(new Set());
  const [flaggedIds, setFlaggedIds] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem("equinox:flagged_profiles") ?? "[]") as number[]; } catch { return []; }
  });
  const handleBulkFlag = useCallback(() => {
    setFlaggedIds(prev => {
      const newIds = [...new Set([...prev, ...selectedProfileIds])];
      try { localStorage.setItem("equinox:flagged_profiles", JSON.stringify(newIds)); } catch {}
      return newIds;
    });
    setActionsOpen(false);
  }, [selectedProfileIds]);
  const handleBulkUnflag = useCallback(() => {
    setFlaggedIds(prev => {
      const newIds = prev.filter(id => !selectedProfileIds.includes(id));
      try { localStorage.setItem("equinox:flagged_profiles", JSON.stringify(newIds)); } catch {}
      return newIds;
    });
    setActionsOpen(false);
  }, [selectedProfileIds]);
  const [statusFilter, setStatusFilter] = useState<string>(() => sessionStorage.getItem("profiles:filter") ?? "");
  const [sortField, setSortField] = useState<"account" | "status" | "ip" | "followers" | "following" | "trustscore" | "sync" | "lastApiCall" | null>(() => {
    const v = localStorage.getItem("profiles:sortField");
    return (v === "account" || v === "status" || v === "ip" || v === "followers" || v === "following" || v === "trustscore" || v === "sync" || v === "lastApiCall") ? v as any : "account";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    (localStorage.getItem("profiles:sortDir") as "asc" | "desc") === "desc" ? "desc" : "asc"
  );
  // Stable order: IDs in the order frozen when user last clicked a column header,
  // or seeded from the first data load. Data refreshes update account data in-place
  // but never reorder the list.
  const [stableOrder, setStableOrder] = useState<number[]>(() => {
    try {
      const s = localStorage.getItem("profiles:stableOrder");
      return s ? (JSON.parse(s) as number[]) : [];
    } catch { return []; }
  });

  // Seed stableOrder on first profiles load; keep it current as accounts are
  // added/removed, but never change existing positions.
  useEffect(() => {
    if (!profiles || profiles.length === 0) return;
    setStableOrder(prev => {
      const prevSet    = new Set(prev);
      const activeIds  = new Set(profiles.map(p => p.id));
      const kept       = prev.filter(id => activeIds.has(id));
      const newIds     = profiles.filter(p => !prevSet.has(p.id)).map(p => p.id);
      if (kept.length === prev.length && newIds.length === 0) return prev;
      const next = [...kept, ...newIds];
      try { localStorage.setItem("profiles:stableOrder", JSON.stringify(next)); } catch {}
      return next;
    });
  }, [profiles]);

  // ── Group Profiles state ──────────────────────────────────────────────────
  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("profiles:groupMode") === "true");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("profiles:collapsedGroups");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [setGroupOpen, setSetGroupOpen] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [changeDetailsOpen, setChangeDetailsOpen] = useState(false);
  const [changeDetailsUsername, setChangeDetailsUsername] = useState("");
  const [changeDetailsBio, setChangeDetailsBio] = useState("");
  const [changeDetailsPictures, setChangeDetailsPictures] = useState<File[]>([]);
  const changeDetailsPicInputRef = useRef<HTMLInputElement>(null);

  const setFilterPersisted = (v: string) => {
    sessionStorage.setItem("profiles:filter", v);
    setStatusFilter(v);
  };

  // ── Derived: filtered + sorted list ──────────────────────────────────────
  const filterTokens = useMemo(() =>
    statusFilter.split(/\|\|?/).map(t => t.trim().toLowerCase()).filter(Boolean),
    [statusFilter]
  );

  const ipToNum = (host: string | null | undefined): number => {
    if (!host) return Infinity;
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      return parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3];
    }
    return Infinity;
  };

  const ERROR_STATUSES = new Set([
    "logged_out", "bad_password", "captcha", "error", "banned",
    "api_block", "compromised", "invalid_credentials", "password_reset",
  ]);

  const filteredProfiles = useMemo(() => {
    let base = filterTokens.length > 0
      ? (profiles ?? []).filter(p => {
          const status      = (p.accountStatus ?? "pending").toLowerCase();
          const statusLabel = (STATUS_META[p.accountStatus as AccountStatus]?.label ?? "").toLowerCase();
          const username    = (p.username ?? "").toLowerCase();
          const label       = (p.accountLabel ?? "").toLowerCase();
          return filterTokens.some(token =>
            status.includes(token) ||
            statusLabel.includes(token) ||
            username.includes(token) ||
            label.includes(token)
          );
        })
      : (profiles ?? []);

    // Always use stableOrder when available — this freezes row positions so live
    // data refreshes (e.g. status changes) never reorder accounts. stableOrder is
    // seeded on first load and re-snapshotted only when the user clicks a column header.
    if (stableOrder.length > 0) {
      const orderMap = new Map(stableOrder.map((id, idx) => [id, idx]));
      return [...base].sort((a, b) => {
        const ia = orderMap.has(a.id) ? orderMap.get(a.id)! : Infinity;
        const ib = orderMap.has(b.id) ? orderMap.get(b.id)! : Infinity;
        return ia - ib;
      });
    }

    if (!sortField) return base;

    // No stable order yet — sort live as a one-time fallback (before first load)
    return [...base].sort((a, b) => {
      if (sortField === "ip") {
        const na = ipToNum(a.proxyHost);
        const nb = ipToNum(b.proxyHost);
        const diff = na - nb;
        if (diff !== 0) return sortDir === "asc" ? diff : -diff;
        const pa = a.proxyPort ?? 0;
        const pb = b.proxyPort ?? 0;
        return sortDir === "asc" ? pa - pb : pb - pa;
      }
      if (sortField === "followers" || sortField === "following") {
        const na = sortField === "followers" ? (a.followersCount ?? -1) : (a.followingCount ?? -1);
        const nb = sortField === "followers" ? (b.followersCount ?? -1) : (b.followingCount ?? -1);
        return sortDir === "asc" ? na - nb : nb - na;
      }
      if (sortField === "trustscore") {
        const tsA = getTrustScore(a.id); const tsB = getTrustScore(b.id);
        const lvls = getTrustLevels();
        const ra = tsA !== null ? lvls.findIndex(l => l.id === tsA) : Infinity;
        const rb = tsB !== null ? lvls.findIndex(l => l.id === tsB) : Infinity;
        return sortDir === "asc" ? (ra === rb ? 0 : ra < rb ? -1 : 1) : (ra === rb ? 0 : ra > rb ? -1 : 1);
      }
      if (sortField === "sync") {
        const ta = a.lastSyncedAt ? new Date(a.lastSyncedAt).getTime() : 0;
        const tb = b.lastSyncedAt ? new Date(b.lastSyncedAt).getTime() : 0;
        return sortDir === "asc" ? ta - tb : tb - ta;
      }
      if (sortField === "lastApiCall") {
        const ta = lastApiCallMap[a.id] ? new Date(lastApiCallMap[a.id]).getTime() : 0;
        const tb = lastApiCallMap[b.id] ? new Date(lastApiCallMap[b.id]).getTime() : 0;
        return sortDir === "asc" ? ta - tb : tb - ta;
      }
      let va = "", vb = "";
      if (sortField === "account") {
        va = (a.accountLabel || a.username || "").toLowerCase();
        vb = (b.accountLabel || b.username || "").toLowerCase();
      } else {
        va = (STATUS_META[a.accountStatus as AccountStatus]?.label ?? a.accountStatus ?? "").toLowerCase();
        vb = (STATUS_META[b.accountStatus as AccountStatus]?.label ?? b.accountStatus ?? "").toLowerCase();
      }
      return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }, [profiles, filterTokens, sortField, sortDir, stableOrder, lastApiCallMap]);

  // ── Duplicate Instagram username detection ────────────────────────────────
  // Scans ALL profiles (not just the filtered view) so a duplicate is flagged
  // even when the other copy is scrolled off-screen or hidden by the filter.
  const duplicateUsernames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of profiles ?? []) {
      const u = (p.username ?? "").trim().toLowerCase();
      if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [u, n] of counts) if (n > 1) dupes.add(u);
    return dupes;
  }, [profiles]);

  // ── Grouped view (groupMode) ──────────────────────────────────────────────
  const groupedProfiles = useMemo(() => {
    if (!groupMode) return null;
    const map = new Map<string, typeof filteredProfiles>();
    for (const p of filteredProfiles) {
      const key = (p.tags ?? "").trim() || "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [groupMode, filteredProfiles]);

  const toggleGroupCollapse = (groupKey: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
      try { localStorage.setItem("profiles:collapsedGroups", JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const cycleSort = (field: "account" | "status" | "ip" | "followers" | "following" | "trustscore" | "sync" | "lastApiCall") => {
    let newDir: "asc" | "desc";
    if (sortField !== field) {
      const defaultDir = (field === "sync" || field === "lastApiCall") ? "desc" : "asc";
      setSortField(field); setSortDir(defaultDir);
      newDir = defaultDir;
      localStorage.setItem("profiles:sortField", field);
      localStorage.setItem("profiles:sortDir", defaultDir);
    } else {
      newDir = sortDir === "asc" ? "desc" : "asc";
      setSortDir(newDir);
      localStorage.setItem("profiles:sortDir", newDir);
    }

    // Snapshot the current sort order so data refreshes won't reorder accounts.
    // Only the user clicking a header (this function) changes the arrangement.
    const base = filterTokens.length > 0
      ? (profiles ?? []).filter(p => {
          const status      = (p.accountStatus ?? "pending").toLowerCase();
          const statusLabel = (STATUS_META[p.accountStatus as AccountStatus]?.label ?? "").toLowerCase();
          const username    = (p.username ?? "").toLowerCase();
          const label       = (p.accountLabel ?? "").toLowerCase();
          return filterTokens.some(token =>
            status.includes(token) || statusLabel.includes(token) ||
            username.includes(token) || label.includes(token)
          );
        })
      : (profiles ?? []);

    const sorted = [...base].sort((a, b) => {
      if (field === "ip") {
        const na = ipToNum(a.proxyHost);
        const nb = ipToNum(b.proxyHost);
        const diff = na - nb;
        if (diff !== 0) return newDir === "asc" ? diff : -diff;
        const pa = a.proxyPort ?? 0;
        const pb = b.proxyPort ?? 0;
        return newDir === "asc" ? pa - pb : pb - pa;
      }
      if (field === "trustscore") {
        const tsA = getTrustScore(a.id); const tsB = getTrustScore(b.id);
        const lvls = getTrustLevels();
        const ra = tsA !== null ? lvls.findIndex(l => l.id === tsA) : Infinity;
        const rb = tsB !== null ? lvls.findIndex(l => l.id === tsB) : Infinity;
        return newDir === "asc" ? (ra === rb ? 0 : ra < rb ? -1 : 1) : (ra === rb ? 0 : ra > rb ? -1 : 1);
      }
      let va = "", vb = "";
      if (field === "account") {
        va = (a.accountLabel || a.username || "").toLowerCase();
        vb = (b.accountLabel || b.username || "").toLowerCase();
      } else {
        va = (STATUS_META[a.accountStatus as AccountStatus]?.label ?? a.accountStatus ?? "").toLowerCase();
        vb = (STATUS_META[b.accountStatus as AccountStatus]?.label ?? b.accountStatus ?? "").toLowerCase();
      }
      return newDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    const newOrder = sorted.map(p => p.id);
    setStableOrder(newOrder);
    try { localStorage.setItem("profiles:stableOrder", JSON.stringify(newOrder)); } catch {}
  };

  const getNextAccountNum = () => {
    const existing = (profiles ?? [])
      .map(p => { const m = (p.accountLabel ?? "").match(/^Account(\d+)$/i); return m ? Number(m[1]) : 0; })
      .filter(n => n > 0);
    return existing.length > 0 ? Math.max(...existing) + 1 : (profiles?.length ?? 0) + 1;
  };

  const handleCreate = () => {
    if (isAtLimit) { setShowUpgradeDialog(true); return; }
    const nextNum = getNextAccountNum();
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    createProfileMutation.mutate({
      username: "",
      password: "",
      accountLabel: `Account${nextNum}`,
      proxyHost: "",
      proxyPort: null,
      proxyUsername: "",
      proxyPassword: "",
      userAgentApi: ua.api,
      userAgentEmbedded: ua.embedded,
    }, {
      onSuccess: (profile) => {
        if (!getTrustScore(profile.id)) setTrustScore(profile.id, "noob");
        window.location.href = `/profiles/${profile.id}`;
      }
    });
  };

  const handleCreateMultiple = async () => {
    if (isAtLimit) { setShowUpgradeDialog(true); return; }
    const count = Math.max(1, Math.min(500, parseInt(addProfileCount, 10) || 1));
    setAddProfileCreating(true);
    let startNum = getNextAccountNum();
    try {
      for (let i = 0; i < count; i++) {
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        const newProfile = await createProfileMutation.mutateAsync({
          username: "",
          password: "",
          accountLabel: `Account${startNum + i}`,
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
          userAgentApi: ua.api,
          userAgentEmbedded: ua.embedded,
        });
        if (!getTrustScore(newProfile.id)) setTrustScore(newProfile.id, "noob");
      }
      setAddProfilePanelOpen(false);
      setAddProfileCount("1");
    } catch {
      // silent
    } finally {
      setAddProfileCreating(false);
    }
  };

  const toggleSelection = (id: number) => {
    setSelectedProfileIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  useEffect(() => {
    const onMouseUp = () => { isDragSelecting.current = false; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  const toggleAll = useCallback(() => {
    const filteredIds = filteredProfiles.map(p => p.id);
    const allFilteredSelected = filteredIds.every(id => selectedProfileIds.includes(id));
    if (allFilteredSelected) {
      // Deselect only the filtered ones, keeping any out-of-filter selections
      setSelectedProfileIds(prev => prev.filter(id => !filteredIds.includes(id)));
    } else {
      // Add all filtered ones to the selection
      setSelectedProfileIds(prev => [...new Set([...prev, ...filteredIds])]);
    }
  }, [filteredProfiles, selectedProfileIds]);

  const handleBulkLock = useCallback(async (lock: boolean) => {
    if (selectedProfileIds.length === 0) return;
    for (const id of selectedProfileIds) {
      await updateProfileMutation.mutateAsync({ id, locked: lock });
    }
    toast({ title: lock ? "Accounts Locked" : "Accounts Unlocked", description: `${selectedProfileIds.length} account(s) ${lock ? "locked" : "unlocked"}.` });
  }, [selectedProfileIds, updateProfileMutation, toast]);

  const handleBulkDelete = useCallback(() => {
    if (selectedProfileIds.length === 0) return;
    setDeleteConfirm({ ids: [...selectedProfileIds] });
  }, [selectedProfileIds]);

  const performDelete = useCallback(async (ids: number[]) => {
    try {
      for (const id of ids) {
        await deleteProfileMutation.mutateAsync(id);
        closeWindow(id);
      }
      setSelectedProfileIds(prev => prev.filter(id => !ids.includes(id)));
      toast({ title: "Profiles Deleted", description: `${ids.length} account${ids.length !== 1 ? "s" : ""} removed.` });
    } catch {
      toast({ title: "Error", description: "Failed to delete some profiles.", variant: "destructive" });
    }
  }, [deleteProfileMutation, closeWindow, toast]);

  const handleBulkLoginEB = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    toast({ title: "Login Started", description: `Auto-filling credentials for ${selectedProfileIds.length} account(s) in the background.` });
    for (const id of selectedProfileIds) {
      fetch(`/api/browser/${id}/login`, { method: "POST" }).catch(() => {});
    }
  }, [selectedProfileIds, toast]);

  const handleBulkResetDeviceIds = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    try {
      for (const id of selectedProfileIds) {
        await fetch(`/api/profiles/${id}/reset-device-ids`, { method: "POST" });
      }
      await queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      setSelectedProfileIds([]);
      toast({ title: "Device IDs Reset", description: `${selectedProfileIds.length} account(s) assigned new device fingerprints.` });
    } catch {
      toast({ title: "Error", description: "Failed to reset some device IDs.", variant: "destructive" });
    }
  }, [selectedProfileIds, queryClient, toast]);

  const handleBulkResetAndClear = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    try {
      for (const id of selectedProfileIds) {
        await fetch(`/api/profiles/${id}/clear-session-cookies`, { method: "POST" }).catch(() => {});
        await fetch(`/api/profiles/${id}/reset-device-ids`, { method: "POST" });
      }
      await queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      setSelectedProfileIds([]);
      toast({ title: "Reset & Cleared", description: `${selectedProfileIds.length} account(s) had cookies cleared and device IDs reset.` });
    } catch {
      toast({ title: "Error", description: "Failed to reset some accounts.", variant: "destructive" });
    }
  }, [selectedProfileIds, queryClient, toast]);

  const handleExportProfiles = useCallback(async () => {
    const toExport = selectedProfileIds.length > 0
      ? profiles?.filter(p => selectedProfileIds.includes(p.id))
      : profiles;
    if (!toExport?.length) {
      toast({ title: "No profiles to export", variant: "destructive" });
      return;
    }

    // Fetch proxy list so we can resolve proxyId → host:port for Proxy Manager-linked accounts
    let proxyMap = new Map<number, { host: string; port: number | null; username: string | null; password: string | null }>();
    try {
      const res = await fetch("/api/proxies");
      if (res.ok) {
        const proxies: any[] = await res.json();
        for (const px of proxies) {
          proxyMap.set(px.id, { host: px.proxyHost ?? "", port: px.proxyPort ?? null, username: px.proxyUsername ?? null, password: px.proxyPassword ?? null });
        }
      }
    } catch { /* non-critical — export continues without resolved proxies */ }

    const resolveProxy = (p: any) => {
      if (p.proxyHost) return { host: p.proxyHost, port: p.proxyPort, username: p.proxyUsername, password: p.proxyPassword };
      if (p.proxyId && proxyMap.has(p.proxyId)) return proxyMap.get(p.proxyId)!;
      return { host: "", port: null, username: null, password: null };
    };

    const csvCell = (v: string) => {
      const s = String(v ?? "");
      return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = [
      "Label", "Instagram Username", "Password",
      "Email", "Proxy-url/Proxy-ip:port",
      "Proxy Username", "Proxy Password",
      "Date of birth(US Format)", "EB User Agent", "API User Agent",
      "Notes", "Phone number", "2FA Secret Key",
      "Backup Codes", "Email Validation Username", "Email Validation Pass",
      "Email Validation Pop3Server", "Email Validation Port",
      "TrustScore",
    ];
    const rows = toExport.map(p => {
      const proxy = resolveProxy(p);
      return [
        p.tags ?? "",
        p.username ?? "",
        p.password ?? "",
        p.email ?? "",
        proxy.host ? `${proxy.host}${proxy.port ? `:${proxy.port}` : ""}` : "",
        proxy.username ?? "",
        proxy.password ?? "",
        p.dateOfBirth ?? "",
        p.userAgentEmbedded ?? "",
        p.userAgentApi ?? "",
        p.notes ?? "",
        p.phoneNumber ?? "",
        p.twoFASecretKey ?? "",
        p.backupCodes ?? "",
        p.emailValidationUsername ?? "",
        p.emailValidationPassword ?? "",
        p.emailValidationPop3Server ?? "",
        p.emailValidationPort ?? "",
        getTrustScore(p.id) ?? "",
      ];
    });
    const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
    const filename = `profiles_export_${new Date().toISOString().slice(0, 10)}.csv`;
    const eApi = (window as any).electronAPI;
    if (eApi?.openCsvTemp) {
      eApi.openCsvTemp({ content: csv, filename }).catch(() => {});
    } else {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    toast({ title: "Exported", description: `${toExport.length} profile(s) exported as CSV.` });
  }, [profiles, selectedProfileIds, toast]);

  const PRESTOP_KEY = "profiles_prestop_status";
  const getPreStopMap = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(PRESTOP_KEY) ?? "{}"); } catch { return {}; }
  };

  const toggleStopped = (id: number, currentStatus: string) => {
    if (currentStatus === "stopped") {
      // Restore to the exact status the account had before being stopped.
      // Use localStorage so the mapping survives page reloads.
      const map = getPreStopMap();
      const restore = map[String(id)] ?? preStoppedStatus.current.get(id) ?? "valid";
      delete map[String(id)];
      localStorage.setItem(PRESTOP_KEY, JSON.stringify(map));
      preStoppedStatus.current.delete(id);
      updateAccountStatus.mutate({ id, accountStatus: restore });
    } else {
      // Persist the current status so we can restore it exactly on un-stop.
      const map = getPreStopMap();
      map[String(id)] = currentStatus;
      localStorage.setItem(PRESTOP_KEY, JSON.stringify(map));
      preStoppedStatus.current.set(id, currentStatus);
      updateAccountStatus.mutate({ id, accountStatus: "stopped" });
    }
  };

  const handleBulkToggle = useCallback(() => {
    if (selectedProfileIds.length === 0) return;
    for (const id of selectedProfileIds) {
      const p = profiles?.find(pr => pr.id === id);
      if (p) toggleStopped(id, p.accountStatus ?? "valid");
    }
  }, [selectedProfileIds, profiles, toggleStopped]);

  // ── Bulk: Verify All ─────────────────────────────────────────────────────
  const handleVerifyAll = useCallback(async () => {
    const ids = selectedProfileIds.length > 0 ? selectedProfileIds : filteredProfiles.map(p => p.id);
    if (!ids.length) return;
    setVerifyingAll(true);
    try {
      const res = await fetch("/api/profiles/verify-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileIds: ids }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: `Verifying ${ids.length} account${ids.length !== 1 ? "s" : ""}`, description: `All ${ids.length} running simultaneously in the background.` });
      } else {
        toast({ title: "Error", description: data.error ?? "Failed to start verification.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to reach server.", variant: "destructive" });
    } finally {
      setVerifyingAll(false);
    }
  }, [selectedProfileIds, filteredProfiles, toast]);

  // ── Per-account: Fix Automated Behaviour Detected ────────────────────────
  const handleFixAbdForProfile = useCallback(async (profileId: number) => {
    if (fixingAbdIds.has(profileId)) return;
    setFixingAbdIds(prev => new Set(prev).add(profileId));
    try {
      const result = await fetch(`/api/profiles/${profileId}/fix-abd`, { method: "POST", credentials: "include" }).then(r => r.json());
      toast({
        title: "Fix Auto-Behaviour",
        description: result?.ok
          ? "Automated Behaviour warning dismissed — account restored to valid."
          : (result?.message ?? "Dismiss failed. Try Verify Credentials first."),
        variant: result?.ok ? "default" : "destructive",
      });
    } catch {
      toast({ title: "Error", description: "Fix Auto-Behaviour failed.", variant: "destructive" });
    } finally {
      setFixingAbdIds(prev => { const s = new Set(prev); s.delete(profileId); return s; });
    }
  }, [fixingAbdIds, toast]);

  // ── Bulk: Fix Automated Behaviour Detected ───────────────────────────────
  const handleBulkFixAbd = useCallback(async () => {
    const ids = selectedProfileIds.length > 0 ? selectedProfileIds : filteredProfiles.map(p => p.id);
    if (ids.length === 0) return;
    setFixingAbd(true);
    try {
      const results = await Promise.allSettled(
        ids.map(id =>
          fetch(`/api/profiles/${id}/fix-abd`, { method: "POST", credentials: "include" }).then(r => r.json())
        )
      );
      const ok = results.filter(r => r.status === "fulfilled" && (r as any).value?.ok).length;
      const fail = ids.length - ok;
      toast({
        title: "Fix Auto-Behaviour",
        description: ok > 0
          ? `${ok} account${ok !== 1 ? "s" : ""} cleared${fail > 0 ? ` — ${fail} could not be dismissed` : ""}.`
          : "No accounts could be dismissed. Accounts may not be in ABD state — try Verify Credentials first.",
        variant: ok > 0 ? "default" : "destructive",
      });
    } catch {
      toast({ title: "Error", description: "Fix Auto-Behaviour failed.", variant: "destructive" });
    } finally {
      setFixingAbd(false);
    }
  }, [selectedProfileIds, filteredProfiles, toast]);

  // ── Bulk: Fix Captcha ────────────────────────────────────────────────────
  const handleBulkFixCaptcha = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    setFixingCaptcha(true);
    try {
      const results = await Promise.allSettled(
        selectedProfileIds.map(id =>
          fetch(`/api/profiles/${id}/fix-captcha`, { method: "POST", credentials: "include" }).then(r => r.json())
        )
      );
      const ok = results.filter(r => r.status === "fulfilled" && (r as any).value?.ok).length;
      toast({ title: "Fix Captcha", description: `${ok} / ${selectedProfileIds.length} account(s) resolved.` });
    } catch {
      toast({ title: "Error", description: "Fix captcha failed.", variant: "destructive" });
    } finally {
      setFixingCaptcha(false);
    }
  }, [selectedProfileIds, toast]);

  // ── Bulk: Remove Proxies → Pending ───────────────────────────────────────
  const handleBulkRemoveProxies = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    try {
      for (const id of selectedProfileIds) {
        await updateProfileMutation.mutateAsync({
          id,
          proxyId: null,
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
          accountStatus: "pending" as const,
          credentialsDirty: true,
        });
      }
      toast({ title: "Proxies Removed", description: `${selectedProfileIds.length} account(s) unlinked from their proxy.` });
    } catch {
      toast({ title: "Error", description: "Failed to remove proxies.", variant: "destructive" });
    }
  }, [selectedProfileIds, updateProfileMutation, toast]);

  // ── Bulk: Assign TrustScore ───────────────────────────────────────────────
  const handleBulkAssignTrustScore = useCallback((levelId: string | null) => {
    if (selectedProfileIds.length === 0) return;
    for (const id of selectedProfileIds) {
      setTrustScore(id, levelId);
    }
    const level = getTrustLevels().find(l => l.id === levelId);
    toast({
      title: levelId ? "TrustScore Assigned" : "TrustScore Cleared",
      description: levelId
        ? `${selectedProfileIds.length} account(s) assigned ${level?.label ?? levelId}.`
        : `TrustScore cleared on ${selectedProfileIds.length} account(s).`,
    });
    setTsVersion(v => v + 1);
    setActionsOpen(false);
    setTsSubOpen(false);
  }, [selectedProfileIds, toast]);

  // ── Set Group ─────────────────────────────────────────────────────────────
  const handleSetGroup = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    const groupName = groupNameInput.trim();
    try {
      for (const id of selectedProfileIds) {
        await updateProfileMutation.mutateAsync({ id, tags: groupName || "" });
      }
      toast({ title: "Group Updated", description: `${selectedProfileIds.length} account(s) ${groupName ? `assigned to "${groupName}"` : "removed from group"}.` });
      setSetGroupOpen(false);
      setGroupNameInput("");
    } catch {
      toast({ title: "Error", description: "Failed to update group.", variant: "destructive" });
    }
  }, [selectedProfileIds, groupNameInput, updateProfileMutation, toast]);

  const handleUngroup = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    try {
      for (const id of selectedProfileIds) {
        await updateProfileMutation.mutateAsync({ id, tags: "" });
      }
      toast({ title: "Ungrouped", description: `${selectedProfileIds.length} account(s) removed from their group.` });
    } catch {
      toast({ title: "Error", description: "Failed to ungroup accounts.", variant: "destructive" });
    }
  }, [selectedProfileIds, updateProfileMutation, toast]);

  // ── Bulk: Open Embedded Browsers ─────────────────────────────────────────
  const handleBulkOpenBrowsers = useCallback(() => {
    const ids = selectedProfileIds.length > 0 ? selectedProfileIds : filteredProfiles.map(p => p.id);
    const targets = filteredProfiles.filter(p => ids.includes(p.id));
    for (const p of targets) {
      openWindow(p.id, p.username ?? "", p.userAgentEmbedded ?? "");
    }
  }, [selectedProfileIds, filteredProfiles, openWindow]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if focus is on an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!e.ctrlKey && !e.metaKey) return;
      switch (e.key.toLowerCase()) {
        case "d":
          e.preventDefault();
          handleBulkDelete();
          break;
        case "p":
          e.preventDefault();
          handleBulkRemoveProxies();
          break;
        case "r":
          e.preventDefault();
          handleVerifyAll();
          break;
        case "f":
          e.preventDefault();
          handleBulkFixCaptcha();
          break;
        case "o":
          e.preventDefault();
          handleBulkOpenBrowsers();
          break;
        case "l":
          e.preventDefault();
          handleBulkLoginEB();
          break;
        case "t":
          e.preventDefault();
          handleBulkToggle();
          break;
        case "c":
          e.preventDefault();
          handleUngroup();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleBulkDelete, handleBulkRemoveProxies, handleVerifyAll, handleBulkFixCaptcha, handleBulkOpenBrowsers, handleBulkLoginEB, handleBulkToggle, handleUngroup]);

  // Click-outside handler for the profiles manage-columns popup
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (manageProfileColsRef.current && !manageProfileColsRef.current.contains(e.target as Node)) {
        setManageProfileColsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const setSlot = useSidebarSetSlot();
  // Sidebar slot is unused on this page clear it on mount/unmount
  useEffect(() => { setSlot(null); return () => setSlot(null); }, [setSlot]);

  return (
    <AppLayout>
      {/* Hidden file input for group icon picker */}
      <input
        ref={groupIconInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleGroupIconFile}
      />
      <div className="mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-foreground shrink-0">Account Manager</h1>
          <Button
            onClick={() => setAddProfilePanelOpen(o => !o)}
            size="sm"
            className="bg-sky-400 hover:bg-sky-500 text-white border-0 shrink-0"
          >
            Add Account
          </Button>
          {addProfilePanelOpen && (
            <div className="flex items-center gap-2 ml-2 animate-in fade-in slide-in-from-left-2 duration-150">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={addProfileCount}
                onChange={e => {
                  const v = e.target.value.replace(/[^0-9]/g, "");
                  if (Number(v) > 999) return;
                  setAddProfileCount(v);
                }}
                onKeyDown={e => { if (e.key === "Enter") handleCreateMultiple(); if (e.key === "Escape") setAddProfilePanelOpen(false); }}
                autoFocus
                placeholder="1"
                maxLength={3}
                className="w-12 h-8 text-sm border-2 border-cyan-400 rounded px-1 bg-cyan-950/30 text-cyan-100 text-center font-bold focus:outline-none focus:border-cyan-300"
              />
              <Button
                size="sm"
                onClick={handleCreateMultiple}
                disabled={addProfileCreating}
                className="h-8 bg-sky-400 hover:bg-sky-500 text-white border-0"
              >
                {addProfileCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create"}
              </Button>
              <button
                onClick={() => setAddProfilePanelOpen(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Manage your Instagram accounts, proxies, and automation settings.</p>
      </div>

      {/* Status filter bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-xs">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={statusFilter}
            onChange={e => setFilterPersisted(e.target.value)}
            placeholder="Search accounts"
            className="h-8 pl-7 pr-7 text-sm"
          />
          {statusFilter && (
            <button
              onClick={() => setFilterPersisted("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {filterTokens.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {filteredProfiles?.length ?? 0} of {profiles?.length ?? 0} accounts
          </span>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer ml-1 shrink-0">
          <Checkbox
            checked={groupMode}
            onCheckedChange={checked => {
              const next = !!checked;
              setGroupMode(next);
              localStorage.setItem("profiles:groupMode", String(next));
            }}
            className="w-3.5 h-3.5"
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">Group Accounts</span>
        </label>
      </div>

      <div className="desktop-card overflow-hidden flex flex-col" style={{ height: "calc(100vh - 178px)" }}>
          {/* ── Top column-header bar always visible ────────────────────── */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-muted/40 text-[12px] font-bold uppercase tracking-wide text-foreground select-none shrink-0">
            <div style={{ width: profColWidths.account + 32 }} className="shrink-0 flex items-center gap-2 min-w-0">
              <button
                onClick={() => cycleSort("account")}
                className="flex items-center gap-1 text-left hover:text-foreground transition-colors"
              >
                ACCOUNT NAME
              </button>
            </div>
            {profColOrder.filter(k => k !== "account" && k !== "ip" && profColVisible[k as keyof typeof DEFAULT_PROFILES_COL_VISIBLE]).map(key => {
              const isDragTarget = profDragOverCol === key;
              const dragBorder = isDragTarget ? "border-l-2 border-l-primary bg-primary/5" : "";
              const dragProps = {
                draggable: true as const,
                onDragStart: (e: React.DragEvent) => { profDragColRef.current = key; e.dataTransfer.effectAllowed = "move"; },
                onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (profDragColRef.current && profDragColRef.current !== key) setProfDragOverCol(key); },
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault();
                  const from = profDragColRef.current;
                  profDragColRef.current = null;
                  setProfDragOverCol(null);
                  if (!from || from === key) return;
                  const reorderable = profColOrder.filter(k => k !== "account" && k !== "ip");
                  const fromIdx = reorderable.indexOf(from as any);
                  const toIdx = reorderable.indexOf(key as any);
                  if (fromIdx === -1 || toIdx === -1) return;
                  const next = [...reorderable];
                  next.splice(fromIdx, 1);
                  next.splice(toIdx, 0, from as any);
                  const fullOrder = ["account" as const, ...next, "ip" as const];
                  setProfColOrder(fullOrder);
                  localStorage.setItem("profiles_col_order", JSON.stringify(fullOrder));
                },
                onDragEnd: () => { profDragColRef.current = null; setProfDragOverCol(null); },
              };
              if (key === "status") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("status")} style={{ width: profColWidths.status }} className={`shrink-0 flex items-center justify-center gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  STATUS
                </button>
              );
              if (key === "active") return <div key={key} {...dragProps} style={{ width: profColWidths.active }} className={`shrink-0 text-left cursor-default select-none ${dragBorder}`}>Active</div>;
              if (key === "followers") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("followers")} style={{ width: profColWidths.followers }} className={`shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  FOLLOWERS
                </button>
              );
              if (key === "following") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("following")} style={{ width: profColWidths.following }} className={`shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  FOLLOWING
                </button>
              );
              if (key === "sync") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("sync")} style={{ width: profColWidths.sync }} className={`shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  SYNC
                </button>
              );
              if (key === "lastApiCall") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("lastApiCall")} style={{ width: profColWidths.lastApiCall }} className={`shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  LAST API CALL
                </button>
              );
              if (key === "actions") return <div key={key} {...dragProps} style={{ width: profColWidths.actions }} className={`shrink-0 text-left cursor-default select-none ${dragBorder}`}>Actions</div>;
              if (key === "battery") return <div key={key} {...dragProps} style={{ width: profColWidths.battery }} className={`shrink-0 text-left cursor-default select-none ${dragBorder}`}>Battery</div>;
              if (key === "connection") return <div key={key} {...dragProps} style={{ width: profColWidths.connection }} className={`shrink-0 text-left cursor-default select-none ${dragBorder}`}>Mbps</div>;
              if (key === "trustscore") return (
                <button key={key} {...dragProps} onClick={() => cycleSort("trustscore")} style={{ width: profColWidths.trustscore }} className={`shrink-0 flex items-center justify-center gap-1 hover:text-foreground transition-colors cursor-default select-none ${dragBorder}`}>
                  TRUSTSCORE
                </button>
              );
              if (key === "abd") return <div key={key} {...dragProps} style={{ width: profColWidths.abd }} className={`shrink-0 text-left cursor-default select-none ${dragBorder}`}>ABD</div>;
              return null;
            })}
            <div className="flex-1" />
            {profColVisible.ip && (
              <button
                onClick={() => cycleSort("ip")}
                style={{ width: profColWidths.ip }}
                className="shrink-0 flex items-center justify-start gap-1 pl-2 hover:text-foreground transition-colors"
              >
                IP:PORT
              </button>
            )}
          </div>

          {/* ── Scrollable body conditional content ────────────────────── */}
          <div ref={scrollBodyRef} className="overflow-y-auto flex-1 min-h-0">
          {isLoading ? (
            <div className="divide-y divide-border/40">
              {[1,2,3,4,5].map(i => <div key={i} className="h-8 animate-pulse bg-muted/30" />)}
            </div>
          ) : profiles?.length === 0 ? (
            <div className="flex flex-col items-center py-20">
              <Instagram className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium">No Profiles Yet</h3>
              <p className="text-muted-foreground text-sm mt-1 mb-4">Add your first Instagram account to start automating.</p>
              <Button onClick={handleCreate} variant="outline" disabled={createProfileMutation.isPending}>Add Profile</Button>
            </div>
          ) : filteredProfiles?.length === 0 ? (
            <div className="flex flex-col items-center py-16">
              <Filter className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <h3 className="text-base font-medium">No accounts match this filter</h3>
              <p className="text-muted-foreground text-sm mt-1">
                Try a different status or{" "}
                <button onClick={() => setFilterPersisted("")} className="underline hover:text-foreground transition-colors">clear the filter</button>.
              </p>
            </div>
          ) : (
            <>
          {(() => {
            const renderProfileRow = (profile: typeof filteredProfiles[0], idx: number) => {
              const acctStatus = (verifyingIds.has(profile.id) ? "verifying" : (profile.accountStatus ?? "pending")) as AccountStatus;
              const isStopped  = acctStatus === "stopped";
              const isEven     = idx % 2 === 1;
              const hasProxy   = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
              const isDupUsername = !!(profile.username && duplicateUsernames.has((profile.username ?? "").trim().toLowerCase()));
              return (
                <div
                  key={profile.id}
                  className={`flex items-center gap-3 px-3 py-1 border-b border-border/30 last:border-b-0 transition-colors select-none ${
                    selectedProfileIds.includes(profile.id)
                      ? "bg-primary/8 border-primary/20"
                      : isStopped
                      ? "opacity-50 bg-slate-50/80"
                      : isDupUsername
                      ? "bg-purple-50 hover:bg-purple-100/70 border-l-2 border-l-purple-400"
                      : isEven
                      ? "bg-slate-50/70 hover:bg-slate-100/60"
                      : "bg-white hover:bg-slate-50/60"
                  }`}
                  onMouseDown={e => {
                    if (e.button !== 0) return;
                    // Let the Checkbox and Switch handle their own clicks — don't double-toggle
                    if ((e.target as HTMLElement).closest('[role="checkbox"]')) return;
                    if ((e.target as HTMLElement).closest('[role="switch"]')) return;
                    e.preventDefault();
                    const isSelected = selectedProfileIds.includes(profile.id);
                    dragAddMode.current = !isSelected;
                    isDragSelecting.current = true;
                    toggleSelection(profile.id);
                  }}
                  onMouseEnter={() => {
                    if (!isDragSelecting.current) return;
                    const isSelected = selectedProfileIds.includes(profile.id);
                    if (dragAddMode.current !== isSelected) toggleSelection(profile.id);
                  }}
                >
                  <div className="w-5 shrink-0">
                    <Checkbox
                      checked={selectedProfileIds.includes(profile.id)}
                      onCheckedChange={() => toggleSelection(profile.id)}
                      data-testid={`checkbox-profile-${profile.id}`}
                    />
                  </div>
                  <div style={{ width: profColWidths.account }} className="shrink-0 min-w-0">
                    <Link href={`/profiles/${profile.id}`} onClick={(e: React.MouseEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }}>
                      <span
                        className={`text-xs font-semibold truncate hover:text-primary cursor-pointer flex items-center gap-1 ${isStopped ? "text-muted-foreground" : acctStatus === "valid" ? "text-foreground" : "text-red-600"}`}
                        data-testid={`text-username-${profile.id}`}
                        title={isDupUsername ? `Duplicate username: @${profile.username}` : undefined}
                      >
                        {profile.accountLabel || profile.username}
                        {profile.locked && <span title="Locked — excluded from copy targets"><Lock className="w-3 h-3 text-amber-500 shrink-0" /></span>}
                        {isDupUsername && <span title={`Duplicate username: @${profile.username}`} className="text-purple-500 font-bold text-[9px] shrink-0 border border-purple-300 rounded px-0.5 bg-purple-100">DUP</span>}
                        {flaggedIds.includes(profile.id) && <span title="Flagged account"><Flag className="w-3 h-3 text-red-500 shrink-0" /></span>}
                      </span>
                    </Link>
                  </div>
                  {profColOrder.filter(k => k !== "account" && k !== "ip" && profColVisible[k as keyof typeof DEFAULT_PROFILES_COL_VISIBLE]).map(key => {
                    if (key === "status") return (
                      <div key={key} style={{ width: profColWidths.status }} className="flex items-center justify-center gap-1.5 shrink-0">
                        {hasProxy
                          ? <AccountStatusBadge status={acctStatus} statusMessage={profile.statusMessage} />
                          : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border bg-red-50 text-red-700 border-red-200">
                              <Globe className="w-2.5 h-2.5" />No Proxy
                            </span>
                        }
                        {hasProxy && (acctStatus !== "valid" || profile.credentialsDirty) && !isStopped && (acctStatus !== "verifying" || verifyingIds.has(profile.id)) && (
                          <button onClick={() => handleVerify(profile.id)} disabled={verifyingIds.has(profile.id) || acctStatus === "verifying"} data-testid={`button-verify-${profile.id}`} className="text-[9px] font-bold text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors">
                            {verifyingIds.has(profile.id) ? "…" : "Verify"}
                          </button>
                        )}
                      </div>
                    );
                    if (key === "trustscore") return (
                      <div key={key} style={{ width: profColWidths.trustscore }} className="flex items-center justify-center shrink-0" onMouseDown={e => e.stopPropagation()}>
                        <TrustScoreBadge key={`ts-${profile.id}-${tsVersion}`} profileId={profile.id} />
                      </div>
                    );
                    if (key === "active") return (
                      <div key={key} style={{ width: profColWidths.active }} className="flex items-center justify-center shrink-0" onMouseDown={e => e.stopPropagation()}>
                        <Switch checked={!isStopped} onCheckedChange={() => toggleStopped(profile.id, acctStatus)} data-testid={`switch-active-${profile.id}`} className="data-[state=checked]:bg-green-500" disabled={!hasProxy} title={!hasProxy ? "Assign a proxy before enabling this account" : undefined} />
                      </div>
                    );
                    if (key === "followers") return (
                      <div key={key} style={{ width: profColWidths.followers }} className="shrink-0 flex items-center" onMouseDown={e => e.stopPropagation()}>
                        <span className="text-[11px] font-mono text-foreground/80">
                          {profile.followersCount != null ? profile.followersCount.toLocaleString() : <span className="text-muted-foreground/40">—</span>}
                        </span>
                      </div>
                    );
                    if (key === "following") return (
                      <div key={key} style={{ width: profColWidths.following }} className="shrink-0 flex items-center" onMouseDown={e => e.stopPropagation()}>
                        <span className="text-[11px] font-mono text-foreground/80">
                          {profile.followingCount != null ? profile.followingCount.toLocaleString() : <span className="text-muted-foreground/40">—</span>}
                        </span>
                      </div>
                    );
                    if (key === "sync") {
                      const syncAt = profile.lastSyncedAt ? new Date(profile.lastSyncedAt) : null;
                      let syncLabel = <span className="text-muted-foreground/40">Never</span>;
                      if (syncAt) {
                        const diffMs = Date.now() - syncAt.getTime();
                        const diffMin = Math.floor(diffMs / 60_000);
                        const diffHr  = Math.floor(diffMin / 60);
                        const diffDay = Math.floor(diffHr / 24);
                        if (diffMin < 1)        syncLabel = <span>Just now</span>;
                        else if (diffMin < 60)  syncLabel = <span>{diffMin}m ago</span>;
                        else if (diffHr  < 24)  syncLabel = <span>{diffHr}h ago</span>;
                        else                    syncLabel = <span>{diffDay}d ago</span>;
                      }
                      return (
                        <div key={key} style={{ width: profColWidths.sync }} className="shrink-0 flex items-center" title={syncAt?.toLocaleString() ?? "Never synced"} onMouseDown={e => e.stopPropagation()}>
                          <span className="text-[10px] text-muted-foreground truncate">{syncLabel}</span>
                        </div>
                      );
                    }
                    if (key === "lastApiCall") {
                      const lastDate = lastApiCallMap[profile.id] ? new Date(lastApiCallMap[profile.id]) : null;
                      let label: React.ReactNode = <span className="text-muted-foreground/40">Never</span>;
                      if (lastDate) {
                        const diffMs  = Date.now() - lastDate.getTime();
                        const diffMin = Math.floor(diffMs / 60_000);
                        const diffHr  = Math.floor(diffMin / 60);
                        const diffDay = Math.floor(diffHr / 24);
                        if (diffMin < 1)       label = <span>Just now</span>;
                        else if (diffMin < 60) label = <span>{diffMin}m ago</span>;
                        else if (diffHr < 24)  label = <span>{diffHr}h ago</span>;
                        else                   label = <span>{diffDay}d ago</span>;
                      }
                      return (
                        <div key={key} style={{ width: profColWidths.lastApiCall }} className="shrink-0 flex items-center" title={lastDate?.toLocaleString() ?? "No valid API calls recorded"} onMouseDown={e => e.stopPropagation()}>
                          <span className="text-[10px] text-muted-foreground truncate">{label}</span>
                        </div>
                      );
                    }
                    if (key === "actions") return (
                      <div key={key} style={{ width: profColWidths.actions }} className="shrink-0 flex items-center justify-start gap-3 overflow-hidden" onMouseDown={e => e.stopPropagation()}>
                        <button onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded ?? "")} title={!hasProxy ? "Assign a proxy before using the browser" : "Open embedded browser"} data-testid={`btn-open-browser-${profile.id}`} disabled={!hasProxy} className={`transition-colors ${!hasProxy ? "text-muted-foreground/40 cursor-not-allowed" : "text-muted-foreground hover:text-primary"}`}><Monitor className="w-[18px] h-[18px]" /></button>
                        <button onClick={() => { window.location.href = `/stats?profileId=${profile.id}&tab=metrics`; }} title="View account metrics" className="text-muted-foreground/40 hover:text-primary transition-colors"><BarChart2 className="w-[16px] h-[16px]" /></button>
                        <button onClick={() => setDeleteConfirm({ ids: [profile.id] })} data-testid={`button-delete-${profile.id}`} title="Delete account" className="text-muted-foreground/40 hover:text-destructive transition-colors"><Trash2 className="w-[16px] h-[16px]" /></button>
                      </div>
                    );
                    if (key === "battery") {
                      const fp  = profile.userAgentEmbedded ? _pageFingerprint(profile.userAgentEmbedded, profile.userAgentApi) : null;
                      const pct = fp?.batteryPct ?? null;
                      const chg = fp?.charging ?? false;
                      if (pct === null) return <div key={key} style={{ width: profColWidths.battery }} className="shrink-0" />;
                      const color = pct > 25 ? "text-green-600" : pct > 5 ? "text-amber-600" : "text-red-500";
                      const barW  = pct > 25 ? "bg-green-400" : pct > 5 ? "bg-amber-400" : "bg-red-400";
                      return (
                        <div key={key} style={{ width: profColWidths.battery }} className="shrink-0 flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
                          {chg
                            ? <BatteryCharging className="w-3 h-3 shrink-0 text-green-500" />
                            : <Battery className={`w-3 h-3 shrink-0 ${color}`} />}
                          <div className="w-10 h-1 rounded-full bg-slate-200 overflow-hidden">
                            <div className={`h-full rounded-full ${barW}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`text-[10px] font-mono font-semibold ${color}`}>{pct}%</span>
                        </div>
                      );
                    }
                    if (key === "connection") {
                      const live = (profile as any).ebLiveStats as { battery: number; charging: boolean; downlink: number } | undefined;
                      const mbps = live ? live.downlink : (profile.userAgentEmbedded ? _pageFingerprint(profile.userAgentEmbedded, profile.userAgentApi).downlink : null);
                      if (mbps === null) return <div key={key} style={{ width: profColWidths.connection }} className="shrink-0" />;
                      return (
                        <div key={key} style={{ width: profColWidths.connection }} className="shrink-0 flex items-center gap-1" onMouseDown={e => e.stopPropagation()}>
                          <Wifi className="w-3 h-3 shrink-0 text-blue-400" />
                          <span className="text-[10px] font-mono font-semibold text-blue-600">{mbps}</span>
                        </div>
                      );
                    }
                    if (key === "abd") {
                      const count = abdDailyCount[profile.id] ?? 0;
                      const isFixing = fixingAbdIds.has(profile.id);
                      return (
                        <div key={key} style={{ width: profColWidths.abd }} className="shrink-0 flex items-center gap-1.5 justify-center" onMouseDown={e => e.stopPropagation()} title={count > 0 ? `${count} automated behaviour warning${count === 1 ? "" : "s"} auto-dismissed today` : "No ABD flags today"}>
                          <span className={`text-[11px] font-bold ${count > 0 ? "text-orange-600" : "text-muted-foreground/50"}`}>{count}</span>
                          {profile.accountStatus === "automated_behaviour_detected" && (
                            <button
                              onClick={() => handleFixAbdForProfile(profile.id)}
                              disabled={isFixing}
                              className="text-[9px] font-bold text-orange-500 hover:text-orange-700 disabled:opacity-40 transition-colors"
                              title="Manually dismiss Automated Behaviour Detected warning"
                            >
                              {isFixing ? "…" : "Fix"}
                            </button>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })}
                  {profColVisible.ip && (() => {
                    let ip = "";
                    if (profile.proxyId && proxies) {
                      const px = proxies.find(p => p.id === profile.proxyId);
                      if (px?.host && px?.port) ip = `${px.host}:${px.port}`;
                    } else if (profile.proxyHost && profile.proxyPort) {
                      ip = `${profile.proxyHost}:${profile.proxyPort}`;
                    }
                    return (
                      <div style={{ width: profColWidths.ip }} className="shrink-0 text-left pl-2 ml-auto" title={ip || "No proxy"}>
                        <span className="text-[10px] font-mono text-muted-foreground truncate block">{ip || " "}</span>
                      </div>
                    );
                  })()}
                </div>
              );
            };

            if (groupMode && groupedProfiles) {
              return Array.from(groupedProfiles.entries()).map(([groupKey, groupProfiles]) => {
                const displayName = groupKey === "__ungrouped__" ? "No Group Assigned" : groupKey;
                const isCollapsed = collapsedGroups.has(groupKey);
                const groupIds = groupProfiles.map(p => p.id);
                const allInGroupSelected = groupIds.every(id => selectedProfileIds.includes(id));
                return (
                  <div key={groupKey}>
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-background border-b border-border sticky top-0 z-10 select-none">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <button onClick={() => toggleGroupCollapse(groupKey)} className="flex items-center gap-2 min-w-0 text-left">
                          {isCollapsed
                            ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                          <span className={`text-sm font-bold truncate ${groupKey === "__ungrouped__" ? "text-muted-foreground italic" : "text-foreground"}`}>{displayName}</span>
                        </button>
                        {groupKey !== "__ungrouped__" && (
                          <button
                            onClick={e => { e.stopPropagation(); groupIconKeyRef.current = groupKey; groupIconInputRef.current?.click(); }}
                            title={groupIcons[groupKey] ? "Change group icon" : "Add group icon"}
                            className="shrink-0 w-[18px] h-[18px] rounded border border-dashed border-border/60 hover:border-primary/50 overflow-hidden flex items-center justify-center transition-colors bg-muted/20 hover:bg-muted/50"
                          >
                            {groupIcons[groupKey]
                              ? <img src={groupIcons[groupKey]} alt="" className="w-full h-full object-cover" />
                              : <ImagePlus className="w-2.5 h-2.5 text-muted-foreground/30" />
                            }
                          </button>
                        )}
                        <span className="text-[10px] text-muted-foreground shrink-0">({groupProfiles.length})</span>
                      </div>
                      <button
                        onClick={() => {
                          if (allInGroupSelected) setSelectedProfileIds(prev => prev.filter(id => !groupIds.includes(id)));
                          else setSelectedProfileIds(prev => [...new Set([...prev, ...groupIds])]);
                        }}
                        className="text-[10px] text-primary hover:underline shrink-0 font-medium"
                      >
                        {allInGroupSelected ? "None" : "All"}
                      </button>
                    </div>
                    {!isCollapsed && groupProfiles.map((p, i) => renderProfileRow(p, i))}
                  </div>
                );
              });
            }
            return filteredProfiles?.map((profile, idx) => renderProfileRow(profile, idx));
          })()}
            </>
          )}
          </div>{/* end scrollable body */}

          {/* ── Bottom toolbar inside card, width matches card ─────────── */}
          <div className="flex items-center gap-4 px-3 py-2 border-t border-border bg-muted/40 select-none shrink-0">
            <button
              onClick={() => setSelectedProfileIds(filteredProfiles.map(p => p.id))}
              className="text-[12px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors whitespace-nowrap"
            >
              Select All{selectedProfileIds.length > 0 && <span className="ml-1 text-[11px] font-bold text-sky-400">({selectedProfileIds.length})</span>}
            </button>
            <button
              onClick={() => setSelectedProfileIds([])}
              className="text-[12px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors whitespace-nowrap"
            >
              Select None
            </button>
            <button
              onClick={() => setActionsOpen(true)}
              className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors"
            >
              Actions <ChevronDown className="w-3.5 h-3.5" />
            </button>
            <div ref={manageProfileColsRef} className="relative ml-auto">
              <button
                onClick={() => setManageProfileColsOpen(o => !o)}
                className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors"
              >
                <Settings2 className="w-3.5 h-3.5" /> Columns
              </button>
              {manageProfileColsOpen && (
                <div className="absolute right-0 bottom-full mb-2 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-72">
                  <p className="text-[11px] font-bold uppercase tracking-wide mb-3 text-muted-foreground">Columns</p>
                  {profColOrder.map((key, idx) => {
                    const label = PROFILES_COL_LABELS[key];
                    const isAccount = key === "account";
                    const isIp = key === "ip";
                    const isMiddle = !isAccount && !isIp;
                    const reorderable = profColOrder.filter(k => k !== "account" && k !== "ip");
                    const midIdx = reorderable.indexOf(key as any);
                    const updateCol = (delta: number) => {
                      const v = Math.max(1, Math.min(600, profColWidths[key] + delta));
                      const next = { ...profColWidths, [key]: v };
                      setProfColWidths(next);
                      localStorage.setItem("profiles_col_widths_px", JSON.stringify(next));
                    };
                    const isVisible = isAccount || profColVisible[key as keyof typeof DEFAULT_PROFILES_COL_VISIBLE];
                    return (
                      <div key={key} className="flex items-center gap-1 mb-2">
                        <div className="flex flex-col mr-0.5">
                          <button onClick={() => moveProfCol(key, -1)} disabled={!isMiddle || midIdx === 0} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronUp className="w-2.5 h-2.5" /></button>
                          <button onClick={() => moveProfCol(key, 1)} disabled={!isMiddle || midIdx === reorderable.length - 1} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronDown className="w-2.5 h-2.5" /></button>
                        </div>
                        <Checkbox
                          checked={isAccount || isVisible}
                          disabled={isAccount}
                          onCheckedChange={checked => {
                            if (isAccount) return;
                            const next = { ...profColVisible, [key]: !!checked };
                            setProfColVisible(next);
                            localStorage.setItem("profiles_col_visible_v2", JSON.stringify(next));
                          }}
                          className="mr-1"
                        />
                        <label className="text-xs w-16 text-muted-foreground shrink-0">{label}</label>
                        <button onClick={() => updateCol(-10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronDown className="w-3 h-3" /></button>
                        <input type="number" min={1} max={600} value={profColWidths[key]} onChange={e => { const v = Math.max(1, Math.min(600, Number(e.target.value))); const next = { ...profColWidths, [key]: v }; setProfColWidths(next); localStorage.setItem("profiles_col_widths_px", JSON.stringify(next)); }} className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center" />
                        <button onClick={() => updateCol(10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronUp className="w-3 h-3" /></button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => { setProfColWidths(DEFAULT_PROFILES_COL_WIDTHS); localStorage.removeItem("profiles_col_widths_px"); setProfColVisible(DEFAULT_PROFILES_COL_VISIBLE); localStorage.removeItem("profiles_col_visible_v2"); setProfColOrder(DEFAULT_PROFILES_COL_ORDER); localStorage.removeItem("profiles_col_order"); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* Hidden Jarvee binary import file input */}
      <input
        ref={jarveeImportRef}
        type="file"
        accept="*"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          if (!jarveeImportRef.current) return;
          jarveeImportRef.current.value = "";
          if (!files.length) return;
          setJarveeImporting(true);

          let totalImported = 0;
          let totalFailed = 0;
          const allErrors: string[] = [];

          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (files.length > 1) {
              toast({ title: `Parsing ${i + 1} of ${files.length}…`, description: file.name });
            }
            try {
              const buffer = await file.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = "";
              const CHUNK = 8192;
              for (let j = 0; j < bytes.length; j += CHUNK) {
                binary += String.fromCharCode(...bytes.subarray(j, j + CHUNK));
              }
              const fileBase64 = btoa(binary);
              const res = await fetch("/api/profiles/import-jarvee", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ fileBase64 }),
              });
              const data = await res.json();
              if (!res.ok) {
                allErrors.push(`${file.name}: ${data.error ?? "Unknown error"}`);
              } else {
                totalImported += data.imported ?? 0;
                totalFailed   += data.failed   ?? 0;
                if (data.failed > 0) {
                  const failNames = (data.accounts ?? []).filter((a: any) => !a.ok).map((a: any) => a.username).join(", ");
                  allErrors.push(`${file.name}: failed for ${failNames}`);
                }
              }
            } catch (err: any) {
              allErrors.push(`${file.name}: ${err?.message ?? "Could not read file"}`);
            }
          }

          if (allErrors.length === 0) {
            toast({ title: "Jarvee import complete", description: `${totalImported} account${totalImported === 1 ? "" : "s"} imported successfully. All accounts set to Pending — verify before running.` });
          } else if (totalImported > 0) {
            toast({ title: `Jarvee import: ${totalImported} imported, ${totalFailed + allErrors.length} failed`, description: allErrors.join("; "), variant: "destructive" });
          } else {
            toast({ title: "Jarvee import failed", description: allErrors.join("; "), variant: "destructive" });
          }

          setJarveeImporting(false);
        }}
      />

      {/* Hidden EQX import file input — multiple allowed */}
      <input
        ref={eqxImportRef}
        type="file"
        accept=".eqx"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          if (!eqxImportRef.current) return;
          eqxImportRef.current.value = "";
          if (!files.length) return;
          setEqxImporting(true);

          const results: { username: string; ok: boolean; error?: string }[] = [];

          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (files.length > 1) {
              toast({ title: `Importing ${i + 1} of ${files.length}…`, description: file.name });
            }
            try {
              const buffer = await file.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = "";
              const CHUNK = 8192;
              for (let j = 0; j < bytes.length; j += CHUNK) {
                binary += String.fromCharCode(...bytes.subarray(j, j + CHUNK));
              }
              const eqxBase64 = btoa(binary);
              const res = await fetch("/api/profiles/import-eqx", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ eqxBase64 }),
              });
              const data = await res.json();
              if (!res.ok) {
                results.push({ username: file.name, ok: false, error: data.error ?? "Unknown error" });
              } else {
                // Restore trust score from EQX payload into localStorage so the
                // badge shows the correct level immediately after import.
                if (data.trustScoreId && data.profileId) {
                  localStorage.setItem(`trustscore_v2_${data.profileId}`, String(data.trustScoreId));
                }
                results.push({ username: data.username, ok: true });
              }
            } catch (err: any) {
              results.push({ username: file.name, ok: false, error: err?.message ?? "Could not read file" });
            }
          }

          // Summary toast
          if (files.length === 1) {
            const r = results[0];
            if (r.ok) {
              toast({ title: "EQX imported", description: `@${r.username} imported successfully.` });
            } else {
              toast({ title: "Import failed", description: r.error, variant: "destructive" });
            }
          } else {
            const ok = results.filter(r => r.ok);
            const failed = results.filter(r => !r.ok);
            if (ok.length > 0) {
              toast({
                title: `${ok.length} of ${files.length} EQX files imported`,
                description: failed.length > 0
                  ? `Failed: ${failed.map(r => r.username).join(", ")}`
                  : `${ok.map(r => `@${r.username}`).join(", ")}`,
              });
            } else {
              toast({ title: "All imports failed", description: failed.map(r => r.error).join("; "), variant: "destructive" });
            }
          }

          setEqxImporting(false);
        }}
      />

      {/* ── Actions popup no dark overlay, transparent click-away ──────── */}
      {actionsOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[720px] overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-border">
              <p className="text-sm font-semibold">Actions</p>
            </div>
            <div className="py-1 grid grid-cols-3">
              <button onClick={() => { setActionsOpen(false); setImportOpen(true); }} className="flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                Import Profiles
                <ChevronDown className="w-4 h-4 shrink-0 text-cyan-500" />
              </button>
              <button onClick={() => { setActionsOpen(false); handleExportProfiles(); }} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                <FileDown className="w-4 h-4 shrink-0 text-muted-foreground" /> Export Profiles
              </button>
              <button
                onClick={() => { setActionsOpen(false); eqxImportRef.current?.click(); }}
                disabled={eqxImporting}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {eqxImporting ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <Upload className="w-4 h-4 shrink-0 text-primary" />}
                Import EQX File
              </button>
              <button
                onClick={async () => {
                  setActionsOpen(false);
                  if (selectedProfileIds.length === 0) {
                    toast({ title: "No accounts selected", description: "Select at least one account to export as EQX.", variant: "destructive" });
                    return;
                  }

                  const eApi = (window as any).electronAPI;

                  if (eApi?.pickEqxFolder) {
                    // Electron path (two-phase): ask where to save FIRST, then fetch and write.
                    const pick = await eApi.pickEqxFolder();
                    if (pick.canceled) return;
                    const folder: string = pick.folder;

                    const files: Array<{ filename: string; data: string }> = [];
                    const fetchErrors: string[] = [];
                    const exportTotal = selectedProfileIds.length;
                    for (let ei = 0; ei < selectedProfileIds.length; ei++) {
                      const id = selectedProfileIds[ei];
                      const profile = profiles?.find(p => p.id === id);
                      const safeUsername = (profile?.username || String(id)).replace(/[^a-zA-Z0-9_-]/g, "_");
                      try {
                        const tsId = localStorage.getItem(`trustscore_v2_${id}`);
                        const params = new URLSearchParams({ pos: String(ei + 1), total: String(exportTotal) });
                        if (tsId) params.set("trustScoreId", tsId);
                        const exportUrl = `/api/profiles/${id}/export-eqx?${params.toString()}`;
                        const res = await fetch(exportUrl, { credentials: "include" });
                        if (!res.ok) { fetchErrors.push(safeUsername); continue; }
                        const arrayBuf = await res.arrayBuffer();
                        const bytes = new Uint8Array(arrayBuf);
                        let binary = "";
                        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                        files.push({ filename: `${safeUsername}.eqx`, data: btoa(binary) });
                      } catch { fetchErrors.push(safeUsername); }
                    }
                    if (fetchErrors.length > 0) {
                      toast({ title: "Export failed", description: `Could not fetch: ${fetchErrors.join(", ")}`, variant: "destructive" });
                    }
                    if (files.length === 0) return;
                    const writeResult = await eApi.writeEqxFiles({ folder, files });
                    toast({ title: "EQX Export Complete", description: `${writeResult.count} file(s) saved to ${folder}` });
                  } else {
                    // Browser/web fallback: individual downloads
                    let successCount = 0;
                    const fallbackTotal = selectedProfileIds.length;
                    for (let ei2 = 0; ei2 < selectedProfileIds.length; ei2++) {
                      const id = selectedProfileIds[ei2];
                      const profile = profiles?.find(p => p.id === id);
                      const safeUsername = (profile?.username || String(id)).replace(/[^a-zA-Z0-9_-]/g, "_");
                      try {
                        const tsId2 = localStorage.getItem(`trustscore_v2_${id}`);
                        const p2 = new URLSearchParams({ pos: String(ei2 + 1), total: String(fallbackTotal) });
                        if (tsId2) p2.set("trustScoreId", tsId2);
                        const exportUrl2 = `/api/profiles/${id}/export-eqx?${p2.toString()}`;
                        const res = await fetch(exportUrl2, { credentials: "include" });
                        if (!res.ok) { toast({ title: "Export failed", description: `Could not export ${safeUsername}`, variant: "destructive" }); continue; }
                        const blob = await res.blob();
                        const objectUrl = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = objectUrl; a.download = `${safeUsername}.eqx`;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
                        successCount++;
                      } catch { toast({ title: "Export failed", description: `Error exporting ${safeUsername}`, variant: "destructive" }); }
                    }
                    if (successCount > 1) toast({ title: "EQX Export Complete", description: `${successCount} accounts exported` });
                  }
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileDown className="w-4 h-4 shrink-0 text-primary" />
                Export EQX{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={() => { setActionsOpen(false); jarveeImportRef.current?.click(); }}
                disabled={jarveeImporting}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {jarveeImporting ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <Upload className="w-4 h-4 shrink-0 text-muted-foreground" />}
                Import Binary File
              </button>
              <button
                onClick={async () => {
                  setActionsOpen(false);
                  try {
                    const tz = new Date().getTimezoneOffset();
                    const ids = selectedProfileIds.length > 0 ? selectedProfileIds.join(",") : "";
                    const url = `/api/logs/export?${ids ? `profileIds=${ids}&` : ""}tz=${tz}`;
                    const res = await fetch(url, { credentials: "include" });
                    if (!res.ok) { toast({ title: "Export failed", description: "Could not fetch API call history.", variant: "destructive" }); return; }
                    const text = await res.text();
                    const filename = `api-calls_${new Date().toISOString().slice(0, 10)}.csv`;
                    const eApi2 = (window as any).electronAPI;
                    if (eApi2?.openCsvTemp) {
                      await eApi2.openCsvTemp({ content: text, filename });
                    } else {
                      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = filename;
                      document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                    }
                  } catch { toast({ title: "Export failed", variant: "destructive" }); }
                }}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left"
              >
                <FileDown className="w-4 h-4 shrink-0 text-muted-foreground" />
                Export API Calls{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleBulkOpenBrowsers(); }} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                <Monitor className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="whitespace-nowrap">Open EB</span><span className="ml-1 text-[8px] font-semibold text-foreground">Ctrl+O</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkLoginEB(); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <LogIn className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="whitespace-nowrap">Login EB</span><span className="ml-1 text-[8px] font-semibold text-foreground">Ctrl+L</span>
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleVerifyAll(); }} disabled={verifyingAll || selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                {verifyingAll ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <RefreshCw className="w-4 h-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1">Verify {selectedProfileIds.length} Account{selectedProfileIds.length !== 1 ? "s" : ""}</span><span className="ml-1 text-[7px] text-foreground">Ctrl+R</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkFixCaptcha(); }} disabled={selectedProfileIds.length === 0 || fixingCaptcha} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                {fixingCaptcha ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <ScanFace className="w-4 h-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1">Fix Captcha</span><span className="ml-1 text-[7px] text-foreground">Ctrl+F</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkFixAbd(); }} disabled={fixingAbd} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                {fixingAbd ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <ShieldCheck className="w-4 h-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1">Fix Auto-Behaviour ({selectedProfileIds.length > 0 ? selectedProfileIds.length : filteredProfiles.length})</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkRemoveProxies(); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Globe className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="flex-1">Remove Proxies</span><span className="ml-1 text-[7px] text-foreground">Ctrl+P</span>
              </button>
              <button onClick={() => { setActionsOpen(false); setResetDeviceConfirmOpen(true); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Smartphone className="w-4 h-4 shrink-0 text-muted-foreground" /> Reset Device IDs
              </button>
              <button onClick={() => { setActionsOpen(false); setResetAndClearConfirmOpen(true); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Smartphone className="w-4 h-4 shrink-0 text-destructive" /> Reset IDs + Clear Cookies
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => {
                  setActionsOpen(false);
                  const tags = selectedProfileIds.map(id => profiles?.find(p => p.id === id)?.tags ?? "");
                  const common = tags.every(t => t === tags[0]) ? (tags[0] ?? "") : "";
                  setGroupNameInput(common);
                  setSetGroupOpen(true);
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Tag className="w-4 h-4 shrink-0 text-muted-foreground" />
                Group Accounts{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={() => { setActionsOpen(false); handleUngroup(); }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Tag className="w-4 h-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">Ungroup Accounts{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}</span><span className="ml-1 text-[7px] text-foreground">Ctrl+C</span>
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              {/* Assign TrustScore */}
              <button
                onClick={() => setTsSubOpen(o => !o)}
                disabled={selectedProfileIds.length === 0}
                className="col-span-3 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full shrink-0" style={{ background: "#1AD2F2", border: "1px solid #0eb8d4" }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="white"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" /></svg>
                </span>
                <span className="flex-1">Assign TrustScore{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}</span>
                <svg className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${tsSubOpen ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {tsSubOpen && (
                <div className="col-span-3 px-4 pb-3">
                  <div className="flex flex-wrap gap-1.5 max-h-[180px] overflow-y-auto">
                    {getTrustLevels().map(lvl => {
                      const Icon = lvl.icon;
                      return (
                        <button
                          key={lvl.id}
                          onClick={() => handleBulkAssignTrustScore(lvl.id)}
                          className="flex items-center gap-1 rounded-full px-2 py-0.5 transition-opacity hover:opacity-75"
                          style={{ background: lvl.bg, border: `1px solid ${lvl.border}`, cursor: "pointer" }}
                          title={lvl.label}
                        >
                          <Icon size={10} color={lvl.text} fill={lvl.text} strokeWidth={2} />
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: lvl.text, whiteSpace: "nowrap" }}>{lvl.label}</span>
                        </button>
                      );
                    })}
                    <button
                      onClick={() => handleBulkAssignTrustScore(null)}
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors"
                      style={{ border: "1px dashed #94a3b8", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", whiteSpace: "nowrap" }}
                    >
                      Clear score
                    </button>
                  </div>
                </div>
              )}
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => { setActionsOpen(false); handleBulkLock(true); }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Lock className="w-4 h-4 shrink-0 text-amber-500" /> Lock Accounts{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={() => { setActionsOpen(false); handleBulkLock(false); }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <LockOpen className="w-4 h-4 shrink-0 text-muted-foreground" /> Unlock Accounts{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => { setActionsOpen(false); setChangeDetailsOpen(true); }}
                disabled={selectedProfileIds.length === 0}
                className="col-span-3 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <UserCog className="w-4 h-4 shrink-0 text-muted-foreground" />
                Change Details{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => { selectedProfileIds.length > 0 && selectedProfileIds.every(id => flaggedIds.includes(id)) ? handleBulkUnflag() : handleBulkFlag(); }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Flag className="w-4 h-4 shrink-0 text-red-500" />
                {selectedProfileIds.length > 0 && selectedProfileIds.every(id => flaggedIds.includes(id))
                  ? `Unflag Accounts (${selectedProfileIds.length})`
                  : `Flag Accounts${selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}`
                }
              </button>
              <button
                onClick={async () => {
                  if (selectedProfileIds.length === 0) {
                    toast({ title: "No accounts selected", description: "Select at least one account to flag as banned.", variant: "destructive" });
                    return;
                  }
                  setActionsOpen(false);
                  const confirmed = window.confirm(
                    `Flag ${selectedProfileIds.length} account${selectedProfileIds.length !== 1 ? "s" : ""} as banned?\n\nThis will:\n• Snapshot their full API call history for ban analytics\n• Permanently delete them from Equinox\n\nThis cannot be undone.`
                  );
                  if (!confirmed) return;
                  let successCount = 0;
                  for (const id of selectedProfileIds) {
                    try {
                      const r = await fetch(`/api/profiles/${id}/flag-banned`, { method: "POST", credentials: "include" });
                      if (r.ok) successCount++;
                    } catch {}
                  }
                  toast({ title: "Flagged as Banned", description: `${successCount} account${successCount !== 1 ? "s" : ""} recorded in ban analytics and removed.` });
                  queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed text-red-600"
              >
                <Ban className="w-4 h-4 shrink-0" />
                Flag as Banned{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={async () => {
                  if (selectedProfileIds.length === 0) {
                    toast({ title: "No accounts selected", description: "Select at least one account to flag.", variant: "destructive" });
                    return;
                  }
                  setActionsOpen(false);
                  const confirmed = window.confirm(
                    `Flag ${selectedProfileIds.length} account${selectedProfileIds.length !== 1 ? "s" : ""} as Automated Behaviour Detected?\n\nThis will:\n• Snapshot their API call history for Evasion Stats\n• Set their status to Automated Behaviour Detected\n• Keep the accounts in Equinox (not deleted)\n\nYou can still verify and recover these accounts.`
                  );
                  if (!confirmed) return;
                  let successCount = 0;
                  for (const id of selectedProfileIds) {
                    try {
                      const r = await fetch(`/api/profiles/${id}/flag-automated`, { method: "POST", credentials: "include" });
                      if (r.ok) successCount++;
                    } catch {}
                  }
                  toast({ title: "Flagged as Automated Behaviour", description: `${successCount} account${successCount !== 1 ? "s" : ""} recorded in Evasion Stats.` });
                  queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed text-orange-600"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Flag as Automated Behaviour{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={async () => {
                  if (selectedProfileIds.length === 0) {
                    toast({ title: "No accounts selected", description: "Select at least one account to flag.", variant: "destructive" });
                    return;
                  }
                  setActionsOpen(false);
                  const confirmed = window.confirm(
                    `Flag ${selectedProfileIds.length} account${selectedProfileIds.length !== 1 ? "s" : ""} as Captcha Error?\n\nThis will:\n• Snapshot their API call history for Evasion Stats\n• Set their status to Captcha\n• Keep the accounts in Equinox (not deleted)\n\nYou can still verify and recover these accounts.`
                  );
                  if (!confirmed) return;
                  let successCount = 0;
                  for (const id of selectedProfileIds) {
                    try {
                      const r = await fetch(`/api/profiles/${id}/flag-captcha`, { method: "POST", credentials: "include" });
                      if (r.ok) successCount++;
                    } catch {}
                  }
                  toast({ title: "Flagged as Captcha Error", description: `${successCount} account${successCount !== 1 ? "s" : ""} recorded in Evasion Stats.` });
                  queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-yellow-50 dark:hover:bg-yellow-900/10 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed text-yellow-600"
              >
                <ShieldAlert className="w-4 h-4 shrink-0" />
                Flag as Captcha Error{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <div className="col-span-3 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleBulkDelete(); }} disabled={selectedProfileIds.length === 0} className="col-span-3 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-red-50 text-destructive transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Trash2 className="w-4 h-4 shrink-0" /><span className="flex-1">Delete Selected</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+D</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Set Group dialog ──────────────────────────────────────────────── */}
      {setGroupOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setSetGroupOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-80 overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-border">
              <p className="text-sm font-semibold">Set Group</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectedProfileIds.length} account{selectedProfileIds.length !== 1 ? "s" : ""} selected
              </p>
            </div>
            <div className="p-5">
              <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2 block">Group Name</label>
              <Input
                value={groupNameInput}
                onChange={e => setGroupNameInput(e.target.value)}
                placeholder="e.g. Clients, Niche A…"
                className="h-8 text-sm"
                onKeyDown={e => {
                  if (e.key === "Enter") handleSetGroup();
                  if (e.key === "Escape") setSetGroupOpen(false);
                }}
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">Leave blank to remove from any group.</p>
            </div>
            <div className="px-5 pb-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setSetGroupOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSetGroup}>Apply</Button>
            </div>
          </div>
        </>
      )}

      {/* ── Change Details dialog ─────────────────────────────────────────── */}
      {changeDetailsOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setChangeDetailsOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[520px] overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-border flex items-center gap-2">
              <UserCog className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-semibold">Change Details</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {selectedProfileIds.length} account{selectedProfileIds.length !== 1 ? "s" : ""} selected
                </p>
              </div>
            </div>
            <div className="p-5 space-y-5">
              {/* Username */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5 block">
                  Username
                </label>
                <Input
                  value={changeDetailsUsername}
                  onChange={e => setChangeDetailsUsername(e.target.value)}
                  placeholder="{newuser_a|newuser_b|newuser_c}"
                  className="h-8 text-sm font-mono"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Use spintax <span className="font-mono bg-muted px-1 rounded">{"{ option1 | option2 | option3 }"}</span> to randomly pick one per account.
                </p>
              </div>

              {/* Bio */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5 block">
                  Bio
                </label>
                <textarea
                  value={changeDetailsBio}
                  onChange={e => setChangeDetailsBio(e.target.value)}
                  placeholder={"{ Fitness coach 💪 | Personal trainer 🏋️ | Helping you reach your goals 🎯 }"}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Use spintax <span className="font-mono bg-muted px-1 rounded">{"{ option1 | option2 }"}</span> for random bio per account.
                </p>
              </div>

              {/* Profile Picture */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5 block">
                  Profile Picture
                </label>
                <input
                  ref={changeDetailsPicInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) setChangeDetailsPictures(prev => [...prev, ...files]);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => changeDetailsPicInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-border hover:border-primary hover:bg-muted/40 transition-colors text-sm text-muted-foreground w-full"
                >
                  <Images className="w-4 h-4 shrink-0" />
                  <span>Browse images… <span className="text-[10px]">(multiple allowed — one picked at random per account)</span></span>
                </button>
                {changeDetailsPictures.length > 0 && (
                  <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                    {changeDetailsPictures.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-foreground bg-muted/40 rounded px-2 py-1">
                        <ImagePlus className="w-3 h-3 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setChangeDetailsPictures(prev => prev.filter((_, j) => j !== i))}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {changeDetailsPictures.length === 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1">No images selected. A random image will be chosen per account at run time.</p>
                )}
              </div>
            </div>
            <div className="px-5 pb-4 flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" size="sm" onClick={() => { setChangeDetailsOpen(false); setChangeDetailsUsername(""); setChangeDetailsBio(""); setChangeDetailsPictures([]); }}>Cancel</Button>
              <Button size="sm" onClick={() => { setChangeDetailsOpen(false); toast({ title: "Change Details queued", description: `Scheduled for ${selectedProfileIds.length} account${selectedProfileIds.length !== 1 ? "s" : ""}` }); }}>Apply</Button>
            </div>
          </div>
        </>
      )}

      <AlertDialog open={!!deleteConfirm} onOpenChange={open => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteConfirm?.ids.length === 1 ? "Profile" : `${deleteConfirm?.ids.length} Profiles`}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.ids.length === 1
                ? "This account will be permanently removed."
                : `${deleteConfirm?.ids.length} accounts will be permanently removed.`}
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteConfirm) { performDelete(deleteConfirm.ids); setDeleteConfirm(null); } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetDeviceConfirmOpen} onOpenChange={setResetDeviceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Device IDs?</AlertDialogTitle>
            <AlertDialogDescription>
              This will assign new random device fingerprints (User Agent, Device ID, UUID) to{" "}
              {selectedProfileIds.length} selected account{selectedProfileIds.length !== 1 ? "s" : ""} and set their status to Pending. Instagram may require fresh verification after this change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkResetDeviceIds}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetAndClearConfirmOpen} onOpenChange={setResetAndClearConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Device IDs + Clear Cookies?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear all session cookies AND assign new random device fingerprints to{" "}
              {selectedProfileIds.length} selected account{selectedProfileIds.length !== 1 ? "s" : ""}. The account{selectedProfileIds.length !== 1 ? "s" : ""} will be logged out and set to Pending — a fresh login and verification will be required.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBulkResetAndClear}
            >
              Reset &amp; Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Account Limit Reached</AlertDialogTitle>
            <AlertDialogDescription>
              Your current plan allows up to {licenseData?.accountLimit ?? 0} account{(licenseData?.accountLimit ?? 0) !== 1 ? "s" : ""}.
              You have reached that limit. Sign in to My Account in Settings to upgrade your plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
