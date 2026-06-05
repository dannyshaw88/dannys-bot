import { useRef, useState, useMemo, useEffect, Fragment } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { TrustScoreBadge } from "@/components/TrustScoreBadge";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfiles } from "@/hooks/use-profiles";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  User, Heart, MessageCircle, Eye, UserPlus, UserMinus, Mail, Activity,
  Settings2, ChevronDown, ChevronUp, ChevronRight, Bot, Monitor, ImagePlus,
} from "lucide-react";
import { type Profile, type Tool } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";

type StatKey = "follow" | "unfollow" | "dm" | "like" | "comment" | "story" | "human_session";

const ALL_STAT_TYPES: { key: StatKey; label: string; icon: React.ReactNode; color: string; isTool: boolean; toolTypeKey?: string }[] = [
  { key: "follow",        label: "Follow",        icon: <UserPlus className="w-3.5 h-3.5" />,     color: "text-blue-500",    isTool: true  },
  { key: "unfollow",      label: "Unfollow",      icon: <UserMinus className="w-3.5 h-3.5" />,    color: "text-orange-500",  isTool: true  },
  { key: "dm",            label: "DMs Sent",      icon: <Mail className="w-3.5 h-3.5" />,          color: "text-violet-500",  isTool: true,  toolTypeKey: "contact" },
  { key: "like",          label: "Likes",         icon: <Heart className="w-3.5 h-3.5" />,         color: "text-rose-500",    isTool: false },
  { key: "comment",       label: "Comments",      icon: <MessageCircle className="w-3.5 h-3.5" />, color: "text-indigo-500",  isTool: false },
  { key: "story",         label: "Story Views",   icon: <Eye className="w-3.5 h-3.5" />,           color: "text-emerald-500", isTool: false },
  { key: "human_session", label: "Human Session Tool", icon: <Bot className="w-3.5 h-3.5" />, color: "text-cyan-500", isTool: true, toolTypeKey: "human_session" },
];

const DEFAULT_COL_WIDTHS: Record<StatKey | "account" | "open_eb" | "trustscore", number> = {
  account: 160, open_eb: 80, trustscore: 120, follow: 110, unfollow: 110, dm: 110,
  like: 100, comment: 110, story: 120, human_session: 140,
};


const DEFAULT_VISIBLE: Record<StatKey | "open_eb", boolean> = {
  follow: true, unfollow: true, dm: true, like: true,
  comment: true, story: true, human_session: true, open_eb: true,
};

const DEFAULT_STAT_COL_ORDER: StatKey[] = ["follow", "unfollow", "dm", "like", "comment", "story", "human_session"];

function ProfileStatsRow({
  profile,
  visibleCols,
  statColOrder,
  colWidths,
  statsData,
  onOpenBrowser,
  onNavigateToProfile,
}: {
  profile: Profile;
  visibleCols: Record<StatKey | "open_eb", boolean>;
  statColOrder: StatKey[];
  colWidths: Record<StatKey | "account" | "open_eb" | "trustscore", number>;
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

  const displayName = profile.accountLabel || profile.username;

  return (
    <tr className="hover:bg-accent/5 transition-colors border-b border-border/50">
      {/* Account column label, clickable → profile details */}
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
      {visibleCols.open_eb && (
        <td style={{ width: colWidths.open_eb }} className="px-4 py-3">
          <button
            className="flex items-center gap-1.5 text-xs text-cyan-500 hover:text-cyan-400 transition-colors font-medium whitespace-nowrap"
            onClick={onOpenBrowser}
            title="Open Embedded Browser for this account"
          >
            <Monitor className="w-3.5 h-3.5 shrink-0" />
            <span>Open EB</span>
          </button>
        </td>
      )}

      {/* TrustScore column */}
      <td style={{ width: colWidths.trustscore }} className="px-4 py-3">
        <div className="flex justify-center">
          <TrustScoreBadge profileId={profile.id} />
        </div>
      </td>

      {/* Stat columns — in user-defined order */}
      {statColOrder.filter(key => visibleCols[key]).map(key => {
        const statType = ALL_STAT_TYPES.find(s => s.key === key)!;
        const isTool = statType.isTool;
        const lookupType = statType.toolTypeKey ?? key;
        const tool = isTool ? tools?.find((t: Tool) => t.type === lookupType) : undefined;
        const todayCount = getStat(key, today);
        const lifetime = getStat(key, "lifetime");
        return (
          <td key={key} style={{ width: colWidths[key] }} className="px-4 py-3">
            {key === "human_session" ? (
              // Human Session Tool column: toggle only, no counts
              <div className="flex items-center">
                {tool && (
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={(val) => handleToggle(tool, val)}
                    className="scale-75 origin-left"
                  />
                )}
              </div>
            ) : (
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
            )}
          </td>
        );
      })}
    </tr>
  );
}

export function StatsPage() {
  useScrollRestore("stats");
  const { data: rawProfiles, isLoading } = useProfiles();
  const profiles = useMemo(() => rawProfiles?.filter(p => !p.isTemplate), [rawProfiles]);
  const [, setLocation] = useLocation();
  const { openWindow } = useBrowserWindows();

  const [colWidths, setColWidths] = usePersistentSetting<Record<StatKey | "account" | "open_eb" | "trustscore", number>>(
    "stats_col_widths_px",
    DEFAULT_COL_WIDTHS,
    (s, d) => ({ ...d, ...s }),
  );

  const [visibleCols, setVisibleCols] = usePersistentSetting<Record<StatKey | "open_eb", boolean>>(
    "stats_visible_cols",
    DEFAULT_VISIBLE,
    (s, d) => ({ ...d, ...s }),
  );

  const [statColOrder, setStatColOrder] = usePersistentSetting<StatKey[]>(
    "stats_col_order",
    DEFAULT_STAT_COL_ORDER,
    (stored, defaults) => {
      const storedSet = new Set(stored);
      const newKeys = defaults.filter(k => !storedSet.has(k));
      return [...stored, ...newKeys];
    },
  );

  const moveStatCol = (key: StatKey, dir: -1 | 1) => {
    const idx = statColOrder.indexOf(key);
    if (idx === -1) return;
    const next = [...statColOrder];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setStatColOrder(next);
    localStorage.setItem("stats_col_order", JSON.stringify(next));
  };

  const statDragColRef = useRef<string | null>(null);
  const [statDragOverCol, setStatDragOverCol] = useState<string | null>(null);

  const [manageColsOpen, setManageColsOpen] = useState(false);
  const manageColsRef = useRef<HTMLDivElement>(null);

  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("stats:groupMode") === "true");

  // ── Group icons (shared localStorage key with ProfilesPage) ────────────────
  const [groupIcons, setGroupIcons] = useState<Record<string, string>>(() => {
    try {
      const s = localStorage.getItem("profiles:groupIcons");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const groupIconInputRef = useRef<HTMLInputElement>(null);
  const groupIconKeyRef   = useRef<string>("");

  const handleGroupIconFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const data = ev.target?.result as string;
      const key  = groupIconKeyRef.current;
      if (!data || !key) return;
      setGroupIcons(prev => {
        const next = { ...prev, [key]: data };
        try { localStorage.setItem("profiles:groupIcons", JSON.stringify(next)); } catch {}
        return next;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const [collapsedGroups, setCollapsedGroups] = usePersistentSetting<string[]>(
    "stats:collapsedGroups",
    [],
    (s) => s,
  );
  const collapsedGroupsSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroupCollapse = (key: string) => {
    const next = collapsedGroupsSet.has(key)
      ? collapsedGroups.filter(g => g !== key)
      : [...collapsedGroups, key];
    setCollapsedGroups(next);
  };

  // ── Sort state ────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<StatKey | "account" | null>(() => {
    const v = localStorage.getItem("stats:sortKey");
    return v ? (v as StatKey | "account") : null;
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    localStorage.getItem("stats:sortDir") === "desc" ? "desc" : "asc"
  );

  const cycleSort = (key: StatKey | "account") => {
    if (sortKey !== key) {
      setSortKey(key); setSortDir("asc");
      localStorage.setItem("stats:sortKey", key);
      localStorage.setItem("stats:sortDir", "asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
      localStorage.setItem("stats:sortDir", "desc");
    } else {
      setSortDir("asc");
      localStorage.setItem("stats:sortDir", "asc");
    }
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
  // statsQueries changes identity on every render include its length + loaded count as proxy keys
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

  const toggleVisible = (key: StatKey | "open_eb", val: boolean) => {
    const next = { ...visibleCols, [key]: val };
    setVisibleCols(next);
    localStorage.setItem("stats_visible_cols", JSON.stringify(next));
  };

  const updateWidth = (key: StatKey | "account" | "open_eb", delta: number) => {
    const v = Math.max(40, colWidths[key] + delta);
    const next = { ...colWidths, [key]: v };
    setColWidths(next);
    localStorage.setItem("stats_col_widths_px", JSON.stringify(next));
  };

  const visibleTypes = ALL_STAT_TYPES.filter(({ key }) => visibleCols[key]);
  // Account + (Open EB if visible) + TrustScore + stat columns
  const colCount = 2 + (visibleCols.open_eb ? 1 : 0) + visibleTypes.length;

  const colGroups: [string, string][] = [
    ["account", "Account"],
    ["open_eb", "Open EB"],
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
      {/* Hidden file input for group icon upload */}
      <input
        ref={groupIconInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleGroupIconFile}
      />

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
                      {/* Fixed column: Open EB */}
                      <div className="flex items-center gap-1.5 select-none">
                        <div className="w-[18px] shrink-0" />
                        <label className="flex items-center gap-2 cursor-pointer flex-1">
                          <Checkbox checked={visibleCols.open_eb} onCheckedChange={(val) => toggleVisible("open_eb", !!val)} className="h-3.5 w-3.5 shrink-0" />
                          <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-cyan-500"><Monitor className="w-3.5 h-3.5" /> Open EB</span>
                        </label>
                      </div>
                      {/* Orderable stat columns */}
                      {statColOrder.map((key, ordIdx) => {
                        const st = ALL_STAT_TYPES.find(s => s.key === key)!;
                        return (
                          <div key={key} className="flex items-center gap-1.5 select-none">
                            <div className="flex flex-col mr-0.5">
                              <button onClick={() => moveStatCol(key, -1)} disabled={ordIdx === 0} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronUp className="w-2.5 h-2.5" /></button>
                              <button onClick={() => moveStatCol(key, 1)} disabled={ordIdx === statColOrder.length - 1} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronDown className="w-2.5 h-2.5" /></button>
                            </div>
                            <label className="flex items-center gap-2 cursor-pointer flex-1">
                              <Checkbox checked={visibleCols[key]} onCheckedChange={(val) => toggleVisible(key, !!val)} className="h-3.5 w-3.5 shrink-0" />
                              <span className={`flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide ${st.color}`}>{st.icon} {st.label}</span>
                            </label>
                          </div>
                        );
                      })}
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
                      onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("stats_col_widths_px"); setStatColOrder(DEFAULT_STAT_COL_ORDER); localStorage.removeItem("stats_col_order"); }}
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
            <table className="text-sm text-left" style={{ tableLayout: "fixed", minWidth: "100%", width: `${colWidths.account + (visibleCols.open_eb ? colWidths.open_eb : 0) + colWidths.trustscore + statColOrder.filter(k => visibleCols[k]).reduce((s, k) => s + colWidths[k], 0)}px` }}>
              <colgroup>
                <col style={{ width: colWidths.account }} />
                {visibleCols.open_eb && <col style={{ width: colWidths.open_eb }} />}
                <col style={{ width: colWidths.trustscore }} />
                {statColOrder.filter(key => visibleCols[key]).map(key => <col key={key} style={{ width: colWidths[key] }} />)}
              </colgroup>
              <thead className="text-xs bg-muted/30 text-muted-foreground border-b border-border/50">
                <tr>
                  <th className="px-4 py-3 font-bold uppercase tracking-wide">
                    <button
                      onClick={() => cycleSort("account")}
                      className="flex items-center hover:text-foreground transition-colors"
                    >
                      Account Name
                    </button>
                  </th>
                  {visibleCols.open_eb && (
                    <th style={{ width: colWidths.open_eb }} className="px-4 py-3 font-bold uppercase tracking-wide">
                      <span className="flex items-center gap-1 text-cyan-500/70">
                        <Monitor className="w-3 h-3" />
                        <span className="text-[10px]">Open EB</span>
                      </span>
                    </th>
                  )}
                  <th style={{ width: colWidths.trustscore }} className="px-4 py-3 font-bold uppercase tracking-wide text-[10px] text-muted-foreground/60">TrustScore</th>
                  {statColOrder.filter(key => visibleCols[key]).map(key => {
                    const st = ALL_STAT_TYPES.find(s => s.key === key)!;
                    const isDragTarget = statDragOverCol === key;
                    return (
                      <th
                        key={key}
                        draggable
                        onDragStart={e => { statDragColRef.current = key; e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (statDragColRef.current && statDragColRef.current !== key) setStatDragOverCol(key); }}
                        onDrop={e => {
                          e.preventDefault();
                          const from = statDragColRef.current as StatKey | null;
                          statDragColRef.current = null;
                          setStatDragOverCol(null);
                          if (!from || from === key) return;
                          const fromIdx = statColOrder.indexOf(from);
                          const toIdx = statColOrder.indexOf(key);
                          if (fromIdx === -1 || toIdx === -1) return;
                          const next = [...statColOrder];
                          next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, from);
                          setStatColOrder(next);
                          localStorage.setItem("stats_col_order", JSON.stringify(next));
                        }}
                        onDragEnd={() => { statDragColRef.current = null; setStatDragOverCol(null); }}
                        className={`px-4 py-3 font-bold cursor-default select-none ${isDragTarget ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                      >
                        <button onClick={() => cycleSort(key)} className={`flex items-center gap-1 hover:opacity-90 transition-opacity ${st.color} ${sortKey === key ? "opacity-100" : "opacity-60"}`}>
                          {st.icon}<span className="uppercase tracking-wide text-[10px]">{st.label}</span>
                        </button>
                      </th>
                    );
                  })}
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
                  Array.from(groupedStats.entries()).map(([groupKey, groupProfiles]) => {
                    const isCollapsed = collapsedGroupsSet.has(groupKey);
                    return (
                      <Fragment key={`group-${groupKey}`}>
                        <tr className="bg-background border-b border-border sticky top-0 z-10">
                          <td colSpan={colCount} className="px-3 py-1.5 select-none">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => toggleGroupCollapse(groupKey)}
                                className="flex items-center gap-2 min-w-0 text-left"
                              >
                                {isCollapsed
                                  ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                }
                                <span className={`text-sm font-bold truncate ${groupKey === "__ungrouped__" ? "text-muted-foreground" : "text-foreground"}`}>
                                  {groupKey === "__ungrouped__" ? "No Group Assigned" : groupKey}
                                </span>
                              </button>
                              {groupKey !== "__ungrouped__" && (
                                <button
                                  onClick={e => { e.stopPropagation(); groupIconKeyRef.current = groupKey; groupIconInputRef.current?.click(); }}
                                  title={groupIcons[groupKey] ? "Change group icon" : "Add group icon"}
                                  className="shrink-0 w-[18px] h-[18px] rounded border border-dashed border-border/60 hover:border-primary/50 overflow-hidden flex items-center justify-center transition-colors bg-muted/20 hover:bg-muted/50"
                                >
                                  {groupIcons[groupKey]
                                    ? <img src={groupIcons[groupKey]} alt="" className="w-full h-full object-cover" />
                                    : <ImagePlus className="w-2.5 h-2.5 text-muted-foreground/30" />
                                  }
                                </button>
                              )}
                              <span className="text-[10px] text-muted-foreground shrink-0">({groupProfiles.length})</span>
                            </div>
                          </td>
                        </tr>
                        {!isCollapsed && groupProfiles.map(profile => (
                          <ProfileStatsRow
                            key={profile.id}
                            profile={profile}
                            visibleCols={visibleCols}
                            statColOrder={statColOrder}
                            colWidths={colWidths}
                            statsData={statsMap.get(profile.id) ?? []}
                            {...makeRowProps(profile)}
                          />
                        ))}
                      </Fragment>
                    );
                  })
                ) : (
                  sortedProfiles.map(profile => (
                    <ProfileStatsRow
                      key={profile.id}
                      profile={profile}
                      visibleCols={visibleCols}
                      statColOrder={statColOrder}
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
