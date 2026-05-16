import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useCreatorProfiles, useCreateProfile, useDeleteProfile, useUpdateAccountStatus, useVerifyProfile, useUpdateProfile, useMoveToAccounts } from "@/hooks/use-profiles";
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
  AlertTriangle, ShieldAlert, WifiOff, RefreshCw, Lock, UserMinus, Camera, Eye,
  Tag, FolderOpen, Users,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import type { AccountStatus } from "@shared/schema";

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
};

function AccountStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as AccountStatus] ?? STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border whitespace-nowrap ${meta.pill}`}>
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  );
}

const DEFAULT_COL_WIDTHS = { account: 200, status: 96, active: 56, actions: 220, ip: 128 };

export function CreateAccountPage() {
  const { data: profiles, isLoading } = useCreatorProfiles();
  const createProfileMutation = useCreateProfile();
  const deleteProfileMutation = useDeleteProfile();
  const updateAccountStatus   = useUpdateAccountStatus();
  const verifyMutation        = useVerifyProfile();
  const updateProfileMutation = useUpdateProfile();
  const moveToAccountsMutation = useMoveToAccounts();
  const { toast } = useToast();
  const { openWindow } = useBrowserWindows();
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
        updateAccountStatus.mutate({ id, accountStatus: "pending" });
        toast({ title: "Error", description: "Could not reach Instagram.", variant: "destructive" });
      },
    });
  };

  const [eqxImporting, setEqxImporting] = useState(false);
  const eqxImportRef = useRef<HTMLInputElement>(null);

  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(() => {
    try {
      const s = localStorage.getItem("creator_col_widths_px");
      return s ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_COL_WIDTHS;
    } catch { return DEFAULT_COL_WIDTHS; }
  });
  const [manageColsOpen, setManageColsOpen] = useState(false);
  const manageColsRef = useRef<HTMLDivElement>(null);

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(() => sessionStorage.getItem("creator:filter") ?? "");
  const [sortField, setSortField] = useState<"account" | "status" | "ip" | null>(() => {
    const v = sessionStorage.getItem("creator:sortField");
    return (v === "account" || v === "status" || v === "ip") ? v : null;
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    (sessionStorage.getItem("creator:sortDir") as "asc" | "desc") ?? "asc"
  );
  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("creator:groupMode") === "true");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [setGroupOpen, setSetGroupOpen] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [resetDeviceConfirmOpen, setResetDeviceConfirmOpen] = useState(false);

  const setFilterPersisted = (v: string) => {
    sessionStorage.setItem("creator:filter", v);
    setStatusFilter(v);
  };

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

  const filteredProfiles = useMemo(() => {
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
    return sortField
      ? [...base].sort((a, b) => {
          if (sortField === "ip") {
            const na = ipToNum(a.proxyHost); const nb = ipToNum(b.proxyHost);
            const diff = na - nb;
            if (diff !== 0) return sortDir === "asc" ? diff : -diff;
            const pa = a.proxyPort ?? 0; const pb = b.proxyPort ?? 0;
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
      return next;
    });
  };

  const cycleSort = (field: "account" | "status" | "ip") => {
    if (sortField !== field) {
      setSortField(field); setSortDir("asc");
      sessionStorage.setItem("creator:sortField", field);
      sessionStorage.setItem("creator:sortDir", "asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
      sessionStorage.setItem("creator:sortDir", "desc");
    } else {
      setSortField(null); setSortDir("asc");
      sessionStorage.removeItem("creator:sortField");
      sessionStorage.setItem("creator:sortDir", "asc");
    }
  };

  const handleCreate = () => {
    createProfileMutation.mutate({
      username: "",
      password: "",
      proxyHost: "",
      proxyPort: null,
      proxyUsername: "",
      proxyPassword: "",
      creatorMode: true,
    } as any, {
      onSuccess: (profile) => {
        window.location.href = `/profiles/${profile.id}?from=create-account`;
      }
    });
  };

  const handleMoveToAccounts = useCallback(async (ids: number[]) => {
    try {
      for (const id of ids) await moveToAccountsMutation.mutateAsync(id);
      setSelectedIds(prev => prev.filter(id => !ids.includes(id)));
      toast({ title: "Moved to Accounts", description: `${ids.length} account${ids.length !== 1 ? "s" : ""} ready for automation.` });
    } catch {
      toast({ title: "Error", description: "Failed to move some accounts.", variant: "destructive" });
    }
  }, [moveToAccountsMutation, toast]);

  const toggleSelection = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const toggleAll = useCallback(() => {
    const filteredIds = filteredProfiles.map(p => p.id);
    const allSelected = filteredIds.every(id => selectedIds.includes(id));
    if (allSelected) setSelectedIds(prev => prev.filter(id => !filteredIds.includes(id)));
    else setSelectedIds(prev => [...new Set([...prev, ...filteredIds])]);
  }, [filteredProfiles, selectedIds]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    setDeleteConfirm({ ids: [...selectedIds] });
  }, [selectedIds]);

  const performDelete = useCallback(async (ids: number[]) => {
    try {
      for (const id of ids) await deleteProfileMutation.mutateAsync(id);
      setSelectedIds(prev => prev.filter(id => !ids.includes(id)));
      toast({ title: "Accounts Deleted", description: `${ids.length} account${ids.length !== 1 ? "s" : ""} removed.` });
    } catch {
      toast({ title: "Error", description: "Failed to delete some accounts.", variant: "destructive" });
    }
  }, [deleteProfileMutation, toast]);

  const handleBulkResetDeviceIds = useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      for (const id of selectedIds) {
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        await updateProfileMutation.mutateAsync({ id, userAgentApi: ua.api, userAgentEmbedded: ua.embedded, credentialsDirty: true, accountStatus: "pending" });
      }
      setSelectedIds([]);
      toast({ title: "Device IDs Reset", description: `${selectedIds.length} account(s) assigned new device fingerprints.` });
    } catch {
      toast({ title: "Error", description: "Failed to reset some device IDs.", variant: "destructive" });
    }
  }, [selectedIds, updateProfileMutation, toast]);

  const handleExportProfiles = useCallback(() => {
    const toExport = selectedIds.length > 0
      ? profiles?.filter(p => selectedIds.includes(p.id))
      : profiles;
    if (!toExport?.length) { toast({ title: "No profiles to export", variant: "destructive" }); return; }
    const headers = ["#Email/Username","Password","Proxy-url/Proxy-ip:port","Proxy Username","Proxy Password","Tags","Date of birth(US Format)","EB User Agent","API User Agent","Username","Notes","Phone number","2FA Secret Key","Backup Codes","Email Validation Username","Email Validation Pass","Email Validation Pop3Server","Email Validation Port"];
    const rows = toExport.map(p => [p.email ?? "",p.password ?? "",p.proxyHost ? `${p.proxyHost}${p.proxyPort ? `:${p.proxyPort}` : ""}` : "",p.proxyUsername ?? "",p.proxyPassword ?? "",p.tags ?? "",p.dateOfBirth ?? "",p.userAgentEmbedded ?? "",p.userAgentApi ?? "",p.username ?? "",p.notes ?? "",p.phoneNumber ?? "",p.twoFASecretKey ?? "",p.backupCodes ?? "",p.emailValidationUsername ?? "",p.emailValidationPassword ?? "",p.emailValidationPop3Server ?? "",p.emailValidationPort ?? ""].map(v => String(v)));
    const tsv = [headers, ...rows].map(r => r.join("\t")).join("\r\n");
    const buf = new ArrayBuffer(2 + tsv.length * 2);
    const view = new DataView(buf);
    view.setUint8(0, 0xff); view.setUint8(1, 0xfe);
    for (let i = 0; i < tsv.length; i++) view.setUint16(2 + i * 2, tsv.charCodeAt(i), true);
    const blob = new Blob([buf], { type: "text/plain;charset=utf-16le" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `creator_export_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${toExport.length} profile(s) saved.` });
  }, [profiles, selectedIds, toast]);

  const PRESTOP_KEY = "profiles_prestop_status";
  const getPreStopMap = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(PRESTOP_KEY) ?? "{}"); } catch { return {}; }
  };
  const toggleStopped = (id: number, currentStatus: string, credentialsDirty?: boolean | null) => {
    if (currentStatus === "stopped") {
      const map = getPreStopMap();
      const restore = map[String(id)] ?? (credentialsDirty ? "pending" : "pending");
      delete map[String(id)];
      localStorage.setItem(PRESTOP_KEY, JSON.stringify(map));
      updateAccountStatus.mutate({ id, accountStatus: restore });
    } else {
      const map = getPreStopMap();
      map[String(id)] = currentStatus;
      localStorage.setItem(PRESTOP_KEY, JSON.stringify(map));
      updateAccountStatus.mutate({ id, accountStatus: "stopped" });
    }
  };

  const handleSetGroup = useCallback(async () => {
    if (selectedIds.length === 0) return;
    const groupName = groupNameInput.trim();
    try {
      for (const id of selectedIds) await updateProfileMutation.mutateAsync({ id, tags: groupName || undefined });
      toast({ title: "Group Updated", description: `${selectedIds.length} account(s) ${groupName ? `assigned to "${groupName}"` : "removed from group"}.` });
      setSetGroupOpen(false); setGroupNameInput("");
    } catch {
      toast({ title: "Error", description: "Failed to update group.", variant: "destructive" });
    }
  }, [selectedIds, groupNameInput, updateProfileMutation, toast]);

  const handleBulkOpenBrowsers = useCallback(() => {
    const ids = selectedIds.length > 0 ? selectedIds : filteredProfiles.map(p => p.id);
    const targets = filteredProfiles.filter(p => ids.includes(p.id));
    for (const p of targets) openWindow(p.id, p.username ?? "", p.userAgentEmbedded ?? "");
  }, [selectedIds, filteredProfiles, openWindow]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key.toLowerCase() === "d") { e.preventDefault(); handleBulkDelete(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleBulkDelete]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (manageColsRef.current && !manageColsRef.current.contains(e.target as Node)) setManageColsOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const setSlot = useSidebarSetSlot();
  useEffect(() => { setSlot(null); return () => setSlot(null); }, [setSlot]);

  return (
    <AppLayout>
      <div className="mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-foreground shrink-0">Account Creator</h1>
          <Button onClick={handleCreate} disabled={createProfileMutation.isPending} size="sm" className="bg-sky-400 hover:bg-sky-500 text-white border-0 shrink-0">
            <Plus className="w-4 h-4 mr-1" />
            {createProfileMutation.isPending ? "Creating..." : "Add Account"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">Use the EB to create accounts here. Move them to Accounts when ready for automation.</p>
      </div>

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
            <button onClick={() => setFilterPersisted("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors" aria-label="Clear filter">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {filterTokens.length > 0 && (
          <span className="text-xs text-muted-foreground">{filteredProfiles?.length ?? 0} of {profiles?.length ?? 0} accounts</span>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer ml-1 shrink-0">
          <Checkbox
            checked={groupMode}
            onCheckedChange={checked => {
              const next = !!checked;
              setGroupMode(next);
              localStorage.setItem("creator:groupMode", String(next));
            }}
            className="w-3.5 h-3.5"
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">Group Accounts</span>
        </label>
      </div>

      <div className="desktop-card overflow-hidden flex flex-col" style={{ height: "calc(100vh - 208px)" }}>
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-muted/40 text-[10px] font-bold uppercase tracking-wider text-muted-foreground select-none shrink-0">
          <div style={{ width: colWidths.account + 32 }} className="shrink-0 flex items-center gap-2 min-w-0">
            <button onClick={() => cycleSort("account")} className="flex items-center gap-1 text-left hover:text-foreground transition-colors">
              Account
              <span className="text-[9px]">{sortField === "account" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}</span>
            </button>
          </div>
          <button onClick={() => cycleSort("status")} style={{ width: colWidths.status }} className="shrink-0 flex items-center justify-start gap-1 hover:text-foreground transition-colors">
            Status
            <span className="text-[9px]">{sortField === "status" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}</span>
          </button>
          <div style={{ width: colWidths.active }} className="shrink-0 text-left">Active</div>
          <div style={{ width: colWidths.actions }} className="shrink-0 text-left">Actions</div>
          <div className="flex-1" />
          <button onClick={() => cycleSort("ip")} style={{ width: colWidths.ip }} className="shrink-0 flex items-center justify-start gap-1 pl-2 hover:text-foreground transition-colors">
            IP:PORT
            <span className="text-[9px]">{sortField === "ip" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}</span>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 min-h-0">
          {isLoading ? (
            <div className="divide-y divide-border/40">{[1,2,3,4,5].map(i => <div key={i} className="h-8 animate-pulse bg-muted/30" />)}</div>
          ) : profiles?.length === 0 ? (
            <div className="flex flex-col items-center py-20">
              <Instagram className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium">No Accounts Yet</h3>
              <p className="text-muted-foreground text-sm mt-1 mb-4">Add an account to start creating via the embedded browser.</p>
              <Button onClick={handleCreate} variant="outline" disabled={createProfileMutation.isPending}>Add Account</Button>
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
                const renderRow = (profile: typeof filteredProfiles[0], idx: number) => {
                  const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
                  const isStopped  = acctStatus === "stopped";
                  const isEven     = idx % 2 === 1;
                  const hasProxy   = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
                  return (
                    <div
                      key={profile.id}
                      className={`flex items-center gap-3 px-3 py-1 border-b border-border/30 last:border-b-0 transition-colors ${
                        selectedIds.includes(profile.id)
                          ? "bg-primary/8 border-primary/20"
                          : isStopped
                          ? "opacity-50 bg-slate-50/80"
                          : isEven
                          ? "bg-slate-50/70 hover:bg-slate-100/60"
                          : "bg-white hover:bg-slate-50/60"
                      }`}
                    >
                      <div className="w-5 shrink-0">
                        <Checkbox checked={selectedIds.includes(profile.id)} onCheckedChange={() => toggleSelection(profile.id)} />
                      </div>
                      <div style={{ width: colWidths.account }} className="shrink-0 min-w-0">
                        <Link href={`/profiles/${profile.id}?from=create-account`}>
                          <span className="text-xs font-semibold text-foreground truncate hover:text-primary cursor-pointer block">
                            {profile.accountLabel || profile.username}
                          </span>
                        </Link>
                      </div>
                      <div style={{ width: colWidths.status }} className="flex justify-start shrink-0">
                        {hasProxy
                          ? <AccountStatusBadge status={acctStatus} />
                          : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border bg-red-50 text-red-700 border-red-200"><Globe className="w-2.5 h-2.5" />No Proxy</span>
                        }
                      </div>
                      <div style={{ width: colWidths.active }} className="flex items-center justify-center shrink-0">
                        <Switch
                          checked={!isStopped}
                          onCheckedChange={() => toggleStopped(profile.id, acctStatus, profile.credentialsDirty)}
                          className="data-[state=checked]:bg-green-500"
                        />
                      </div>
                      <div style={{ width: colWidths.actions }} className="shrink-0 flex items-center justify-start gap-3 overflow-hidden">
                        <button
                          onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded ?? "")}
                          className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
                        >
                          Browser
                        </button>
                        {!hasProxy
                          ? <span title="Assign a proxy before verifying" className="text-[11px] text-red-400 cursor-not-allowed">No Proxy</span>
                          : (acctStatus !== "valid" || profile.credentialsDirty) && acctStatus !== "verifying" && (
                            <button
                              onClick={() => handleVerify(profile.id)}
                              disabled={verifyMutation.isPending && verifyMutation.variables === profile.id}
                              className="text-[11px] text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors"
                            >
                              Verify
                            </button>
                          )
                        }
                        <Link href={`/profiles/${profile.id}?from=create-account`} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">Config</Link>
                        <button
                          onClick={() => handleMoveToAccounts([profile.id])}
                          disabled={moveToAccountsMutation.isPending}
                          className="text-[11px] text-sky-600 hover:text-sky-800 disabled:opacity-40 transition-colors font-medium"
                        >
                          Move
                        </button>
                        <button
                          onClick={() => setDeleteConfirm({ ids: [profile.id] })}
                          className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                      {(() => {
                        let ip = "";
                        if (profile.proxyId && proxies) {
                          const px = proxies.find(p => p.id === profile.proxyId);
                          if (px?.host && px?.port) ip = `${px.host}:${px.port}`;
                        } else if (profile.proxyHost && profile.proxyPort) {
                          ip = `${profile.proxyHost}:${profile.proxyPort}`;
                        }
                        return (
                          <div style={{ width: colWidths.ip }} className="shrink-0 text-left pl-2 ml-auto" title={ip || "No proxy"}>
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
                    const allInGroupSelected = groupIds.every(id => selectedIds.includes(id));
                    return (
                      <div key={groupKey}>
                        {groupKey !== "__ungrouped__" && (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-background border-b border-border sticky top-0 z-10 select-none">
                          <button onClick={() => toggleGroupCollapse(groupKey)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                            {isCollapsed
                              ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                            <Tag className="w-3.5 h-3.5 text-primary/50 shrink-0" />
                            <span className="text-[13px] font-bold uppercase tracking-wider text-foreground truncate">{displayName}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0">({groupProfiles.length})</span>
                          </button>
                          <button
                            onClick={() => {
                              if (allInGroupSelected) setSelectedIds(prev => prev.filter(id => !groupIds.includes(id)));
                              else setSelectedIds(prev => [...new Set([...prev, ...groupIds])]);
                            }}
                            className="text-[10px] text-primary hover:underline shrink-0 font-medium"
                          >
                            {allInGroupSelected ? "None" : "All"}
                          </button>
                        </div>
                        )}
                        {(groupKey === "__ungrouped__" || !isCollapsed) && groupProfiles.map((p, i) => renderRow(p, i))}
                      </div>
                    );
                  });
                }
                return filteredProfiles?.map((profile, idx) => renderRow(profile, idx));
              })()}
            </>
          )}
        </div>

        <div className="flex items-center gap-4 px-3 py-2 border-t border-border bg-muted/40 select-none shrink-0">
          <button onClick={() => setSelectedIds(filteredProfiles.map(p => p.id))} className="text-[12px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors whitespace-nowrap">Select All</button>
          <button onClick={() => setSelectedIds([])} className="text-[12px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors whitespace-nowrap">Select None</button>
          <button onClick={() => setActionsOpen(true)} className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors">
            Actions <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <div ref={manageColsRef} className="relative ml-auto">
            <button onClick={() => setManageColsOpen(o => !o)} className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors">
              <Settings2 className="w-3.5 h-3.5" /> Columns
            </button>
            {manageColsOpen && (
              <div className="absolute right-0 bottom-full mb-2 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-64">
                <p className="text-[11px] font-bold uppercase tracking-wide mb-3 text-muted-foreground">Column Widths (px)</p>
                {([ ["account","Account"],["status","Status"],["active","Active"],["actions","Actions"],["ip","IP:Port"] ] as [keyof typeof DEFAULT_COL_WIDTHS, string][]).map(([key, label]) => {
                  const updateCol = (delta: number) => {
                    const v = Math.max(40, Math.min(600, colWidths[key] + delta));
                    const next = { ...colWidths, [key]: v };
                    setColWidths(next);
                    localStorage.setItem("creator_col_widths_px", JSON.stringify(next));
                  };
                  return (
                    <div key={key} className="flex items-center gap-1.5 mb-2">
                      <label className="text-xs w-20 text-muted-foreground shrink-0">{label}</label>
                      <button onClick={() => updateCol(-10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronDown className="w-3 h-3" /></button>
                      <input type="number" min={40} max={600} value={colWidths[key]} onChange={e => { const v = Math.max(40, Math.min(600, Number(e.target.value))); const next = { ...colWidths, [key]: v }; setColWidths(next); localStorage.setItem("creator_col_widths_px", JSON.stringify(next)); }} className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center" />
                      <button onClick={() => updateCol(10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronUp className="w-3 h-3" /></button>
                    </div>
                  );
                })}
                <button onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("creator_col_widths_px"); }} className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">Reset to defaults</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* Hidden EQX import file input */}
      <input
        ref={eqxImportRef}
        type="file"
        accept=".eqx"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!eqxImportRef.current) return;
          eqxImportRef.current.value = "";
          if (!file) return;
          setEqxImporting(true);
          try {
            const arrayBuffer = await file.arrayBuffer();
            const binary = String.fromCharCode(...new Uint8Array(arrayBuffer));
            const eqxBase64 = btoa(binary);
            const res = await fetch("/api/profiles/import-eqx", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ eqxBase64 }),
            });
            if (!res.ok) { toast({ title: "Import failed", description: await res.text(), variant: "destructive" }); return; }
            const data = await res.json();
            toast({ title: "EQX imported", description: `@${data.username} imported successfully (${data.followedImported} followed users).` });
          } catch (err: any) {
            toast({ title: "Import error", description: err?.message ?? "Unknown error", variant: "destructive" });
          } finally {
            setEqxImporting(false);
          }
        }}
      />

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
                  if (selectedIds.length === 0) {
                    toast({ title: "No accounts selected", description: "Select at least one account to export as EQX.", variant: "destructive" });
                    return;
                  }
                  // Download each selected account as its own .eqx file
                  let successCount = 0;
                  for (const id of selectedIds) {
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
                disabled={selectedIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileDown className="w-4 h-4 shrink-0 text-primary" />
                Export EQX{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </button>
              <button onClick={() => { setActionsOpen(false); handleBulkOpenBrowsers(); }} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left">
                <Globe className="w-4 h-4 shrink-0 text-muted-foreground" /> Open Browsers
              </button>
              <button onClick={() => { setActionsOpen(false); setResetDeviceConfirmOpen(true); }} disabled={selectedIds.length === 0} className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Smartphone className="w-4 h-4 shrink-0 text-muted-foreground" /> Reset Device IDs
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => {
                  const ids = selectedIds.length > 0 ? selectedIds : filteredProfiles.map(p => p.id);
                  setActionsOpen(false);
                  handleMoveToAccounts(ids);
                }}
                disabled={filteredProfiles.length === 0}
                className="col-span-2 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-sky-50 text-sky-700 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Users className="w-4 h-4 shrink-0" />
                Move to Accounts{selectedIds.length > 0 ? ` (${selectedIds.length})` : ` (${filteredProfiles.length})`}
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
              <button
                onClick={() => {
                  setActionsOpen(false);
                  const tags = selectedIds.map(id => profiles?.find(p => p.id === id)?.tags ?? "");
                  const common = tags.every(t => t === tags[0]) ? (tags[0] ?? "") : "";
                  setGroupNameInput(common);
                  setSetGroupOpen(true);
                }}
                disabled={selectedIds.length === 0}
                className="flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Tag className="w-4 h-4 shrink-0 text-muted-foreground" />
                Group Accounts{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </button>
              <div className="col-span-2 mx-4 my-1 border-t border-border" />
              <button onClick={() => { setActionsOpen(false); handleBulkDelete(); }} disabled={selectedIds.length === 0} className="col-span-2 flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-red-50 text-destructive transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <Trash2 className="w-4 h-4 shrink-0" /> Delete Selected
              </button>
            </div>
          </div>
        </>
      )}

      {setGroupOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setSetGroupOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-80 overflow-hidden">
            <div className="px-5 pt-4 pb-3 border-b border-border">
              <p className="text-sm font-semibold">Set Group</p>
              <p className="text-xs text-muted-foreground mt-0.5">{selectedIds.length} account{selectedIds.length !== 1 ? "s" : ""} selected</p>
            </div>
            <div className="p-5">
              <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2 block">Group Name</label>
              <Input value={groupNameInput} onChange={e => setGroupNameInput(e.target.value)} placeholder="e.g. Clients, Niche A…" className="h-8 text-sm" onKeyDown={e => { if (e.key === "Enter") handleSetGroup(); if (e.key === "Escape") setSetGroupOpen(false); }} autoFocus />
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
            <AlertDialogTitle>Delete {deleteConfirm?.ids.length === 1 ? "Account" : `${deleteConfirm?.ids.length} Accounts`}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.ids.length === 1 ? "This account will be permanently removed." : `${deleteConfirm?.ids.length} accounts will be permanently removed.`}
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
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
              {selectedIds.length} selected account{selectedIds.length !== 1 ? "s" : ""} and set their status to Pending. Instagram may require fresh verification after this change.
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
