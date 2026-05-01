import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProfiles, useCreateProfile, useDeleteProfile, useUpdateAccountStatus, useVerifyProfile, useUpdateProfile } from "@/hooks/use-profiles";
import { userAgents } from "@/shared/userAgents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Plus, Trash2, Instagram, Activity, ChevronDown, Upload, Download,
  ShieldCheck, Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, LogIn, Loader2, Globe, Clock,
  Smartphone, FileDown
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
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
  valid:                { label: "Valid",                icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200"  },
  banned:               { label: "Banned",               icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
  captcha:              { label: "Captcha",              icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200"  },
  email_confirmation:   { label: "Email Confirm",        icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  phone_verification:   { label: "Phone Verify",         icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200"   },
  "2fa_verification":   { label: "2FA Verify",           icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200" },
  stopped:              { label: "Stopped",              icon: PowerOff,    pill: "bg-slate-100 text-slate-600  border-slate-200"  },
  logged_out:           { label: "Logged Out",           icon: LogOut,      pill: "bg-orange-50 text-orange-700 border-orange-200" },
  action_blocked:       { label: "Action Blocked",       icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200"    },
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

  const handleBulkDelete = useCallback(async () => {
    if (selectedProfileIds.length === 0) return;
    if (!confirm(`Delete ${selectedProfileIds.length} profile(s)?`)) return;
    try {
      for (const id of selectedProfileIds) await deleteProfileMutation.mutateAsync(id);
      setSelectedProfileIds([]);
      toast({ title: "Profiles Deleted", description: `${selectedProfileIds.length} accounts removed.` });
    } catch {
      toast({ title: "Error", description: "Failed to delete some profiles.", variant: "destructive" });
    }
  }, [selectedProfileIds, deleteProfileMutation, toast]);

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
        <div className="flex items-center gap-2.5 px-1">
          <Checkbox
            id="sidebar-select-all"
            checked={allSelected}
            onCheckedChange={toggleAll}
          />
          <Label htmlFor="sidebar-select-all" className="text-sm font-semibold cursor-pointer select-none">
            Select All
          </Label>
        </div>
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
              onClick={async () => {
                try {
                  const res = await fetch("/api/logs/export");
                  const blob = await res.blob();
                  const url = URL.createObjectURL(new Blob([blob], { type: "text/csv" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `api_calls_${new Date().toISOString().slice(0, 10)}.csv`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } catch {
                  toast({ title: "Export failed", description: "Could not download the file.", variant: "destructive" });
                }
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

  return (
    <AppLayout>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Accounts</h1>
          <p className="text-muted-foreground mt-1">Manage your Instagram profiles and their status.</p>
        </div>
        <Button onClick={handleCreate} disabled={createProfileMutation.isPending}>
          <Plus className="w-4 h-4 mr-2" />
          {createProfileMutation.isPending ? "Creating..." : "Add Profile"}
        </Button>
      </div>

      {/* Column headers */}
      <div className="mb-2 flex items-center gap-2 px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <div className="w-6 shrink-0" />
        <div className="ml-1">Account</div>
        <div className="flex-1" />
        <div className="w-8 shrink-0" />
        <div className="w-32 shrink-0 text-center">IG Status</div>
        <div className="w-24 shrink-0 text-center">Active</div>
        <div className="w-40 shrink-0" />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="desktop-card h-12 animate-pulse bg-muted/50" />)}
        </div>
      ) : profiles?.length === 0 ? (
        <div className="text-center py-20 desktop-card flex flex-col items-center">
          <Instagram className="w-12 h-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium">No Profiles Yet</h3>
          <p className="text-muted-foreground text-sm mt-1 mb-4">Add your first Instagram account to start automating.</p>
          <Button onClick={handleCreate} variant="outline" disabled={createProfileMutation.isPending}>Add Profile</Button>
        </div>
      ) : (
        <div className="space-y-1.5 pb-24">
          {profiles?.map((profile) => {
            const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
            const isStopped  = acctStatus === "stopped";

            return (
              <div
                key={profile.id}
                className={`desktop-card flex items-center gap-2 px-3 overflow-hidden transition-all h-12 ${
                  isStopped
                    ? "opacity-60 bg-slate-50"
                    : selectedProfileIds.includes(profile.id)
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/30"
                }`}
              >
                {/* Checkbox */}
                <div className="w-6 shrink-0">
                  <Checkbox
                    checked={selectedProfileIds.includes(profile.id)}
                    onCheckedChange={() => toggleSelection(profile.id)}
                    data-testid={`checkbox-profile-${profile.id}`}
                  />
                </div>

                {/* Username */}
                <div className="min-w-0 ml-1">
                  <Link href={`/profiles/${profile.id}`}>
                    <span
                      className="font-bold text-sm text-foreground truncate hover:text-primary cursor-pointer block"
                      data-testid={`text-username-${profile.id}`}
                    >
                      {profile.accountLabel || `@${profile.username}`}
                    </span>
                  </Link>
                </div>

                <div className="flex-1" />

                {/* Open Browser button */}
                <div className="w-8 shrink-0 flex justify-center">
                  <button
                    onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded ?? "")}
                    title="Open embedded browser"
                    data-testid={`btn-open-browser-${profile.id}`}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:text-primary hover:bg-primary/10 transition-colors"
                  >
                    <Globe className="w-4 h-4" />
                  </button>
                </div>

                {/* IG Account Status badge */}
                <div className="w-32 flex justify-center shrink-0">
                  <AccountStatusBadge status={acctStatus} />
                </div>

                {/* Stopped toggle */}
                <div className="w-24 flex items-center justify-center shrink-0">
                  <Switch
                    checked={!isStopped}
                    onCheckedChange={() => toggleStopped(profile.id, acctStatus, profile.credentialsDirty)}
                    data-testid={`switch-active-${profile.id}`}
                    className="data-[state=checked]:bg-green-500"
                  />
                </div>

                {/* Actions */}
                <div className="w-40 shrink-0 flex items-center justify-end gap-1.5">
                  {(acctStatus !== "valid" || profile.credentialsDirty) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-white hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 h-7 text-xs px-2"
                      onClick={() => handleVerify(profile.id)}
                      disabled={verifyMutation.isPending && verifyMutation.variables === profile.id}
                      data-testid={`button-verify-${profile.id}`}
                    >
                      {verifyMutation.isPending && verifyMutation.variables === profile.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <LogIn className="w-3 h-3 mr-1" />
                      }
                      {verifyMutation.isPending && verifyMutation.variables === profile.id ? "" : "Verify"}
                    </Button>
                  )}
                  <Link href={`/profiles/${profile.id}`}>
                    <Button variant="outline" size="sm" className="bg-white hover:bg-gray-50 h-7 text-xs px-2">
                      <Activity className="w-3 h-3 mr-1" /> Config
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm("Delete this profile?")) deleteProfileMutation.mutate(profile.id);
                    }}
                    data-testid={`button-delete-${profile.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />
    </AppLayout>
  );
}
