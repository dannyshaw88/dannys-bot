import { useRef, useState, useMemo, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfiles } from "@/hooks/use-profiles";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  User, Heart, MessageCircle, Eye, UserPlus, UserMinus, Mail, Activity,
  Settings2, ChevronDown, ChevronUp, Bot, Monitor,
} from "lucide-react";
import { type Profile, type Tool } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";

type StatKey = "follow" | "unfollow" | "dm" | "like" | "comment" | "story" | "human_session";

const ALL_STAT_TYPES: { key: StatKey; label: string; icon: React.ReactNode; color: string; isTool: boolean }[] = [
  { key: "follow",        label: "Follow",        icon: <UserPlus className="w-3.5 h-3.5" />,     color: "text-blue-500",    isTool: true  },
  { key: "unfollow",      label: "Unfollow",      icon: <UserMinus className="w-3.5 h-3.5" />,    color: "text-orange-500",  isTool: true  },
  { key: "dm",            label: "DMs Sent",      icon: <Mail className="w-3.5 h-3.5" />,          color: "text-violet-500",  isTool: true  },
  { key: "like",          label: "Likes",         icon: <Heart className="w-3.5 h-3.5" />,         color: "text-rose-500",    isTool: false },
  { key: "comment",       label: "Comments",      icon: <MessageCircle className="w-3.5 h-3.5" />, color: "text-indigo-500",  isTool: false },
  { key: "story",         label: "Story Views",   icon: <Eye className="w-3.5 h-3.5" />,           color: "text-emerald-500", isTool: false },
  { key: "human_session", label: "Human Sessions",icon: <Bot className="w-3.5 h-3.5" />,           color: "text-cyan-500",    isTool: false },
];

const DEFAULT_COL_WIDTHS: Record<StatKey | "account", number> = {
  account: 160, follow: 110, unfollow: 110, dm: 110,
  like: 100, comment: 110, story: 120, human_session: 140,
};


const DEFAULT_VISIBLE: Record<StatKey, boolean> = {
  follow: true, unfollow: true, dm: true, like: true,
  comment: true, story: true, human_session: true,
};

function ProfileStatsRow({
  profile,
  visibleCols,
  colWidths,
  statsData,
  onOpenBrowser,
  onNavigateToProfile,
}: {
  profile: Profile;
  visibleCols: Record<StatKey, boolean>;
  colWidths: Record<StatKey | "account", number>;
  statsData: any[];
  onOpenBrowser: () => void;
  onNavigateToProfile: () => void;
}) {
  const { data: tools } = useQuery<Tool[]>({ queryKey: [`/api/profiles/${profile.id}/tools`] });
  const updateToolMutation = useUpdateTool();

  const today = new Date().toISOString().split("T")[0];
  const getStat = (type: string, date: string) =>
    statsData?.find((s: any) => s.toolType === type && s.date === date)?.count || 0;

  const handleToggle = (tool: Tool, enabled: boolean) => {
    updateToolMutation.mutate({ id: tool.id, profileId: profile.id, enabled }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/tools`] }),
    });
  };

  const visibleTypes = ALL_STAT_TYPES.filter(({ key }) => visibleCols[key]);
  const displayName = profile.accountLabel || profile.username;

  return (
    <tr className="hover:bg-accent/5 transition-colors border-b border-border/50">
      {/* Account column — label, clickable → profile details */}
      <td style={{ width: colWidths.account }} className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
        <button
          className="flex items-center gap-2 hover:text-primary transition-colors text-left w-full group"
          onClick={onNavigateToProfile}
          title={`Go to profile: ${displayName}`}
        >
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="truncate">{displayName}</span>
        </button>
      </td>

      {/* Open EB column */}
      <td className="px-4 py-3">
        <button
          className="flex items-center gap-1.5 text-xs text-cyan-500 hover:text-cyan-400 transition-colors font-medium whitespace-nowrap"
          onClick={onOpenBrowser}
          title="Open Embedded Browser for this account"
        >
          <Monitor className="w-3.5 h-3.5 shrink-0" />
          <span>Open EB</span>
        </button>
      </td>

      {/* Stat columns */}
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
  const [, setLocation] = useLocation();
  const { openWindow } = useBrowserWindows();

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

  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("stats:groupMode") === "true");

  // ── Sort state ────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<StatKey | "account" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const cycleSort = (key: StatKey | "account") => {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); }
    else if (sortDir === "asc") setSortDir("desc");
    else { setSortKey(null); setSortDir("asc"); }
  };

  // ── Fetch all profile stats at page level (enables sort) ──────────────────
  const statsQueries = useQueries({
    queries: (profiles ?? []).map(p => ({
      queryKey: [`/api/profiles/${p.id}/stats`],
      refetchInterval: 10000,
    })),
  });

  const today = new Date().toISOString().split("T")[0];

  const statsMap = useMemo(() => {
    const m = new Map<number, any[]>();
    (profiles ?? []).forEach((p, i) => {
      m.set(p.id, (statsQueries[i]?.data as any[]) ?? []);
    });
    return m;
  // statsQueries changes identity on every render — include its length + loaded count as proxy keys
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, statsQueries.length, statsQueries.filter(q => q.isSuccess).length]);

  const getStatById = (profileId: number, type: string, date: string) =>
    statsMap.get(profileId)?.find((s: any) => s.toolType === type && s.date === date)?.count ?? 0;

  // ── Sorted profiles ────────────────────────────────────────────────────────
  const sortedProfiles = useMemo(() => {
    if (!profiles) return [];
    if (!sortKey) return profiles;
    return [...profiles].sort((a, b) => {
      if (sortKey === "account") {
        const sa = (a.accountLabel || a.username || "").toLowerCase();
        const sb = (b.accountLabel || b.username || "").toLowerCase();
        return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }
      const va = getStatById(a.id, sortKey, today);
      const vb = getStatById(b.id, sortKey, today);
      if (va !== vb) return sortDir === "asc" ? va - vb : vb - va;
      const la = getStatById(a.id, sortKey, "lifetime");
      const lb = getStatById(b.id, sortKey, "lifetime");
      return sortDir === "asc" ? la - lb : lb - la;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, sortKey, sortDir, statsMap]);

  // ── Grouped profiles (for group view) ──────────────────────────────────────
  const groupedStats = useMemo(() => {
    if (!groupMode) return null;
    const map = new Map<string, typeof sortedProfiles>();
    for (const p of sortedProfiles) {
      const key = p.tags?.trim() || "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [sortedProfiles, groupMode]);

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
    const v = Math.max(40, colWidths[key] + delta);
    const next = { ...colWidths, [key]: v };
    setColWidths(next);
    localStorage.setItem("stats_col_widths_px", JSON.stringify(next));
  };

  const visibleTypes = ALL_STAT_TYPES.filter(({ key }) => visibleCols[key]);
  // Account + Browser Embedded + stat columns
  const colCount = 2 + visibleTypes.length;

  const colGroups: [string, string][] = [
    ["account", "Account"],
    ...ALL_STAT_TYPES.map(({ key, label }) => [key, label] as [string, string]),
  ];

  const sortIcon = (key: StatKey | "account") => {
    if (sortKey !== key) return <span className="text-[9px] opacity-30 ml-0.5">⇅</span>;
    return <span className="text-[9px] ml-0.5">{sortDir === "asc" ? "▲" : "▼"}</span>;
  };

  const makeRowProps = (profile: Profile) => ({
    onOpenBrowser: () => openWindow(profile.id, profile.username ?? "", profile.userAgentEmbedded ?? ""),
    onNavigateToProfile: () => setLocation(`/profiles/${profile.id}`),
  });

  return (
    <AppLayout>
      <div className="mb-3">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Automation Stats</h1>
        <p className="text-muted-foreground mt-1">Daily and lifetime performance metrics for all accounts.</p>
      </div>

      <Card className="desktop-card border-none shadow-sm flex flex-col">
        <CardHeader className="border-b border-border/50 bg-muted/5">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Tool Performance
            <div className="flex items-center gap-4 ml-auto">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox
                  checked={groupMode}
                  onCheckedChange={checked => {
                    const next = !!checked;
                    setGroupMode(next);
                    localStorage.setItem("stats:groupMode", String(next));
                  }}
                  className="w-3.5 h-3.5"
                />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Group Accounts</span>
              </label>
              <div ref={manageColsRef} className="relative">
                <button
                  onClick={() => setManageColsOpen(o => !o)}
                  className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Columns
                </button>
                {manageColsOpen && (
                  <div className="absolute right-0 top-full mt-2 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-72">
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
                          value={colWidths[key as StatKey | "account"]}
                          onChange={e => {
                            const v = Math.max(40, Number(e.target.value) || 40);
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
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 flex flex-col">
          <div className="overflow-x-auto">
            <table className="text-sm text-left" style={{ tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                <col style={{ width: colWidths.account }} />
                <col />
                {visibleTypes.map(({ key }) => <col key={key} style={{ width: colWidths[key] }} />)}
              </colgroup>
              <thead className="text-xs bg-muted/30 text-muted-foreground border-b border-border/50">
                <tr>
                  <th className="px-4 py-3 font-bold uppercase tracking-wide">
                    <button
                      onClick={() => cycleSort("account")}
                      className="flex items-center hover:text-foreground transition-colors"
                    >
                      Account{sortIcon("account")}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-bold uppercase tracking-wide">
                    <span className="flex items-center gap-1 text-cyan-500/70">
                      <Monitor className="w-3 h-3" />
                      <span className="text-[10px]">Open EB</span>
                    </span>
                  </th>
                  {visibleTypes.map(({ key, label, icon, color }) => (
                    <th key={key} className="px-4 py-3 font-bold">
                      <button
                        onClick={() => cycleSort(key)}
                        className={`flex items-center gap-1 hover:opacity-90 transition-opacity ${color} ${sortKey === key ? "opacity-100" : "opacity-60"}`}
                      >
                        {icon}
                        <span className="uppercase tracking-wide text-[10px]">{label}</span>
                        {sortIcon(key)}
                      </button>
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
                ) : groupMode && groupedStats ? (
                  Array.from(groupedStats.entries()).map(([groupKey, groupProfiles]) => (
                    <>
                      <tr key={`group-${groupKey}`} className="bg-background border-b border-border">
                        <td colSpan={colCount} className="px-4 py-1.5 select-none">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                              {groupKey === "__ungrouped__" ? "Ungrouped" : groupKey}
                            </span>
                            <span className="text-[10px] text-muted-foreground">({groupProfiles.length})</span>
                          </div>
                        </td>
                      </tr>
                      {groupProfiles.map(profile => (
                        <ProfileStatsRow
                          key={profile.id}
                          profile={profile}
                          visibleCols={visibleCols}
                          colWidths={colWidths}
                          statsData={statsMap.get(profile.id) ?? []}
                          {...makeRowProps(profile)}
                        />
                      ))}
                    </>
                  ))
                ) : (
                  sortedProfiles.map(profile => (
                    <ProfileStatsRow
                      key={profile.id}
                      profile={profile}
                      visibleCols={visibleCols}
                      colWidths={colWidths}
                      statsData={statsMap.get(profile.id) ?? []}
                      {...makeRowProps(profile)}
                    />
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
