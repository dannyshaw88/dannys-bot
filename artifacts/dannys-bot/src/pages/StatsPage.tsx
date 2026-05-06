import { useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfiles } from "@/hooks/use-profiles";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Activity, User, Heart, MessageCircle, Eye, UserPlus, UserMinus, Mail,
  Settings2, ChevronDown, ChevronUp, Bot,
} from "lucide-react";
import { type Profile, type Tool } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";

type StatKey = "follow" | "unfollow" | "dm" | "like" | "comment" | "story" | "human_session" | "tools_ran";

const ALL_STAT_TYPES: { key: StatKey; label: string; icon: React.ReactNode; color: string; isTool: boolean }[] = [
  { key: "follow",        label: "Follow",        icon: <UserPlus className="w-3.5 h-3.5" />,     color: "text-blue-500",    isTool: true  },
  { key: "unfollow",      label: "Unfollow",      icon: <UserMinus className="w-3.5 h-3.5" />,    color: "text-orange-500",  isTool: true  },
  { key: "dm",            label: "DMs Sent",      icon: <Mail className="w-3.5 h-3.5" />,          color: "text-violet-500",  isTool: true  },
  { key: "like",          label: "Likes",         icon: <Heart className="w-3.5 h-3.5" />,         color: "text-rose-500",    isTool: false },
  { key: "comment",       label: "Comments",      icon: <MessageCircle className="w-3.5 h-3.5" />, color: "text-indigo-500",  isTool: false },
  { key: "story",         label: "Story Views",   icon: <Eye className="w-3.5 h-3.5" />,           color: "text-emerald-500", isTool: false },
  { key: "human_session", label: "Human Session", icon: <Bot className="w-3.5 h-3.5" />,           color: "text-cyan-500",    isTool: false },
  { key: "tools_ran",     label: "Tools Ran",     icon: <Activity className="w-3.5 h-3.5" />,      color: "text-amber-500",   isTool: false },
];

const DEFAULT_COL_WIDTHS: Record<StatKey | "account", number> = {
  account: 160, follow: 110, unfollow: 110, dm: 110,
  like: 100, comment: 110, story: 120, human_session: 130, tools_ran: 110,
};

const DEFAULT_VISIBLE: Record<StatKey, boolean> = {
  follow: true, unfollow: true, dm: true, like: true,
  comment: true, story: true, human_session: true, tools_ran: true,
};

function ProfileStatsRow({
  profile,
  visibleCols,
  colWidths,
}: {
  profile: Profile;
  visibleCols: Record<StatKey, boolean>;
  colWidths: Record<StatKey | "account", number>;
}) {
  const { data: tools } = useQuery<Tool[]>({ queryKey: [`/api/profiles/${profile.id}/tools`] });
  const { data: stats } = useQuery<any[]>({ queryKey: [`/api/profiles/${profile.id}/stats`] });
  const updateToolMutation = useUpdateTool();

  const today = new Date().toISOString().split("T")[0];
  const getStat = (type: string, date: string) =>
    stats?.find((s: any) => s.toolType === type && s.date === date)?.count || 0;

  const handleToggle = (tool: Tool, enabled: boolean) => {
    updateToolMutation.mutate({ id: tool.id, profileId: profile.id, enabled }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/tools`] }),
    });
  };

  const visibleTypes = ALL_STAT_TYPES.filter(({ key }) => visibleCols[key]);

  return (
    <tr className="hover:bg-accent/5 transition-colors border-b border-border/50">
      <td style={{ width: colWidths.account }} className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="truncate">{profile.username}</span>
        </div>
      </td>
      {visibleTypes.map(({ key, isTool }) => {
        const tool = isTool ? tools?.find((t: Tool) => t.type === key) : undefined;
        const todayCount = getStat(key, today);
        const lifetime = getStat(key, "lifetime");
        return (
          <td key={key} style={{ width: colWidths[key] }} className="px-4 py-3">
            <div className="flex items-center gap-2">
              {isTool && tool && (
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={(val) => handleToggle(tool, val)}
                  className="scale-75 origin-left"
                />
              )}
              <div className="flex items-baseline gap-1 text-[13px]">
                <span className="font-bold tabular-nums text-foreground">{todayCount}</span>
                <span className="text-muted-foreground text-[11px]">/ {lifetime}</span>
              </div>
            </div>
          </td>
        );
      })}
    </tr>
  );
}

export function StatsPage() {
  const { data: profiles, isLoading } = useProfiles();

  const [colWidths, setColWidths] = useState<Record<StatKey | "account", number>>(() => {
    try {
      const s = localStorage.getItem("stats_col_widths_px");
      return s ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_COL_WIDTHS;
    } catch { return DEFAULT_COL_WIDTHS; }
  });

  const [visibleCols, setVisibleCols] = useState<Record<StatKey, boolean>>(() => {
    try {
      const s = localStorage.getItem("stats_visible_cols");
      return s ? { ...DEFAULT_VISIBLE, ...JSON.parse(s) } : DEFAULT_VISIBLE;
    } catch { return DEFAULT_VISIBLE; }
  });

  const [manageColsOpen, setManageColsOpen] = useState(false);
  const manageColsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (manageColsRef.current && !manageColsRef.current.contains(e.target as Node)) {
        setManageColsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggleVisible = (key: StatKey, val: boolean) => {
    const next = { ...visibleCols, [key]: val };
    setVisibleCols(next);
    localStorage.setItem("stats_visible_cols", JSON.stringify(next));
  };

  const updateWidth = (key: StatKey | "account", delta: number) => {
    const v = Math.max(60, Math.min(400, colWidths[key] + delta));
    const next = { ...colWidths, [key]: v };
    setColWidths(next);
    localStorage.setItem("stats_col_widths_px", JSON.stringify(next));
  };

  const visibleTypes = ALL_STAT_TYPES.filter(({ key }) => visibleCols[key]);
  const colCount = 1 + visibleTypes.length;

  const colGroups: [string, string][] = [
    ["account", "Account"],
    ...ALL_STAT_TYPES.map(({ key, label }) => [key, label] as [string, string]),
  ];

  return (
    <AppLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Automation Stats</h1>
        <p className="text-muted-foreground mt-1">Daily and lifetime performance metrics for all accounts.</p>
      </div>

      <Card className="desktop-card border-none shadow-sm flex flex-col">
        <CardHeader className="border-b border-border/50 bg-muted/5">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Tool Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 flex flex-col">
          <div className="overflow-x-auto">
            <table className="text-sm text-left" style={{ tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                <col style={{ width: colWidths.account }} />
                {visibleTypes.map(({ key }) => <col key={key} style={{ width: colWidths[key] }} />)}
              </colgroup>
              <thead className="text-xs bg-muted/30 text-muted-foreground border-b border-border/50">
                <tr>
                  <th className="px-4 py-3 font-bold uppercase tracking-wide">Account</th>
                  {visibleTypes.map(({ key, label, icon, color }) => (
                    <th key={key} className="px-4 py-3 font-bold">
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
                      <td colSpan={colCount} className="px-5 py-4 bg-muted/10 h-16" />
                    </tr>
                  ))
                ) : profiles?.length === 0 ? (
                  <tr>
                    <td colSpan={colCount} className="px-5 py-12 text-center text-muted-foreground">
                      No accounts found. Add an account to see stats.
                    </td>
                  </tr>
                ) : (
                  profiles?.map(profile => (
                    <ProfileStatsRow
                      key={profile.id}
                      profile={profile}
                      visibleCols={visibleCols}
                      colWidths={colWidths}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* ── Bottom toolbar ─────────────────────────────────────────────── */}
          <div className="border-t border-border/50 bg-muted/5 px-4 py-2 flex items-center shrink-0">
            <div ref={manageColsRef} className="relative">
              <button
                onClick={() => setManageColsOpen(o => !o)}
                className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors"
              >
                <Settings2 className="w-3.5 h-3.5" /> Columns
              </button>
              {manageColsOpen && (
                <div className="absolute right-0 bottom-full mb-2 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-72">
                  {/* Show / hide columns */}
                  <p className="text-[11px] font-bold uppercase tracking-wide mb-2 text-muted-foreground">Show / Hide Columns</p>
                  <div className="space-y-1.5 mb-3">
                    {ALL_STAT_TYPES.map(({ key, label, icon, color }) => (
                      <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                        <Checkbox
                          checked={visibleCols[key]}
                          onCheckedChange={(val) => toggleVisible(key, !!val)}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className={`flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide ${color}`}>
                          {icon} {label}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="border-t border-border/50 my-3" />

                  {/* Column widths */}
                  <p className="text-[11px] font-bold uppercase tracking-wide mb-2 text-muted-foreground">Column Widths (px)</p>
                  {colGroups.map(([key, label]) => (
                    <div key={key} className="flex items-center gap-1.5 mb-2">
                      <label className="text-xs w-24 text-muted-foreground shrink-0">{label}</label>
                      <button
                        onClick={() => updateWidth(key as StatKey | "account", -10)}
                        className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      <input
                        type="number"
                        min={60}
                        max={400}
                        value={colWidths[key as StatKey | "account"]}
                        onChange={e => {
                          const v = Math.max(60, Math.min(400, Number(e.target.value)));
                          const next = { ...colWidths, [key]: v };
                          setColWidths(next);
                          localStorage.setItem("stats_col_widths_px", JSON.stringify(next));
                        }}
                        className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center"
                      />
                      <button
                        onClick={() => updateWidth(key as StatKey | "account", 10)}
                        className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("stats_col_widths_px"); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </AppLayout>
  );
}
