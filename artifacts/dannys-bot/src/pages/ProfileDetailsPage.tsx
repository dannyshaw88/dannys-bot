import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useProfile, useUpdateProfile, useUpdateAccountStatus, useProfiles } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import { SessionLogPanel } from "@/components/tools/SessionLogPanel";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";
import { UnfollowToolPanel } from "@/components/tools/UnfollowToolPanel";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import * as Tabs from "@radix-ui/react-tabs";
import { 
  ArrowLeft, Settings, Shield, User, Lock, Globe, Zap, Instagram, Activity, Monitor,
  CheckCircle2, XCircle, Loader2, ShieldCheck,
  Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, ChevronDown, ChevronLeft, ChevronRight,
  Tag, Calendar, FileText, Server, X, Clock, Copy, Search,
  UserPlus, MessageSquare, RefreshCw, Users, BarChart2,
  AlertTriangle, ShieldAlert, WifiOff, UserMinus, Camera, Eye
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useProxies, useUpdateProxy } from "@/hooks/use-proxies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import type { AccountStatus } from "@shared/schema";
import { ACCOUNT_STATUSES } from "@shared/schema";
import { userAgents } from "@shared/userAgents";

const STATUS_META: Record<AccountStatus, { label: string; icon: React.ElementType; pill: string; dot: string }> = {
  pending:            { label: "Pending",           icon: Clock,       pill: "bg-slate-50  text-slate-600  border-slate-200",  dot: "bg-slate-400"  },
  verifying:          { label: "Verifying",         icon: Loader2,     pill: "bg-blue-50   text-blue-600   border-blue-200",   dot: "bg-blue-400"   },
  valid:              { label: "Valid",             icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200",  dot: "bg-green-500"  },
  banned:             { label: "Banned",            icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  captcha:            { label: "Captcha",           icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  email_confirmation: { label: "Email Confirm",     icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  phone_verification: { label: "Phone Verify",      icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  "2fa_verification": { label: "2FA Verify",        icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  stopped:              { label: "Stopped",            icon: PowerOff,      pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  logged_out:           { label: "Logged Out",         icon: LogOut,        pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  bad_password:         { label: "Incorrect Password", icon: KeyRound,      pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  action_blocked:       { label: "Action Blocked",     icon: Ban,           pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  action_required:      { label: "Action Required",    icon: AlertTriangle, pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  post_deleted:         { label: "Post Deleted",       icon: AlertTriangle, pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  account_disabled:     { label: "Acct Disabled",      icon: UserMinus,     pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
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
  suspended:            { label: "Suspended",          icon: UserMinus,     pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  selfie_verification:  { label: "Selfie Verify",      icon: Camera,        pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  own_phone_verification: { label: "Own Phone Verify", icon: Phone,         pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  email_connection:     { label: "Email Connect",      icon: Mail,          pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  upload:               { label: "Upload",             icon: AlertTriangle, pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  review:               { label: "Review",             icon: Eye,           pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
};

export function ProfileDetailsPage() {
  const params = useParams();
  const profileId = Number(params.id);
  
  const { data: profile, isLoading: profileLoading } = useProfile(profileId);
  const { data: tools, isLoading: toolsLoading } = useTools(profileId);
  const { data: proxies } = useProxies();
  const updateProfileMutation = useUpdateProfile();
  const updateAccountStatusMutation = useUpdateAccountStatus();
  const updateProxyMutation = useUpdateProxy();
  const { toast } = useToast();

  const { openWindow } = useBrowserWindows();

  const { data: allProfiles } = useProfiles();

  const [formData, setFormData] = useState<any>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "pending" | "ok" | "fail">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedProfileIdRef = useRef<number | null>(null);

  const [linkedHostPort, setLinkedHostPort] = useState("");
  const [linkedUsername, setLinkedUsername] = useState("");
  const [linkedPassword, setLinkedPassword] = useState("");

  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [location, navigate] = useLocation();
  const initialTab = (() => {
    try { return new URLSearchParams(window.location.search).get("tab") ?? "settings"; } catch { return "settings"; }
  })();
  const [activeTab, setActiveTab] = useState(initialTab);

  const ACCOUNT_COPY_GROUPS: CopyOptionGroup[] = [
    {
      label: "API & Performance",
      options: [
        { key: "apiLimits", label: "API Limits & Control", description: "Min/max calls and interval settings" },
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
  ];

  const [syncNowStatus, setSyncNowStatus] = useState<"idle" | "syncing" | "done" | "fail">("idle");
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

  const otherProfiles = allProfiles?.filter(p => p.id !== profileId) ?? [];

  const handleAccountCopy = async (targetIds: number[], expandedKeys: string[]) => {
    if (!formData) return;
    const patch: Record<string, any> = {};
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
    const res = await fetch("/api/profiles/bulk-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: targetIds, patch }),
      credentials: "include",
    });
    if (!res.ok) throw new Error("Bulk update failed");
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
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
        userAgentApi: profile.userAgentApi || "",
        userAgentEmbedded: profile.userAgentEmbedded || "",
        apiLimits: (profile.apiLimits as any) || {
          requestsMin: 1,
          requestsMax: 1,
          everySecondsMin: 1,
          everySecondsMax: 30000
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
    scheduleAutoSave(next);
    // Reset verify badge whenever credentials change
    if ("username" in patch || "password" in patch) setVerifyStatus("idle");
  };

  const handleVerify = async (bypassProxy = false) => {
    setVerifyStatus("pending");
    queryClient.setQueryData(["/api/profiles"], (old: any) =>
      Array.isArray(old) ? old.map((p: any) => p.id === profileId ? { ...p, accountStatus: "verifying" } : p) : old
    );
    queryClient.setQueryData(["/api/profiles", profileId], (old: any) =>
      old ? { ...old, accountStatus: "verifying" } : old
    );
    const url = `/api/profiles/${profileId}/verify${bypassProxy ? "?bypassProxy=true" : ""}`;
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (res.status === 429) {
        // Another verify is already running for this account — keep pending state and wait
        toast({ title: "Verification In Progress", description: "Already verifying this account — please wait for it to finish." });
        return;
      }
      if (data.ok) {
        setVerifyStatus("ok");
        toast({ title: "Credentials Verified", description: data.message });
      } else {
        setVerifyStatus("fail");
        const suffix = bypassProxy ? " (tested without proxy — proxy may be the issue)" : "";
        toast({ title: "Verification Failed", description: data.message + suffix, variant: "destructive" });
      }
    } catch {
      setVerifyStatus("fail");
      toast({ title: "Error", description: "Could not reach server.", variant: "destructive" });
    }
  };

  const handleResetDeviceIds = () => {
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    const patch = {
      userAgentApi: randomUA.api,
      userAgentEmbedded: randomUA.embedded,
      credentialsDirty: true,
      accountStatus: "pending" as AccountStatus,
    };
    updateProfileMutation.mutate(
      { id: profileId, ...patch },
      {
        onSuccess: () => {
          setFormData((prev: any) => ({ ...prev, userAgentApi: randomUA.api, userAgentEmbedded: randomUA.embedded }));
          setVerifyStatus("idle");
          queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
          toast({ title: "Device IDs Reset", description: "New device fingerprint assigned. Account set to Pending." });
        },
        onError: () => toast({ title: "Error", description: "Failed to reset device IDs.", variant: "destructive" }),
      }
    );
  };

  if (profileLoading || toolsLoading) {
    return <AppLayout><div className="p-8 text-muted-foreground">Loading profile...</div></AppLayout>;
  }

  if (!profile || !formData) {
    return <AppLayout><div className="p-8 text-destructive">Profile not found.</div></AppLayout>;
  }

  const canVerify = formData.username.trim().length > 0 && formData.password.trim().length > 0;

  const getTool = (type: string) => tools?.find(t => t.type === type);

  // Profile switcher helpers
  const sortedProfiles = [...(allProfiles ?? [])].sort((a, b) =>
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
      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="w-full flex gap-8 items-start">
        <Tabs.List className="flex flex-col w-48 shrink-0 sticky top-4 self-start border-r border-border pr-0 py-1">
          <Tabs.Trigger value="settings" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <Settings className="w-4 h-4 shrink-0" /> Account Settings
          </Tabs.Trigger>
          <Tabs.Trigger value="follow" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <UserPlus className="w-4 h-4 shrink-0" /> Follow Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="unfollow" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <UserMinus className="w-4 h-4 shrink-0" /> Unfollow Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="contact" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <MessageSquare className="w-4 h-4 shrink-0" /> Contact Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="human-session" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <User className="w-4 h-4 shrink-0" /> Human Session Tools
          </Tabs.Trigger>
          <Tabs.Trigger value="session-log" className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left w-full rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 data-[state=active]:text-primary data-[state=active]:bg-accent data-[state=active]:font-semibold transition-all whitespace-nowrap">
            <Activity className="w-4 h-4 shrink-0" /> Session Log
          </Tabs.Trigger>
        </Tabs.List>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-4 mb-3">
            <div className="flex-1">
              <div className="flex items-center gap-1 flex-wrap">
                {(() => {
                  const acctStatus = (profile.accountStatus ?? "pending") as AccountStatus;
                  const meta = STATUS_META[acctStatus] ?? STATUS_META.pending;
                  const Icon = meta.icon;
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full border cursor-pointer hover:opacity-80 transition-opacity ${meta.pill}`}>
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
                <button
                  onClick={() => prevProfile && navigate(`/profiles/${prevProfile.id}`)}
                  disabled={!prevProfile}
                  title={prevProfile ? (prevProfile.accountLabel || prevProfile.username) : undefined}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <DropdownMenu onOpenChange={open => { if (!open) setProfileSearch(""); }}>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent transition-colors max-w-md">
                      <Instagram className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-2xl font-bold tracking-tight text-foreground truncate">
                        {profile.accountLabel || `@${profile.username}`}
                      </span>
                      <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-80 p-0">
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
                      ) : switcherProfiles.map(p => (
                        <DropdownMenuItem
                          key={p.id}
                          onClick={() => navigate(`/profiles/${p.id}`)}
                          className={`flex items-center gap-2.5 cursor-pointer px-3 py-2 text-sm ${p.id === profileId ? "bg-accent font-semibold" : ""}`}
                        >
                          <Instagram className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{p.accountLabel || `@${p.username}`}</span>
                          {p.id === profileId && <CheckCircle2 className="w-3.5 h-3.5 text-primary ml-auto shrink-0" />}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  onClick={() => nextProfile && navigate(`/profiles/${nextProfile.id}`)}
                  disabled={!nextProfile}
                  title={nextProfile ? (nextProfile.accountLabel || nextProfile.username) : undefined}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <span className="text-border mx-1 select-none">|</span>
                <Link href="/profiles" className="inline-flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-600 transition-colors">
                  <ArrowLeft className="w-3 h-3 text-red-500" /> Back to Accounts
                </Link>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto flex items-center gap-2 shrink-0"
              onClick={() => openWindow(profile.id, profile.username, profile.userAgentEmbedded || "")}
              data-testid="button-open-browser"
            >
              <Monitor className="w-4 h-4" />
              Open Browser
            </Button>
          </div>

        <Tabs.Content value="settings" className="outline-none animate-in fade-in duration-300">
          {/* Auto-save status bar */}
          <div className="flex items-center justify-between mb-4 h-8">
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2 h-8 text-xs text-blue-500 border-blue-500/40 hover:text-blue-600 hover:border-blue-600/60 hover:bg-blue-500/5"
              onClick={() => setCopyDialogOpen(true)}
              disabled={otherProfiles.length === 0}
            >
              <Copy className="w-3.5 h-3.5" />
              Copy Settings
            </Button>
            <div className="flex items-center h-5">
              {saveStatus === "saving" && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                </span>
              )}
              {saveStatus === "saved" && (
                <span className="flex items-center gap-1.5 text-xs text-green-600">
                  <CheckCircle2 className="w-3 h-3" /> Saved
                </span>
              )}
            </div>
          </div>

          <CopySettingsDialog
            key={copyDialogOpen ? "open" : "closed"}
            open={copyDialogOpen}
            onOpenChange={setCopyDialogOpen}
            title="Copy Account Settings"
            profiles={otherProfiles}
            optionGroups={ACCOUNT_COPY_GROUPS}
            onCopy={handleAccountCopy}
          />

          {/* Account Label */}
          <div className="space-y-2 pb-2">
            <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <Tag className="w-3.5 h-3.5" /> Account Name
            </Label>
            <Input
              placeholder="e.g. @Account1 | Monster Trustscore"
              value={formData.accountLabel}
              onChange={e => updateField({ accountLabel: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">A display label for quick identification — use any format you like.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2"><User className="w-5 h-5 text-primary" /> Instagram Login Information</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4">
                <div className="space-y-4">
                  {/* Credentials + verify */}
                  <div className="space-y-3">
                    <div className="space-y-3 max-w-[280px]">
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Instagram className="w-3.5 h-3.5" /> Username</Label>
                        <Input
                          value={formData.username}
                          onChange={e => updateField({ username: e.target.value })}
                          data-testid="input-username"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Lock className="w-3.5 h-3.5" /> Password</Label>
                        <PasswordInput
                          value={formData.password}
                          onChange={e => updateField({ password: e.target.value })}
                          data-testid="input-password"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5 max-w-[336px]">
                      <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><KeyRound className="w-3.5 h-3.5" /> 2FA Secret Key</Label>
                      <Input
                        placeholder="TOTP secret (e.g. M5ZM ZRDO…)"
                        value={formData.twoFASecretKey}
                        onChange={e => updateField({ twoFASecretKey: e.target.value })}
                        data-testid="input-2fa-secret"
                      />
                    </div>

                    {/* Verify button — constrained to match username/password width */}
                    <div className="max-w-[280px]">
                    {canVerify && (
                      <div>
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
                                : ""
                            }`}
                            onClick={() => handleVerify(false)}
                            disabled={verifyStatus === "pending"}
                            data-testid="button-verify-credentials"
                          >
                            {verifyStatus === "pending" && <Loader2 className="w-4 h-4 animate-spin" />}
                            {verifyStatus === "fail" && <XCircle className="w-4 h-4" />}
                            {verifyStatus === "idle" && <ShieldCheck className="w-4 h-4" />}
                            {verifyStatus === "pending" ? "Verifying…"
                              : verifyStatus === "fail" ? "Retry Verification"
                              : "Verify Credentials"}
                          </Button>
                        )}
                      </div>
                    )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleResetDeviceIds}
                    disabled={updateProfileMutation.isPending}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-50 text-left w-fit"
                  >
                    Reset Device IDs
                  </button>

                  <div className="space-y-3 pt-4 border-t border-border mt-4">
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
                                className="font-mono text-sm h-8 w-48 shrink-0"
                                placeholder="host:port"
                              />
                              <Input
                                value={linkedUsername}
                                onChange={e => setLinkedUsername(e.target.value)}
                                onBlur={() => saveLinkedField("username")}
                                onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                placeholder="username"
                                className="font-mono text-sm h-8 w-32 shrink-0"
                              />
                              <Input
                                value={linkedPassword}
                                onChange={e => setLinkedPassword(e.target.value)}
                                onBlur={() => saveLinkedField("password")}
                                onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                                placeholder="password"
                                className="font-mono text-sm h-8 w-32 shrink-0"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 px-2 shrink-0"
                                onClick={() => updateProfileMutation.mutate({ id: profileId, proxyId: null })}
                              >
                                <X className="w-3.5 h-3.5 mr-1" /> Unassign
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">Managed by Proxy Manager — changes update the shared proxy.</p>
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
                              className="font-mono text-sm h-8 w-48 shrink-0"
                            />
                            <Input
                              value={formData.proxyUsername}
                              onChange={e => updateField({ proxyUsername: e.target.value })}
                              onBlur={saveManualProxyField}
                              onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                              placeholder="username"
                              className="font-mono text-sm h-8 w-32 shrink-0"
                            />
                            <Input
                              value={formData.proxyPassword}
                              onChange={e => updateField({ proxyPassword: e.target.value })}
                              onBlur={saveManualProxyField}
                              onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                              placeholder="password"
                              className="font-mono text-sm h-8 w-32 shrink-0"
                            />
                          </div>
                          {proxies && proxies.length > 0 && (
                            <select
                              className="h-7 w-full rounded border border-dashed border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer hover:border-primary/50 transition-colors"
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

                  {/* ── Active Timer ── */}
                  <div className="space-y-4 pt-4 border-t border-border mt-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold flex items-center gap-2">
                        <Clock className="w-4 h-4 text-primary" /> Active Timer
                      </h4>
                      <Switch
                        checked={!!formData.activeTimerEnabled}
                        onCheckedChange={checked => updateField({ activeTimerEnabled: checked })}
                      />
                    </div>
                    {formData.activeTimerEnabled ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Start Time</Label>
                          <Input
                            type="time"
                            value={formData.activeTimerStart || "00:00"}
                            onChange={e => updateField({ activeTimerStart: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">End Time</Label>
                          <Input
                            type="time"
                            value={formData.activeTimerEnd || "23:59"}
                            onChange={e => updateField({ activeTimerEnd: e.target.value })}
                          />
                        </div>
                        <p className="col-span-2 text-xs text-muted-foreground -mt-1">
                          The account will only run automation tasks between these times. Outside this window it stays dormant.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground -mt-1">
                        Enable to restrict automation to specific hours of the day.
                      </p>
                    )}
                  </div>
                  
                  <div className="pt-6 border-t border-border mt-6">
                    <h4 className="text-sm font-bold mb-4 flex items-center gap-2"><Shield className="w-4 h-4 text-primary" /> Device Fingerprint</h4>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">API User Agent</Label>
                        <Input 
                          value={formData.userAgentApi}
                          onChange={e => updateField({ userAgentApi: e.target.value })}
                          placeholder="API Fingerprint string..."
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Embedded Agent</Label>
                        <Input 
                          value={formData.userAgentEmbedded}
                          onChange={e => updateField({ userAgentEmbedded: e.target.value })}
                          placeholder="Browser-like User Agent..."
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2"><Zap className="w-5 h-5 text-primary" /> API Limits & Control</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-6">
                <div className="flex gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Allow Min Calls</Label>
                    <Input 
                      type="number"
                      className="h-8 text-sm w-28"
                      value={formData.apiLimits.requestsMin}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, requestsMin: Number(e.target.value)} })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Allow Max Calls</Label>
                    <Input 
                      type="number"
                      className="h-8 text-sm w-28"
                      value={formData.apiLimits.requestsMax}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, requestsMax: Number(e.target.value)} })}
                    />
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Every Min (ms)</Label>
                    <Input 
                      type="number"
                      className="h-8 text-sm w-28"
                      value={formData.apiLimits.everySecondsMin}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, everySecondsMin: Number(e.target.value)} })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Every Max (ms)</Label>
                    <Input 
                      type="number"
                      className="h-8 text-sm w-28"
                      value={formData.apiLimits.everySecondsMax}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, everySecondsMax: Number(e.target.value)} })}
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Allow x-y amount of api calls every x-y milliseconds globally for this account.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Second row: Account Details + Security + Email Validation ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">

            {/* Account Details */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base"><Tag className="w-4 h-4 text-primary" /> Account Details</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4">
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
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><FileText className="w-3.5 h-3.5" /> Notes</Label>
                  <textarea
                    className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
                    placeholder="Any notes about this account…"
                    value={formData.notes}
                    onChange={e => updateField({ notes: e.target.value })}
                    data-testid="input-notes"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Security */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="w-4 h-4 text-primary" /> Security</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4">
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
                    className="flex min-h-[90px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none font-mono"
                    placeholder="One code per line…"
                    value={formData.backupCodes}
                    onChange={e => updateField({ backupCodes: e.target.value })}
                    data-testid="input-backup-codes"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Email Validation */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base"><Server className="w-4 h-4 text-primary" /> Email Validation</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4">
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
                <div className="pt-3 border-t border-border">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Used to automatically confirm Instagram emails via POP3 access.
                  </p>
                </div>
              </CardContent>
            </Card>
            {/* Profile Sync */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base"><RefreshCw className="w-4 h-4 text-primary" /> Profile Sync</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <div className="flex items-start gap-4">
                  {/* Left — stat icons */}
                  <div className="flex flex-col gap-2 shrink-0">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="flex flex-col items-center justify-center bg-muted/40 rounded-lg py-3 px-2 border border-border">
                        <Users className="w-4 h-4 text-blue-500 mb-1" />
                        <span className="text-base font-bold">
                          {profile?.followersCount != null ? profile.followersCount.toLocaleString() : "—"}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">Followers</span>
                      </div>
                      <div className="flex flex-col items-center justify-center bg-muted/40 rounded-lg py-3 px-2 border border-border">
                        <UserPlus className="w-4 h-4 text-purple-500 mb-1" />
                        <span className="text-base font-bold">
                          {profile?.followingCount != null ? profile.followingCount.toLocaleString() : "—"}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">Following</span>
                      </div>
                      <div className="flex flex-col items-center justify-center bg-muted/40 rounded-lg py-3 px-2 border border-border">
                        <BarChart2 className="w-4 h-4 text-green-500 mb-1" />
                        <span className="text-base font-bold">
                          {profile?.postsCount != null ? profile.postsCount.toLocaleString() : "—"}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">Posts</span>
                      </div>
                    </div>
                    {profile?.lastSyncedAt && (
                      <p className="text-[11px] text-muted-foreground">
                        Last synced: {new Date(profile.lastSyncedAt).toLocaleString()}
                      </p>
                    )}
                  </div>

                  {/* Right — controls */}
                  <div className="flex flex-col gap-3 flex-1 border-l border-border pl-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={!!formData?.syncEnabled}
                        onCheckedChange={v => updateField({ syncEnabled: v })}
                      />
                      <Label className="text-sm font-semibold whitespace-nowrap">Auto Sync</Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        value={formData?.syncIntervalMin ?? 60}
                        onChange={e => updateField({ syncIntervalMin: Number(e.target.value) })}
                        className="h-7 text-sm w-16"
                      />
                      <span className="text-xs text-muted-foreground">–</span>
                      <Input
                        type="number"
                        min={1}
                        value={formData?.syncIntervalMax ?? 120}
                        onChange={e => updateField({ syncIntervalMax: Number(e.target.value) })}
                        className="h-7 text-sm w-16"
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">min</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="syncUseHiker"
                        checked={!!formData?.syncUseHiker}
                        onCheckedChange={v => updateField({ syncUseHiker: !!v })}
                      />
                      <Label htmlFor="syncUseHiker" className="text-sm cursor-pointer whitespace-nowrap">HikerAPI</Label>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 self-start"
                      disabled={syncNowStatus === "syncing"}
                      onClick={handleSyncNow}
                    >
                      {syncNowStatus === "syncing" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {syncNowStatus === "done" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                      {syncNowStatus === "fail" && <XCircle className="w-3.5 h-3.5 text-destructive" />}
                      {syncNowStatus === "idle" && <RefreshCw className="w-3.5 h-3.5" />}
                      {syncNowStatus === "syncing" ? "Syncing…" : syncNowStatus === "done" ? "Synced!" : syncNowStatus === "fail" ? "Sync Failed" : "Sync Now"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

          </div>
        </Tabs.Content>

        <Tabs.Content value="follow" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <ToolConfigPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="unfollow" className="outline-none animate-in fade-in duration-300">
          {getTool('unfollow')
            ? <UnfollowToolPanel tool={getTool('unfollow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Unfollow tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="contact" className="outline-none animate-in fade-in duration-300">
          {getTool('contact')
            ? <ContactToolPanel tool={getTool('contact')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Contact tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
          {getTool('human_sessions')
            ? <HumanSessionPanel tool={getTool('human_sessions')!} profile={profile} />
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
    </AppLayout>
  );
}
