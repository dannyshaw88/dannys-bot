import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { UserMinus } from "lucide-react";
import { type Tool, type Profile } from "@shared/schema";

interface UnfollowToolPanelProps {
  tool: Tool;
  profile: Profile;
}

export function UnfollowToolPanel({ tool }: UnfollowToolPanelProps) {
  const updateToolMutation = useUpdateTool();

  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <div className="flex items-center gap-3 bg-card border border-border rounded-2xl px-8 py-6 shadow-sm">
        <UserMinus className="w-5 h-5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Unfollow Tool</span>
        <Switch
          checked={tool.enabled}
          onCheckedChange={(enabled) =>
            updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled })
          }
          disabled={updateToolMutation.isPending}
          className="ml-4"
        />
        <span className={`text-sm font-medium ${tool.enabled ? "text-primary" : "text-muted-foreground"}`}>
          {tool.enabled ? "ACTIVE" : "STOPPED"}
        </span>
      </div>
    </div>
  );
}
