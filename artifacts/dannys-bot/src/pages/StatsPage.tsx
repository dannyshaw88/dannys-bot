import { useRef, useState, useMemo, useEffect, Fragment } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { TrustScoreBadge } from "@/components/TrustScoreBadge";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useProfiles } from "@/hooks/use-profiles";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  User, Heart, MessageCircle, Eye, UserPlus, UserMinus, Mail, Activity,
  Settings2, ChevronDown, ChevronUp, ChevronRight, Fingerprint, ImagePlus,
  BarChart2, Zap, Repeat2, ShieldAlert, PhoneOff, Webhook, Bot, Lock, Flag,
  Smartphone,
} from "lucide-react";
import { type Profile, type Tool } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";

type StatKey = "follow" | "unfollow" | "dm" | "like" | "comment" | "story" | "repost" | "human_session";
type ColKey = StatKey | "trustscore";


const ALL_STAT_TYPES: { key: StatKey; label: string; icon: React.ReactNode; color: string; isTool: boolean; toolTypeKey?: string; pieColor: string }[] = [
  { key: "follow",        label: "Follow",        icon: <UserPlus className="w-3.5 h-3.5" />,     color: "text-blue-500",    isTool: false, pieColor: "#3b82f6" },
  { key: "unfollow",      label: "Unfollow",      icon: <UserMinus className="w-3.5 h-3.5" />,    color: "text-orange-500",  isTool: false, pieColor: "#f97316" },
  { key: "dm",            label: "DMs Sent",      icon: <Mail className="w-3.5 h-3.5" />,          color: "text-violet-500",  isTool: false, pieColor: "#8b5cf6" },
  { key: "like",          label: "Likes",         icon: <Heart className="w-3.5 h-3.5" />,         color: "text-rose-500",    isTool: false, pieColor: "#f43f5e" },
  { key: "comment",       label: "Comments",      icon: <MessageCircle className="w-3.5 h-3.5" />, color: "text-indigo-500",  isTool: false, pieColor: "#6366f1" },
  { key: "story",         label: "Story Views",   icon: <Eye className="w-3.5 h-3.5" />,           color: "text-emerald-500", isTool: false, pieColor: "#10b981" },
  { key: "repost",        label: "Reposts",       icon: <Repeat2 className="w-3.5 h-3.5" />,       color: "text-sky-500",     isTool: false, pieColor: "#0ea5e9" },
  { key: "human_session", label: "Human Session", icon: <Fingerprint className="w-3.5 h-3.5" />,           color: "text-cyan-500",    isTool: true,  toolTypeKey: "human_sessions", pieColor: "#06b6d4" },
];

const ENDPOINT_COLORS: Record<string, string> = {
  ViewTimelineFeedSeen:      "#3b82f6",
  FollowedUser:              "#10b981",
  UnfollowUser:              "#ef4444",
  GetDirectMessages:         "#8b5cf6",
  GetDirectMessageThread:    "#a78bfa",
  ViewTimelineStories:       "#f97316",
  LikeMedia:                 "#f43f5e",
  ViewFeedPost:              "#06b6d4",
  VisitUserProfile:          "#0ea5e9",
  ViewUserFeed:              "#14b8a6",
  SaveMedia:                 "#84cc16",
  FetchConfig:               "#64748b",
  GetKeyedTokens:            "#94a3b8",
  SendMobileConfig:          "#c084fc",
  ViewStories:               "#f59e0b",
  TopicalExplore:            "#ec4899",
  Banyan:                    "#6366f1",
  ExecuteNotificationsBadge: "#a3e635",
  GetReelsTray:              "#fb923c",
  GetTimeLineFeed:           "#38bdf8",
  GetAccountFamily:          "#34d399",
  VerifyAccount:             "#fbbf24",
  ViewHighlights:            "#f472b6",
  CommentMedia:              "#22d3ee",
  PostMedia:                 "#4ade80",
};
const EP_FALLBACK = ["#3b82f6","#10b981","#f43f5e","#f97316","#8b5cf6","#06b6d4","#84cc16","#ec4899","#14b8a6","#6366f1","#fbbf24","#0ea5e9"];
function epColor(name: string, idx: number): string {
  return ENDPOINT_COLORS[name] ?? EP_FALLBACK[idx % EP_FALLBACK.length];
}
// Strip legacy "METHOD:Name" format (e.g. "POST:FeedTimeline" → "FeedTimeline")
// that was produced by an older version of _opNameFromPath.
function cleanEpName(name: string): string {
  return /^(GET|POST|PUT|PATCH|DELETE):/.test(name) ? name.replace(/^[A-Z]+:/, "") : name;
}

const DEFAULT_COL_WIDTHS: Record<ColKey | "account", number> = {
  account: 160, trustscore: 120, follow: 110, unfollow: 110, dm: 110,
  like: 100, comment: 110, story: 120, repost: 110, human_session: 140,
};

const DEFAULT_VISIBLE: Record<ColKey, boolean> = {
  follow: true, unfollow: true, dm: true, like: true,
  comment: true, story: true, repost: true, human_session: true, trustscore: true,
};

const DEFAULT_STAT_COL_ORDER: ColKey[] = ["trustscore", "follow", "unfollow", "dm", "like", "comment", "story", "repost", "human_session"];

function ProfileStatsRow({
  profile,
  visibleCols,
  statColOrder,
  colWidths,
  statsData,
  onNavigateToProfile,
  isFlagged,
}: {
  profile: Profile;
  visibleCols: Record<ColKey, boolean>;
  statColOrder: ColKey[];
  colWidths: Record<ColKey | "account", number>;
  statsData: any[];
  onNavigateToProfile: () => void;
  isFlagged?: boolean;
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
    <tr className={`hover:bg-accent/5 transition-colors border-b border-border/50${profile.accountStatus === 'stopped' ? ' opacity-50' : ''}`}>
      {/* Account column — left-aligned */}
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
          {isFlagged && <Flag className="w-3 h-3 text-red-500 shrink-0 ml-0.5" fill="currentColor" title="Flagged account" />}
        </button>
      </td>

      {/* All non-account columns — centred */}
      {statColOrder.filter(key => visibleCols[key]).map(key => {
        if (key === "trustscore") {
          return (
            <td key="trustscore" style={{ width: colWidths.trustscore }} className="px-4 py-3">
              <div className="flex items-center justify-center h-full">
                <TrustScoreBadge profileId={profile.id} width={90} height={50} />
              </div>
            </td>
          );
        }
        const statType = ALL_STAT_TYPES.find(s => s.key === key)!;
        const isTool = statType.isTool;
        const lookupType = statType.toolTypeKey ?? key;
        const tool = isTool ? tools?.find((t: Tool) => t.type === lookupType) : undefined;
        const todayCount = getStat(key, today);
        const lifetime = getStat(key, "lifetime");
        return (
          <td key={key} style={{ width: colWidths[key] }} className="px-4 py-3 text-center">
            {key === "human_session" ? (
              <div className="flex items-center justify-center gap-1.5">
                {tool && (
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={(val) => handleToggle(tool, val)}
                    className="scale-75 origin-center shrink-0 self-center"
                  />
                )}
                <div className="flex items-center gap-0.5 text-[11px]">
                  <span className="font-bold tabular-nums text-foreground">{todayCount}</span>
                  <span className="text-muted-foreground">/{lifetime}</span>
                </div>
              </div>
            ) : (
              <div className="flex items-baseline justify-center gap-1 text-[11px]">
                <span className="font-bold tabular-nums text-foreground">{todayCount}</span>
                <span className="text-muted-foreground">/ {lifetime}</span>
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Phone Farm tab ───────────────────────────────────────────────────────────

const FARM_STAT_LABELS: { key: string; label: string; icon: React.ReactNode; color: string }[] = [
  { key: "cycles",      label: "Cycles",       icon: <Activity className="w-3 h-3" />,   color: "text-cyan-500" },
  { key: "likes",       label: "Likes",        icon: <Heart className="w-3 h-3" />,       color: "text-rose-500" },
  { key: "follows",     label: "Follows",      icon: <UserPlus className="w-3 h-3" />,    color: "text-blue-500" },
  { key: "stories",     label: "Stories",      icon: <Eye className="w-3 h-3" />,         color: "text-emerald-500" },
  { key: "reels",       label: "Reels",        icon: <Repeat2 className="w-3 h-3" />,     color: "text-sky-500" },
  { key: "dms",         label: "DMs",          icon: <Mail className="w-3 h-3" />,        color: "text-violet-500" },
  { key: "feed_shares", label: "Feed Shares",  icon: <Zap className="w-3 h-3" />,         color: "text-amber-500" },
];

interface FarmPhone {
  serial: string;
  state: string;
  model?: string;
  manufacturer?: string;
  marketName?: string;
}

function PhoneFarmPhoneSection({
  phone,
  farmColOrder,
  farmSortKey,
  farmSortDir,
}: {
  phone: FarmPhone;
  farmColOrder: string[];
  farmSortKey: string | null;
  farmSortDir: "desc" | "asc";
}) {
  const { data: account, isLoading } = useQuery<{ slots: { username: string }[] }>({
    queryKey: [`/api/mobile/devices/${encodeURIComponent(phone.serial)}/account`],
    refetchInterval: 30000,
  });

  const slots = (account?.slots ?? [])
    .map((s, i) => ({ username: s.username?.trim() ?? "", idx: i }))
    .filter(s => s.username !== "");

  const slotStatsResults = useQueries({
    queries: slots.map(slot => ({
      queryKey: [`/api/mobile/slot-stats?username=${encodeURIComponent(slot.username)}`],
      refetchInterval: 30000,
    })),
  });

  const orderedLabels = farmColOrder
    .map(k => FARM_STAT_LABELS.find(s => s.key === k))
    .filter(Boolean) as typeof FARM_STAT_LABELS;
  const colCount = 1 + farmColOrder.length;

  const slotsWithStats = slots.map((slot, i) => {
    const d = slotStatsResults[i]?.data as { daily: Record<string, number>; lifetime: Record<string, number> } | undefined;
    return {
      ...slot,
      isLoadingStats: slotStatsResults[i]?.isLoading ?? true,
      daily: d?.daily ?? {},
      lifetime: d?.lifetime ?? {},
    };
  });

  const sortedSlots = farmSortKey
    ? [...slotsWithStats].sort((a, b) => {
        const va = a.daily[farmSortKey] ?? 0;
        const vb = b.daily[farmSortKey] ?? 0;
        return farmSortDir === "desc" ? vb - va : va - vb;
      })
    : slotsWithStats;

  const label = phone.marketName || (phone.manufacturer && phone.model ? `${phone.manufacturer} ${phone.model}` : phone.serial);

  return (
    <>
      <tr className="bg-background border-b border-border sticky top-0 z-10">
        <td colSpan={colCount} className="px-3 py-1.5">
          <div className="flex items-center gap-2">
            <Smartphone className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-sm font-bold text-foreground">{label}</span>
          </div>
        </td>
      </tr>
      {isLoading ? (
        <tr className="animate-pulse">
          <td colSpan={colCount} className="px-5 py-4 bg-muted/10 h-10" />
        </tr>
      ) : slots.length === 0 ? (
        <tr>
          <td colSpan={colCount} className="px-5 py-3 text-[12px] text-muted-foreground italic">
            No accounts configured on this device
          </td>
        </tr>
      ) : (
        sortedSlots.map(slot => (
          <tr key={slot.idx} className="border-b border-border/50 hover:bg-muted/10 transition-colors">
            <td className="py-2.5 px-4 text-[12px]">
              <span className="text-muted-foreground text-[10px] mr-1.5">Slot {slot.idx + 1}</span>
              <span className="font-medium text-foreground">@{slot.username}</span>
            </td>
            {orderedLabels.map(s => {
              const daily = slot.daily[s.key] ?? 0;
              const lifetime = slot.lifetime[s.key] ?? 0;
              return (
                <td key={s.key} className="py-2.5 px-3 text-center tabular-nums">
                  {slot.isLoadingStats ? (
                    <span className="text-muted-foreground text-[11px]">…</span>
                  ) : (
                    <div className="flex items-center justify-center gap-0.5 text-[11px]">
                      <span className="font-bold text-foreground">{daily.toLocaleString()}</span>
                      <span className="text-muted-foreground">/{lifetime.toLocaleString()}</span>
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))
      )}
    </>
  );
}

export function StatsPage() {
  useScrollRestore("stats");
  const { data: rawProfiles, isLoading } = useProfiles();
  const profiles = useMemo(() => rawProfiles?.filter(p => !p.isTemplate), [rawProfiles]);
  const [, setLocation] = useLocation();

  const [colWidths, setColWidths] = usePersistentSetting<Record<ColKey | "account", number>>(
    "stats_col_widths_px",
    DEFAULT_COL_WIDTHS,
    (s, d) => ({ ...d, ...s }),
  );

  const [visibleCols, setVisibleCols] = usePersistentSetting<Record<ColKey, boolean>>(
    "stats_visible_cols",
    DEFAULT_VISIBLE,
    (s, d) => ({ ...d, ...s }),
  );

  const [statColOrder, setStatColOrder] = usePersistentSetting<ColKey[]>(
    "stats_col_order",
    DEFAULT_STAT_COL_ORDER,
    (stored, defaults) => {
      const storedSet = new Set(stored);
      const newKeys = defaults.filter(k => !storedSet.has(k));
      return [...stored, ...newKeys];
    },
  );

  const moveStatCol = (key: ColKey, dir: -1 | 1) => {
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

  const [groupMode, setGroupMode] = useState<boolean>(() => localStorage.getItem("stats:groupMode") === "true");

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, statsQueries.length, statsQueries.filter(q => q.isSuccess).length]);

  const getStatById = (profileId: number, type: string, date: string) =>
    statsMap.get(profileId)?.find((s: any) => s.toolType === type && s.date === date)?.count ?? 0;

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


  const toggleVisible = (key: ColKey, val: boolean) => {
    const next = { ...visibleCols, [key]: val };
    setVisibleCols(next);
    localStorage.setItem("stats_visible_cols", JSON.stringify(next));
  };

  const updateWidth = (key: ColKey | "account", delta: number) => {
    const v = Math.max(1, colWidths[key] + delta);
    const next = { ...colWidths, [key]: v };
    setColWidths(next);
    localStorage.setItem("stats_col_widths_px", JSON.stringify(next));
  };

  const colCount = 1 + statColOrder.filter(k => visibleCols[k]).length;

  const colGroups: [string, string][] = [
    ["account", "Account"],
    ...statColOrder.map(k => {
      if (k === "trustscore") return ["trustscore", "TrustScore"] as [string, string];
      const found = ALL_STAT_TYPES.find(s => s.key === k);
      return [k, found ? found.label : k] as [string, string];
    }),
  ];

  const sortIcon = (key: StatKey | "account") => {
    if (sortKey !== key) return <span className="text-[9px] opacity-30 ml-0.5">⇅</span>;
    return <span className="text-[9px] ml-0.5">{sortDir === "asc" ? "▲" : "▼"}</span>;
  };

  const [flaggedIds] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem("equinox:flagged_profiles") ?? "[]") as number[]; } catch { return []; }
  });

  const makeRowProps = (profile: Profile) => ({
    onNavigateToProfile: () => setLocation(`/profiles/${profile.id}`),
    isFlagged: flaggedIds.includes(profile.id),
  });

  // ── Metrics tab state ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("tab") || "farm";
  });

  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("profileId") || "";
  });

  // Fetch devices + slots for grouped account selector
  const { data: metricsPhones } = useQuery<{ phones: FarmPhone[]; adbFound: boolean }>({
    queryKey: ["/api/mobile/usb-phones"],
    refetchInterval: 30000,
    enabled: activeTab === "metrics",
  });
  const metricsPhoneList = metricsPhones?.phones ?? [];

  const deviceSlotResults = useQueries({
    queries: metricsPhoneList.map(phone => ({
      queryKey: [`/api/mobile/devices/${encodeURIComponent(phone.serial)}/account`],
      refetchInterval: 30000,
      enabled: activeTab === "metrics",
    })),
  });

  const deviceGroups = useMemo(() => {
    return metricsPhoneList.map((phone, idx) => {
      const slots = (deviceSlotResults[idx]?.data as { slots: { username: string }[] } | undefined)?.slots ?? [];
      const slotProfiles = slots
        .map(s => (profiles ?? []).find(p => p.username === s.username?.trim()))
        .filter(Boolean) as Profile[];
      return {
        serial: phone.serial,
        label: phone.marketName || phone.model || phone.manufacturer || phone.serial,
        profiles: slotProfiles,
      };
    }).filter(g => g.profiles.length > 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricsPhoneList, deviceSlotResults.map(r => r.dataUpdatedAt).join(","), profiles]);

  const assignedProfileIds = useMemo(
    () => new Set(deviceGroups.flatMap(g => g.profiles.map(p => p.id))),
    [deviceGroups],
  );
  const unassignedProfiles = useMemo(
    () => [...(profiles ?? [])].filter(p => !assignedProfileIds.has(p.id))
      .sort((a, b) => (a.accountLabel || a.username || "").localeCompare(b.accountLabel || b.username || "")),
    [profiles, assignedProfileIds],
  );

  const selectedProfile = useMemo(() => {
    if (!selectedAccountId || !profiles) return profiles?.[0] ?? null;
    return profiles.find(p => String(p.id) === selectedAccountId) ?? profiles[0] ?? null;
  }, [selectedAccountId, profiles]);

  const metricsStats = useMemo(() => {
    if (!selectedProfile) return [];
    return statsMap.get(selectedProfile.id) ?? [];
  }, [selectedProfile, statsMap]);

  const { data: metricsTools } = useQuery<Tool[]>({
    queryKey: selectedProfile ? [`/api/profiles/${selectedProfile.id}/tools`] : ["no-profile"],
    enabled: !!selectedProfile,
  });

  const { data: apiCallCountData } = useQuery<{ count: number }>({
    queryKey: selectedProfile ? [`/api/profiles/${selectedProfile.id}/api-call-count`] : ["no-profile-api"],
    enabled: !!selectedProfile,
    refetchInterval: 30000,
  });

  const { data: endpointCountsRaw } = useQuery<{ operationName: string; todayCount: number; totalCount: number }[]>({
    queryKey: selectedProfile ? [`/api/profiles/${selectedProfile.id}/api-endpoint-counts`] : ["no-profile-endpoint"],
    enabled: !!selectedProfile,
    refetchInterval: 60000,
  });

  // Filter out HikerAPI calls (not made by the account itself)
  const endpointCountsData = useMemo(
    () => (endpointCountsRaw ?? []).filter(r => r.operationName !== "HikerAPI"),
    [endpointCountsRaw],
  );

  // Sortable columns for the Raw API Endpoint table
  const [epSortCol, setEpSortCol] = useState<"endpoint" | "today" | "total" | "preAccount" | "preGlobal">("endpoint");
  const [epSortDir, setEpSortDir] = useState<"asc" | "desc">("asc");

  const cycleEpSort = (col: typeof epSortCol) => {
    if (epSortCol === col) {
      setEpSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setEpSortCol(col);
      setEpSortDir(col === "endpoint" ? "asc" : "desc");
    }
  };

  const { data: preStatusChangeHitsData } = useQuery<{
    perAccount: { operationName: string; perAccountCount: number }[];
    global: { operationName: string; globalCount: number }[];
  }>({
    queryKey: selectedProfile ? [`/api/profiles/${selectedProfile.id}/pre-status-change-hits`] : ["no-profile-psch"],
    enabled: !!selectedProfile,
    refetchInterval: 60000,
  });

  const perAccountHitsMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of preStatusChangeHitsData?.perAccount ?? []) m[r.operationName] = r.perAccountCount;
    return m;
  }, [preStatusChangeHitsData]);

  const globalHitsMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of preStatusChangeHitsData?.global ?? []) m[r.operationName] = r.globalCount;
    return m;
  }, [preStatusChangeHitsData]);

  const sortedEndpointData = useMemo(() => {
    if (!endpointCountsData.length) return endpointCountsData;
    const dir = epSortDir === "asc" ? 1 : -1;
    return [...endpointCountsData].sort((a, b) => {
      if (epSortCol === "endpoint") return dir * a.operationName.localeCompare(b.operationName);
      if (epSortCol === "today")    return dir * (a.todayCount - b.todayCount);
      if (epSortCol === "total")    return dir * (a.totalCount - b.totalCount);
      if (epSortCol === "preAccount") return dir * ((perAccountHitsMap[a.operationName] ?? 0) - (perAccountHitsMap[b.operationName] ?? 0));
      if (epSortCol === "preGlobal")  return dir * ((globalHitsMap[a.operationName] ?? 0) - (globalHitsMap[b.operationName] ?? 0));
      return 0;
    });
  }, [endpointCountsData, epSortCol, epSortDir, perAccountHitsMap, globalHitsMap]);

  const getStat = (type: string, date: string) =>
    metricsStats.find((s: any) => s.toolType === type && s.date === date)?.count ?? 0;

  const actionStatTypes = ALL_STAT_TYPES.filter(st => !st.isTool);

  const pieData = useMemo(() =>
    endpointCountsData
      .map((ep, idx) => ({ name: cleanEpName(ep.operationName), value: ep.todayCount, color: epColor(ep.operationName, idx) }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value),
  [endpointCountsData]);

  const lifetimePieData = useMemo(() =>
    endpointCountsData
      .map((ep, idx) => ({ name: cleanEpName(ep.operationName), value: ep.totalCount, color: epColor(ep.operationName, idx) }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value),
  [endpointCountsData]);

  const totalToday = useMemo(() =>
    actionStatTypes.reduce((sum, st) => sum + getStat(st.key, today), 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [metricsStats, today]);

  const totalLifetime = useMemo(() =>
    actionStatTypes.reduce((sum, st) => sum + getStat(st.key, "lifetime"), 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [metricsStats]);

  const humanSessionTool = metricsTools?.find(t => t.type === "human_sessions");
  const humanSessionEnabled = humanSessionTool?.enabled ?? false;

  // Extra tracked metrics (stored via incrementStat with these keys)
  const abdToday    = getStat("abd", today);
  const abdLifetime = getStat("abd", "lifetime");
  const bannedToday    = getStat("banned", today);
  const bannedLifetime = getStat("banned", "lifetime");
  const captchaToday    = getStat("captcha", today);
  const captchaLifetime = getStat("captcha", "lifetime");
  const lockedCount = (profiles ?? []).filter(p => p.accountStatus === "locked").length;

  return (
    <AppLayout>
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col gap-0">
        <div className="flex items-center gap-3 mb-3">
          <TabsList className="w-fit">
            <TabsTrigger value="farm" className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" />
              Tool Performance
            </TabsTrigger>
            <TabsTrigger value="metrics" className="flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5" />
              Metrics
            </TabsTrigger>
          </TabsList>
          {activeTab === "metrics" && selectedProfile && (
            <button
              onClick={() => setLocation(`/profiles/${selectedProfile.id}`)}
              className="flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors"
            >
              <Settings2 className="w-3.5 h-3.5" />
              Account Settings
            </button>
          )}
        </div>


        {/* ── Metrics Tab ─────────────────────────────────────────────────────── */}
        <TabsContent value="metrics" className="mt-0">
          <div className="flex flex-col gap-4">
            {/* Account selector — grouped by device */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-muted-foreground whitespace-nowrap">Account:</span>
              <Select
                value={selectedAccountId || (profiles?.[0] ? String(profiles[0].id) : "")}
                onValueChange={setSelectedAccountId}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Select account…" />
                </SelectTrigger>
                <SelectContent className="max-h-[calc(30*2rem)] overflow-y-auto">
                  {deviceGroups.length > 0 ? (
                    <>
                      {deviceGroups.map(group => (
                        <SelectGroup key={group.serial}>
                          <SelectLabel className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-2 py-1.5">
                            <Smartphone className="w-3 h-3" />
                            {group.label}
                          </SelectLabel>
                          {group.profiles.map(p => (
                            <SelectItem key={p.id} value={String(p.id)} className="pl-6">
                              {p.accountLabel || p.username}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                      {unassignedProfiles.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-2 py-1.5">
                            Other
                          </SelectLabel>
                          {unassignedProfiles.map(p => (
                            <SelectItem key={p.id} value={String(p.id)} className="pl-6">
                              {p.accountLabel || p.username}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </>
                  ) : (
                    // Fallback flat list when no device data yet
                    [...(profiles ?? [])].sort((a, b) => (a.accountLabel || a.username || "").localeCompare(b.accountLabel || b.username || "")).map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.accountLabel || p.username}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedProfile && (
                <TrustScoreBadge profileId={selectedProfile.id} />
              )}
            </div>

            {!selectedProfile ? (
              <Card className="desktop-card border-none shadow-sm">
                <CardContent className="py-16 text-center text-muted-foreground">
                  No accounts found. Add an account to view metrics.
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Pie charts — actions only */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card className="desktop-card border-none shadow-sm">
                    <CardHeader className="border-b border-border/50 bg-muted/5 pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <BarChart2 className="w-4 h-4 text-primary" />
                        Today's Endpoint Breakdown
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-4">
                      {pieData.length === 0 ? (
                        <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No actions recorded today</div>
                      ) : (
                        <div className="flex gap-3 items-center">
                          <div className="flex-1 min-w-0 max-h-[220px] overflow-y-auto space-y-0.5 pr-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full">
                            {(() => {
                              const total = pieData.reduce((s, d) => s + d.value, 0);
                              return pieData.map((entry, idx) => (
                                <div key={idx} className="flex items-center justify-between gap-1.5 py-0.5">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: entry.color }} />
                                    <span className="text-[10px] text-muted-foreground truncate">{entry.name}</span>
                                  </div>
                                  <span className="text-[10px] font-semibold text-foreground shrink-0 tabular-nums">{total > 0 ? (entry.value / total * 100).toFixed(1) : "0.0"}%</span>
                                </div>
                              ));
                            })()}
                          </div>
                          <div className="shrink-0 w-[180px]">
                            <ResponsiveContainer width="100%" height={220}>
                              <PieChart>
                                <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="value">
                                  {pieData.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
                                </Pie>
                                <Tooltip formatter={(v: number, n: string) => [v.toLocaleString(), n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="desktop-card border-none shadow-sm">
                    <CardHeader className="border-b border-border/50 bg-muted/5 pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <BarChart2 className="w-4 h-4 text-primary" />
                        Lifetime Endpoint Breakdown
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-4">
                      {lifetimePieData.length === 0 ? (
                        <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No lifetime actions recorded</div>
                      ) : (
                        <div className="flex gap-3 items-center">
                          <div className="flex-1 min-w-0 max-h-[220px] overflow-y-auto space-y-0.5 pr-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full">
                            {(() => {
                              const total = lifetimePieData.reduce((s, d) => s + d.value, 0);
                              return lifetimePieData.map((entry, idx) => (
                                <div key={idx} className="flex items-center justify-between gap-1.5 py-0.5">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: entry.color }} />
                                    <span className="text-[10px] text-muted-foreground truncate">{entry.name}</span>
                                  </div>
                                  <span className="text-[10px] font-semibold text-foreground shrink-0 tabular-nums">{total > 0 ? (entry.value / total * 100).toFixed(1) : "0.0"}%</span>
                                </div>
                              ));
                            })()}
                          </div>
                          <div className="shrink-0 w-[180px]">
                            <ResponsiveContainer width="100%" height={220}>
                              <PieChart>
                                <Pie data={lifetimePieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="value">
                                  {lifetimePieData.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
                                </Pie>
                                <Tooltip formatter={(v: number, n: string) => [v.toLocaleString(), n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Account health & system data points */}
                <Card className="desktop-card border-none shadow-sm">
                  <CardHeader className="border-b border-border/50 bg-muted/5 pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-primary" />
                      Account Health &amp; System
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {/* Total API calls */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                          <Webhook className="w-3 h-3" />Total API Calls
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">
                          {(apiCallCountData?.count ?? 0).toLocaleString()}
                        </span>
                        <span className="text-[10px] text-muted-foreground">all time</span>
                      </div>

                      {/* ABD dismissed */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-500 flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3" />ABD Dismissed
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{abdToday.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">today · {abdLifetime.toLocaleString()} lifetime</span>
                      </div>

                      {/* Captchas encountered */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-yellow-500 flex items-center gap-1">
                          <Activity className="w-3 h-3" />Captchas Hit
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{captchaToday.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">today · {captchaLifetime.toLocaleString()} lifetime</span>
                      </div>

                      {/* Bans / suspensions detected */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-destructive flex items-center gap-1">
                          <PhoneOff className="w-3 h-3" />Bans Detected
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{bannedToday.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">today · {bannedLifetime.toLocaleString()} lifetime</span>
                      </div>

                      {/* Locked accounts */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-red-500 flex items-center gap-1">
                          <Lock className="w-3 h-3" />Locked
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{lockedCount.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">accounts currently locked</span>
                      </div>

                    </div>
                  </CardContent>
                </Card>

                {/* Action data points */}
                <Card className="desktop-card border-none shadow-sm">
                  <CardHeader className="border-b border-border/50 bg-muted/5 pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Zap className="w-4 h-4 text-primary" />
                      Action Totals
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {/* Grand totals */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Total Today</span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{totalToday.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">all actions</span>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Total Lifetime</span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{totalLifetime.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">all actions</span>
                      </div>
                      {/* Per-action breakdown */}
                      {actionStatTypes.map(st => (
                        <div key={st.key} className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                          <span className={`text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${st.color}`}>
                            {st.icon}{st.label}
                          </span>
                          <span className="text-2xl font-bold tabular-nums text-foreground">{getStat(st.key, today).toLocaleString()}</span>
                          <span className="text-[10px] text-muted-foreground">today · {getStat(st.key, "lifetime").toLocaleString()} lifetime</span>
                        </div>
                      ))}
                      {/* HS Cycles — human session activity count */}
                      <div className="rounded-lg border border-border/50 bg-muted/5 p-3 flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-cyan-500 flex items-center gap-1">
                          <Bot className="w-3 h-3" />HS Cycles
                        </span>
                        <span className="text-2xl font-bold tabular-nums text-foreground">{getStat("human_session", today).toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">today · {getStat("human_session", "lifetime").toLocaleString()} lifetime</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Raw API Endpoint Count */}
                <Card className="desktop-card border-none shadow-sm">
                  <CardHeader className="border-b border-border/50 bg-muted/5 pb-3">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Webhook className="w-4 h-4 text-primary" />
                      Raw API Endpoint Count
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    {!endpointCountsData || endpointCountsData.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground text-sm">No API calls recorded yet for this account.</div>
                    ) : (
                      <div className="overflow-x-auto max-h-[340px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-card z-10">
                            <tr className="border-b border-border/50">
                              {([ 
                                { key: "endpoint" as const, label: "Endpoint", align: "left", cls: "text-muted-foreground", pad: "py-2 pr-4" },
                                { key: "today" as const, label: "Today", align: "center", cls: "text-muted-foreground", pad: "py-2 px-3" },
                                { key: "total" as const, label: "Total", align: "center", cls: "text-muted-foreground", pad: "py-2 px-3" },
                                { key: "preAccount" as const, label: "Pre-Change (Account)", align: "center", cls: "text-amber-500/80", pad: "py-2 px-3", title: "Times this endpoint was the last API call before this account's status changed" },
                                { key: "preGlobal" as const, label: "Pre-Change (Global)", align: "center", cls: "text-red-500/80", pad: "py-2 pl-3", title: "Times this endpoint was the last API call before any account's status changed" },
                              ] as const).map(col => (
                                <th
                                  key={col.key}
                                  onClick={() => cycleEpSort(col.key)}
                                  title={col.title ?? undefined}
                                  className={`${col.pad} text-${col.align} text-[10px] font-bold uppercase tracking-wide ${col.cls} whitespace-nowrap cursor-pointer select-none hover:text-foreground transition-colors`}
                                >
                                  {col.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/30">
                            {sortedEndpointData.map(row => (
                              <tr key={row.operationName} className="hover:bg-muted/5 transition-colors">
                                <td className="py-1.5 pr-4 text-[12px] text-foreground">{cleanEpName(row.operationName)}</td>
                                <td className="py-1.5 px-3 text-center tabular-nums text-[12px] font-bold text-foreground">{row.todayCount.toLocaleString()}</td>
                                <td className="py-1.5 px-3 text-center tabular-nums text-[12px] text-foreground">{row.totalCount.toLocaleString()}</td>
                                <td className="py-1.5 px-3 text-center tabular-nums text-[12px] font-bold text-amber-500">{(perAccountHitsMap[row.operationName] ?? 0) > 0 ? (perAccountHitsMap[row.operationName] ?? 0).toLocaleString() : <span className="text-muted-foreground/30">—</span>}</td>
                                <td className="py-1.5 pl-3 text-center tabular-nums text-[12px] font-bold text-red-500">{(globalHitsMap[row.operationName] ?? 0) > 0 ? (globalHitsMap[row.operationName] ?? 0).toLocaleString() : <span className="text-muted-foreground/30">—</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-border/50 bg-muted/5">
                              <td className="py-2 pr-4 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Total ({endpointCountsData.length} endpoints)</td>
                              <td className="py-2 px-3 text-center tabular-nums text-[11px] font-bold text-foreground">
                                {endpointCountsData.reduce((s, r) => s + r.todayCount, 0).toLocaleString()}
                              </td>
                              <td className="py-2 px-3 text-center tabular-nums text-[11px] text-foreground">
                                {endpointCountsData.reduce((s, r) => s + r.totalCount, 0).toLocaleString()}
                              </td>
                              <td className="py-2 px-3 text-center tabular-nums text-[11px] font-bold text-amber-500">
                                {endpointCountsData.reduce((s, r) => s + (perAccountHitsMap[r.operationName] ?? 0), 0).toLocaleString()}
                              </td>
                              <td className="py-2 pl-3 text-center tabular-nums text-[11px] font-bold text-red-500">
                                {endpointCountsData.reduce((s, r) => s + (globalHitsMap[r.operationName] ?? 0), 0).toLocaleString()}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>

              </>
            )}
          </div>
        </TabsContent>

        {/* ── Phone Farm Tab ───────────────────────────────────────────────────── */}
        <TabsContent value="farm" className="mt-0">
          <PhoneFarmTab />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function PhoneFarmTab() {
  const { data, isLoading, isError } = useQuery<{ phones: FarmPhone[]; adbFound: boolean }>({
    queryKey: ["/api/mobile/usb-phones"],
    refetchInterval: 15000,
  });

  const phones = data?.phones ?? [];

  const [farmColOrder, setFarmColOrder] = usePersistentSetting<string[]>(
    "farm_col_order",
    FARM_STAT_LABELS.map(s => s.key),
    (stored, defaults) => {
      const filtered = stored.filter(k => defaults.includes(k));
      const newKeys = defaults.filter(k => !filtered.includes(k));
      return [...filtered, ...newKeys];
    },
  );

  const [farmSortKey, setFarmSortKey] = useState<string | null>(null);
  const [farmSortDir, setFarmSortDir] = useState<"desc" | "asc">("desc");

  const cycleFarmSort = (key: string) => {
    if (farmSortKey === key) {
      setFarmSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setFarmSortKey(key);
      setFarmSortDir("desc");
    }
  };

  const farmDragColRef = useRef<string | null>(null);
  const [farmDragOverCol, setFarmDragOverCol] = useState<string | null>(null);

  const [farmManageColsOpen, setFarmManageColsOpen] = useState(false);

  const [farmVisibleCols, setFarmVisibleCols] = usePersistentSetting<Record<string, boolean>>(
    "farm_visible_cols",
    Object.fromEntries(FARM_STAT_LABELS.map(s => [s.key, true])),
    (stored, defaults) => ({ ...defaults, ...stored }),
  );

  const moveFarmCol = (key: string, dir: -1 | 1) => {
    const idx = farmColOrder.indexOf(key);
    if (idx === -1) return;
    const next = [...farmColOrder];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setFarmColOrder(next);
  };

  const orderedLabels = farmColOrder
    .map(k => FARM_STAT_LABELS.find(s => s.key === k))
    .filter(Boolean)
    .filter(s => farmVisibleCols[s!.key] !== false) as typeof FARM_STAT_LABELS;
  const colCount = 1 + orderedLabels.length;

  return (
    <Card className="desktop-card border-none shadow-sm flex flex-col">
      <CardHeader className="border-b border-border/50 bg-muted/5 flex flex-row items-center justify-between py-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" /> Tool Performance
        </CardTitle>
        <div className="relative">
          <button
            onClick={() => setFarmManageColsOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded hover:bg-muted/40"
          >
            <Settings2 className="w-3.5 h-3.5" /> Columns
          </button>
          {farmManageColsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFarmManageColsOpen(false)} />
              <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[360px] max-h-[80vh] overflow-y-auto">
                <div className="px-5 pt-4 pb-3 border-b border-border">
                  <p className="text-sm font-semibold">Tool Performance Columns</p>
                </div>
                <div className="p-4 flex flex-col gap-1">
                  {farmColOrder.map((key, idx) => {
                    const col = FARM_STAT_LABELS.find(s => s.key === key);
                    if (!col) return null;
                    const visible = farmVisibleCols[key] !== false;
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <div className="flex flex-col mr-0.5">
                          <button
                            onClick={() => moveFarmCol(key, -1)}
                            disabled={idx === 0}
                            className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"
                          >
                            <ChevronUp className="w-2.5 h-2.5" />
                          </button>
                          <button
                            onClick={() => moveFarmCol(key, 1)}
                            disabled={idx === farmColOrder.length - 1}
                            className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"
                          >
                            <ChevronDown className="w-2.5 h-2.5" />
                          </button>
                        </div>
                        <Checkbox
                          id={`farm-col-${key}`}
                          checked={visible}
                          onCheckedChange={checked => {
                            setFarmVisibleCols(prev => ({ ...prev, [key]: !!checked }));
                          }}
                        />
                        <label
                          htmlFor={`farm-col-${key}`}
                          className={`text-sm flex items-center gap-1.5 cursor-pointer select-none ${col.color}`}
                        >
                          {col.icon} {col.label}
                        </label>
                      </div>
                    );
                  })}
                </div>
                <div className="px-4 pb-4">
                  <button
                    onClick={() => {
                      setFarmColOrder(FARM_STAT_LABELS.map(s => s.key));
                      setFarmVisibleCols(Object.fromEntries(FARM_STAT_LABELS.map(s => [s.key, true])));
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 flex flex-col">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead className="text-xs bg-muted/30 text-muted-foreground border-b border-border/50">
              <tr>
                <th className="px-4 py-3 font-bold uppercase tracking-wide text-left w-56">
                  Device / Account
                </th>
                {orderedLabels.map(s => {
                  const isSorted = farmSortKey === s.key;
                  const isDragTarget = farmDragOverCol === s.key;
                  return (
                    <th
                      key={s.key}
                      draggable
                      onDragStart={e => { farmDragColRef.current = s.key; e.dataTransfer.effectAllowed = "move"; }}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (farmDragColRef.current && farmDragColRef.current !== s.key) setFarmDragOverCol(s.key); }}
                      onDrop={e => {
                        e.preventDefault();
                        const from = farmDragColRef.current;
                        farmDragColRef.current = null;
                        setFarmDragOverCol(null);
                        if (!from || from === s.key) return;
                        const fromIdx = farmColOrder.indexOf(from);
                        const toIdx = farmColOrder.indexOf(s.key);
                        if (fromIdx === -1 || toIdx === -1) return;
                        const next = [...farmColOrder];
                        next.splice(fromIdx, 1);
                        next.splice(toIdx, 0, from);
                        setFarmColOrder(next);
                      }}
                      onDragEnd={() => { farmDragColRef.current = null; setFarmDragOverCol(null); }}
                      onClick={() => cycleFarmSort(s.key)}
                      className={`px-3 py-3 text-center uppercase tracking-wide text-[10px] cursor-pointer select-none ${isDragTarget ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                    >
                      <span className={`inline-flex items-center gap-1 transition-opacity ${s.color} ${isSorted ? "opacity-100" : "opacity-60 hover:opacity-100"}`}>
                        {s.icon} {s.label}
                        {isSorted
                          ? <span className="text-[9px]">{farmSortDir === "desc" ? "▼" : "▲"}</span>
                          : <span className="text-[9px] opacity-30">⇅</span>
                        }
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={colCount} className="px-5 py-4 bg-muted/10 h-12" />
                  </tr>
                ))
              ) : isError ? (
                <tr>
                  <td colSpan={colCount} className="px-5 py-12 text-center text-muted-foreground text-sm">
                    <div className="flex items-center justify-center gap-2">
                      <PhoneOff className="w-4 h-4" /> Failed to load device list.
                    </div>
                  </td>
                </tr>
              ) : !data?.adbFound ? (
                <tr>
                  <td colSpan={colCount} className="px-5 py-12 text-center text-muted-foreground text-sm">
                    ADB not found — make sure the API server is running on Windows with ADB installed.
                  </td>
                </tr>
              ) : phones.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-5 py-12 text-center text-muted-foreground text-sm">
                    <div className="flex items-center justify-center gap-2">
                      <PhoneOff className="w-4 h-4" /> No phones connected via USB.
                    </div>
                  </td>
                </tr>
              ) : (
                phones.map(phone => (
                  <PhoneFarmPhoneSection
                    key={phone.serial}
                    phone={phone}
                    farmColOrder={farmColOrder}
                    farmSortKey={farmSortKey}
                    farmSortDir={farmSortDir}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
