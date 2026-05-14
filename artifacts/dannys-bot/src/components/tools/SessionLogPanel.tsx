import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Activity, Clock, ExternalLink, Hash, Users, Image,
  Heart, PlaySquare, BookOpen, Star, UserCheck, Ban, SkipForward,
  AlertCircle, MessageSquare, Bell, User, RefreshCw, Settings,
} from "lucide-react";
import { type Tool, type Profile, type SessionAction } from "@shared/schema";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";

const ACTION_META: Record<string, { label: string; icon: any; color: string }> = {
  follow:                  { label: "Followed",           icon: UserCheck,    color: "text-green-600" },
  follow_blocked:          { label: "Follow Blocked",     icon: Ban,          color: "text-red-600" },
  follow_skipped:          { label: "Follow Skipped",     icon: SkipForward,  color: "text-orange-500" },
  dedup_skip:              { label: "Skipped",             icon: SkipForward,  color: "text-slate-500" },
  like:                    { label: "Liked Post",          icon: Heart,        color: "text-pink-600" },
  view_stories:            { label: "Viewed Stories",     icon: BookOpen,     color: "text-blue-600" },
  view_reels:              { label: "Viewed Reels",       icon: PlaySquare,   color: "text-violet-600" },
  view_highlights:         { label: "Viewed Highlights",  icon: Star,         color: "text-amber-600" },
  visit_notifications:     { label: "Notifications",      icon: Bell,         color: "text-orange-600" },
  visit_own_profile:       { label: "Own Profile",        icon: User,         color: "text-indigo-600" },
  refresh_own_profile:     { label: "Refreshed Profile",  icon: RefreshCw,    color: "text-cyan-600" },
  visit_settings_activity: { label: "Settings & Activity",icon: Settings,     color: "text-gray-600" },
  check_timeline_stories:  { label: "Timeline Stories",   icon: BookOpen,     color: "text-sky-600" },
  check_dm:                { label: "Checked DMs",        icon: MessageSquare,color: "text-teal-600" },
  like_timeline_post:      { label: "Liked Timeline Post",icon: Heart,        color: "text-pink-600" },
  contact_dm:              { label: "New-Follower DM",    icon: MessageSquare,color: "text-blue-600" },
  contact_dm_blocked:      { label: "DM Blocked",         icon: Ban,          color: "text-red-600" },
};

interface SessionLogPanelProps {
  tool: Tool;
  profile: Profile;
}

export function SessionLogPanel({ tool, profile }: SessionLogPanelProps) {
  const { navigateTo } = useBrowserWindows();

  const { data: sessionActionsList, isLoading: sessionActionsLoading } = useQuery<SessionAction[]>({
    queryKey: [`/api/profiles/${tool.profileId}/session-actions`],
    refetchInterval: 3000,
    staleTime: 0,
  });

  return (
    <div className="animate-in fade-in duration-300 space-y-5">
      <div className="desktop-card overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Session Action Log</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              All automation actions performed · sorted by most recent · {sessionActionsList?.length ?? 0} entries · refreshes every 5s
            </p>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm text-left">
            <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
              <tr>
                <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Action</th>
                <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Username</th>
                <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Source</th>
                <th className="px-5 py-3 font-bold bg-muted/30 w-full">Reason / Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {sessionActionsLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={5} className="px-5 py-3.5 bg-muted/10 h-11" />
                  </tr>
                ))
              ) : !sessionActionsList || sessionActionsList.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-20 text-center text-muted-foreground">
                    <Activity className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="text-sm font-medium">No actions logged yet</p>
                    <p className="text-xs mt-1">Actions will appear here once the session tool runs.</p>
                  </td>
                </tr>
              ) : (
                sessionActionsList.map(sa => {
                  const meta = ACTION_META[sa.action] ?? { label: sa.action, icon: AlertCircle, color: "text-muted-foreground" };
                  const Icon = meta.icon;
                  const isError = sa.result === "error";
                  return (
                    <tr key={sa.id} className={`hover:bg-accent/5 transition-colors ${isError ? "bg-red-50/40" : ""}`}>
                      <td className="px-5 py-3 whitespace-nowrap text-muted-foreground text-xs font-mono">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {format(new Date(sa.timestamp), "d MMM yyyy, HH:mm:ss")}
                        </span>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold ${meta.color}`}>
                          <Icon className="w-3 h-3" />
                          {meta.label}
                          {isError && <AlertCircle className="w-3 h-3 text-red-500" />}
                        </span>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap font-medium text-foreground">
                        {sa.targetUsername ? (
                          <button
                            onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${sa.targetUsername}/`)}
                            className="flex items-center gap-1.5 text-primary hover:text-primary/70 hover:underline transition-colors group"
                            title={`Open @${sa.targetUsername} in browser`}
                          >
                            @{sa.targetUsername}
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground italic">
                            <User className="w-3 h-3 shrink-0" />@{profile.username}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {sa.sourceType === "post" && sa.sourceValue ? (
                          <button
                            onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/p/${sa.sourceValue}/`)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-pink-50 border border-pink-200 text-pink-700 text-[11px] font-medium hover:bg-pink-100 transition-colors group"
                            title={`Open post in browser`}
                          >
                            <Image className="w-3 h-3" />
                            View Post
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        ) : sa.sourceValue ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-medium">
                            {sa.sourceType === 'hashtag' ? <Hash className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                            {sa.sourceValue}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs"> </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground leading-relaxed">
                        {sa.detail || " "}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
