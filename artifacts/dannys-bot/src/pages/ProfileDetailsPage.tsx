import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useProfile, useUpdateProfile, useUpdateAccountStatus, useProfiles } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import { SessionLogPanel } from "@/components/tools/SessionLogPanel";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";
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
import { useProxies } from "@/hooks/use-proxies";
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
  valid:              { label: "Valid",             icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200",  dot: "bg-green-500"  },
  banned:             { label: "Banned",            icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  captcha:            { label: "Captcha",           icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  email_confirmation: { label: "Email Confirm",     icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  phone_verification: { label: "Phone Verify",      icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  "2fa_verification": { label: "2FA Verify",        icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  stopped:              { label: "Stopped",            icon: PowerOff,      pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  logged_out:           { label: "Logged Out",         icon: LogOut,        pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
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
  const { toast } = useToast();

  const { openWindow } = useBrowserWindows();

  const { data: allProfiles } = useProfiles();

  const [formData, setFormData] = useState<any>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "pending" | "ok" | "fail">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(false);

  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [activeTab, setActiveTab] = useState("settings");
  const [, navigate] = useLocation();

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

  const handleAccountCopy = async (targetIds: number[], selectedKeys: Set<string>) => {
    if (!formData) return;
    const patch: Record<string, any> = {};
    if (selectedKeys.has("apiLimits")) patch.apiLimits = formData.apiLimits;
    if (selectedKeys.has("activeTimer")) {
      patch.activeTimerEnabled = formData.activeTimerEnabled;
      patch.activeTimerStart = formData.activeTimerStart;
      patch.activeTimerEnd = formData.activeTimerEnd;
    }
    if (selectedKeys.has("profileSync")) {
      patch.syncEnabled = formData.syncEnabled;
      patch.syncIntervalMin = formData.syncIntervalMin;
      patch.syncIntervalMax = formData.syncIntervalMax;
      patch.syncUseHiker = formData.syncUseHiker;
    }
    await Promise.all(
      targetIds.map(id =>
        new Promise<void>((resolve, reject) =>
          updateProfileMutation.mutate({ id, ...patch }, { onSuccess: () => resolve(), onError: reject })
        )
      )
    );
    const names = targetIds.map(id => "@" + (otherProfiles.find(p => p.id === id)?.username ?? id)).join(", ");
    toast({ title: "Settings copied", description: `Applied to ${names}.` });
  };

  useEffect(() => {
    if (profile && !initialLoadRef.current) {
      initialLoadRef.current = true;
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
          requestsMin: 5,
          requestsMax: 10,
          everySecondsMin: 30,
          everySecondsMax: 60
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

  const updateField = (patch: any) => {
    const next = { ...formData, ...patch };
    setFormData(next);
    scheduleAutoSave(next);
    // Reset verify badge whenever credentials change
    if ("username" in patch || "password" in patch) setVerifyStatus("idle");
  };

  const handleVerify = async (bypassProxy = false) => {
    setVerifyStatus("pending");
    const url = `/api/profiles/${profileId}/verify${bypassProxy ? "?bypassProxy=true" : ""}`;
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
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
      <div className="mb-8">
        <Link href="/profiles" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-4 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Accounts
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            {/* Profile switcher */}
            <div className="flex items-center gap-1 mb-1">
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
            </div>
            <div className="flex items-center gap-2 mt-2">
              {/* Account status badge — click to change */}
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
                        const m = STATUS_META[s];
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
              {/* Automation running indicator */}
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className={`w-2 h-2 rounded-full ${profile.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
                {profile.status === 'running' ? 'Automation running' : 'Automation idle'}
              </span>
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
      </div>

      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="w-full">
        <Tabs.List className="flex border-b border-border mb-8 overflow-x-auto">
          <Tabs.Trigger value="settings" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <Settings className="w-4 h-4 mr-2" /> Account Settings
          </Tabs.Trigger>
          <Tabs.Trigger value="follow" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <UserPlus className="w-4 h-4 mr-2" /> Follow Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="contact" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <MessageSquare className="w-4 h-4 mr-2" /> Contact Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="human-session" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <User className="w-4 h-4 mr-2" /> Human Session Tools
          </Tabs.Trigger>
          <Tabs.Trigger value="session-log" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <Activity className="w-4 h-4 mr-2" /> Session Log
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="settings" className="outline-none animate-in fade-in duration-300">
          {/* Auto-save status bar */}
          <div className="flex items-center justify-between mb-4 h-8">
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2 h-8 text-xs"
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
              <Tag className="w-3.5 h-3.5" /> Account Name &amp; Trustscore
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
                <CardTitle className="flex items-center gap-2"><User className="w-5 h-5 text-primary" /> Login Information</CardTitle>
              </CardHeader>
              <CardContent className="px-0 space-y-4">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Instagram className="w-3.5 h-3.5" /> Username</Label>
                    <Input 
                      value={formData.username}
                      onChange={e => updateField({ username: e.target.value })}
                      data-testid="input-username"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Lock className="w-3.5 h-3.5" /> Password</Label>
                    <PasswordInput
                      value={formData.password}
                      onChange={e => updateField({ password: e.target.value })}
                      data-testid="input-password"
                    />
                  </div>

                  {/* Verify button — appears only when credentials are filled */}
                  {canVerify && (
                    <div className="flex gap-2">
                      {verifyStatus === "ok" ? (
                        <div
                          data-testid="status-logged-in"
                          className="flex-1 h-10 flex items-center justify-center gap-2 rounded-md border border-green-500 bg-green-50 text-green-700 font-medium text-sm cursor-default select-none"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Logged In
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant={verifyStatus === "fail" ? "outline" : "default"}
                          className={`flex-1 h-10 gap-2 transition-all ${
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
                            : verifyStatus === "fail" ? "Retry with Proxy"
                            : "Verify Credentials"}
                        </Button>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleResetDeviceIds}
                    disabled={updateProfileMutation.isPending}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors disabled:opacity-50 text-left w-fit"
                  >
                    Reset Device IDs
                  </button>

                  <div className="space-y-4 pt-4 border-t border-border mt-4">
                    <h4 className="text-sm font-bold mb-2 flex items-center gap-2"><Globe className="w-4 h-4 text-primary" /> Proxy Settings</h4>

                    {/* Linked proxy from Proxy Manager */}
                    {(() => {
                      const linked = proxies?.find(p => p.id === profile.proxyId);
                      if (linked) {
                        return (
                          <div className="flex items-center gap-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
                            <Server className="w-4 h-4 text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold font-mono truncate">{linked.host}:{linked.port}</p>
                              {linked.username && (
                                <p className="text-xs text-muted-foreground mt-0.5">{linked.username}</p>
                              )}
                            </div>
                            {linked.username
                              ? <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded shrink-0">Auth</span>
                              : <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-accent px-2 py-0.5 rounded shrink-0">No Auth</span>
                            }
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-7 px-2 shrink-0"
                              onClick={() => updateProfileMutation.mutate({ id: profileId, proxyId: null })}
                            >
                              <X className="w-3.5 h-3.5 mr-1" /> Unassign
                            </Button>
                          </div>
                        );
                      }
                      return (
                        <>
                          <p className="text-xs text-muted-foreground -mt-1">No proxy assigned. Go to the <strong>Proxy Manager</strong> to assign one, or enter details manually below.</p>
                          <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">IP Address &amp; Port</Label>
                            <Input
                              placeholder="45.80.96.251:29842"
                              className="font-mono"
                              value={formData.proxyHost && formData.proxyPort ? `${formData.proxyHost}:${formData.proxyPort}` : formData.proxyHost || ""}
                              onChange={e => {
                                const val = e.target.value;
                                const lastColon = val.lastIndexOf(":");
                                if (lastColon !== -1) {
                                  const host = val.slice(0, lastColon);
                                  const port = val.slice(lastColon + 1);
                                  updateField({ proxyHost: host, proxyPort: port });
                                } else {
                                  updateField({ proxyHost: val, proxyPort: "" });
                                }
                              }}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Proxy User</Label>
                              <Input
                                placeholder="Optional"
                                value={formData.proxyUsername}
                                onChange={e => updateField({ proxyUsername: e.target.value })}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Proxy Pass</Label>
                              <PasswordInput
                                placeholder="Optional"
                                value={formData.proxyPassword}
                                onChange={e => updateField({ proxyPassword: e.target.value })}
                              />
                            </div>
                          </div>
                        </>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Allow Min Calls</Label>
                    <Input 
                      type="number"
                      value={formData.apiLimits.requestsMin}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, requestsMin: Number(e.target.value)} })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Allow Max Calls</Label>
                    <Input 
                      type="number"
                      value={formData.apiLimits.requestsMax}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, requestsMax: Number(e.target.value)} })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Every Min (s)</Label>
                    <Input 
                      type="number"
                      value={formData.apiLimits.everySecondsMin}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, everySecondsMin: Number(e.target.value)} })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Every Max (s)</Label>
                    <Input 
                      type="number"
                      value={formData.apiLimits.everySecondsMax}
                      onChange={e => updateField({ apiLimits: {...formData.apiLimits, everySecondsMax: Number(e.target.value)} })}
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Allow x-y amount of api calls every x-y seconds globally for this account.
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
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">2FA Secret Key</Label>
                  <Input
                    placeholder="TOTP secret (e.g. M5ZM ZRDO…)"
                    value={formData.twoFASecretKey}
                    onChange={e => updateField({ twoFASecretKey: e.target.value })}
                    data-testid="input-2fa-secret"
                  />
                  <p className="text-[11px] text-muted-foreground">Base32 TOTP secret for authenticator apps.</p>
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
              <CardContent className="px-0 space-y-4">

                {/* Current stats read-out */}
                <div className="grid grid-cols-3 gap-3">
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

                {/* Enable sync */}
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div>
                    <Label className="text-sm font-semibold">Enable Auto Sync</Label>
                    <p className="text-[11px] text-muted-foreground">Periodically update follower, following and post counts.</p>
                  </div>
                  <Switch
                    checked={!!formData?.syncEnabled}
                    onCheckedChange={v => updateField({ syncEnabled: v })}
                  />
                </div>

                {/* Interval range */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Min Interval (min)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={formData?.syncIntervalMin ?? 60}
                      onChange={e => updateField({ syncIntervalMin: Number(e.target.value) })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Max Interval (min)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={formData?.syncIntervalMax ?? 120}
                      onChange={e => updateField({ syncIntervalMax: Number(e.target.value) })}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                {/* Use HikerAPI checkbox */}
                <div className="flex items-center gap-2.5">
                  <Checkbox
                    id="syncUseHiker"
                    checked={!!formData?.syncUseHiker}
                    onCheckedChange={v => updateField({ syncUseHiker: !!v })}
                  />
                  <Label htmlFor="syncUseHiker" className="text-sm cursor-pointer">
                    Use HikerAPI for sync
                  </Label>
                </div>
                {formData?.syncUseHiker && (
                  <p className="text-[11px] text-blue-600">
                    Requires HikerAPI enabled and token set in Global Settings.
                  </p>
                )}

                {/* Sync Now button */}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 w-full"
                  disabled={syncNowStatus === "syncing"}
                  onClick={handleSyncNow}
                >
                  {syncNowStatus === "syncing" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {syncNowStatus === "done" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                  {syncNowStatus === "fail" && <XCircle className="w-3.5 h-3.5 text-destructive" />}
                  {syncNowStatus === "idle" && <RefreshCw className="w-3.5 h-3.5" />}
                  {syncNowStatus === "syncing" ? "Syncing…" : syncNowStatus === "done" ? "Synced!" : syncNowStatus === "fail" ? "Sync Failed" : "Sync Now"}
                </Button>
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

        <Tabs.Content value="contact" className="outline-none animate-in fade-in duration-300">
          {getTool('contact')
            ? <ContactToolPanel tool={getTool('contact')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Contact tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <HumanSessionPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="session-log" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <SessionLogPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>

      </Tabs.Root>
    </AppLayout>
  );
}
