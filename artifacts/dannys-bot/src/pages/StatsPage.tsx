import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfiles } from "@/hooks/use-profiles";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Activity, User, Heart, MessageCircle, Eye, UserPlus, UserMinus, Mail } from "lucide-react";
import { type Profile, type Tool } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";

const ALL_STAT_TYPES = [
  { key: 'follow',   label: 'Follow',      icon: <UserPlus className="w-3.5 h-3.5" />,     color: 'text-blue-500',    isTool: true  },
  { key: 'unfollow', label: 'Unfollow',    icon: <UserMinus className="w-3.5 h-3.5" />,    color: 'text-orange-500',  isTool: true  },
  { key: 'dm',       label: 'DM',          icon: <Mail className="w-3.5 h-3.5" />,          color: 'text-violet-500',  isTool: true  },
  { key: 'like',     label: 'Likes',       icon: <Heart className="w-3.5 h-3.5" />,         color: 'text-rose-500',    isTool: false },
  { key: 'comment',  label: 'Comments',    icon: <MessageCircle className="w-3.5 h-3.5" />, color: 'text-indigo-500',  isTool: false },
  { key: 'story',    label: 'Story Views', icon: <Eye className="w-3.5 h-3.5" />,           color: 'text-emerald-500', isTool: false },
];

function ProfileStatsRow({ profile }: { profile: Profile }) {
  const { data: tools } = useQuery<Tool[]>({ queryKey: [`/api/profiles/${profile.id}/tools`] });
  const { data: stats } = useQuery<any[]>({ queryKey: [`/api/profiles/${profile.id}/stats`] });
  const updateToolMutation = useUpdateTool();

  const today = new Date().toISOString().split('T')[0];
  const getStat = (type: string, date: string) =>
    stats?.find(s => s.toolType === type && s.date === date)?.count || 0;

  const handleToggle = (tool: Tool, enabled: boolean) => {
    updateToolMutation.mutate({ id: tool.id, profileId: profile.id, enabled }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/tools`] }),
    });
  };

  return (
    <tr className="hover:bg-accent/5 transition-colors border-b border-border/50">
      <td className="px-5 py-4 font-medium text-foreground whitespace-nowrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="truncate max-w-[120px]">{profile.username}</span>
        </div>
      </td>

      {ALL_STAT_TYPES.map(({ key, isTool }) => {
        const tool = isTool ? tools?.find(t => t.type === key) : undefined;
        const todayCount = getStat(key, today);
        const lifetime  = getStat(key, 'lifetime');
        return (
          <td key={key} className="px-5 py-4">
            <div className="flex flex-col gap-1">
              {isTool && tool && (
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={(val) => handleToggle(tool, val)}
                  className="scale-75 origin-left mb-0.5"
                />
              )}
              <div className="flex items-baseline gap-1 text-[13px]">
                <span className="font-bold tabular-nums text-foreground">{todayCount}</span>
                <span className="text-muted-foreground text-[11px]">/ {lifetime}</span>
              </div>
              <span className="text-[10px] text-muted-foreground">today / lifetime</span>
            </div>
          </td>
        );
      })}
    </tr>
  );
}

export function StatsPage() {
  const { data: profiles, isLoading } = useProfiles();

  return (
    <AppLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Automation Stats</h1>
        <p className="text-muted-foreground mt-1">Daily and lifetime performance metrics for all accounts.</p>
      </div>

      <Card className="desktop-card border-none shadow-sm">
        <CardHeader className="border-b border-border/50 bg-muted/5">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Tool Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs bg-muted/30 text-muted-foreground border-b border-border/50">
                <tr>
                  <th className="px-5 py-3 font-bold uppercase tracking-wide">Account</th>
                  {ALL_STAT_TYPES.map(({ key, label, icon, color }) => (
                    <th key={key} className="px-5 py-3 font-bold">
                      <div className={`flex items-center gap-1.5 ${color}`}>
                        {icon}
                        <span className="uppercase tracking-wide text-[10px]">{label}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={7} className="px-5 py-4 bg-muted/10 h-16" />
                    </tr>
                  ))
                ) : profiles?.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                      No accounts found. Add an account to see stats.
                    </td>
                  </tr>
                ) : (
                  profiles?.map(profile => (
                    <ProfileStatsRow key={profile.id} profile={profile} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </AppLayout>
  );
}
