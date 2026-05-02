import { useState, useEffect, useRef } from "react";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserMinus, Timer, Users, Clock } from "lucide-react";
import { type Tool, type Profile } from "@shared/schema";

interface UnfollowToolPanelProps {
  tool: Tool;
  profile: Profile;
}

export function UnfollowToolPanel({ tool }: UnfollowToolPanelProps) {
  const updateToolMutation = useUpdateTool();

  const [settings, setSettings] = useState(() => {
    const def = {
      delayMin: 5,
      delayMax: 15,
      processMin: 5,
      processMax: 15,
      delayAfterUnfollowMin: 5,
      delayAfterUnfollowMax: 15,
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

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
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

      {row(<Timer className="w-4 h-4" />, "Wait between executions", "minutes", "delayMin", "delayMax", 1)}
      {row(<Users className="w-4 h-4" />, "Process users", "users", "processMin", "processMax", 1)}
      {row(<Clock className="w-4 h-4" />, "Delay between each", "seconds", "delayAfterUnfollowMin", "delayAfterUnfollowMax", 1)}
    </div>
  );
}
