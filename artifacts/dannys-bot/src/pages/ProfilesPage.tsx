import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProfiles, useCreateProfile, useDeleteProfile, useUpdateAccountStatus, useVerifyProfile, useUpdateProfile } from "@/hooks/use-profiles";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents } from "@/shared/userAgents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Plus, Trash2, Instagram, Activity, ChevronDown, ChevronUp, ChevronRight, Upload, Download,
  ShieldCheck, Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, LogIn, Loader2, Globe, Clock,
  Smartphone, FileDown, Filter, X, Settings2,
  AlertTriangle, ShieldAlert, WifiOff, RefreshCw, Lock, LockOpen, UserMinus, Camera, Eye,
  Tag, FolderOpen,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import type { AccountStatus } from "@shared/schema";

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
  account_disabled:     { label: "Acct Disabled",        icon: UserMinus,   pill: "bg-red-50    text-red-700    border-red-200"    },
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
  suspended:            { label: "Suspended",            icon: UserMinus,   pill: "bg-red-50    text-red-700    border-red-200"    },
  selfie_verification:  { label: "Selfie Verify",        icon: Camera,      pill: "bg-purple-50 text-purple-700 border-purple-200" },
  own_phone_verification: { label: "Own Phone Verify",  icon: Smartphone,  pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  email_connection:     { label: "Email Connect",        icon: Mail,        pill: "bg-orange-50 text-orange-700 border-orange-200" },
  upload:               { label: "Upload",               icon: Upload,      pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  review:               { label: "Review",               icon: Eye,         pill: "bg-slate-100 text-slate-600  border-slate-200"  },
};

function AccountStatusBadge({ status, statusMessage }: { status: string; statusMessage?: string | null }) {
  const meta = STATUS_META[status as AccountStatus] ?? STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span
      title={statusMessage || undefined}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border whitespace-nowrap ${meta.pill}${statusMessage ? " cursor-help" : ""}`}
    >
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  );
}

const DEFAULT_PROFILES_COL_WIDTHS = { account: 200, status: 96, active: 56, actions: 176, ip: 128 };
const DEFAULT_PROFILES_COL_VISIBLE = { status: true, active: true, actions: true, ip: true };
const DEFAULT_PROFILES_COL_ORDER: (keyof typeof DEFAULT_PROFILES_COL_WIDTHS)[] = ["account", "status", "active", "actions", "ip"];
const PROFILES_COL_LABELS: Record<keyof typeof DEFAULT_PROFILES_COL_WIDTHS, string> = {
  account: "Account", status: "Status", active: "Active", actions: "Actions", ip: "IP:Port",
};

// ── Component ────────────────────────────────────────────────────────────────
export function ProfilesPage() {
  const { data: profiles, isLoading } = useProfiles();
  const createProfileMutation = useCreateProfile();
  const deleteProfileMutation = useDeleteProfile();
  const updateAccountStatus   = useUpdateAccountStatus();
  const verifyMutation        = useVerifyProfile();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();
  const { openWindow, closeWindow } = useBrowserWindows();
  const { data: proxies } = useProxies();

  const handleVerify = (id: number) => {
    updateAccountStatus.mutate({ id, accountStatus: "verifying" });
    verifyMutation.mutate(id, {
      onSuccess: (data) => {
        toast({
          title: data.ok ? "Verified" : "Verification Failed",
          description: data.message,
          variant: data.ok ? "default" : "destructive",
        });
      },
      onError: () => {
        // Reset to pending so the account isn't stuck in "verifying"
        updateAccountStatus.mutate({ id, accountStatus: "pending" });
        toast({ title: "Error", description: "Could not reach Instagram.", variant: "destructive" });
      },
    });
  };

  const [profColWidths, setProfColWidths] = useState<typeof DEFAULT_PROFILES_COL_WIDTHS>(() => {
    try {
      const s = localStorage.getItem("profiles_col_widths_px");
      return s ? { ...DEFAULT_PROFILES_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_PROFILES_COL_WIDTHS;
    } catch { return DEFAULT_PROFILES_COL_WIDTHS; }
  });
  const [profColVisible, setProfColVisible] = useState<typeof DEFAULT_PROFILES_COL_VISIBLE>(() => {
    try {
      const s = localStorage.getItem("profiles_col_visible");
      return s ? { ...DEFAULT_PROFILES_COL_VISIBLE, ...JSON.parse(s) } : DEFAULT_PROFILES_COL_VISIBLE;
    } catch { return DEFAULT_PROFILES_COL_VISIBLE; }
  });
  const [profColOrder, setProfColOrder] = useState<(keyof typeof DEFAULT_PROFILES_COL_WIDTHS)[]>(() => {
    try {
      const s = localStorage.getItem("profiles_col_order");
      return s ? JSON.parse(s) : DEFAULT_PROFILES_COL_ORDER;
    } catch { return DEFAULT_PROFILES_COL_ORDER; }
  });
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

  const [selectedProfileIds, setSelectedProfileIds] = useState<number[]>([]);
  const isDragSelecting = useRef(false);
  const dragAddMode = useRef(true);
  const preStoppedStatus = useRef<Map<number, string>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  const [addProfilePanelOpen, setAddProfilePanelOpen] = useState(false);
  const [addProfileCount, setAddProfileCount] = useState("1");
  const [addProfileCreating, setAddProfileCreating] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [eqxImporting, setEqxImporting] = useState(false);
  const eqxImportRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[] } | null>(null);
  const [resetDeviceConfirmOpen, setResetDeviceConfirmOpen] = useState(false);
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [fixingCaptcha, setFixingCaptcha] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(() => sessionStorage.getItem("profiles:filter") ?? "");
  const [sortField, setSortField] = useState<"account" | "status" | "ip" | null>(() => {
    const v = sessionStorage.getItem("profiles:sortField");
    return (v === "account" || v === "status" || v === "ip") ? v : null;
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    (sessionStorage.getItem("profiles:sortDir") as "asc" | "desc") ?? "asc"
  );

  // ── Group Profiles state ──────────────────────────────────────────────────
  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("profiles:groupMode") === "true");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem("profiles:collapsedGroups");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [setGroupOpen, setSetGroupOpen] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");

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
    return sortField
      ? [...base].sort((a, b) => {
          if (sortField === "ip") {
            const na = ipToNum(a.proxyHost);
            const nb = ipToNum(b.proxyHost);
            const diff = na - nb;
            if (diff !== 0) return sortDir === "asc" ? diff : -diff;
            const pa = a.proxyPort ?? 0;
            const pb = b.proxyPort ?? 0;
            return sortDir === "asc" ? pa - pb : pb - pa;
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
        })
      : base;
  }, [profiles, filterTokens, sortField, sortDir]);

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
      try { sessionStorage.setItem("profiles:collapsedGroups", JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const cycleSort = (field: "account" | "status" | "ip") => {
    if (sortField !== field) {
      setSortField(field); setSortDir("asc");
      sessionStorage.setItem("profiles:sortField", field);
      sessionStorage.setItem("profiles:sortDir", "asc");
    } else {
      const next = sortDir === "asc" ? "desc" : "asc";
      setSortDir(next);
      sessionStorage.setItem("profiles:sortDir", next);
    }
  };

  const getNextAccountNum = () => {
    const existing = (profiles ?? [])
      .map(p => { const m = (p.accountLabel ?? "").match(/^Account(\d+)$/i); return m ? Number(m[1]) : 0; })
      .filter(n => n > 0);
    return existing.length > 0 ? Math.max(...existing) + 1 : (profiles?.length ?? 0) + 1;
  };

  const handleCreate = () => {
    const nextNum = getNextAccountNum();
    createProfileMutation.mutate({
      username: "",
      password: "",
      accountLabel: `Account${nextNum}`,
      proxyHost: "",
      proxyPort: null,
      proxyUsername: "",
      proxyPassword: "",
    }, {
      onSuccess: (profile) => {
        window.location.href = `/profiles/${profile.id}`;
      }
    });
  };

  const handleCreateMultiple = async () => {
    const count = Math.max(1, Math.min(500, parseInt(addProfileCount, 10) || 1));
    setAddProfileCreating(true);
    let startNum = getNextAccountNum();
    try {
      for (let i = 0; i < count; i++) {
        await createProfileMutation.mutateAsync({
          username: "",
          password: "",
          accountLabel: `Account${startNum + i}`,
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
        });
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
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        await updateProfileMutation.mutateAsync({
          id,
          userAgentApi: ua.api,
          userAgentEmbedded: ua.embedded,
          credentialsDirty: true,
          accountStatus: "pending",
        });
      }
      setSelectedProfileIds([]);
      toast({ title: "Device IDs Reset", description: `${selectedProfileIds.length} account(s) assigned new device fingerprints.` });
    } catch {
      toast({ title: "Error", description: "Failed to reset some device IDs.", variant: "destructive" });
    }
  }, [selectedProfileIds, updateProfileMutation, toast]);

  const handleExportProfiles = useCallback(() => {
    const toExport = selectedProfileIds.length > 0
      ? profiles?.filter(p => selectedProfileIds.includes(p.id))
      : profiles;
    if (!toExport?.length) {
      toast({ title: "No profiles to export", variant: "destructive" });
      return;
    }
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
    ];
    const rows = toExport.map(p => [
      p.tags ?? "",
      p.username ?? "",
      p.password ?? "",
      p.email ?? "",
      p.proxyHost ? `${p.proxyHost}${p.proxyPort ? `:${p.proxyPort}` : ""}` : "",
      p.proxyUsername ?? "",
      p.proxyPassword ?? "",
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
    ]);
    const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `profiles_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      const restore = map[String(id)] ?? preStoppedStatus.current.get(id) ?? "pending";
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
      // Fetch the delay settings so the server uses the values from the Settings page
      let delayMin = 5;
      let delayMax = 15;
      try {
        const settingsRes = await fetch("/api/settings", { credentials: "include" });
        if (settingsRes.ok) {
          const s = await settingsRes.json();
          if (typeof s.verifyAllDelayMin === "number") delayMin = s.verifyAllDelayMin;
          if (typeof s.verifyAllDelayMax === "number") delayMax = s.verifyAllDelayMax;
        }
      } catch { /* use defaults */ }

      const res = await fetch("/api/profiles/verify-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileIds: ids, delayMin, delayMax }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: `Verifying ${ids.length} profile${ids.length !== 1 ? "s" : ""}`, description: `Running in the background with ${delayMin}–${delayMax}s delays between each.` });
      } else {
        toast({ title: "Error", description: data.error ?? "Failed to start verification.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to reach server.", variant: "destructive" });
    } finally {
      setVerifyingAll(false);
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
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
          accountStatus: "pending" as const,
          credentialsDirty: true,
        });
      }
      toast({ title: "Proxies Removed", description: `${selectedProfileIds.length} account(s) set to Pending.` });
    } catch {
      toast({ title: "Error", description: "Failed to remove proxies.", variant: "destructive" });
    }
  }, [selectedProfileIds, updateProfileMutation, toast]);

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
      <div className="mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-foreground shrink-0">Accounts</h1>
          <Button
            onClick={() => setAddProfilePanelOpen(o => !o)}
            size="sm"
            className="bg-sky-400 hover:bg-sky-500 text-white border-0 shrink-0"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Profile
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
                  setAddProfileCount(v);
                }}
                onKeyDown={e => { if (e.key === "Enter") handleCreateMultiple(); if (e.key === "Escape") setAddProfilePanelOpen(false); }}
                autoFocus
                placeholder="Count"
                className="w-20 h-8 text-sm border border-border rounded px-2 bg-background text-foreground text-center"
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
                Account
                <span className="text-[9px]">
                  {sortField === "account" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
                </span>
              </button>
            </div>
            {profColOrder.filter(k => k !== "account" && k !== "ip" && profColVisible[k as keyof typeof DEFAULT_PROFILES_COL_VISIBLE]).map(key => {
              if (key === "status") return (
                <button key={key} onClick={() => cycleSort("status")} style={{ width: profColWidths.status }} className="shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors">
                  Status<span className="text-[9px]">{sortField === "status" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}</span>
                </button>
              );
              if (key === "active") return <div key={key} style={{ width: profColWidths.active }} className="shrink-0 text-left">Active</div>;
              if (key === "actions") return <div key={key} style={{ width: profColWidths.actions }} className="shrink-0 text-left">Actions</div>;
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
                <span className="text-[9px]">
                  {sortField === "ip" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
                </span>
              </button>
            )}
          </div>

          {/* ── Scrollable body conditional content ────────────────────── */}
          <div className="overflow-y-auto flex-1 min-h-0">
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
              const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
              const isStopped  = acctStatus === "stopped";
              const isEven     = idx % 2 === 1;
              const hasProxy   = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
              return (
                <div
                  key={profile.id}
                  className={`flex items-center gap-3 px-3 py-1 border-b border-border/30 last:border-b-0 transition-colors select-none ${
                    selectedProfileIds.includes(profile.id)
                      ? "bg-primary/8 border-primary/20"
                      : isStopped
                      ? "opacity-50 bg-slate-50/80"
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
                      >
                        {profile.accountLabel || profile.username}
                        {profile.locked && <span title="Locked — excluded from copy targets"><Lock className="w-3 h-3 text-amber-500 shrink-0" /></span>}
                      </span>
                    </Link>
                  </div>
                  {profColOrder.filter(k => k !== "account" && k !== "ip" && profColVisible[k as keyof typeof DEFAULT_PROFILES_COL_VISIBLE]).map(key => {
                    if (key === "status") return (
                      <div key={key} style={{ width: profColWidths.status }} className="flex items-center justify-start gap-1.5 shrink-0">
                        {hasProxy
                          ? <AccountStatusBadge status={acctStatus} statusMessage={profile.statusMessage} />
                          : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border bg-red-50 text-red-700 border-red-200">
                              <Globe className="w-2.5 h-2.5" />No Proxy
                            </span>
                        }
                        {hasProxy && (acctStatus !== "valid" || profile.credentialsDirty) && !isStopped && acctStatus !== "verifying" && (
                          <button onClick={() => handleVerify(profile.id)} disabled={verifyMutation.isPending && verifyMutation.variables === profile.id} data-testid={`button-verify-${profile.id}`} className="text-[9px] font-bold text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors">Verify</button>
                        )}
                      </div>
                    );
                    if (key === "active") return (
                      <div key={key} style={{ width: profColWidths.active }} className="flex items-center justify-center shrink-0" onMouseDown={e => e.stopPropagation()}>
                        <Switch checked={!isStopped} onCheckedChange={() => toggleStopped(profile.id, acctStatus)} data-testid={`switch-active-${profile.id}`} className="data-[state=checked]:bg-green-500" />
                      </div>
                    );
                    if (key === "actions") return (
                      <div key={key} style={{ width: profColWidths.actions }} className="shrink-0 flex items-center justify-start gap-3 overflow-hidden" onMouseDown={e => e.stopPropagation()}>
                        <button onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded ?? "")} title="Open embedded browser" data-testid={`btn-open-browser-${profile.id}`} className="text-[11px] text-muted-foreground hover:text-primary transition-colors">Browser</button>
                        <Link href={`/profiles/${profile.id}`} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">Config</Link>
                        <button onClick={() => setDeleteConfirm({ ids: [profile.id] })} data-testid={`button-delete-${profile.id}`} className="text-[11px] text-muted-foreground hover:text-destructive transition-colors">Delete</button>
                      </div>
                    );
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
                const displayName = groupKey === "__ungrouped__" ? "Ungrouped" : groupKey;
                const isCollapsed = collapsedGroups.has(groupKey);
                const groupIds = groupProfiles.map(p => p.id);
                const allInGroupSelected = groupIds.every(id => selectedProfileIds.includes(id));
                return (
                  <div key={groupKey}>
                    {groupKey !== "__ungrouped__" && (
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-background border-b border-border sticky top-0 z-10 select-none">
                        <button onClick={() => toggleGroupCollapse(groupKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                          {isCollapsed
                            ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                          <span className="text-sm font-bold text-foreground truncate">{displayName}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">({groupProfiles.length})</span>
                        </button>
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
                    )}
                    {(groupKey === "__ungrouped__" || !isCollapsed) && groupProfiles.map((p, i) => renderProfileRow(p, i))}
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
                      const v = Math.max(40, Math.min(600, profColWidths[key] + delta));
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
                            localStorage.setItem("profiles_col_visible", JSON.stringify(next));
                          }}
                          className="mr-1"
                        />
                        <label className="text-xs w-16 text-muted-foreground shrink-0">{label}</label>
                        <button onClick={() => updateCol(-10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronDown className="w-3 h-3" /></button>
                        <input type="number" min={40} max={600} value={profColWidths[key]} onChange={e => { const v = Math.max(40, Math.min(600, Number(e.target.value))); const next = { ...profColWidths, [key]: v }; setProfColWidths(next); localStorage.setItem("profiles_col_widths_px", JSON.stringify(next)); }} className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center" />
                        <button onClick={() => updateCol(10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronUp className="w-3 h-3" /></button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => { setProfColWidths(DEFAULT_PROFILES_COL_WIDTHS); localStorage.removeItem("profiles_col_widths_px"); setProfColVisible(DEFAULT_PROFILES_COL_VISIBLE); localStorage.removeItem("profiles_col_visible"); setProfColOrder(DEFAULT_PROFILES_COL_ORDER); localStorage.removeItem("profiles_col_order"); }}
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
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[500px] overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-border">
              <p className="text-sm font-semibold">Actions</p>
            </div>
            <div className="py-1 grid grid-cols-2">
              <button onClick={() => { setActionsOpen(false); setImportOpen(true); }} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                <Upload className="w-4 h-4 shrink-0 text-muted-foreground" /> Import Profiles
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

                  // Download each selected account as its own .eqx file
                  let successCount = 0;
                  for (const id of selectedProfileIds) {
                    const profile = profiles?.find(p => p.id === id);
                    const safeUsername = (profile?.username || String(id)).replace(/[^a-zA-Z0-9_-]/g, "_");
                    try {
                      const res = await fetch(`/api/profiles/${id}/export-eqx`, { credentials: "include" });
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
                }}
                disabled={selectedProfileIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileDown className="w-4 h-4 shrink-0 text-primary" />
                Export EQX{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button
                onClick={async () => {
                  setActionsOpen(false);
                  const tzOffset = new Date().getTimezoneOffset();
                  const ids = selectedProfileIds.length > 0 ? selectedProfileIds.join(",") : "";
                  const url = `/api/logs/export?tz=${tzOffset}${ids ? `&profileIds=${ids}` : ""}`;
                  try {
                    const res = await fetch(url, { credentials: "include" });
                    const text = await res.text();
                    const filename = `api_calls_${new Date().toISOString().slice(0, 10)}.csv`;
                    const eApi = (window as any).electronAPI;
                    if (eApi?.openCsvTemp) {
                      await eApi.openCsvTemp({ content: text, filename });
                    } else {
                      const blob = new Blob([text], { type: "text/csv" });
                      const objectUrl = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = objectUrl;
                      a.download = filename;
                      document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      URL.revokeObjectURL(objectUrl);
                    }
                  } catch { /* ignore */ }
                }}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left"
              >
                <Download className="w-4 h-4 shrink-0 text-muted-foreground" />
                Export API Calls{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkOpenBrowsers(); }} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                <Globe className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="flex-1">Open Browsers</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+O</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkLoginEB(); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <LogIn className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="flex-1">Login Embedded Browsers</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+L</span>
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleVerifyAll(); }} disabled={verifyingAll} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                {verifyingAll ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <RefreshCw className="w-4 h-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1">Verify {selectedProfileIds.length > 0 ? selectedProfileIds.length : filteredProfiles.length} Account{(selectedProfileIds.length > 0 ? selectedProfileIds.length : filteredProfiles.length) !== 1 ? "s" : ""}</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+R</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkFixCaptcha(); }} disabled={selectedProfileIds.length === 0 || fixingCaptcha} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                {fixingCaptcha ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <ScanFace className="w-4 h-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1">Fix Captcha</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+F</span>
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkRemoveProxies(); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Globe className="w-4 h-4 shrink-0 text-muted-foreground" /><span className="flex-1">Remove Proxies</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+P</span>
              </button>
              <button onClick={() => { setActionsOpen(false); setResetDeviceConfirmOpen(true); }} disabled={selectedProfileIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Smartphone className="w-4 h-4 shrink-0 text-muted-foreground" /> Reset Device IDs
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
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
                <span className="flex-1">Ungroup Accounts{selectedProfileIds.length > 0 ? ` (${selectedProfileIds.length})` : ""}</span><span className="ml-auto text-[7px] text-muted-foreground/50">Ctrl+C</span>
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
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
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleBulkDelete(); }} disabled={selectedProfileIds.length === 0} className="col-span-2 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-red-50 text-destructive transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
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
    </AppLayout>
  );
}
