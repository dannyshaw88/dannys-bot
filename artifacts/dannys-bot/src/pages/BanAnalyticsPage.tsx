import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Loader2, BarChart2, Calendar, Globe, AlertTriangle, Shield,
  Clock, TrendingUp, ChevronDown, ChevronUp, UserPlus, UserMinus,
  MessageSquare, Zap, Award, RefreshCw, X,
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

// ── Per-tab reasoning statements ─────────────────────────────────────────────
const TAB_REASONING: Record<Exclude<Tab, "survivors">, string> = {
  ban: "REASONING: A permanent ban occurs when Instagram is certain the account is bot-operated. Key triggers: high follow/unfollow velocity with minimal session noise (timeline reads, inbox checks), device fingerprint inconsistencies, or being on a proxy that has flagged multiple accounts. Target ratio is ~15 timeline reads · ~15 DM inbox checks per 1 follow action. Accounts below this ratio look automated.",
  automated: "REASONING: Automated Behaviour Detected is Instagram's soft warning — it does not ban the account but throttles it and monitors more closely. Primary signal: action calls (follows, likes) outweigh session calls (timeline, story views, inbox checks). A ratio of follow:timeline below 1:5 is a strong trigger. Timing also matters — actions fired in rapid bursts with no browsing gaps between them are a clear bot pattern.",
  captcha: "REASONING: Captcha challenges fire when Instagram detects an unusual session — new device fingerprint, IP change, high velocity, or simultaneous sessions. The challenge is separate from automated behaviour detection; it means Instagram wants human proof before allowing further actions. Accounts that immediately retry actions after a captcha without solving it escalate to locked or banned status.",
  locked: "REASONING: Account Locked is a security hold — Instagram detected something suspicious enough to suspend action entirely and force a recovery flow (email/phone confirmation). Common triggers: rapid credential change, proxy IP that differs from previous sessions, or being flagged on a shared proxy where another account was simultaneously acting. Recovery requires identity verification through Instagram's challenge flow.",
};

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

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseEps(snapshot: string): EpItem[] {
  try { return JSON.parse(snapshot) ?? []; } catch { return []; }
}

function filterHiker(eps: EpItem[]): EpItem[] {
  return eps.filter(e => e.source !== "HikerAPI");
}

function getCallRateNum(eps: EpItem[]): number {
  if (eps.length < 2) return 0;
  const dates = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (dates.length < 2) return 0;
  const spanMs = dates[dates.length - 1] - dates[0];
  if (spanMs <= 0) return 0;
  return eps.length / (spanMs / 60000);
}

function getSpanMinutes(eps: EpItem[]): number {
  if (eps.length < 2) return 0;
  const dates = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (dates.length < 2) return 0;
  return (dates[dates.length - 1] - dates[0]) / 60000;
}

function categorise(eps: EpItem[]) {
  const counts: Record<string, number> = { follow: 0, unfollow: 0, dm: 0, like: 0, session: 0, auth: 0, other: 0 };
  for (const ep of eps) {
    const m = matchLabel(ep.operationName);
    counts[m?.category ?? "other"]++;
  }
  return counts;
}

function topEps(eps: EpItem[], n = 10): Array<{ name: string; count: number; label: string | null }> {
  const map = new Map<string, number>();
  for (const e of eps) map.set(e.operationName, (map.get(e.operationName) ?? 0) + 1);
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count, label: matchLabel(name)?.label ?? null }));
}

function buildFindings(eps: EpItem[], allSameType: AnalyticsEntry[]): string[] {
  const findings: string[] = [];
  const cats = categorise(eps);
  const rate = getCallRateNum(eps);
  const span = getSpanMinutes(eps);

  if (eps.length < 5) {
    findings.push(`Only ${eps.length} Instagram API call${eps.length !== 1 ? "s" : ""} captured — not enough activity to identify a pattern. The account may have been flagged very early or after a short session.`);
    return findings;
  }

  const spanStr = span < 1 ? `${Math.round(span * 60)}s` : span < 60 ? `${span.toFixed(1)} min` : `${(span / 60).toFixed(1)} hr`;

  if (cats.follow > 0) {
    const perHour = span > 0 ? Math.round(cats.follow / (span / 60)) : 0;
    findings.push(`Follow: ${cats.follow} calls over ${spanStr}${perHour > 0 ? ` — ${perHour}/hr` : ""}.`);
  }
  if (cats.unfollow > 0) {
    const perHour = span > 0 ? Math.round(cats.unfollow / (span / 60)) : 0;
    findings.push(`Unfollow: ${cats.unfollow} calls over ${spanStr}${perHour > 0 ? ` — ${perHour}/hr` : ""}.`);
  }
  if (cats.dm > 0) {
    findings.push(`DM: ${cats.dm} calls captured.`);
  }
  if (cats.like > 0) {
    const perHour = span > 0 ? Math.round(cats.like / (span / 60)) : 0;
    findings.push(`Likes: ${cats.like} calls over ${spanStr}${perHour > 0 ? ` — ${perHour}/hr` : ""}.`);
  }
  if (rate > 0) {
    findings.push(`API call rate: ${rate.toFixed(2)}/min (${eps.length} calls across ${spanStr}).`);
  }
  if (cats.follow === 0 && cats.unfollow === 0 && cats.dm === 0 && cats.like === 0) {
    findings.push(`No follow, unfollow, DM or like calls recorded — activity was session/auth only (${eps.length} calls).`);
  }

  return findings;
}

// ── Aggregate endpoint ratio analysis across all flagged entries ──────────────
function buildRatioAnalysis(entries: AnalyticsEntry[]): {
  totals: Record<string, number>;
  totalCalls: number;
  dominantAction: string;
} {
  const totals: Record<string, number> = { follow: 0, unfollow: 0, dm: 0, like: 0, session: 0, auth: 0, other: 0 };
  let totalCalls = 0;
  for (const entry of entries) {
    const eps = filterHiker(parseEps(entry.endpointSnapshot));
    const cats = categorise(eps);
    for (const [k, v] of Object.entries(cats)) {
      if (k in totals) totals[k] = (totals[k] || 0) + (v as number);
    }
    totalCalls += eps.length;
  }
  const actionCats = ["follow", "unfollow", "dm", "like"];
  let dominantAction = "follow";
  let maxCount = 0;
  for (const cat of actionCats) {
    if (totals[cat] > maxCount) { maxCount = totals[cat]; dominantAction = cat; }
  }
  return { totals, totalCalls, dominantAction };
}

function buildCrossTrend(entries: AnalyticsEntry[]): Array<{ endpoint: string; label: string | null; accountCount: number; pct: number }> {
  if (entries.length < 2) return [];
  const epToAccounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    const eps = filterHiker(parseEps(entry.endpointSnapshot));
    for (const ep of eps) {
      if (!epToAccounts.has(ep.operationName)) epToAccounts.set(ep.operationName, new Set());
      epToAccounts.get(ep.operationName)!.add(entry.username);
    }
  }
  return Array.from(epToAccounts.entries())
    .map(([endpoint, accs]) => ({
      endpoint,
      label: matchLabel(endpoint)?.label ?? null,
      accountCount: accs.size,
      pct: Math.round(accs.size / entries.length * 100),
    }))
    .filter(t => t.pct >= 50)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 12);
}

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

// ── Surviving accounts helpers ────────────────────────────────────────────────
// Parses the original "Added: YYYY-MM-DD HH:MM:SS UTC" stamp (first-ever add).
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

// Returns ALL add/re-add/re-import timestamps in chronological order.
// Matches: "Added:", "Re-added:", "Re-imported:"
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

// ── Clickable @username link ──────────────────────────────────────────────────
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

// ── Per-entry card ────────────────────────────────────────────────────────────
function EntryCard({ entry, cfg, allSameType, profileMap }: { entry: AnalyticsEntry; cfg: typeof TAB_CONFIG[Exclude<Tab, "survivors">]; allSameType: AnalyticsEntry[]; profileMap: Map<string, number> }) {
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
    } finally {
      setDeleting(false);
    }
  }

  const allEps   = parseEps(entry.endpointSnapshot);
  const eps      = filterHiker(allEps);
  const hikerN   = allEps.length - eps.length;
  const cats     = categorise(eps);
  const rate     = getCallRateNum(eps);
  const findings = buildFindings(eps, allSameType);
  const top5     = topEps(eps, 5);
  const topFull  = topEps(eps, 20);
  const ts       = entry.flaggedAt ?? entry.bannedAt ?? "";

  const proxyOverlap = allSameType.filter(e => e.id !== entry.id && e.proxyHost && e.proxyHost === entry.proxyHost);

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
            <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{ts ? new Date(ts).toLocaleString() : "—"}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {entry.proxyHost
              ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Globe className="w-3 h-3" />{entry.proxyHost}</span>
              : <span className="text-[11px] text-muted-foreground italic">no proxy</span>
            }
          </div>

          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
            <span>{eps.length} calls{hikerN > 0 ? ` (${hikerN} HikerAPI excluded)` : ""}</span>
            {rate > 0 && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{rate.toFixed(2)}/min</span>}
            {cats.follow > 0   && <span className="flex items-center gap-1"><UserPlus className="w-3 h-3" />{cats.follow} follows</span>}
            {cats.unfollow > 0 && <span className="flex items-center gap-1"><UserMinus className="w-3 h-3" />{cats.unfollow} unfollows</span>}
            {cats.dm > 0       && <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{cats.dm} DMs</span>}
            {cats.like > 0     && <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{cats.like} likes</span>}
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

          {/* Findings */}
          <div className="px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">What happened</p>
            <ul className="space-y-1">
              {findings.map((f, i) => (
                <li key={i} className="text-xs text-foreground flex gap-2">
                  <span className="text-muted-foreground shrink-0 mt-0.5">→</span>
                  <span>{f}</span>
                </li>
              ))}
              {proxyOverlap.length > 0 && (
                <li className="text-xs text-foreground flex gap-2">
                  <span className="text-yellow-600 shrink-0 mt-0.5">→</span>
                  <span>
                    {proxyOverlap.length} other account{proxyOverlap.length !== 1 ? "s" : ""} on the same proxy ({entry.proxyHost}) also {cfg.label.toLowerCase()}:{" "}
                    {proxyOverlap.map((e, i) => (
                      <span key={e.id}>{i > 0 ? ", " : ""}<UsernameLink username={e.username} profileMap={profileMap} /></span>
                    ))}.
                  </span>
                </li>
              )}
            </ul>
          </div>

          {/* Action counts grid */}
          {eps.length >= 5 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Action counts (Instagram session only)</p>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { icon: <UserPlus className="w-3 h-3" />,    label: "Follows",   val: cats.follow },
                  { icon: <UserMinus className="w-3 h-3" />,   label: "Unfollows", val: cats.unfollow },
                  { icon: <MessageSquare className="w-3 h-3" />, label: "DMs",     val: cats.dm },
                  { icon: <Zap className="w-3 h-3" />,         label: "Likes",     val: cats.like },
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
                <BarChart2 className="w-3.5 h-3.5" /> Top endpoints (Instagram session)
              </p>
              <div className="space-y-0.5">
                {topFull.map(ep => (
                  <div key={ep.name} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-muted-foreground truncate flex-1">{ep.name}</span>
                    {ep.label && <span className="text-muted-foreground shrink-0">({ep.label})</span>}
                    <span className={`shrink-0 px-1 rounded font-semibold ${cfg.accentBg}`}>{ep.count}×</span>
                  </div>
                ))}
              </div>
              {hikerN > 0 && (
                <p className="text-[10px] text-muted-foreground mt-2 italic">{hikerN} HikerAPI call{hikerN !== 1 ? "s" : ""} excluded from this list.</p>
              )}
            </div>
          )}

          {/* Footer stats */}
          <div className="px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span>Rate: <strong>{rate > 0 ? `${rate.toFixed(2)}/min` : "—"}</strong></span>
            <span>Session reads: <strong>{cats.session}</strong></span>
            <span>Auth syncs: <strong>{cats.auth}</strong></span>
            <span>Total (session): <strong>{eps.length}</strong></span>
            {hikerN > 0 && <span>HikerAPI excluded: <strong>{hikerN}</strong></span>}
          </div>

        </div>
      )}
    </div>
  );
}

const RATIO_CAT_META: { key: string; label: string; color: string; target: number }[] = [
  { key: "session", label: "Timeline / Session",  color: "bg-blue-400",   target: 15 },
  { key: "dm",      label: "DM Inbox Checks",     color: "bg-purple-400", target: 15 },
  { key: "like",    label: "Likes",               color: "bg-pink-400",   target: 5  },
  { key: "follow",  label: "Follows",             color: "bg-cyan-400",   target: 1  },
  { key: "unfollow",label: "Unfollows",           color: "bg-orange-400", target: 1  },
  { key: "auth",    label: "Auth Syncs",          color: "bg-slate-400",  target: 3  },
];

// ── Tab content panel ─────────────────────────────────────────────────────────
function EntryList({ entries, cfg, tabKey, profileMap }: { entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[Exclude<Tab, "survivors">]; tabKey: Exclude<Tab, "survivors">; profileMap: Map<string, number> }) {
  const [showAll, setShowAll] = useState(false);

  if (entries.length === 0) return (
    <div className="border border-border rounded-lg p-10 text-center">
      <p className="text-sm font-medium">{cfg.emptyMsg}</p>
      <p className="text-xs text-muted-foreground mt-1">{cfg.flagMsg}</p>
    </div>
  );

  const ratio = buildRatioAnalysis(entries);
  const dominantMeta = RATIO_CAT_META.find(m => m.key === ratio.dominantAction) ?? RATIO_CAT_META[3];
  const dominantCount = ratio.totals[ratio.dominantAction] || 1;

  const reversed = [...entries].reverse();
  const visible = showAll ? reversed : reversed.slice(0, 3);

  return (
    <div className="space-y-4">

      {/* ── Reasoning ── */}
      <div className="border border-amber-300 dark:border-amber-700 rounded-lg bg-amber-50 dark:bg-amber-900/10 px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-1">Logic &amp; Reasoning — {cfg.label}</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">{TAB_REASONING[tabKey]}</p>
      </div>

      {/* ── Endpoint Ratio Analysis ── */}
      {ratio.totalCalls >= 5 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-cyan-500" />
            <span className="text-sm font-semibold">Endpoint Ratio Analysis</span>
            <span className="text-xs text-muted-foreground ml-auto">{entries.length} event{entries.length !== 1 ? "s" : ""} · {ratio.totalCalls.toLocaleString()} total calls aggregated</span>
          </div>
          <div className="divide-y divide-border">
            {RATIO_CAT_META.map(({ key, label, color, target }) => {
              const count = ratio.totals[key] || 0;
              const actualRatio = dominantCount > 0 ? count / dominantCount : 0;
              const barPct = Math.min(100, Math.round(count / (ratio.totalCalls || 1) * 300));
              const isLow = count > 0 && actualRatio < target * 0.4;
              const isHigh = count > 0 && actualRatio > target * 2 && key !== ratio.dominantAction;
              return (
                <div key={key} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-xs w-36 shrink-0 text-muted-foreground">{label}</span>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${barPct}%` }} />
                  </div>
                  <span className="text-xs w-12 text-right font-mono text-foreground">{count.toLocaleString()}</span>
                  <span className="text-[11px] w-24 text-right">
                    <strong className={isLow ? "text-amber-600" : isHigh ? "text-red-500" : "text-foreground"}>
                      {actualRatio >= 10 ? actualRatio.toFixed(0) : actualRatio.toFixed(1)}x
                    </strong>
                    <span className="text-muted-foreground"> / ~{target}x</span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="px-4 py-2 bg-muted/30 text-[10px] text-muted-foreground">
            Ratios expressed relative to dominant action ({dominantMeta.label}). Target column shows estimated healthy ratio per 1 {dominantMeta.label.toLowerCase()} call. <span className="text-amber-600 font-semibold">Amber</span> = below target (not enough session noise). <span className="text-red-500 font-semibold">Red</span> = far above target.
          </div>
        </div>
      )}

      {/* ── Event History ── */}
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
            <EntryCard key={entry.id} entry={entry} cfg={cfg} allSameType={entries} profileMap={profileMap} />
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
    } finally {
      setDeleting(false);
    }
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

  // username → profile id map for clickable @mentions
  const profileMap = new Map<string, number>(allProfiles.map(p => [p.username, p.id]));

  // Surviving accounts: valid, not flagged, sorted by most-recent add date (oldest session first).
  // Using the most-recent add/re-add/re-import stamp means re-imported accounts reset their
  // timer — only genuinely long-running sessions surface to the top.
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
      // runMs is measured from the MOST RECENT add event so re-imported accounts
      // don't appear to have artificially long survival times.
      const mostRecentDate = allDates.length > 0 ? allDates[allDates.length - 1] : firstDate;
      return { ...p, firstDate, allDates, runMs: mostRecentDate ? now - mostRecentDate.getTime() : null };
    })
    .filter(p => p.firstDate !== null)
    .sort((a, b) => (a.runMs ?? 0) > (b.runMs ?? 0) ? -1 : 1)
    .slice(0, 20);

  const proxyRisks = buildProxyRiskMap(banEntries, automatedEntries, captchaEntries, lockedEntries);
  const concurrencyAlerts = buildConcurrencyAlerts(banEntries, automatedEntries, captchaEntries, lockedEntries);

  const cfg = activeTab !== "survivors" ? TAB_CONFIG[activeTab] : TAB_CONFIG["ban"];
  const activeEntries = activeTab === "ban" ? banEntries : activeTab === "automated" ? automatedEntries : activeTab === "captcha" ? captchaEntries : lockedEntries;
  const TABS: Tab[] = ["ban", "automated", "captcha", "locked", "survivors"];

  const TAB_LABELS: Record<Tab, string> = {
    ban: "Banned Accounts",
    automated: "Automated Behaviour",
    captcha: "Captcha Errors",
    locked: "Locked Accounts",
    survivors: "Top Survivors",
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
              <p className="text-sm text-muted-foreground">Raw data per flagged account — actions, timing, endpoint patterns, cross-account trends</p>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading analytics…</span>
            </div>
          )}

          {/* Main tabbed panel */}
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
                      <span className="text-xs text-muted-foreground ml-auto">
                        Timer resets on each re-import — only genuine long runners surface
                      </span>
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
                                {reAdded && (
                                  <span>Latest re-add: {p.allDates[p.allDates.length - 1].toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                                )}
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
                <EntryList entries={activeEntries} cfg={TAB_CONFIG[activeTab as Exclude<Tab, "survivors">]} tabKey={activeTab as Exclude<Tab, "survivors">} profileMap={profileMap} />
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
