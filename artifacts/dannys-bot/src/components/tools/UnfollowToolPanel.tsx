import { useState, useEffect, useRef } from "react";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { UserMinus, Timer, Users, Clock, CalendarDays, Repeat2, Copy, List, Upload, Loader2, Download, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";

interface UnfollowToolPanelProps {
  tool: Tool;
  profile: Profile;
}

const UNFOLLOW_COPY_GROUPS: CopyOptionGroup[] = [
  { label: "General", options: [
    { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
    { key: "randomiseTiming", label: "Randomise timing", description: "Spread each account's session start times across the Wait Between Sessions window so they don't all fire simultaneously" },
  ]},
  { label: "Settings", options: [
    { key: "uf_settings", label: "Unfollow Settings", description: "Timing, limits and age filters for unfollow actions", subOptions: [
      { key: "uf_age",    label: "Min follow age (days)",                    settingKeys: ["minFollowAgeDays"] },
      { key: "uf_wait",   label: "Wait between sessions (min / max mins)",   settingKeys: ["delayMin","delayMax"] },
      { key: "uf_count",  label: "Users per session (min / max)",            settingKeys: ["processMin","processMax"] },
      { key: "uf_delay",  label: "Delay after each unfollow (min / max secs)", settingKeys: ["delayAfterUnfollowMin","delayAfterUnfollowMax"] },
    ]},
  ]},
  { label: "Auto Follow / Unfollow", options: [
    { key: "uf_autoFU", label: "Auto Follow / Unfollow", description: "Automatic switching between unfollow and follow tools", subOptions: [
      { key: "uf_autoEnabled",    label: "Enabled",                                        settingKeys: ["autoFollowUnfollowEnabled"] },
      { key: "uf_autoStopAt",     label: "Stop unfollow at followings count (min / max)", settingKeys: ["autoStopUnfollowAtFollowingsMin","autoStopUnfollowAtFollowingsMax"] },
      { key: "uf_autoStartAfter", label: "Start follow after (min / max mins)",           settingKeys: ["autoStartFollowAfterMin","autoStartFollowAfterMax"] },
    ]},
  ]},
];

export function UnfollowToolPanel({ tool, profile }: UnfollowToolPanelProps) {
  const updateToolMutation = useUpdateTool();  // settings saves
  const toggleMutation     = useUpdateTool();  // enable/disable toggle separate so it's never blocked
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();
  const [copyOpen, setCopyOpen] = useState(false);
  const [fetchingFollowings, setFetchingFollowings] = useState(false);
  const [hikerFetchMin, setHikerFetchMin] = useState(50);
  const [hikerFetchMax, setHikerFetchMax] = useState(200);
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const otherProfiles = allProfiles.filter(p => p.id !== profile.id && !p.locked);
  const hasOtherProfiles = allProfiles.some(p => p.id !== profile.id);

  const [settings, setSettings] = useState(() => {
    const def = {
      randomiseTiming: false,
      delayMin: 5,
      delayMax: 15,
      processMin: 5,
      processMax: 15,
      delayAfterUnfollowMin: 5,
      delayAfterUnfollowMax: 15,
      minFollowAgeDays: 3,
      autoFollowUnfollowEnabled: false,
      autoStopUnfollowAtFollowingsMin: 7000,
      autoStopUnfollowAtFollowingsMax: 7000,
      autoStartFollowAfterMin: 60,
      autoStartFollowAfterMax: 135,
      unfollowTargetListEnabled: false,
      unfollowTargetList: "",
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [settings]);

  const handleCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled = expandedKeys.includes("startStop");
    const keysToSend  = expandedKeys.filter(k => k !== "startStop");

    const willEnable    = copyEnabled && tool.enabled;
    const willRandomise = expandedKeys.includes("randomiseTiming") && willEnable;
    let staggerOffsets: number[] | undefined;
    if (willRandomise && targetIds.length > 1) {
      const delayMax = (settings as any).delayMax ?? 15;
      staggerOffsets = targetIds.map((_, i) =>
        Math.round((i * delayMax) / Math.max(1, targetIds.length - 1))
      );
    }

    await copyToolSettingsToProfiles(
      settings as Record<string, unknown>,
      "unfollow",
      targetIds,
      keysToSend,
      copyEnabled ? tool.enabled : undefined,
      staggerOffsets,
    );
    toast({ title: `Settings copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}` });
  };

  const num = (key: string, min = 0) => (
    <Input
      type="number"
      min={min}
      className="w-20 h-8 text-sm"
      value={(settings as any)[key] ?? 0}
      onChange={(e) => setSettings(s => ({ ...s, [key]: Math.max(min, Number(e.target.value)) }))}
    />
  );

  const row = (
    icon: React.ReactNode,
    label: string,
    unit: string,
    minKey: string,
    maxKey: string,
    minVal = 0,
  ) => (
    <div className="border border-border rounded-xl p-4 flex items-center gap-4">
      <div className="flex items-center gap-2 text-muted-foreground w-44 shrink-0">
        {icon}
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2 flex-1">
        <Label className="text-xs text-muted-foreground">Min</Label>
        {num(minKey, minVal)}
        <Label className="text-xs text-muted-foreground ml-2">Max</Label>
        {num(maxKey, minVal)}
        <span className="text-xs text-muted-foreground ml-1">{unit}</span>
      </div>
    </div>
  );

  const autoEnabled = !!(settings as any).autoFollowUnfollowEnabled;

  const s = settings as any;
  const avgDelay     = ((s.delayMin ?? 5) + (s.delayMax ?? 15)) / 2;
  const avgProcess   = ((s.processMin ?? 5) + (s.processMax ?? 15)) / 2;
  const avgMaxPerDay = ((s.maxPerDayMin ?? 0) + (s.maxPerDayMax ?? 0)) / 2;
  const perHour      = avgDelay > 0 ? Math.round((avgProcess / avgDelay) * 60) : 0;
  const perDayRaw    = perHour * 24;
  const perDay       = avgMaxPerDay > 0 ? Math.min(perDayRaw, avgMaxPerDay) : perDayRaw;

  const nextUnfollowStatus: { label: string; executing: boolean } | null = (() => {
    if (!tool.enabled) return null;
    const nextAt = engineStatus?.nextUnfollowAt ?? 0;
    if (!nextAt) return null;
    if (nextAt <= Date.now()) return { label: "Executing", executing: true };
    return { label: format(new Date(nextAt), "HH:mm:ss"), executing: false };
  })();

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Master toggle */}
      <div className="border border-border rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <UserMinus className="w-4 h-4 text-muted-foreground" />
          <h4 className="font-semibold text-sm">Unfollow Tool</h4>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Switch
            checked={tool.enabled}
            onCheckedChange={(enabled) =>
              toggleMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled })
            }
            disabled={toggleMutation.isPending}
          />
          <span className={`text-sm font-medium ${tool.enabled ? "text-primary" : "text-muted-foreground"}`}>
            {tool.enabled ? "ACTIVE" : "STOPPED"}
          </span>
          <button
            onClick={() => setCopyOpen(true)}
            className="ml-1 text-xs text-blue-500 hover:text-blue-600 hover:underline underline-offset-2 cursor-pointer"
          >
            Copy Settings
          </button>
          {nextUnfollowStatus && (
            <span className="flex items-center gap-1 text-[11px] font-bold ml-2" style={{ color: nextUnfollowStatus.executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
              <Clock className="w-3 h-3 shrink-0" />
              {nextUnfollowStatus.executing
                ? <span>Executing</span>
                : <span>Scheduled for: <span className="text-foreground">{nextUnfollowStatus.label}</span></span>
              }
            </span>
          )}
          {tool.enabled && perHour > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
              {perHour}/hr · {perDay}/day
            </span>
          )}
        </div>
      </div>

      {/* Unfollow after X days */}
      <div className="border border-border rounded-xl p-4 flex items-center gap-4">
        <div className="flex items-center gap-2 text-muted-foreground w-44 shrink-0">
          <CalendarDays className="w-4 h-4" />
          <span className="text-sm font-medium text-foreground">Unfollow after</span>
        </div>
        <div className="flex items-center gap-2">
          {num("minFollowAgeDays", 1)}
          <span className="text-xs text-muted-foreground">days since follow</span>
        </div>
      </div>

      <div className="border border-border rounded-xl p-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Wait Between Executions (min)</h4>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                {num("delayMin", 1)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                {num("delayMax", 1)}
              </div>
            </div>
          </div>
          <div className="w-px self-stretch bg-border/50 hidden sm:block" />
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Process Users Per Session</h4>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                {num("processMin", 1)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                {num("processMax", 1)}
              </div>
            </div>
          </div>
          <div className="w-px self-stretch bg-border/50 hidden sm:block" />
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Delay Between Each (sec)</h4>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                {num("delayAfterUnfollowMin", 1)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                {num("delayAfterUnfollowMax", 1)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Custom Unfollow Target List */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="unfollowTargetListEnabled"
            checked={!!(settings as any).unfollowTargetListEnabled}
            onChange={(e) => setSettings(s => ({ ...s, unfollowTargetListEnabled: e.target.checked }))}
            className="w-3.5 h-3.5 accent-primary cursor-pointer"
          />
          <label htmlFor="unfollowTargetListEnabled" className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
            <List className="w-3.5 h-3.5" />
            Unfollow Target List (Custom Users)
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground pl-1">
          When enabled, only users in this list will be unfollowed (ignoring the followed-users database). Usernames, one per line or comma-separated.
        </p>
        <div className={`space-y-3 transition-opacity ${!(settings as any).unfollowTargetListEnabled ? "opacity-40 pointer-events-none" : ""}`}>
          <textarea
            rows={6}
            className="w-full text-xs border border-border rounded-lg p-3 bg-background resize-y focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            placeholder={"@user1\n@user2\nuser3"}
            value={(settings as any).unfollowTargetList ?? ""}
            onChange={(e) => setSettings(s => ({ ...s, unfollowTargetList: e.target.value }))}
          />
          <div className="flex flex-wrap items-center gap-2">
            {/* Import from file */}
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".txt,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const text = ev.target?.result as string ?? "";
                    const existing = (settings as any).unfollowTargetList ?? "";
                    const combined = existing ? existing + "\n" + text.trim() : text.trim();
                    setSettings(s => ({ ...s, unfollowTargetList: combined }));
                    toast({ title: "Imported from file" });
                  };
                  reader.readAsText(file);
                  e.target.value = "";
                }}
              />
              <Button variant="outline" size="sm" className="gap-1.5 pointer-events-none" asChild>
                <span>
                  <Upload className="w-3.5 h-3.5" />
                  Import from File
                </span>
              </Button>
            </label>

            {/* Import from HikerAPI */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Get</span>
              <Input
                type="number" min={1} max={2000}
                className="w-16 h-7 text-xs"
                value={hikerFetchMin}
                onChange={(e) => setHikerFetchMin(Math.max(1, Number(e.target.value)))}
              />
              <span className="text-xs text-muted-foreground">–</span>
              <Input
                type="number" min={1} max={2000}
                className="w-16 h-7 text-xs"
                value={hikerFetchMax}
                onChange={(e) => setHikerFetchMax(Math.max(1, Number(e.target.value)))}
              />
              <Button
                variant="outline" size="sm"
                className="gap-1.5 shrink-0"
                disabled={fetchingFollowings}
                onClick={async () => {
                  setFetchingFollowings(true);
                  try {
                    const res = await fetch(`/api/profiles/${profile.id}/fetch-followings`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ fetchMin: hikerFetchMin, fetchMax: hikerFetchMax }),
                    });
                    const data = await res.json();
                    if (data.ok && Array.isArray(data.usernames)) {
                      const existing = (settings as any).unfollowTargetList ?? "";
                      const combined = existing ? existing + "\n" + data.usernames.join("\n") : data.usernames.join("\n");
                      // Merge pks into the pks map (used by engine to avoid Instagram API lookups)
                      let pksMap: Record<string, string> = {};
                      try { pksMap = JSON.parse((settings as any).unfollowTargetListPks ?? "{}"); } catch {}
                      if (Array.isArray(data.entries)) {
                        for (const e of data.entries) {
                          if (e.username && e.pk) pksMap[e.username.toLowerCase()] = e.pk;
                        }
                      }
                      setSettings(s => ({ ...s, unfollowTargetList: combined, unfollowTargetListPks: JSON.stringify(pksMap) }));
                      toast({ title: `Imported ${data.count} followings from HikerAPI` });
                    } else {
                      toast({ title: "Import failed", description: data.error, variant: "destructive" });
                    }
                  } catch {
                    toast({ title: "Import failed", variant: "destructive" });
                  } finally {
                    setFetchingFollowings(false);
                  }
                }}
              >
                {fetchingFollowings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Import from HikerAPI
              </Button>
            </div>

            {/* Clear */}
            <Button
              variant="ghost" size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setSettings(s => ({ ...s, unfollowTargetList: "", unfollowTargetListPks: "{}" }))}
            >
              Clear
            </Button>
          </div>
          {(settings as any).unfollowTargetList && (
            <p className="text-[11px] text-muted-foreground">
              {((settings as any).unfollowTargetList as string).split(/[\n,]+/).filter((u: string) => u.trim()).length} users in list
            </p>
          )}
        </div>
      </div>

      {/* Enable automatic follow/unfollow */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoFollowUnfollowEnabled"
            checked={autoEnabled}
            onChange={(e) => setSettings(s => ({ ...s, autoFollowUnfollowEnabled: e.target.checked }))}
            className="w-3.5 h-3.5 accent-primary cursor-pointer"
          />
          <label htmlFor="autoFollowUnfollowEnabled" className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
            <Repeat2 className="w-3.5 h-3.5" />
            Enable Automatic Follow / Unfollow
          </label>
        </div>
        <div className={`space-y-3 pl-1 transition-opacity ${!autoEnabled ? "opacity-40 pointer-events-none" : ""}`}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="space-y-1.5">
              <h4 className="text-xs text-muted-foreground">Stop unfollow tool when having less than followings</h4>
              <div className="flex items-center gap-1.5">
                <Input type="number" min="0" className="w-20 h-7 text-xs"
                  value={(settings as any).autoStopUnfollowAtFollowingsMin ?? 7000}
                  onChange={(e) => setSettings(s => ({ ...s, autoStopUnfollowAtFollowingsMin: Number(e.target.value) }))}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <Input type="number" min="0" className="w-20 h-7 text-xs"
                  value={(settings as any).autoStopUnfollowAtFollowingsMax ?? 7000}
                  onChange={(e) => setSettings(s => ({ ...s, autoStopUnfollowAtFollowingsMax: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="w-px self-stretch bg-border/50 hidden sm:block" />
            <div className="space-y-1.5">
              <h4 className="text-xs text-muted-foreground">Start follow tool after (minutes)</h4>
              <div className="flex items-center gap-1.5">
                <Input type="number" min="0" className="w-20 h-7 text-xs"
                  value={(settings as any).autoStartFollowAfterMin ?? 60}
                  onChange={(e) => setSettings(s => ({ ...s, autoStartFollowAfterMin: Number(e.target.value) }))}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <Input type="number" min="0" className="w-20 h-7 text-xs"
                  value={(settings as any).autoStartFollowAfterMax ?? 135}
                  onChange={(e) => setSettings(s => ({ ...s, autoStartFollowAfterMax: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            When your followings count drops below the target, the unfollow tool stops and the follow tool starts automatically after the specified delay. Requires profile sync to stay accurate.
          </p>
        </div>
      </div>

      <CopySettingsDialog
        key={copyOpen ? "open" : "closed"}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title="Copy Unfollow Tool Settings"
        profiles={otherProfiles}
        optionGroups={UNFOLLOW_COPY_GROUPS}
        onCopy={handleCopy}
      />
    </div>
  );
}
