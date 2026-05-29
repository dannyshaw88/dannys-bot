import { useState, useEffect, useRef } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useProfile, useUpdateProfile } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { UnfollowToolPanel } from "@/components/tools/UnfollowToolPanel";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import * as Tabs from "@radix-ui/react-tabs";
import { TRUST_LEVELS } from "@/components/TrustScoreBadge";
import { Zap, RefreshCw, Loader2, ChevronLeft, Save } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface TrustScoreTemplate {
  trustScoreId: string;
  profileId: number | null;
}

interface FormData {
  apiLimits: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number };
  syncEnabled: boolean;
  syncIntervalMin: number;
  syncIntervalMax: number;
  syncUseHiker: boolean;
}

const CYAN = "#1AD2F2";
const CYAN_BORDER = "#0eb8d4";

export function TrustScoreDetailPage() {
  const { trustScoreId } = useParams<{ trustScoreId: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const activeTab = new URLSearchParams(search).get("tab") ?? "settings";

  const level = TRUST_LEVELS.find(l => l.id === trustScoreId);

  const { data: templates, isLoading: templatesLoading } = useQuery<TrustScoreTemplate[]>({
    queryKey: ["/api/trust-score-templates"],
    queryFn: async () => {
      const res = await fetch("/api/trust-score-templates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch trust score templates");
      return res.json();
    },
  });

  const profileId = templates?.find(t => t.trustScoreId === trustScoreId)?.profileId ?? 0;

  const { data: profile } = useProfile(profileId || 0);
  const { data: tools } = useTools(profileId || 0);
  const updateProfileMutation = useUpdateProfile();

  const getTool = (type: string) => tools?.find(t => t.type === type);

  const [formData, setFormData] = useState<FormData | null>(null);
  const loadedIdRef = useRef(0);

  useEffect(() => {
    if (profile && loadedIdRef.current !== profile.id) {
      loadedIdRef.current = profile.id;
      setFormData({
        apiLimits: (profile.apiLimits as any) ?? { requestsMin: 1, requestsMax: 3, everySecondsMin: 1000, everySecondsMax: 30000 },
        syncEnabled: !!profile.syncEnabled,
        syncIntervalMin: profile.syncIntervalMin ?? 60,
        syncIntervalMax: profile.syncIntervalMax ?? 120,
        syncUseHiker: !!profile.syncUseHiker,
      });
    }
  }, [profile]);

  const handleSave = async () => {
    if (!formData || !profileId) return;
    try {
      await updateProfileMutation.mutateAsync({
        id: profileId,
        apiLimits: formData.apiLimits,
        syncEnabled: formData.syncEnabled,
        syncIntervalMin: formData.syncIntervalMin,
        syncIntervalMax: formData.syncIntervalMax,
        syncUseHiker: formData.syncUseHiker,
      } as any);
      toast({ title: "Settings saved" });
    } catch {
      toast({ title: "Failed to save settings", variant: "destructive" });
    }
  };

  const updateApiLimits = (field: keyof FormData["apiLimits"], val: number) =>
    setFormData(f => f ? { ...f, apiLimits: { ...f.apiLimits, [field]: val } } : f);

  if (templatesLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!level || !profileId) {
    return (
      <div className="p-6 text-muted-foreground">Trust score tier not found.</div>
    );
  }

  const Icon = level.icon;

  return (
    <Tabs.Root
      value={activeTab}
      onValueChange={tab => navigate(`/trust-scores/${trustScoreId}?tab=${tab}`)}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 pt-3 pb-0">
          <button
            onClick={() => navigate("/trust-scores")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> TrustScores
          </button>
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-1"
            style={{ background: CYAN, border: `1px solid ${CYAN_BORDER}` }}
          >
            <Icon size={12} color="#ffffff" strokeWidth={2} />
            <span style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", letterSpacing: "0.05em" }}>
              {level.label}
            </span>
          </div>
        </div>

        <Tabs.List className="flex px-4 mt-2 gap-0">
          {[
            { value: "settings",      label: "Settings"       },
            { value: "follow",        label: "Follow Tool"    },
            { value: "unfollow",      label: "Unfollow Tool"  },
            { value: "contact",       label: "Contact Tool"   },
            { value: "human-session", label: "Human Session"  },
          ].map(tab => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className="px-3 py-2 text-[11px] font-semibold text-muted-foreground border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground transition-colors hover:text-foreground outline-none whitespace-nowrap"
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </div>

      {/* Settings */}
      <Tabs.Content value="settings" className="outline-none p-6 max-w-2xl space-y-6">
        {!formData && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {formData && (
          <>
            {/* API Limits */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Zap className="w-4 h-4 text-yellow-500" /> API Limits &amp; Control
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 space-y-3">
                <div className="flex gap-2 items-end flex-wrap">
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min Calls</Label>
                    <Input
                      type="number"
                      className="h-7 text-xs w-[68px]"
                      value={formData.apiLimits.requestsMin}
                      onChange={e => updateApiLimits("requestsMin", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max Calls</Label>
                    <Input
                      type="number"
                      className="h-7 text-xs w-[68px]"
                      value={formData.apiLimits.requestsMax}
                      onChange={e => updateApiLimits("requestsMax", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min (ms)</Label>
                    <Input
                      type="number"
                      className="h-7 text-xs w-[68px]"
                      value={formData.apiLimits.everySecondsMin}
                      onChange={e => updateApiLimits("everySecondsMin", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max (ms)</Label>
                    <Input
                      type="number"
                      className="h-7 text-xs w-[68px]"
                      value={formData.apiLimits.everySecondsMax}
                      onChange={e => updateApiLimits("everySecondsMax", Number(e.target.value))}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Allow x–y calls every x–y ms for accounts at this trust level.</p>
              </CardContent>
            </Card>

            {/* Sync Options */}
            <Card className="border-none shadow-none !bg-transparent">
              <CardHeader className="px-0 pt-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <RefreshCw className="w-4 h-4 text-primary" /> Sync Options
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={formData.syncEnabled}
                      onCheckedChange={v => setFormData(f => f ? { ...f, syncEnabled: v } : f)}
                    />
                    <Label className="text-sm font-semibold whitespace-nowrap">Auto Sync</Label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={formData.syncIntervalMin}
                      onChange={e => setFormData(f => f ? { ...f, syncIntervalMin: Number(e.target.value) } : f)}
                      className="h-7 text-sm w-16"
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input
                      type="number"
                      min={1}
                      value={formData.syncIntervalMax}
                      onChange={e => setFormData(f => f ? { ...f, syncIntervalMax: Number(e.target.value) } : f)}
                      className="h-7 text-sm w-16"
                    />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">min</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`syncHiker-${trustScoreId}`}
                      checked={formData.syncUseHiker}
                      onCheckedChange={v => setFormData(f => f ? { ...f, syncUseHiker: !!v } : f)}
                    />
                    <Label htmlFor={`syncHiker-${trustScoreId}`} className="text-sm cursor-pointer whitespace-nowrap">HikerAPI</Label>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button onClick={handleSave} disabled={updateProfileMutation.isPending} className="gap-2">
              {updateProfileMutation.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Save className="w-4 h-4" />
              }
              Save Settings
            </Button>
          </>
        )}
      </Tabs.Content>

      {/* Follow Tool */}
      <Tabs.Content value="follow" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("follow")
          ? <ToolConfigPanel tool={getTool("follow")!} profile={profile} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Unfollow Tool */}
      <Tabs.Content value="unfollow" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("unfollow")
          ? <UnfollowToolPanel tool={getTool("unfollow")!} profile={profile} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Contact Tool */}
      <Tabs.Content value="contact" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("contact")
          ? <ContactToolPanel tool={getTool("contact")!} profile={profile} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Human Session */}
      <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("human_sessions")
          ? <HumanSessionPanel tool={getTool("human_sessions")!} profile={profile} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>
    </Tabs.Root>
  );
}
