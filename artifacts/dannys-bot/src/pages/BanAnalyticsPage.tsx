import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Loader2, BarChart2, Calendar, Globe, AlertTriangle, Shield,
  Clock, TrendingUp, ChevronDown, ChevronUp, UserPlus, UserMinus,
  MessageSquare, Zap, Award, RefreshCw, X, Activity, Hash,
  Sigma, Target, Flame, Cpu,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";

interface ProfileRow {
  id: number;
  username: string;
  accountLabel?: string | null;
  accountStatus?: string | null;
  tags?: string | null;
  notes?: string | null;
}

interface AnalyticsEntry {
  id: number;
  username: string;
  proxyHost: string;
  endpointCount: number;
  endpointSnapshot: string;
  bannedAt?: string;
  flaggedAt?: string;
}

interface EpItem {
  operationName: string;
  date: string;
  source?: string | null;
}

interface ProxyRisk {
  host: string;
  banCount: number;
  automatedCount: number;
  captchaCount: number;
  lockedCount: number;
  total: number;
  accounts: string[];
  entryIds: { ban: number[]; automated: number[]; captcha: number[]; locked: number[] };
}

interface ConcurrencyAlert {
  proxyHost: string;
  accounts: string[];
  times: string[];
  category: string;
}

interface EntryMetrics {
  totalCalls: number;
  callsPerMin: number;
  avgInterCallSec: number;
  burstCount: number;
  actionCount: number;
  sessionCount: number;
  sessionPerAction: number;
  followCount: number;
  sessionPerFollow: number;
  cats: Record<string, number>;
  spanMin: number;
  anomalyScore: number;
}

interface CrossStats {
  n: number;
  callRateMean: number;
  callRateMedian: number;
  callRateStdDev: number;
  callRateP90: number;
  sessionPerActionMean: number;
  sessionPerActionMedian: number;
  sessionPerActionStdDev: number;
  sessionPerFollowMean: number;
  sessionPerFollowMedian: number;
  burstPct: number;
  fastFlagPct: number;
  avgSpanMin: number;
  commonEndpoints: Array<{ name: string; label: string | null; pct: number; category: string }>;
  proxyConcentration: number;
  topProxy: string;
}

// ── Known Instagram mobile-API endpoint labels ───────────────────────────────
const EP_LABELS: Record<string, { label: string; category: "follow" | "unfollow" | "dm" | "like" | "session" | "auth" | "other" }> = {
  "friendships/create":    { label: "Follow",           category: "follow" },
  "friendships/destroy":   { label: "Unfollow",         category: "unfollow" },
  "direct_v2/threads":     { label: "DM Thread",        category: "dm" },
  "direct_v2/broadcast":   { label: "DM Send",          category: "dm" },
  "FollowedUser":          { label: "Follow",           category: "follow" },
  "UnfollowUser":          { label: "Unfollow",         category: "unfollow" },
  "media/like":            { label: "Like",             category: "like" },
  "media/unlike":          { label: "Unlike",           category: "like" },
  "LikeMedia":             { label: "Like",             category: "like" },
  "GetDirectMessages":     { label: "DM Thread",        category: "dm" },
  "feed/timeline":         { label: "Timeline Feed",    category: "session" },
  "ViewTimelineFeedSeen":  { label: "Timeline Seen",    category: "session" },
  "feed/reels_tray":       { label: "Reels Tray",       category: "session" },
  "news/inbox":            { label: "Notifications",    category: "session" },
  "accounts/login":        { label: "Login",            category: "auth" },
  "qe/sync":               { label: "Session Sync",     category: "auth" },
  "launcher/sync":         { label: "Launcher Sync",    category: "auth" },
  "users/info":            { label: "User Info",        category: "session" },
  "discover/people":       { label: "People Discovery", category: "follow" },
  "bloks":                 { label: "Bloks (UI)",        category: "session" },
  "banyan":                { label: "Banyan Check",      category: "auth" },
  "topical_explore":       { label: "Explore",           category: "session" },
  "ProfileSync":           { label: "Profile Sync",      category: "session" },
};

function matchLabel(name: string) {
  for (const [key, val] of Object.entries(EP_LABELS)) {
    if (name === key || name.includes(key)) return val;
  }
  return null;
}

function parseEps(snapshot: string): EpItem[] {
  try { return JSON.parse(snapshot) ?? []; } catch { return []; }
}

function filterHiker(eps: EpItem[]): EpItem[] {
  return eps.filter(e => e.source !== "HikerAPI");
}

function categorise(eps: EpItem[]): Record<string, number> {
  const counts: Record<string, number> = { follow: 0, unfollow: 0, dm: 0, like: 0, session: 0, auth: 0, other: 0 };
  for (const ep of eps) {
    const m = matchLabel(ep.operationName);
    counts[m?.category ?? "other"]++;
  }
  return counts;
}

function topEps(eps: EpItem[], n = 20): Array<{ name: string; count: number; label: string | null; category: string }> {
  const map = new Map<string, number>();
  for (const e of eps) map.set(e.operationName, (map.get(e.operationName) ?? 0) + 1);
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count, label: matchLabel(name)?.label ?? null, category: matchLabel(name)?.category ?? "other" }));
}

// ── Pure maths helpers ────────────────────────────────────────────────────────
function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function pctile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor(p / 100 * s.length), s.length - 1)];
}
function zScore(val: number, m: number, sd: number): number {
  return sd > 0 ? (val - m) / sd : 0;
}

// ── Per-entry metrics computation ─────────────────────────────────────────────
function computeMetrics(eps: EpItem[]): EntryMetrics {
  const cats = categorise(eps);
  const timestamps = eps
    .map(e => new Date(e.date).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  const spanMs = timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const spanMin = spanMs / 60000;
  const callsPerMin = spanMin > 0 ? eps.length / spanMin : 0;

  // Average inter-call gap (seconds)
  let totalGapMs = 0;
  let gapCount = 0;
  for (let i = 1; i < timestamps.length; i++) {
    totalGapMs += timestamps[i] - timestamps[i - 1];
    gapCount++;
  }
  const avgInterCallSec = gapCount > 0 ? totalGapMs / gapCount / 1000 : 0;

  // Burst detection: count pairs of consecutive calls within 60 seconds
  let burstCount = 0;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] - timestamps[i - 1] <= 60000) burstCount++;
  }

  const actionCount = cats.follow + cats.unfollow + cats.dm + cats.like;
  const sessionCount = cats.session;
  const sessionPerAction = actionCount > 0 ? sessionCount / actionCount : sessionCount;
  const sessionPerFollow = cats.follow > 0 ? sessionCount / cats.follow : sessionCount;

  return {
    totalCalls: eps.length,
    callsPerMin,
    avgInterCallSec,
    burstCount,
    actionCount,
    sessionCount,
    sessionPerAction,
    sessionPerFollow,
    followCount: cats.follow,
    cats,
    spanMin,
    anomalyScore: 0,
  };
}

// ── Cross-account statistical analysis ───────────────────────────────────────
function computeCrossStats(entries: AnalyticsEntry[]): CrossStats {
  if (entries.length === 0) {
    return {
      n: 0, callRateMean: 0, callRateMedian: 0, callRateStdDev: 0, callRateP90: 0,
      sessionPerActionMean: 0, sessionPerActionMedian: 0, sessionPerActionStdDev: 0,
      sessionPerFollowMean: 0, sessionPerFollowMedian: 0,
      burstPct: 0, fastFlagPct: 0, avgSpanMin: 0,
      commonEndpoints: [], proxyConcentration: 0, topProxy: "",
    };
  }

  const metricsList = entries.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot))));

  const callRates = metricsList.map(m => m.callsPerMin).filter(v => v > 0);
  const spaList   = metricsList.map(m => m.sessionPerAction).filter(v => v >= 0);
  const spfList   = metricsList.map(m => m.followCount > 0 ? m.sessionPerFollow : -1).filter(v => v >= 0);
  const spanList  = metricsList.map(m => m.spanMin).filter(v => v > 0);

  const burstCount = metricsList.filter(m => m.burstCount > 0).length;
  const fastFlagCount = metricsList.filter(m => m.spanMin > 0 && m.spanMin < 60).length;

  // Common endpoint denominators: endpoints present in ≥50% of accounts
  const epToAccounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    const eps = filterHiker(parseEps(entry.endpointSnapshot));
    for (const ep of eps) {
      if (!epToAccounts.has(ep.operationName)) epToAccounts.set(ep.operationName, new Set());
      epToAccounts.get(ep.operationName)!.add(entry.username);
    }
  }
  const commonEndpoints = Array.from(epToAccounts.entries())
    .map(([name, accs]) => ({
      name,
      label: matchLabel(name)?.label ?? null,
      category: matchLabel(name)?.category ?? "other",
      pct: Math.round(accs.size / entries.length * 100),
    }))
    .filter(t => t.pct >= 50)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 15);

  // Proxy concentration
  const proxyCounts = new Map<string, number>();
  for (const e of entries) {
    const h = e.proxyHost || "(no proxy)";
    proxyCounts.set(h, (proxyCounts.get(h) ?? 0) + 1);
  }
  const topProxyEntry = Array.from(proxyCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  const topProxy = topProxyEntry?.[0] ?? "";
  const proxyConcentration = entries.length > 0 ? Math.round((topProxyEntry?.[1] ?? 0) / entries.length * 100) : 0;

  return {
    n: entries.length,
    callRateMean: mean(callRates),
    callRateMedian: median(callRates),
    callRateStdDev: stddev(callRates),
    callRateP90: pctile(callRates, 90),
    sessionPerActionMean: mean(spaList),
    sessionPerActionMedian: median(spaList),
    sessionPerActionStdDev: stddev(spaList),
    sessionPerFollowMean: mean(spfList),
    sessionPerFollowMedian: median(spfList),
    burstPct: entries.length > 0 ? Math.round(burstCount / entries.length * 100) : 0,
    fastFlagPct: entries.length > 0 ? Math.round(fastFlagCount / entries.length * 100) : 0,
    avgSpanMin: mean(spanList),
    commonEndpoints,
    proxyConcentration,
    topProxy,
  };
}

// ── Anomaly scoring (z-score based, returns 0–100) ──────────────────────────
function computeAnomalyScore(m: EntryMetrics, cross: CrossStats): number {
  if (cross.n < 2) return 0;
  let score = 0;
  // High call rate is suspicious
  if (cross.callRateStdDev > 0) {
    const z = zScore(m.callsPerMin, cross.callRateMean, cross.callRateStdDev);
    score += Math.min(40, Math.max(0, z * 15));
  }
  // Low session per action is suspicious
  if (cross.sessionPerActionStdDev > 0) {
    const z = zScore(cross.sessionPerActionMean, m.sessionPerAction, cross.sessionPerActionStdDev);
    score += Math.min(40, Math.max(0, z * 15));
  }
  // Burst presence adds risk
  if (m.burstCount > 0) score += 10;
  // Very fast flagging adds risk
  if (m.spanMin > 0 && m.spanMin < 30) score += 10;
  return Math.min(100, Math.round(score));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function buildProxyRiskMap(bans: AnalyticsEntry[], automated: AnalyticsEntry[], captcha: AnalyticsEntry[], locked: AnalyticsEntry[]): ProxyRisk[] {
  const map = new Map<string, ProxyRisk>();
  const empty = (): ProxyRisk => ({ host: "", banCount: 0, automatedCount: 0, captchaCount: 0, lockedCount: 0, total: 0, accounts: [], entryIds: { ban: [], automated: [], captcha: [], locked: [] } });
  const add = (entries: AnalyticsEntry[], countKey: keyof Pick<ProxyRisk, "banCount" | "automatedCount" | "captchaCount" | "lockedCount">, idKey: keyof ProxyRisk["entryIds"]) => {
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!map.has(host)) { const r = empty(); r.host = host; map.set(host, r); }
      const r = map.get(host)!;
      r[countKey]++;
      r.total++;
      r.entryIds[idKey].push(e.id);
      if (!r.accounts.includes(e.username)) r.accounts.push(e.username);
    }
  };
  add(bans, "banCount", "ban");
  add(automated, "automatedCount", "automated");
  add(captcha, "captchaCount", "captcha");
  add(locked, "lockedCount", "locked");
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function buildConcurrencyAlerts(bans: AnalyticsEntry[], automated: AnalyticsEntry[], captcha: AnalyticsEntry[], locked: AnalyticsEntry[]): ConcurrencyAlert[] {
  const alerts: ConcurrencyAlert[] = [];
  for (const { entries, label } of [
    { entries: bans, label: "Ban" }, { entries: automated, label: "Automated" },
    { entries: captcha, label: "Captcha" }, { entries: locked, label: "Locked" },
  ]) {
    const byProxy = new Map<string, AnalyticsEntry[]>();
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!byProxy.has(host)) byProxy.set(host, []);
      byProxy.get(host)!.push(e);
    }
    for (const [host, es] of byProxy) {
      if (es.length < 2) continue;
      const sorted = [...es].sort((a, b) => new Date(a.flaggedAt ?? a.bannedAt ?? 0).getTime() - new Date(b.flaggedAt ?? b.bannedAt ?? 0).getTime());
      for (let i = 0; i < sorted.length - 1; i++) {
        const ta = new Date(sorted[i].flaggedAt ?? sorted[i].bannedAt ?? 0).getTime();
        const tb = new Date(sorted[i + 1].flaggedAt ?? sorted[i + 1].bannedAt ?? 0).getTime();
        if (Math.abs(tb - ta) <= 30 * 60 * 1000) {
          alerts.push({ proxyHost: host, accounts: [sorted[i].username, sorted[i + 1].username], times: [sorted[i].flaggedAt ?? sorted[i].bannedAt ?? "", sorted[i + 1].flaggedAt ?? sorted[i + 1].bannedAt ?? ""], category: label });
        }
      }
    }
  }
  return alerts.slice(0, 20);
}

function parseFirstAddedDate(notes: string | null | undefined): Date | null {
  if (!notes) return null;
  const matches = [...notes.matchAll(/Added:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/gi)];
  if (!matches.length) return null;
  const dates = matches
    .map(m => new Date(m[1].replace(" UTC", "Z").replace(" ", "T")))
    .filter(d => !isNaN(d.getTime()));
  if (!dates.length) return null;
  return dates.reduce((earliest, d) => d < earliest ? d : earliest);
}

function parseAllAddedDates(notes: string | null | undefined): Date[] {
  if (!notes) return [];
  const matches = [...notes.matchAll(/(?:Added|Re-added|Re-imported):\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/gi)];
  return matches
    .map(m => new Date(m[1].replace(" UTC", "Z").replace(" ", "T")))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
}

function formatDuration(ms: number): string {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d >= 1) return `${d}d ${h}h`;
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsernameLink({ username, profileMap }: { username: string; profileMap: Map<string, number> }) {
  const [, navigate] = useLocation();
  const id = profileMap.get(username);
  if (!id) return <span className="font-semibold">@{username}</span>;
  return (
    <button
      onClick={() => navigate(`/profiles/${id}`)}
      className="font-semibold hover:text-cyan-400 hover:underline underline-offset-2 transition-colors cursor-pointer"
    >
      @{username}
    </button>
  );
}

type Tab = "ban" | "automated" | "captcha" | "locked" | "survivors";

const TAB_CONFIG: Record<Exclude<Tab, "survivors">, { label: string; accentBg: string; barColor: string; emptyMsg: string; flagMsg: string; deleteEndpoint: string; queryKey: string }> = {
  ban:       { label: "Banned Accounts",     accentBg: "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",       barColor: "bg-red-400",    emptyMsg: "No ban analytics yet",              flagMsg: "Flag accounts as Banned from Accounts → Actions → Flag as Banned.",             deleteEndpoint: "/api/analytics/ban-patterns",       queryKey: "/api/analytics/ban-patterns" },
  automated: { label: "Automated Behaviour", accentBg: "bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800", barColor: "bg-orange-400", emptyMsg: "No automated behaviour events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Automated Behaviour.", deleteEndpoint: "/api/analytics/automated-patterns", queryKey: "/api/analytics/automated-patterns" },
  captcha:   { label: "Captcha Errors",      accentBg: "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800", barColor: "bg-yellow-400", emptyMsg: "No captcha events yet",             flagMsg: "Flag accounts from Accounts → Actions → Flag as Captcha Error.",             deleteEndpoint: "/api/analytics/captcha-patterns",   queryKey: "/api/analytics/captcha-patterns" },
  locked:    { label: "Locked Accounts",     accentBg: "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800",   barColor: "bg-rose-400",   emptyMsg: "No locked account events yet",     flagMsg: "Flag accounts from Accounts → Actions → Flag as Locked Account.",           deleteEndpoint: "/api/analytics/locked-patterns",    queryKey: "/api/analytics/locked-patterns" },
};

const CAT_META: Record<string, { label: string; color: string }> = {
  follow:   { label: "Follow",   color: "bg-cyan-400" },
  unfollow: { label: "Unfollow", color: "bg-orange-400" },
  dm:       { label: "DM",       color: "bg-purple-400" },
  like:     { label: "Like",     color: "bg-pink-400" },
  session:  { label: "Session",  color: "bg-blue-400" },
  auth:     { label: "Auth",     color: "bg-slate-400" },
  other:    { label: "Other",    color: "bg-muted-foreground" },
};

// ── Per-entry card ────────────────────────────────────────────────────────────
function EntryCard({ entry, cfg, cross, profileMap }: { entry: AnalyticsEntry; cfg: typeof TAB_CONFIG[Exclude<Tab, "survivors">]; cross: CrossStats; profileMap: Map<string, number> }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Remove this log entry for @${entry.username}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetch(`${cfg.deleteEndpoint}/${entry.id}`, { method: "DELETE", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: [cfg.queryKey] });
    } finally { setDeleting(false); }
  }

  const allEps = parseEps(entry.endpointSnapshot);
  const eps    = filterHiker(allEps);
  const hikerN = allEps.length - eps.length;
  const m      = computeMetrics(eps);
  const anomaly = computeAnomalyScore(m, cross);
  const top5   = topEps(eps, 5);
  const topFull = topEps(eps, 25);
  const ts     = entry.flaggedAt ?? entry.bannedAt ?? "";

  const anomalyColor = anomaly >= 70 ? "text-red-500" : anomaly >= 40 ? "text-amber-600" : "text-green-600";
  const anomalyLabel = anomaly >= 70 ? "HIGH" : anomaly >= 40 ? "MED" : "LOW";

  const spanStr = m.spanMin < 1
    ? `${Math.round(m.spanMin * 60)}s`
    : m.spanMin < 60 ? `${m.spanMin.toFixed(1)} min`
    : `${(m.spanMin / 60).toFixed(1)} hr`;

  return (
    <div className="border border-border rounded-lg overflow-hidden relative">
      <button
        onClick={handleDelete}
        disabled={deleting}
        title="Remove this log entry"
        className="absolute top-2 right-2 z-10 flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-500 hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors disabled:opacity-40"
      >
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
      </button>

      <button className="w-full px-4 py-3 pr-9 flex items-start gap-3 text-left hover:bg-muted/30 transition-colors" onClick={() => setOpen(o => !o)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <UsernameLink username={entry.username} profileMap={profileMap} />
            {cross.n >= 2 && (
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${anomaly >= 70 ? "bg-red-50 border-red-200 text-red-600" : anomaly >= 40 ? "bg-amber-50 border-amber-200 text-amber-600" : "bg-green-50 border-green-200 text-green-600"}`}>
                ANOMALY {anomalyLabel} {anomaly}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{ts ? new Date(ts).toLocaleString() : "—"}</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {entry.proxyHost
              ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Globe className="w-3 h-3" />{entry.proxyHost}</span>
              : <span className="text-[11px] text-muted-foreground italic">no proxy</span>
            }
          </div>

          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
            <span>{eps.length} calls{hikerN > 0 ? ` (${hikerN} HikerAPI excluded)` : ""}</span>
            {m.callsPerMin > 0 && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{m.callsPerMin.toFixed(2)}/min</span>}
            {m.spanMin > 0 && <span>over {spanStr}</span>}
            {m.avgInterCallSec > 0 && <span>avg gap: {m.avgInterCallSec < 60 ? `${m.avgInterCallSec.toFixed(1)}s` : `${(m.avgInterCallSec/60).toFixed(1)}m`}</span>}
            {m.burstCount > 0 && <span className="text-amber-600 font-semibold">{m.burstCount} burst{m.burstCount !== 1 ? "s" : ""}</span>}
            {m.cats.follow > 0 && <span className="flex items-center gap-1"><UserPlus className="w-3 h-3" />{m.cats.follow}</span>}
            {m.cats.unfollow > 0 && <span className="flex items-center gap-1"><UserMinus className="w-3 h-3" />{m.cats.unfollow}</span>}
            {m.cats.dm > 0 && <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{m.cats.dm}</span>}
            {m.cats.like > 0 && <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{m.cats.like}</span>}
          </div>

          {top5.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {top5.map(ep => (
                <span key={ep.name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${cfg.accentBg}`}>
                  {ep.label ?? ep.name} <span className="opacity-60">×{ep.count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 mt-0.5 text-muted-foreground">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/20 divide-y divide-border">

          {/* Per-entry computed metrics */}
          {eps.length >= 3 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <Sigma className="w-3.5 h-3.5" /> Computed Metrics for this event
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-muted-foreground">API call rate</span><span className="font-mono font-semibold">{m.callsPerMin > 0 ? `${m.callsPerMin.toFixed(3)}/min` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Session span</span><span className="font-mono font-semibold">{m.spanMin > 0 ? spanStr : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg inter-call gap</span><span className="font-mono font-semibold">{m.avgInterCallSec > 0 ? (m.avgInterCallSec < 60 ? `${m.avgInterCallSec.toFixed(1)}s` : `${(m.avgInterCallSec/60).toFixed(1)}m`) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Burst windows (≤60s)</span><span className={`font-mono font-semibold ${m.burstCount > 0 ? "text-amber-600" : ""}`}>{m.burstCount}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Session calls</span><span className="font-mono font-semibold">{m.sessionCount}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Action calls</span><span className="font-mono font-semibold">{m.actionCount}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Session per action</span>
                  <span className={`font-mono font-semibold ${m.actionCount > 0 && m.sessionPerAction < 5 ? "text-red-500" : m.actionCount > 0 && m.sessionPerAction < 10 ? "text-amber-600" : ""}`}>
                    {m.actionCount > 0 ? m.sessionPerAction.toFixed(2) : "no actions"}
                    {m.actionCount > 0 && cross.sessionPerActionMedian > 0 && (
                      <span className="text-muted-foreground font-normal"> (median: {cross.sessionPerActionMedian.toFixed(2)})</span>
                    )}
                  </span>
                </div>
                {m.cats.follow > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Session per follow</span>
                    <span className={`font-mono font-semibold ${m.sessionPerFollow < 5 ? "text-red-500" : m.sessionPerFollow < 10 ? "text-amber-600" : ""}`}>
                      {m.sessionPerFollow.toFixed(2)}
                      {cross.sessionPerFollowMedian > 0 && (
                        <span className="text-muted-foreground font-normal"> (median: {cross.sessionPerFollowMedian.toFixed(2)})</span>
                      )}
                    </span>
                  </div>
                )}
                {cross.n >= 2 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Anomaly score</span>
                    <span className={`font-mono font-semibold ${anomalyColor}`}>{anomaly}/100 ({anomalyLabel})</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action counts */}
          {eps.length >= 5 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Action breakdown</p>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { icon: <UserPlus className="w-3 h-3" />,     label: "Follows",   val: m.cats.follow },
                  { icon: <UserMinus className="w-3 h-3" />,    label: "Unfollows", val: m.cats.unfollow },
                  { icon: <MessageSquare className="w-3 h-3" />, label: "DMs",      val: m.cats.dm },
                  { icon: <Zap className="w-3 h-3" />,          label: "Likes",     val: m.cats.like },
                ].map(({ icon, label, val }) => (
                  <div key={label} className="border border-border rounded p-2 bg-background">
                    <div className="flex items-center gap-1 text-muted-foreground text-[10px] uppercase tracking-wide">{icon} {label}</div>
                    <p className="text-xl font-bold mt-0.5">{val}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full endpoint list */}
          {topFull.length > 0 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <BarChart2 className="w-3.5 h-3.5" /> All endpoints — by call count
              </p>
              <div className="space-y-0.5">
                {topFull.map(ep => (
                  <div key={ep.name} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CAT_META[ep.category]?.color ?? "bg-muted-foreground"}`} />
                    <span className="font-mono text-muted-foreground truncate flex-1">{ep.name}</span>
                    {ep.label && <span className="text-muted-foreground shrink-0">({ep.label})</span>}
                    <span className={`shrink-0 px-1 rounded font-semibold ${cfg.accentBg}`}>{ep.count}×</span>
                  </div>
                ))}
              </div>
              {hikerN > 0 && <p className="text-[10px] text-muted-foreground mt-2 italic">{hikerN} HikerAPI call{hikerN !== 1 ? "s" : ""} excluded.</p>}
            </div>
          )}

          {/* Footer */}
          <div className="px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span>Rate: <strong>{m.callsPerMin > 0 ? `${m.callsPerMin.toFixed(3)}/min` : "—"}</strong></span>
            <span>Session: <strong>{m.sessionCount}</strong></span>
            <span>Auth: <strong>{m.cats.auth}</strong></span>
            <span>Total (session): <strong>{eps.length}</strong></span>
            {hikerN > 0 && <span>HikerAPI: <strong>{hikerN}</strong></span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pattern Intelligence panel (replaces static theory text) ─────────────────
function PatternIntelligence({ entries, cfg }: { entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[Exclude<Tab, "survivors">] }) {
  if (entries.length === 0) return null;

  const cross = computeCrossStats(entries);

  // Compute per-entry metrics for histogram data
  const allMetrics = entries.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot))));
  const callRates = allMetrics.map(m => m.callsPerMin).filter(v => v > 0);
  const spaValues = allMetrics.map(m => m.sessionPerAction).filter(v => v >= 0);
  const gapValues = allMetrics.map(m => m.avgInterCallSec).filter(v => v > 0);

  // Session noise distribution buckets: <3, 3-8, 8-15, 15-30, >30
  const spaBuckets = [
    { label: "<3 (critical)", min: 0, max: 3, color: "bg-red-500" },
    { label: "3–8 (low)", min: 3, max: 8, color: "bg-orange-400" },
    { label: "8–15 (warn)", min: 8, max: 15, color: "bg-yellow-400" },
    { label: "15–30 (ok)", min: 15, max: 30, color: "bg-green-400" },
    { label: ">30 (good)", min: 30, max: Infinity, color: "bg-blue-400" },
  ].map(b => ({ ...b, count: spaValues.filter(v => v >= b.min && v < b.max).length }));

  // Call rate distribution buckets
  const maxRate = Math.max(...callRates, 1);
  const rateBucketWidth = maxRate / 5;
  const rateBuckets = [0, 1, 2, 3, 4].map(i => {
    const min = i * rateBucketWidth;
    const max = (i + 1) * rateBucketWidth;
    return {
      label: `${min.toFixed(2)}–${max.toFixed(2)}/min`,
      count: callRates.filter(v => v >= min && v < max).length,
    };
  });
  const maxRateBucket = Math.max(...rateBuckets.map(b => b.count), 1);

  const maxSpaBucket = Math.max(...spaBuckets.map(b => b.count), 1);

  // Key findings computed from data
  const findings: Array<{ severity: "critical" | "warning" | "info"; text: string }> = [];

  if (cross.n >= 2) {
    if (cross.sessionPerActionMedian < 3)
      findings.push({ severity: "critical", text: `Session noise is critically low — median ${cross.sessionPerActionMedian.toFixed(2)} session reads per action across all ${cross.n} events. Instagram's bot classifier expects ≥10–15. This is the most likely common cause.` });
    else if (cross.sessionPerActionMedian < 8)
      findings.push({ severity: "warning", text: `Session noise is below safe threshold — median ${cross.sessionPerActionMedian.toFixed(2)} session reads per action. Safe range is 10–15+. Increasing timeline/inbox reads between actions would reduce detection risk.` });
    else
      findings.push({ severity: "info", text: `Session noise is in acceptable range — median ${cross.sessionPerActionMedian.toFixed(2)} session reads per action.` });

    if (cross.burstPct >= 70)
      findings.push({ severity: "critical", text: `${cross.burstPct}% of events had burst patterns (2+ API calls within 60 seconds). Rapid-fire calls are a primary bot signal — Instagram's timing analysis can distinguish human pacing from automated loops.` });
    else if (cross.burstPct >= 30)
      findings.push({ severity: "warning", text: `${cross.burstPct}% of events had burst patterns. Bursts are present but not universal — may indicate timing issues in specific tool configurations.` });

    if (cross.fastFlagPct >= 50)
      findings.push({ severity: "critical", text: `${cross.fastFlagPct}% of accounts were flagged within 60 minutes of starting — indicating Instagram's classifier triggered early. This suggests the account fingerprint or IP reputation was already flagged before automation began.` });

    if (cross.callRateMedian > 2)
      findings.push({ severity: "warning", text: `Median API call rate is ${cross.callRateMedian.toFixed(3)}/min (P90: ${cross.callRateP90.toFixed(3)}/min). Rates above 1/min sustained over hours are atypical of human behaviour.` });

    if (cross.proxyConcentration >= 60 && cross.n >= 3)
      findings.push({ severity: "warning", text: `${cross.proxyConcentration}% of events share proxy host "${cross.topProxy}" — this IP has a high event concentration and may already be flagged by Instagram's IP reputation system.` });

    // Standard deviation insight
    if (cross.callRateStdDev > cross.callRateMean * 0.8)
      findings.push({ severity: "info", text: `High variance in call rates (σ=${cross.callRateStdDev.toFixed(3)}, mean=${cross.callRateMean.toFixed(3)}) — behaviour is inconsistent across accounts. The issue is not uniform; check individual account tool settings.` });
    else if (cross.n >= 3)
      findings.push({ severity: "info", text: `Call rates are consistent across accounts (σ=${cross.callRateStdDev.toFixed(3)}, mean=${cross.callRateMean.toFixed(3)}) — the problem pattern is systemic, not account-specific.` });
  } else if (cross.n === 1) {
    const m = allMetrics[0];
    if (m.sessionPerAction < 5 && m.actionCount > 0)
      findings.push({ severity: "critical", text: `Only ${m.sessionPerAction.toFixed(2)} session reads per action — well below the safe threshold of 10–15. Need more data points to confirm this is a systemic issue.` });
    else
      findings.push({ severity: "info", text: `Only 1 event recorded — add more events to enable cross-account pattern analysis.` });
  }

  return (
    <div className="space-y-4">

      {/* Statistical summary */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Sigma className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Cross-Account Statistical Summary</span>
          <span className="text-xs text-muted-foreground ml-auto">{cross.n} event{cross.n !== 1 ? "s" : ""} analysed</span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-border">
          {/* Left: call rate stats */}
          <div className="p-4 space-y-1.5 text-[11px]">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1">
              <Activity className="w-3 h-3" /> API Call Rate (calls/min)
            </p>
            {[
              { label: "Mean", val: cross.callRateMean.toFixed(4) },
              { label: "Median", val: cross.callRateMedian.toFixed(4) },
              { label: "Std Dev (σ)", val: cross.callRateStdDev.toFixed(4) },
              { label: "P90", val: cross.callRateP90.toFixed(4) },
              { label: "Avg session span", val: cross.avgSpanMin > 0 ? (cross.avgSpanMin < 60 ? `${cross.avgSpanMin.toFixed(1)} min` : `${(cross.avgSpanMin/60).toFixed(2)} hr`) : "—" },
            ].map(r => (
              <div key={r.label} className="flex justify-between">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-mono font-semibold">{r.val}</span>
              </div>
            ))}
          </div>
          {/* Right: session noise stats */}
          <div className="p-4 space-y-1.5 text-[11px]">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1">
              <Target className="w-3 h-3" /> Session Noise (reads per action)
            </p>
            {[
              { label: "Mean", val: cross.sessionPerActionMean.toFixed(3) },
              { label: "Median", val: cross.sessionPerActionMedian.toFixed(3) },
              { label: "Std Dev (σ)", val: cross.sessionPerActionStdDev.toFixed(3) },
              { label: "Median (follows only)", val: cross.sessionPerFollowMedian > 0 ? cross.sessionPerFollowMedian.toFixed(3) : "—" },
              { label: "Burst detection rate", val: `${cross.burstPct}% of events` },
            ].map(r => (
              <div key={r.label} className="flex justify-between">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-mono font-semibold">{r.val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Distribution histograms */}
        {cross.n >= 2 && (
          <div className="border-t border-border grid grid-cols-2 divide-x divide-border">
            {/* Session noise distribution */}
            <div className="p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Session noise distribution</p>
              <div className="space-y-1">
                {spaBuckets.map(b => (
                  <div key={b.label} className="flex items-center gap-2 text-[10px]">
                    <span className="w-24 text-muted-foreground shrink-0">{b.label}</span>
                    <div className="flex-1 h-3 bg-muted rounded-sm overflow-hidden">
                      <div className={`h-full ${b.color} rounded-sm`} style={{ width: `${Math.round(b.count / maxSpaBucket * 100)}%` }} />
                    </div>
                    <span className="w-6 text-right font-mono font-semibold">{b.count}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Call rate distribution */}
            <div className="p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Call rate distribution</p>
              <div className="space-y-1">
                {rateBuckets.map(b => (
                  <div key={b.label} className="flex items-center gap-2 text-[10px]">
                    <span className="w-32 text-muted-foreground shrink-0 truncate">{b.label}</span>
                    <div className="flex-1 h-3 bg-muted rounded-sm overflow-hidden">
                      <div className="h-full bg-cyan-400 rounded-sm" style={{ width: `${Math.round(b.count / maxRateBucket * 100)}%` }} />
                    </div>
                    <span className="w-6 text-right font-mono font-semibold">{b.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Computed findings */}
      {findings.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-semibold">Data-Derived Findings</span>
            <span className="text-xs text-muted-foreground ml-auto">computed from your actual event data</span>
          </div>
          <div className="divide-y divide-border">
            {findings.map((f, i) => (
              <div key={i} className="px-4 py-3 flex gap-3">
                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${f.severity === "critical" ? "bg-red-500" : f.severity === "warning" ? "bg-amber-500" : "bg-blue-400"}`} />
                <p className="text-[11px] text-foreground leading-relaxed">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Common denominators */}
      {cross.commonEndpoints.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Hash className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-semibold">Common Endpoint Denominators</span>
            <span className="text-xs text-muted-foreground ml-auto">endpoints present in ≥50% of flagged accounts</span>
          </div>
          <div className="divide-y divide-border">
            {cross.commonEndpoints.map(ep => (
              <div key={ep.name} className="px-4 py-2 flex items-center gap-3">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CAT_META[ep.category]?.color ?? "bg-muted-foreground"}`} />
                <span className="font-mono text-[11px] text-foreground flex-1 truncate">{ep.name}</span>
                {ep.label && <span className="text-[11px] text-muted-foreground shrink-0">({ep.label})</span>}
                <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
                  <div className="h-full bg-purple-400 rounded-full" style={{ width: `${ep.pct}%` }} />
                </div>
                <span className="text-[11px] font-mono font-semibold w-10 text-right shrink-0">{ep.pct}%</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 bg-muted/20 text-[10px] text-muted-foreground">
            These endpoints appear in the majority of flagged accounts — they are the common denominators of your flag events.
          </div>
        </div>
      )}

      {/* Anomaly ranking */}
      {cross.n >= 3 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Cpu className="w-4 h-4 text-red-500" />
            <span className="text-sm font-semibold">Anomaly Ranking</span>
            <span className="text-xs text-muted-foreground ml-auto">z-score based — which accounts deviate most from the group median</span>
          </div>
          <div className="p-3 text-[11px] text-muted-foreground italic">
            See individual event cards below — each shows an Anomaly score (0–100) comparing that account's call rate, session noise and burst patterns to the group median. A high score means that account deviates significantly from the others.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab content panel ─────────────────────────────────────────────────────────
function EntryList({ entries, cfg, profileMap }: { entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[Exclude<Tab, "survivors">]; profileMap: Map<string, number> }) {
  const [showAll, setShowAll] = useState(false);
  const cross = computeCrossStats(entries);

  if (entries.length === 0) return (
    <div className="border border-border rounded-lg p-10 text-center">
      <p className="text-sm font-medium">{cfg.emptyMsg}</p>
      <p className="text-xs text-muted-foreground mt-1">{cfg.flagMsg}</p>
    </div>
  );

  const reversed = [...entries].reverse();
  const visible = showAll ? reversed : reversed.slice(0, 3);

  return (
    <div className="space-y-4">
      <PatternIntelligence entries={entries} cfg={cfg} />

      {/* Event History */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Event History</span>
          <span className="text-xs text-muted-foreground ml-auto">
            {showAll ? `${entries.length} events` : `${Math.min(3, entries.length)} of ${entries.length}`} — click any row to expand
          </span>
        </div>
        <div className="p-3 space-y-2">
          {visible.map(entry => (
            <EntryCard key={entry.id} entry={entry} cfg={cfg} cross={cross} profileMap={profileMap} />
          ))}
        </div>
        {entries.length > 3 && (
          <div className="px-4 py-2 border-t border-border flex items-center justify-center">
            <button
              onClick={() => setShowAll(o => !o)}
              className="text-xs text-cyan-500 hover:text-cyan-400 font-semibold transition-colors flex items-center gap-1"
            >
              {showAll ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showAll ? "Show less" : `Show all ${entries.length} events`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProxyRankRow({ pr, i, profileMap }: { pr: ProxyRisk; i: number; profileMap: Map<string, number> }) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete all ${pr.total} log ${pr.total === 1 ? "entry" : "entries"} for ${pr.host}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const calls: Promise<unknown>[] = [
        ...pr.entryIds.ban.map(id => fetch(`/api/analytics/ban-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.automated.map(id => fetch(`/api/analytics/automated-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.captcha.map(id => fetch(`/api/analytics/captcha-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.locked.map(id => fetch(`/api/analytics/locked-patterns/${id}`, { method: "DELETE", credentials: "include" })),
      ];
      await Promise.all(calls);
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/ban-patterns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/automated-patterns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/captcha-patterns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/locked-patterns"] });
    } finally { setDeleting(false); }
  }

  return (
    <div className="px-4 py-2.5 flex items-center gap-3 relative group">
      <span className="text-xs text-muted-foreground w-6 text-right shrink-0">#{i + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-sm font-mono truncate">{pr.host}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 font-semibold">{pr.banCount}B</span>
        <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 font-semibold">{pr.automatedCount}A</span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 font-semibold">{pr.captchaCount}C</span>
        <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-600 font-semibold">{pr.lockedCount}L</span>
        <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{pr.total}</span>
      </div>
      <button
        onClick={handleDelete}
        disabled={deleting}
        title="Delete all entries for this proxy"
        className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-500 hover:bg-red-200 dark:hover:bg-red-800/60 transition-all disabled:opacity-40 shrink-0"
      >
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
      </button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function BanAnalyticsPage() {
  const setSidebarSlot = useSidebarSetSlot();
  useEffect(() => { setSidebarSlot(null); return () => setSidebarSlot(null); }, []);
  const [, navigate] = useLocation();

  const [activeTab, setActiveTab] = useState<Tab>("ban");

  const { data: banEntries = [], isLoading: banLoading } = useQuery<AnalyticsEntry[]>({
    queryKey: ["/api/analytics/ban-patterns"],
    queryFn: async () => (await fetch("/api/analytics/ban-patterns", { credentials: "include" })).json(),
    refetchInterval: 30000,
  });
  const { data: automatedEntries = [], isLoading: autoLoading } = useQuery<AnalyticsEntry[]>({
    queryKey: ["/api/analytics/automated-patterns"],
    queryFn: async () => (await fetch("/api/analytics/automated-patterns", { credentials: "include" })).json(),
    refetchInterval: 30000,
  });
  const { data: captchaEntries = [], isLoading: captchaLoading } = useQuery<AnalyticsEntry[]>({
    queryKey: ["/api/analytics/captcha-patterns"],
    queryFn: async () => (await fetch("/api/analytics/captcha-patterns", { credentials: "include" })).json(),
    refetchInterval: 30000,
  });
  const { data: lockedEntries = [], isLoading: lockedLoading } = useQuery<AnalyticsEntry[]>({
    queryKey: ["/api/analytics/locked-patterns"],
    queryFn: async () => (await fetch("/api/analytics/locked-patterns", { credentials: "include" })).json(),
    refetchInterval: 30000,
  });
  const { data: allProfiles = [] } = useQuery<ProfileRow[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => (await fetch("/api/profiles", { credentials: "include" })).json(),
    refetchInterval: 60000,
  });

  const isLoading = banLoading || autoLoading || captchaLoading || lockedLoading;
  const profileMap = new Map<string, number>(allProfiles.map(p => [p.username, p.id]));

  const flaggedUsernames = new Set([
    ...banEntries.map(e => e.username),
    ...automatedEntries.map(e => e.username),
    ...captchaEntries.map(e => e.username),
    ...lockedEntries.map(e => e.username),
  ]);
  const now = Date.now();
  const survivingAccounts = allProfiles
    .filter(p => {
      const st = (p.accountStatus ?? "").toLowerCase().replace(/_/g, " ");
      return st === "valid" && !flaggedUsernames.has(p.username);
    })
    .map(p => {
      const firstDate = parseFirstAddedDate(p.notes);
      const allDates  = parseAllAddedDates(p.notes);
      const mostRecentDate = allDates.length > 0 ? allDates[allDates.length - 1] : firstDate;
      return { ...p, firstDate, allDates, runMs: mostRecentDate ? now - mostRecentDate.getTime() : null };
    })
    .filter(p => p.firstDate !== null)
    .sort((a, b) => (a.runMs ?? 0) > (b.runMs ?? 0) ? -1 : 1)
    .slice(0, 20);

  const proxyRisks = buildProxyRiskMap(banEntries, automatedEntries, captchaEntries, lockedEntries);
  const concurrencyAlerts = buildConcurrencyAlerts(banEntries, automatedEntries, captchaEntries, lockedEntries);

  const activeEntries = activeTab === "ban" ? banEntries : activeTab === "automated" ? automatedEntries : activeTab === "captcha" ? captchaEntries : lockedEntries;
  const TABS: Tab[] = ["ban", "automated", "captcha", "locked", "survivors"];
  const TAB_LABELS: Record<Tab, string> = {
    ban: "Banned Accounts", automated: "Automated Behaviour", captcha: "Captcha Errors", locked: "Locked Accounts", survivors: "Top Survivors",
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto space-y-6">

          <div className="flex items-center gap-3">
            <svg className="w-6 h-6" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ color: "#1AD2F2" }}>
              <path fill="currentColor" fillRule="evenodd" d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/>
              <rect fill="currentColor" x="14.8" y="14.2" width="8.5" height="3.8" rx="1.9" transform="rotate(45 14.8 14.2)"/>
            </svg>
            <div>
              <h1 className="text-xl font-bold">Evasion Stats</h1>
              <p className="text-sm text-muted-foreground">Statistical analysis computed from your actual API call data — session noise, burst patterns, call rates, common denominators</p>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading analytics…</span>
            </div>
          )}

          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex border-b border-border overflow-x-auto">
              {TABS.map(tab => {
                const count = tab === "ban" ? banEntries.length
                  : tab === "automated" ? automatedEntries.length
                  : tab === "captcha" ? captchaEntries.length
                  : tab === "locked" ? lockedEntries.length
                  : survivingAccounts.length;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors whitespace-nowrap flex items-center justify-center gap-1.5 ${activeTab === tab ? "bg-muted text-foreground border-b-2 border-cyan-500" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {tab === "survivors" && <Award className="w-3 h-3 text-green-500 shrink-0" />}
                    {TAB_LABELS[tab]}
                    <span className="opacity-60">({count})</span>
                  </button>
                );
              })}
            </div>
            <div className="p-4">
              {activeTab === "survivors" ? (
                survivingAccounts.length === 0 ? (
                  <div className="border border-border rounded-lg p-10 text-center">
                    <Award className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm font-medium">No surviving accounts tracked yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Valid accounts with an "Added:" timestamp in their Notes will appear here.</p>
                  </div>
                ) : (
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                      <Award className="w-4 h-4 text-green-500" />
                      <span className="text-sm font-semibold">Top Surviving Accounts</span>
                      <span className="text-xs text-muted-foreground ml-auto">Timer resets on each re-import — only genuine long runners surface</span>
                    </div>
                    <div className="divide-y divide-border">
                      {survivingAccounts.map((p, i) => {
                        const reAdded = p.allDates.length > 1;
                        return (
                          <div key={p.id} className="px-4 py-2.5 flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-6 text-right shrink-0 font-bold">#{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <UsernameLink username={p.username} profileMap={profileMap} />
                                {p.accountLabel && p.accountLabel !== p.username && (
                                  <span className="text-[11px] text-muted-foreground truncate">{p.accountLabel}</span>
                                )}
                                {reAdded && (
                                  <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-300 dark:border-blue-700 font-semibold shrink-0">
                                    <RefreshCw className="w-2.5 h-2.5" /> re-added {p.allDates.length - 1}×
                                  </span>
                                )}
                                {p.tags && p.tags !== "No Group Assigned" && (
                                  <span className="text-[10px] text-muted-foreground shrink-0">{p.tags}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                                <span>First added: {p.firstDate!.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                                {reAdded && <span>Latest re-add: {p.allDates[p.allDates.length - 1].toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-base font-bold text-green-600 dark:text-green-400">{formatDuration(p.runMs!)}</p>
                              <p className="text-[10px] text-muted-foreground">since last add</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              ) : (
                <EntryList entries={activeEntries} cfg={TAB_CONFIG[activeTab as Exclude<Tab, "survivors">]} profileMap={profileMap} />
              )}
            </div>
          </div>

          {proxyRisks.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-500" />
                <span className="text-sm font-semibold">Proxy Risk Ranking</span>
                <span className="text-xs text-muted-foreground ml-auto">Ban / Automated / Captcha / Locked per IP</span>
              </div>
              <div className="divide-y divide-border">
                {proxyRisks.map((pr, i) => (
                  <ProxyRankRow key={pr.host} pr={pr} i={i} profileMap={profileMap} />
                ))}
              </div>
            </div>
          )}

          {concurrencyAlerts.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-semibold">Concurrent Usage Alerts</span>
                <span className="text-xs text-muted-foreground ml-auto">2+ accounts on same proxy flagged within 30 min</span>
              </div>
              <div className="divide-y divide-border">
                {concurrencyAlerts.map((alert, i) => (
                  <div key={i} className="px-4 py-3 flex items-start gap-3">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono">{alert.proxyHost}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{alert.category}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 flex-wrap">
                        <UsernameLink username={alert.accounts[0]} profileMap={profileMap} />
                        <span>and</span>
                        <UsernameLink username={alert.accounts[1]} profileMap={profileMap} />
                        <span>— {alert.times[0] ? new Date(alert.times[0]).toLocaleTimeString() : "?"} &amp; {alert.times[1] ? new Date(alert.times[1]).toLocaleTimeString() : "?"}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </AppLayout>
  );
}
