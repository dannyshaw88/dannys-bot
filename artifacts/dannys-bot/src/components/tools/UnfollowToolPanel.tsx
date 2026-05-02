import { useState, useEffect, useRef } from "react";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { UserMinus, Timer, Users, Clock, CalendarDays, Repeat2, Copy } from "lucide-react";
import { type Tool, type Profile } from "@shared/schema";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";

interface UnfollowToolPanelProps {
  tool: Tool;
  profile: Profile;
}

const UNFOLLOW_KEY_MAP: Record<string, string[]> = {
  // Settings
  timing:            ["delayMin","delayMax"],
  process:           ["processMin","processMax"],
  delay:             ["delayAfterUnfollowMin","delayAfterUnfollowMax"],
  age:               ["minFollowAgeDays"],
  // Auto follow/unfollow
  autoEnabled:       ["autoFollowUnfollowEnabled"],
  autoStopAt:        ["autoStopUnfollowAtFollowingsMin","autoStopUnfollowAtFollowingsMax"],
  autoStartAfter:    ["autoStartFollowAfterMin","autoStartFollowAfterMax"],
  // startStop is special — handled in handler
};

const UNFOLLOW_COPY_GROUPS: CopyOptionGroup[] = [
  { label: "General", options: [
    { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
  ]},
  { label: "Settings", options: [
    { key: "age",     label: "Unfollow After (days)",    description: "Minimum days since follow before unfollowing" },
    { key: "timing",  label: "Wait Between Executions",  description: "Min/max minutes between sessions" },
    { key: "process", label: "Process Users",            description: "Min/max users to unfollow per session" },
    { key: "delay",   label: "Delay Between Each",       description: "Min/max seconds between each unfollow action" },
  ]},
  { label: "Auto Follow / Unfollow", options: [
    { key: "autoEnabled",    label: "Auto Follow/Unfollow Enabled", description: "Toggle automatic switching between unfollow and follow" },
    { key: "autoStopAt",     label: "Stop at Followings Count",     description: "Target followings count to stop the unfollow tool" },
    { key: "autoStartAfter", label: "Start Follow After (min)",     description: "Minutes to wait before enabling the follow tool" },
  ]},
];

export function UnfollowToolPanel({ tool, profile }: UnfollowToolPanelProps) {
  const updateToolMutation = useUpdateTool();
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();
  const [copyOpen, setCopyOpen] = useState(false);
  const otherProfiles = allProfiles.filter(p => p.id !== profile.id);

  const [settings, setSettings] = useState(() => {
    const def = {
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

  const handleCopy = async (targetIds: number[], selectedKeys: Set<string>) => {
    const copyEnabled = selectedKeys.has("startStop");
    const keysToSend = [...selectedKeys].filter(k => k !== "startStop").flatMap(k => UNFOLLOW_KEY_MAP[k] ?? []);
    await copyToolSettingsToProfiles(
      settings as Record<string, unknown>,
      "unfollow",
      targetIds,
      keysToSend,
      copyEnabled ? tool.enabled : undefined,
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

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Master toggle */}
      <div className="border border-border rounded-xl p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <UserMinus className="w-4 h-4 text-muted-foreground" />
          <h4 className="font-semibold text-sm">Unfollow Tool</h4>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={tool.enabled}
            onCheckedChange={(enabled) =>
              updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled })
            }
            disabled={updateToolMutation.isPending}
          />
          <span className={`text-sm font-medium ${tool.enabled ? "text-primary" : "text-muted-foreground"}`}>
            {tool.enabled ? "ACTIVE" : "STOPPED"}
          </span>
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

      {row(<Timer className="w-4 h-4" />, "Wait between executions", "minutes", "delayMin", "delayMax", 1)}
      {row(<Users className="w-4 h-4" />, "Process users", "users", "processMin", "processMax", 1)}
      {row(<Clock className="w-4 h-4" />, "Delay between each", "seconds", "delayAfterUnfollowMin", "delayAfterUnfollowMax", 1)}

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

      {/* Copy Settings */}
      <div className="pt-2">
        <Button
          variant="outline"
          className="w-full gap-2"
          disabled={otherProfiles.length === 0}
          onClick={() => setCopyOpen(true)}
        >
          <Copy className="w-4 h-4" /> Copy Unfollow Tool Settings to Other Profiles
        </Button>
        {otherProfiles.length === 0 && (
          <p className="text-xs text-center text-muted-foreground mt-2">Add more profiles to enable copying settings.</p>
        )}
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
