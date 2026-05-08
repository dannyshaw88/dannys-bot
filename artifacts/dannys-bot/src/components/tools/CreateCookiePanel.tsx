import { useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUpdateProfile, useProfiles } from "@/hooks/use-profiles";
import { queryClient } from "@/lib/queryClient";
import { CopySettingsDialog } from "@/components/tools/CopySettingsDialog";
import { Play, Loader2, CheckCircle2, XCircle, Globe, Link2, Clock, Shuffle } from "lucide-react";
import type { Profile } from "@shared/schema";

interface CookieBakerSettings {
  enabled: boolean;
  execIntervalMin: number;
  execIntervalMax: number;
  sitesMin: number;
  sitesMax: number;
  scrollDelayMin: number;
  scrollDelayMax: number;
  internalLinksMin: number;
  internalLinksMax: number;
  internalScrollDelayMin: number;
  internalScrollDelayMax: number;
  visitRandom: boolean;
  sites: string;
}

const DEFAULTS: CookieBakerSettings = {
  enabled: false,
  execIntervalMin: 60,
  execIntervalMax: 120,
  sitesMin: 3,
  sitesMax: 5,
  scrollDelayMin: 5,
  scrollDelayMax: 15,
  internalLinksMin: 1,
  internalLinksMax: 3,
  internalScrollDelayMin: 3,
  internalScrollDelayMax: 10,
  visitRandom: true,
  sites: "",
};

const COPY_GROUPS = [
  {
    label: "Cookie Baker",
    options: [
      {
        key: "cookieBakerAll",
        label: "All Settings",
        description: "Copy all cookie baker settings to target accounts",
        subOptions: [
          { key: "cb_enabled",  label: "Start / Stop",                settingKeys: ["enabled"] },
          { key: "cb_interval", label: "Execute interval (min / max)", settingKeys: ["execIntervalMin", "execIntervalMax"] },
          { key: "cb_sites",    label: "Sites per session (min / max)", settingKeys: ["sitesMin", "sitesMax"] },
          { key: "cb_scroll",   label: "Scroll delay (min / max secs)", settingKeys: ["scrollDelayMin", "scrollDelayMax"] },
          { key: "cb_links",    label: "Internal links (min / max)",    settingKeys: ["internalLinksMin", "internalLinksMax"] },
          { key: "cb_iscroll",  label: "Internal scroll delay (min / max secs)", settingKeys: ["internalScrollDelayMin", "internalScrollDelayMax"] },
          { key: "cb_random",   label: "Visit websites at random",      settingKeys: ["visitRandom"] },
          { key: "cb_siteList", label: "Website list",                  settingKeys: ["sites"] },
        ],
      },
    ],
  },
];

interface Props {
  profile: Profile;
}

export function CreateCookiePanel({ profile }: Props) {
  const [local, setLocal] = useState<CookieBakerSettings>(() => ({
    ...DEFAULTS,
    ...((profile.cookieBakerSettings as any) ?? {}),
  }));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "fail">("idle");
  const [copyOpen, setCopyOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateProfileMutation = useUpdateProfile();
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();

  const otherProfiles = allProfiles.filter((p: Profile) => p.id !== profile.id && !p.locked);
  const hasOtherProfiles = allProfiles.some((p: Profile) => p.id !== profile.id);

  const save = useCallback(
    (next: CookieBakerSettings) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(() => {
        updateProfileMutation.mutate(
          { id: profile.id, cookieBakerSettings: next as any },
          {
            onSuccess: () => {
              setSaveStatus("saved");
              queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id] });
              setTimeout(() => setSaveStatus("idle"), 2000);
            },
            onError: () => setSaveStatus("idle"),
          },
        );
      }, 600);
    },
    [profile.id, updateProfileMutation],
  );

  const update = (patch: Partial<CookieBakerSettings>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    save(next);
  };

  const handleRunNow = async () => {
    setRunStatus("running");
    try {
      const res = await fetch(`/api/profiles/${profile.id}/cookie-baker/run-now`, { method: "POST" });
      if (res.ok) {
        setRunStatus("done");
        toast({ title: "Cookie Baker Triggered", description: "A browsing session will start immediately." });
      } else {
        setRunStatus("fail");
        toast({ title: "Error", description: "Could not trigger session.", variant: "destructive" });
      }
    } catch {
      setRunStatus("fail");
      toast({ title: "Error", description: "Network error.", variant: "destructive" });
    } finally {
      setTimeout(() => setRunStatus("idle"), 3000);
    }
  };

  const handleCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const patch: Partial<CookieBakerSettings> = {};
    if (expandedKeys.includes("cb_enabled"))  patch.enabled = local.enabled;
    if (expandedKeys.includes("cb_interval")) { patch.execIntervalMin = local.execIntervalMin; patch.execIntervalMax = local.execIntervalMax; }
    if (expandedKeys.includes("cb_sites"))    { patch.sitesMin = local.sitesMin; patch.sitesMax = local.sitesMax; }
    if (expandedKeys.includes("cb_scroll"))   { patch.scrollDelayMin = local.scrollDelayMin; patch.scrollDelayMax = local.scrollDelayMax; }
    if (expandedKeys.includes("cb_links"))    { patch.internalLinksMin = local.internalLinksMin; patch.internalLinksMax = local.internalLinksMax; }
    if (expandedKeys.includes("cb_iscroll"))  { patch.internalScrollDelayMin = local.internalScrollDelayMin; patch.internalScrollDelayMax = local.internalScrollDelayMax; }
    if (expandedKeys.includes("cb_random"))   patch.visitRandom = local.visitRandom;
    if (expandedKeys.includes("cb_siteList")) patch.sites = local.sites;

    if (!Object.keys(patch).length) return;

    await Promise.all(
      targetIds.map((id) =>
        fetch(`/api/profiles/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookieBakerSettings: { ...DEFAULTS, ...patch } }),
        }),
      ),
    );
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    toast({ title: "Settings copied", description: `Applied to ${targetIds.length} account${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const numInput = (
    val: number,
    onChange: (v: number) => void,
    min = 0,
  ) => (
    <Input
      type="number"
      min={min}
      value={val}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 w-[72px] text-sm"
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 pb-3 border-b border-border">
        <Switch checked={local.enabled} onCheckedChange={(v) => update({ enabled: v })} />
        <Label className="text-sm font-semibold">Enable Cookie Baker</Label>
        <div className="ml-auto flex items-center gap-3">
          {saveStatus === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          {saveStatus === "saved"  && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
          <Button size="sm" variant="outline" onClick={handleRunNow} disabled={runStatus === "running"} className="gap-1.5">
            {runStatus === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {runStatus === "done"    && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
            {runStatus === "fail"    && <XCircle className="w-3.5 h-3.5 text-destructive" />}
            {runStatus === "idle"    && <Play className="w-3.5 h-3.5" />}
            Run Now
          </Button>
          <button
            className="text-xs text-blue-500 hover:text-blue-600 hover:underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!hasOtherProfiles}
            onClick={() => setCopyOpen(true)}
          >
            Copy Settings
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="w-3.5 h-3.5 text-primary" /> Execute Every
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="flex items-center gap-2">
              {numInput(local.execIntervalMin, (v) => update({ execIntervalMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.execIntervalMax, (v) => update({ execIntervalMax: v }), 1)}
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Globe className="w-3.5 h-3.5 text-primary" /> Process Websites
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="flex items-center gap-2">
              {numInput(local.sitesMin, (v) => update({ sitesMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.sitesMax, (v) => update({ sitesMax: v }), 1)}
              <span className="text-xs text-muted-foreground">per session</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="w-3.5 h-3.5 text-violet-500" /> Scrolling Time
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="flex items-center gap-2">
              {numInput(local.scrollDelayMin, (v) => update({ scrollDelayMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.scrollDelayMax, (v) => update({ scrollDelayMax: v }), 1)}
              <span className="text-xs text-muted-foreground">secs per site</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="w-3.5 h-3.5 text-blue-500" /> Visit Internal Links
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="flex items-center gap-2">
              {numInput(local.internalLinksMin, (v) => update({ internalLinksMin: v }), 0)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.internalLinksMax, (v) => update({ internalLinksMax: v }), 0)}
              <span className="text-xs text-muted-foreground">per site</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="w-3.5 h-3.5 text-emerald-500" /> Scrolling Time (internal)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="flex items-center gap-2">
              {numInput(local.internalScrollDelayMin, (v) => update({ internalScrollDelayMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.internalScrollDelayMax, (v) => update({ internalScrollDelayMax: v }), 1)}
              <span className="text-xs text-muted-foreground">secs per link</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-none !bg-transparent">
          <CardHeader className="px-0 pt-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Shuffle className="w-3.5 h-3.5 text-orange-500" /> Order
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={local.visitRandom}
                onCheckedChange={(v) => update({ visitRandom: !!v })}
              />
              <span className="text-sm">Visit websites at random</span>
            </label>
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-none !bg-transparent">
        <CardHeader className="px-0 pt-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Globe className="w-3.5 h-3.5 text-primary" /> Websites
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 space-y-2">
          <Textarea
            placeholder={"www.example.com\nwww.bbc.co.uk\nhttps://news.ycombinator.com"}
            value={local.sites}
            onChange={(e) => update({ sites: e.target.value })}
            className="font-mono text-xs min-h-[140px] resize-y"
          />
          <p className="text-xs text-muted-foreground">
            One website per line — www.example.com format. Include https:// if needed, otherwise https is assumed.
          </p>
        </CardContent>
      </Card>

      <div className="rounded-lg bg-muted/40 border border-border/50 p-3 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-foreground">How it works:</strong> When enabled, a hidden background browser visits these websites using this account's proxy and user agent, building up real browsing cookies. This can improve Instagram account creation success rates. No browser window is opened.
      </div>

      <CopySettingsDialog
        key={copyOpen ? "open" : "closed"}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title="Copy Cookie Baker Settings"
        profiles={otherProfiles}
        optionGroups={COPY_GROUPS}
        onCopy={handleCopy}
      />
    </div>
  );
}
