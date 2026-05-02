import { useQuery } from "@tanstack/react-query";
import { useProfiles } from "@/hooks/use-profiles";
import { Bell } from "lucide-react";

export function LiveActivityTicker() {
  const { data: profiles } = useProfiles();

  const { data: liveApiCalls } = useQuery<any[]>({
    queryKey: ["/api/instagram-api-calls"],
    refetchInterval: 4000,
    select: (data) => data?.slice(0, 1),
  });

  const latestCall = liveApiCalls?.[0];
  const latestUsername = latestCall
    ? (profiles?.find(p => p.id === latestCall.profileId)?.accountLabel
        || profiles?.find(p => p.id === latestCall.profileId)?.username
        || `#${latestCall.profileId}`)
    : null;

  if (!latestCall || !latestUsername) return null;

  return (
    <div className="border-b border-border/50 bg-muted/30 px-6 py-1.5 flex items-center gap-2 w-full overflow-hidden">
      <Bell className="w-3 h-3 text-primary shrink-0" />
      <span
        key={latestCall.id}
        className="animate-in fade-in slide-in-from-left-2 duration-300 flex items-center gap-1 text-xs text-muted-foreground overflow-hidden min-w-0 flex-1"
      >
        <span className="font-semibold text-foreground shrink-0">{latestCall.operationName}</span>
        <span className="text-muted-foreground/60 mx-0.5 shrink-0">—</span>
        <span className="text-primary font-medium shrink-0">{latestUsername}</span>
        {latestCall.message && (
          <span className="text-muted-foreground truncate"> {latestCall.message}</span>
        )}
      </span>
    </div>
  );
}
