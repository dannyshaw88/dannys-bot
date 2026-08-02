import { useQuery } from "@tanstack/react-query";
import { useProfiles } from "@/hooks/use-profiles";
import { Activity } from "lucide-react";
import { normalizeActivityDetail } from "./activityDetailUtils";

interface RecentActivity {
  id: number;
  profileId: number;
  toolId: number;
  action: string;
  targetUsername: string;
  sourceValue: string;
  sourceType: string;
  result: string;
  detail: string;
  timestamp: string;
}

function getToolLabel(action: string, detail: string): string {
  switch (action) {
    case "follow":
    case "follow_blocked":
    case "follow_skipped":
    case "dedup_skip":
    case "filter_skip":
      return "Follow Tool";
    case "unfollow":
    case "unfollow_blocked":
      return "Unfollow Tool";
    case "like":
    case "view_story":
    case "view_stories":
    case "view_reels":
    case "view_highlights":
    case "view_profile":
    case "viewProfile":
    case "repost":
    case "save_media":
    case "saveMedia":
      return "Human Session";
    case "contact_dm":
    case "contact_dm_blocked":
      return "Contact Tool";
    case "send_dm":
    case "sendDm":
      return "DM Tool";
    case "tool_start":
    case "tool_complete": {
      if (detail.includes("Follow Tool"))   return "Follow Tool";
      if (detail.includes("Unfollow Tool")) return "Unfollow Tool";
      if (detail.includes("Human Session")) return "Human Session";
      if (detail.includes("DM Tool"))       return "DM Tool";
      if (detail.includes("Contact Tool"))  return "Contact Tool";
      return "Tool";
    }
    default:
      return "";
  }
}

function formatActionPart(action: string, target: string, detail: string): string {
  switch (action) {
    case "tool_start":
    case "tool_complete":   return detail || (action === "tool_start" ? "Session starting…" : "Session complete");
    case "follow":          return `followed ${target}`;
    case "unfollow":        return `unfollowed ${target}`;
    case "dedup_skip":      return `skipped ${target}`;
    case "filter_skip":     return `skipped ${target}`;
    case "follow_skipped":  return `skipped ${target}`;
    case "follow_blocked":  return `blocked${target ? ` @${target.replace(/^@/, "")}` : ""}: ${detail || "blocked"}`;
    case "like":            return `liked post by ${target}`;
    case "view_story":
    case "view_stories":
    case "viewStory":       return `viewed story${target ? ` of ${target}` : ""}`;
    case "view_reels":      return `viewed reel${target ? ` by ${target}` : ""}`;
    case "view_highlights": return `viewed highlights${target ? ` of ${target}` : ""}`;
    case "contact_dm":      return `sent DM to ${target}`;
    case "contact_dm_blocked": return `DM blocked`;
    case "send_dm":
    case "sendDm":          return `sent DM to ${target}`;
    case "view_profile":
    case "viewProfile":     return `visited profile${target ? ` of ${target}` : ""}`;
    case "verified":        return `session verified`;
    case "verification_failed": return `verification failed`;
    case "repost":          return `reposted${target ? ` from ${target}` : ""}`;
    case "save_media":
    case "saveMedia":       return `saved post${target ? ` by ${target}` : ""}`;
    case "unfollow_blocked": return `unfollow blocked (skipped)`;
    default:
      return detail || (target ? `${action.replace(/_/g, " ")} ${target}` : action.replace(/_/g, " "));
  }
}

function buildLabel(
  latest: RecentActivity,
  profiles: { id: number; accountLabel?: string | null; username: string }[] | undefined,
): string {
  const detail = normalizeActivityDetail(latest.detail);
  // Phone farm event — profileId may be 0 if the slot has no linked EB profile
  if (latest.sourceType === "phone") {
    const account = latest.targetUsername ? `@${latest.targetUsername}` : "Phone Farm";
    const actionPart = formatActionPart(latest.action, latest.targetUsername ? `@${latest.targetUsername}` : "", detail);
    return `${account} | Phone Farm: ${actionPart}`;
  }
  // Regular IG-profile event
  const profile = profiles?.find(p => p.id === latest.profileId);
  const accountName = profile?.accountLabel || profile?.username || `#${latest.profileId}`;
  const toolLabel = getToolLabel(latest.action, detail);
  const actionPart = formatActionPart(latest.action, latest.targetUsername ? `@${latest.targetUsername}` : "", detail);
  return toolLabel
    ? `@${accountName} | ${toolLabel}: ${actionPart}`
    : `@${accountName} ${actionPart}`;
}

export function LiveActivityTicker() {
  const { data: profiles } = useProfiles();

  const { data: activities } = useQuery<RecentActivity[]>({
    queryKey: ["/api/recent-activity"],
    refetchInterval: 2000,
  });

  const latest = activities?.[0];

  // Real activity = anything that isn't the server-startup sentinel
  const isStartupSentinel = latest?.profileId === 0 && latest?.action === "server_started";
  const hasRealActivity = !!latest && !isStartupSentinel;

  const label = hasRealActivity ? buildLabel(latest!, profiles) : null;

  const ERROR_ACTIONS = new Set([
    "follow_blocked",
    "contact_dm_blocked",
    "unfollow_blocked",
    "verification_failed",
  ]);
  const isError = hasRealActivity && !!(
    ERROR_ACTIONS.has(latest!.action) ||
    latest!.result === "error" ||
    latest!.result === "blocked"
  );

  return (
    <div className="border-b border-border/50 bg-muted/30 px-6 py-1.5 flex items-center justify-center gap-2 w-full overflow-hidden shrink-0">
      <Activity className={`w-3 h-3 shrink-0 ${isError ? "text-red-500" : "text-primary"}`} />
      <span className={`text-xs overflow-hidden min-w-0 truncate ${isError ? "text-red-500" : "text-muted-foreground"}`}>
        {label ?? "Aura Farming booted up waiting for activity"}
      </span>
    </div>
  );
}
