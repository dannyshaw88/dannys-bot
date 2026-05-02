import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProfiles, useCreateProfile, useDeleteProfile, useUpdateAccountStatus, useVerifyProfile, useUpdateProfile } from "@/hooks/use-profiles";
import { userAgents } from "@/shared/userAgents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Plus, Trash2, Instagram, Activity, ChevronDown, Upload, Download,
  ShieldCheck, Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, LogIn, Loader2, Globe, Clock,
  Smartphone, FileDown, Filter, X,
  AlertTriangle, ShieldAlert, WifiOff, RefreshCw, Lock, UserMinus, Camera, Eye
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
  valid:                { label: "Valid",                icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200"  },
  banned:               { label: "Banned",               icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
  captcha:              { label: "Captcha",              icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  email_confirmation:   { label: "Email Confirm",        icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  phone_verification:   { label: "Phone Verify",         icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  "2fa_verification":   { label: "2FA Verify",           icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200" },
  stopped:              { label: "Stopped",              icon: PowerOff,    pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  logged_out:           { label: "Logged Out",           icon: LogOut,      pill: "bg-orange-50 text-orange-700 border-orange-200" },
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

function AccountStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as AccountStatus] ?? STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border ${meta.pill}`}>
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export function ProfilesPage() {
  const { data: profiles, isLoading } = useProfiles();
  const createProfileMutation = useCreateProfile();
  const deleteProfileMutation = useDeleteProfile();
  const updateAccountStatus   = useUpdateAccountStatus();
  const verifyMutation        = useVerifyProfile();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();
  const { openWindow } = useBrowserWindows();

  const handleVerify = (id: number) => {
    verifyMutation.mutate(id, {
      onSuccess: (data) => {
        toast({
          title: data.ok ? "Verified" : "Verification Failed",
          description: data.message,
          variant: data.ok ? "default" : "destructive",
        });
      },
      onError: () => {
        toast({ title: "Error", description: "Could not reach Instagram.", variant: "destructive" });
      },
    });
  };

  const [selectedProfileIds, setSelectedProfileIds] = useState<number[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(() => sessionStorage.getItem("profiles:filter") ?? "");
  const [sortField, setSortField] = useState<"account" | "status" | null>(() => {
    const v = sessionStorage.getItem("profiles:sortField");
    return (v === "account" || v === "status") ? v : null;
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    (sessionStorage.getItem("profiles:sortDir") as "asc" | "desc") ?? "asc"
  );

  const setFilterPersisted = (v: string) => {
    sessionStorage.setItem("profiles:filter", v);
    setStatusFilter(v);
  };

  const cycleSort = (field: "account" | "status") => {
    if (sortField !== field) {
      setSortField(field); setSortDir("asc");
      sessionStorage.setItem("profiles:sortField", field);
      sessionStorage.setItem("profiles:sortDir", "asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
      sessionStorage.setItem("profiles:sortDir", "desc");
    } else {
      setSortField(null); setSortDir("asc");
      sessionStorage.removeItem("profiles:sortField");
      sessionStorage.setItem("profiles:sortDir", "asc");
    }
  };

  const handleCreate = () => {
    createProfileMutation.mutate({
      username: "new_account_" + Math.floor(Math.random() * 10000),
      password: "password",
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

  const toggleSelection = (id: number) => {
    setSelectedProfileIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleAll = useCallback(() => {
    if (profiles) {
      setSelectedProfileIds(
        selectedProfileIds.length === profiles.length ? [] : profiles.map(p => p.id)
      );
    }
  }, [profiles, selectedProfileIds]);

  const handleBulkDelete = useCallback(() => {
    if (selectedProfileIds.length === 0) return;
    setDeleteConfirm({ ids: [...selectedProfileIds] });
  }, [selectedProfileIds]);

  const performDelete = useCallback(async (ids: number[]) => {
    try {
      for (const id of ids) await deleteProfileMutation.mutateAsync(id);
      setSelectedProfileIds(prev => prev.filter(id => !ids.includes(id)));
      toast({ title: "Profiles Deleted", description: `${ids.length} account${ids.length !== 1 ? "s" : ""} removed.` });
    } catch {
      toast({ title: "Error", description: "Failed to delete some profiles.", variant: "destructive" });
    }
  }, [deleteProfileMutation, toast]);

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
    const headers = [
      "#Email/Username", "Password", "Proxy-url/Proxy-ip:port",
      "Proxy Username", "Proxy Password", "Tags",
      "Date of birth(US Format)", "EB User Agent", "API User Agent",
      "Username", "Notes", "Phone number", "2FA Secret Key",
      "Backup Codes", "Email Validation Username", "Email Validation Pass",
      "Email Validation Pop3Server", "Email Validation Port",
    ];
    const rows = toExport.map(p => [
      p.email ?? "",
      p.password ?? "",
      p.proxyHost ? `${p.proxyHost}${p.proxyPort ? `:${p.proxyPort}` : ""}` : "",
      p.proxyUsername ?? "",
      p.proxyPassword ?? "",
      p.tags ?? "",
      p.dateOfBirth ?? "",
      p.userAgentEmbedded ?? "",
      p.userAgentApi ?? "",
      p.username ?? "",
      p.notes ?? "",
      p.phoneNumber ?? "",
      p.twoFASecretKey ?? "",
      p.backupCodes ?? "",
      p.emailValidationUsername ?? "",
      p.emailValidationPassword ?? "",
      p.emailValidationPop3Server ?? "",
      p.emailValidationPort ?? "",
    ].map(v => String(v)));
    const tsv = [headers, ...rows].map(r => r.join("\t")).join("\r\n");
    const buf = new ArrayBuffer(2 + tsv.length * 2);
    const view = new DataView(buf);
    view.setUint8(0, 0xff);
    view.setUint8(1, 0xfe);
    for (let i = 0; i < tsv.length; i++) {
      view.setUint16(2 + i * 2, tsv.charCodeAt(i), true);
    }
    const blob = new Blob([buf], { type: "text/plain;charset=utf-16le" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `profiles_export_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${toExport.length} profile(s) saved as Jarvee-compatible file.` });
  }, [profiles, selectedProfileIds, toast]);

  const toggleStopped = (id: number, currentStatus: string, credentialsDirty?: boolean | null) => {
    const next = currentStatus === "stopped"
      ? (credentialsDirty ? "pending" : "valid")
      : "stopped";
    updateAccountStatus.mutate({ id, accountStatus: next });
  };

  const setSlot = useSidebarSetSlot();

  useEffect(() => {
    const allSelected = !!(profiles?.length && selectedProfileIds.length === profiles.length);
    setSlot(
      <div className="space-y-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="w-full bg-foreground text-background hover:bg-foreground/90 font-bold"
            >
              Actions <ChevronDown className="ml-1 w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56 p-2 mb-2">
            <DropdownMenuItem onClick={() => setImportOpen(true)} className="cursor-pointer font-medium p-3">
              <Upload className="w-4 h-4 mr-2" /> Import Profiles
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleExportProfiles}
              className="cursor-pointer font-medium p-3"
            >
              <FileDown className="w-4 h-4 mr-2" /> Export Profiles
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const a = document.createElement("a");
                const tzOffset = new Date().getTimezoneOffset();
                a.href = `/api/logs/export?tz=${tzOffset}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
              className="cursor-pointer font-medium p-3"
            >
              <Download className="w-4 h-4 mr-2" /> Export API Calls
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleBulkResetDeviceIds}
              disabled={selectedProfileIds.length === 0}
              className="cursor-pointer font-medium p-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Smartphone className="w-4 h-4 mr-2" /> Reset Device IDs
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleBulkDelete}
              disabled={selectedProfileIds.length === 0}
              className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer font-medium p-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete Selected
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
    return () => setSlot(null);
  }, [selectedProfileIds, profiles, toggleAll, handleBulkDelete, handleBulkResetDeviceIds, handleExportProfiles, setImportOpen]);

  // Parse filter: split on | or ||, trim, lowercase
  const filterTokens = statusFilter
    .split(/\|\|?/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  const baseFiltered = filterTokens.length > 0
    ? (profiles ?? []).filter(p => {
        const status   = (p.accountStatus ?? "pending").toLowerCase();
        const username = (p.username ?? "").toLowerCase();
        const label    = (p.accountLabel ?? "").toLowerCase();
        return filterTokens.some(token =>
          status === token ||
          username.includes(token) ||
          label.includes(token)
        );
      })
    : (profiles ?? []);

  const filteredProfiles = sortField
    ? [...baseFiltered].sort((a, b) => {
        let va = "";
        let vb = "";
        if (sortField === "account") {
          va = (a.accountLabel || a.username || "").toLowerCase();
          vb = (b.accountLabel || b.username || "").toLowerCase();
        } else {
          va = (STATUS_META[a.accountStatus as AccountStatus]?.label ?? a.accountStatus ?? "").toLowerCase();
          vb = (STATUS_META[b.accountStatus as AccountStatus]?.label ?? b.accountStatus ?? "").toLowerCase();
        }
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      })
    : baseFiltered;

  return (
    <AppLayout>
      <div className="flex justify-between items-start mb-8">
        <div className="min-w-0 flex-1 mr-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-foreground shrink-0">Accounts</h1>
          </div>
        </div>
        <Button onClick={handleCreate} disabled={createProfileMutation.isPending}>
          <Plus className="w-4 h-4 mr-2" />
          {createProfileMutation.isPending ? "Creating..." : "Add Profile"}
        </Button>
      </div>

      {/* Status filter bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-xs">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={statusFilter}
            onChange={e => setFilterPersisted(e.target.value)}
            placeholder="Filter to show specific profiles"
            className="h-8 pl-7 pr-7 text-xs font-mono"
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
      </div>

      {isLoading ? (
        <div className="desktop-card divide-y divide-border/40">
          {[1,2,3,4,5].map(i => <div key={i} className="h-8 animate-pulse bg-muted/30" />)}
        </div>
      ) : profiles?.length === 0 ? (
        <div className="text-center py-20 desktop-card flex flex-col items-center">
          <Instagram className="w-12 h-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium">No Profiles Yet</h3>
          <p className="text-muted-foreground text-sm mt-1 mb-4">Add your first Instagram account to start automating.</p>
          <Button onClick={handleCreate} variant="outline" disabled={createProfileMutation.isPending}>Add Profile</Button>
        </div>
      ) : filteredProfiles?.length === 0 ? (
        <div className="text-center py-16 desktop-card flex flex-col items-center">
          <Filter className="w-10 h-10 text-muted-foreground/40 mb-3" />
          <h3 className="text-base font-medium">No accounts match this filter</h3>
          <p className="text-muted-foreground text-sm mt-1">
            Try a different status or{" "}
            <button onClick={() => setFilterPersisted("")} className="underline hover:text-foreground transition-colors">clear the filter</button>.
          </p>
        </div>
      ) : (
        <div className="desktop-card overflow-hidden pb-24">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-muted/40 text-[10px] font-bold uppercase tracking-wider text-muted-foreground select-none">
            <div className="w-5 shrink-0">
              <Checkbox
                checked={!!(profiles?.length && selectedProfileIds.length === profiles.length)}
                onCheckedChange={toggleAll}
                aria-label="Select all profiles"
              />
            </div>
            <button
              onClick={() => cycleSort("account")}
              className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-foreground transition-colors"
            >
              Account
              <span className="text-[9px]">
                {sortField === "account" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
              </span>
            </button>
            <button
              onClick={() => cycleSort("status")}
              className="w-24 shrink-0 flex items-center justify-center gap-1 hover:text-foreground transition-colors"
            >
              Status
              <span className="text-[9px]">
                {sortField === "status" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
              </span>
            </button>
            <div className="w-14 shrink-0 text-center">Active</div>
            <div className="w-44 shrink-0 text-right">Actions</div>
          </div>

          {filteredProfiles?.map((profile, idx) => {
            const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
            const isStopped  = acctStatus === "stopped";
            const isEven     = idx % 2 === 1;

            return (
              <div
                key={profile.id}
                className={`flex items-center gap-3 px-3 py-1 border-b border-border/30 last:border-b-0 transition-colors ${
                  selectedProfileIds.includes(profile.id)
                    ? "bg-primary/8 border-primary/20"
                    : isStopped
                    ? "opacity-50 bg-slate-50/80"
                    : isEven
                    ? "bg-slate-50/70 hover:bg-slate-100/60"
                    : "bg-white hover:bg-slate-50/60"
                }`}
              >
                {/* Checkbox */}
                <div className="w-5 shrink-0">
                  <Checkbox
                    checked={selectedProfileIds.includes(profile.id)}
                    onCheckedChange={() => toggleSelection(profile.id)}
                    data-testid={`checkbox-profile-${profile.id}`}
                  />
                </div>

                {/* Username */}
                <div className="flex-1 min-w-0">
                  <Link href={`/profiles/${profile.id}`}>
                    <span
                      className="text-xs font-semibold text-foreground truncate hover:text-primary cursor-pointer block"
                      data-testid={`text-username-${profile.id}`}
                    >
                      {profile.accountLabel || profile.username}
                    </span>
                  </Link>
                </div>

                {/* IG Account Status badge */}
                <div className="w-24 flex justify-center shrink-0">
                  <AccountStatusBadge status={acctStatus} />
                </div>

                {/* Active toggle */}
                <div className="w-14 flex items-center justify-center shrink-0">
                  <Switch
                    checked={!isStopped}
                    onCheckedChange={() => toggleStopped(profile.id, acctStatus, profile.credentialsDirty)}
                    data-testid={`switch-active-${profile.id}`}
                    className="data-[state=checked]:bg-green-500"
                  />
                </div>

                {/* Text-only actions */}
                <div className="w-44 shrink-0 flex items-center justify-end gap-3">
                  <button
                    onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded ?? "")}
                    title="Open embedded browser"
                    data-testid={`btn-open-browser-${profile.id}`}
                    className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
                  >
                    Browser
                  </button>
                  {(acctStatus !== "valid" || profile.credentialsDirty) && (
                    <button
                      onClick={() => handleVerify(profile.id)}
                      disabled={verifyMutation.isPending && verifyMutation.variables === profile.id}
                      data-testid={`button-verify-${profile.id}`}
                      className="text-[11px] text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors flex items-center gap-0.5"
                    >
                      {verifyMutation.isPending && verifyMutation.variables === profile.id
                        ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        : null}
                      Verify
                    </button>
                  )}
                  <Link href={`/profiles/${profile.id}`}>
                    <span className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      Config
                    </span>
                  </Link>
                  <button
                    onClick={() => setDeleteConfirm({ ids: [profile.id] })}
                    data-testid={`button-delete-${profile.id}`}
                    className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />

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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteConfirm) { performDelete(deleteConfirm.ids); setDeleteConfirm(null); } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
