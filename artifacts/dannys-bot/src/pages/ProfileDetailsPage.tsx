import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "wouter";
import { useProfile, useUpdateProfile, useUpdateAccountStatus, useProfiles } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import * as Tabs from "@radix-ui/react-tabs";
import { 
  ArrowLeft, Settings, Shield, User, Lock, Globe, Zap, Instagram, Activity, Monitor,
  CheckCircle2, XCircle, Loader2, ShieldCheck,
  Ban, ScanFace, Mail, Phone, KeyRound, PowerOff, LogOut, ChevronDown,
  Tag, Calendar, FileText, Server, X, Clock, Copy,
  UserPlus
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import type { AccountStatus } from "@shared/schema";
import { ACCOUNT_STATUSES } from "@shared/schema";

const STATUS_META: Record<AccountStatus, { label: string; icon: React.ElementType; pill: string; dot: string }> = {
  pending:            { label: "Pending",           icon: Clock,       pill: "bg-slate-50  text-slate-600  border-slate-200",  dot: "bg-slate-400"  },
  valid:              { label: "Valid",             icon: ShieldCheck, pill: "bg-green-50  text-green-700  border-green-200",  dot: "bg-green-500"  },
  banned:             { label: "Banned",            icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
  captcha:            { label: "Captcha",           icon: ScanFace,    pill: "bg-amber-50  text-amber-700  border-amber-200",  dot: "bg-amber-500"  },
  email_confirmation: { label: "Email Confirm",     icon: Mail,        pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  phone_verification: { label: "Phone Verify",      icon: Phone,       pill: "bg-blue-50   text-blue-700   border-blue-200",   dot: "bg-blue-500"   },
  "2fa_verification": { label: "2FA Verify",        icon: KeyRound,    pill: "bg-purple-50 text-purple-700 border-purple-200", dot: "bg-purple-500" },
  stopped:            { label: "Stopped",           icon: PowerOff,    pill: "bg-slate-100 text-slate-500  border-slate-200",  dot: "bg-slate-400"  },
  logged_out:         { label: "Logged Out",        icon: LogOut,      pill: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  action_blocked:     { label: "Action Blocked",    icon: Ban,         pill: "bg-red-50    text-red-700    border-red-200",    dot: "bg-red-500"    },
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
  const [copyTarget, setCopyTarget] = useState<string>("");
  const [copyOptions, setCopyOptions] = useState({ apiLimits: true, activeTimer: true });
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "done">("idle");

  const otherProfiles = allProfiles?.filter(p => p.id !== profileId) ?? [];

  const handleCopySettings = async () => {
    if (!copyTarget || !formData) return;
    const targetId = Number(copyTarget);
    const patch: Record<string, any> = {};
    if (copyOptions.apiLimits) patch.apiLimits = formData.apiLimits;
    if (copyOptions.activeTimer) {
      patch.activeTimerEnabled = formData.activeTimerEnabled;
      patch.activeTimerStart = formData.activeTimerStart;
      patch.activeTimerEnd = formData.activeTimerEnd;
    }
    setCopyStatus("copying");
    updateProfileMutation.mutate(
      { id: targetId, ...patch },
      {
        onSuccess: () => {
          setCopyStatus("done");
          const targetName = otherProfiles.find(p => p.id === targetId)?.username ?? `#${targetId}`;
          toast({ title: "Settings copied", description: `Applied to @${targetName}.` });
          setTimeout(() => {
            setCopyStatus("idle");
            setCopyDialogOpen(false);
          }, 1200);
        },
        onError: () => {
          setCopyStatus("idle");
          toast({ title: "Copy failed", description: "Could not update the target profile.", variant: "destructive" });
        },
      }
    );
  };

  useEffect(() => {
    if (profile && !initialLoadRef.current) {
      initialLoadRef.current = true;
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

  if (profileLoading || toolsLoading) {
    return <AppLayout><div className="p-8 text-muted-foreground">Loading profile...</div></AppLayout>;
  }

  if (!profile || !formData) {
    return <AppLayout><div className="p-8 text-destructive">Profile not found.</div></AppLayout>;
  }

  const canVerify = formData.username.trim().length > 0 && formData.password.trim().length > 0;

  const getTool = (type: string) => tools?.find(t => t.type === type);

  return (
    <AppLayout>
      <div className="mb-8">
        <Link href="/profiles" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-4 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Accounts
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">@{profile.username}</h1>
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

      <Tabs.Root defaultValue="settings" className="w-full">
        <Tabs.List className="flex border-b border-border mb-8 overflow-x-auto">
          <Tabs.Trigger value="settings" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <Settings className="w-4 h-4 mr-2" /> Account Settings
          </Tabs.Trigger>
          <Tabs.Trigger value="follow" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <UserPlus className="w-4 h-4 mr-2" /> Follow Tool
          </Tabs.Trigger>
          <Tabs.Trigger value="human-session" className="px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary transition-all flex items-center whitespace-nowrap">
            <User className="w-4 h-4 mr-2" /> Human Session Tools
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="settings" className="outline-none animate-in fade-in duration-300">
          {/* Auto-save status bar */}
          <div className="flex items-center justify-between mb-4 h-8">
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2 h-8 text-xs"
              onClick={() => { setCopyTarget(""); setCopyOptions({ apiLimits: true, activeTimer: true }); setCopyStatus("idle"); setCopyDialogOpen(true); }}
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

          {/* Copy Settings Dialog */}
          <Dialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Copy className="w-4 h-4 text-primary" /> Copy Settings to Another Profile
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-5 py-2">
                {/* Target profile selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Copy To</Label>
                  <Select value={copyTarget} onValueChange={setCopyTarget}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a profile…" />
                    </SelectTrigger>
                    <SelectContent>
                      {otherProfiles.map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          @{p.username}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* What to copy */}
                <div className="space-y-3">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Settings to Copy</Label>
                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Checkbox
                        id="copy-api-limits"
                        checked={copyOptions.apiLimits}
                        onCheckedChange={v => setCopyOptions(o => ({ ...o, apiLimits: !!v }))}
                      />
                      <div>
                        <p className="text-sm font-medium leading-none">API Limits &amp; Control</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Min/max calls and interval settings</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Checkbox
                        id="copy-active-timer"
                        checked={copyOptions.activeTimer}
                        onCheckedChange={v => setCopyOptions(o => ({ ...o, activeTimer: !!v }))}
                      />
                      <div>
                        <p className="text-sm font-medium leading-none">Active Timer</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Enabled state, start &amp; end times</p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              <DialogFooter className="gap-2">
                <DialogClose asChild>
                  <Button variant="outline" size="sm">Cancel</Button>
                </DialogClose>
                <Button
                  size="sm"
                  disabled={!copyTarget || (!copyOptions.apiLimits && !copyOptions.activeTimer) || copyStatus === "copying" || copyStatus === "done"}
                  onClick={handleCopySettings}
                  className="min-w-[100px]"
                >
                  {copyStatus === "copying" && <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Copying…</>}
                  {copyStatus === "done" && <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-green-500" /> Copied!</>}
                  {copyStatus === "idle" && <><Copy className="w-3.5 h-3.5 mr-1.5" /> Copy Settings</>}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

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
          </div>
        </Tabs.Content>

        <Tabs.Content value="follow" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <ToolConfigPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>

        <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
          {getTool('follow')
            ? <HumanSessionPanel tool={getTool('follow')!} profile={profile} />
            : <p className="text-sm text-muted-foreground py-8">Follow tool not found for this profile.</p>
          }
        </Tabs.Content>

      </Tabs.Root>
    </AppLayout>
  );
}
