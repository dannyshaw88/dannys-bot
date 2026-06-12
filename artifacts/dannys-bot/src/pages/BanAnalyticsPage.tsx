import { useQuery } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useState } from "react";
import {
  Loader2, BarChart2, Calendar, Globe, AlertTriangle, Shield, Clock,
  TrendingUp, Info, Zap, MessageSquare, UserMinus, UserPlus, ChevronDown, ChevronUp,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";

interface AnalyticsEntry {
  id: number;
  username: string;
  proxyHost: string;
  endpointCount: number;
  endpointSnapshot: string;
  bannedAt?: string;
  flaggedAt?: string;
}

interface EndpointFreq {
  operationName: string;
  count: number;
  pct: number;
}

interface ProxyRisk {
  host: string;
  banCount: number;
  automatedCount: number;
  captchaCount: number;
  lockedCount: number;
  total: number;
  accounts: string[];
}

interface ConcurrencyAlert {
  proxyHost: string;
  accounts: string[];
  times: string[];
  category: string;
}

interface Diagnosis {
  summary: string;
  findings: string[];
  severity: "high" | "medium" | "low";
  dominantCause: string;
}

// ── Endpoint knowledge base ──────────────────────────────────────────────────
// Maps Instagram API path fragments / operation names to human-readable labels
// and risk classifications.
const ENDPOINT_KB: Record<string, { label: string; category: "follow" | "unfollow" | "dm" | "like" | "session" | "auth" | "other"; weight: number }> = {
  "friendships/create":    { label: "Follow",          category: "follow",   weight: 3 },
  "friendships/destroy":   { label: "Unfollow",        category: "unfollow", weight: 3 },
  "direct_v2/threads":     { label: "DM Thread",       category: "dm",       weight: 3 },
  "direct_v2/broadcast":   { label: "DM Send",         category: "dm",       weight: 4 },
  "media/like":            { label: "Like",             category: "like",     weight: 2 },
  "media/unlike":          { label: "Unlike",           category: "like",     weight: 2 },
  "feed/timeline":         { label: "Timeline Feed",    category: "session",  weight: 1 },
  "feed/reels_tray":       { label: "Reels Tray",       category: "session",  weight: 1 },
  "news/inbox":            { label: "Notifications",    category: "session",  weight: 1 },
  "accounts/login":        { label: "Login",            category: "auth",     weight: 2 },
  "qe/sync":               { label: "Session Sync",     category: "auth",     weight: 1 },
  "launcher/sync":         { label: "Launcher Sync",    category: "auth",     weight: 1 },
  "users/info":            { label: "User Info Lookup", category: "session",  weight: 1 },
  "discover/people":       { label: "People Discovery", category: "follow",   weight: 2 },
  "igtv/series":           { label: "IGTV",             category: "session",  weight: 1 },
  "bloks":                 { label: "Bloks (UI)",        category: "session",  weight: 1 },
  "contact_point_prefill": { label: "Contact Prefill",  category: "auth",     weight: 2 },
  "banyan":                { label: "Banyan Check",      category: "auth",     weight: 2 },
  "topical_explore":       { label: "Explore Page",      category: "session",  weight: 1 },
  "push/register":         { label: "Push Register",    category: "auth",     weight: 1 },
};

// THRESHOLDS for detecting high-activity tools
const THRESHOLDS = {
  follow:   { warn: 30,  danger: 80  },
  unfollow: { warn: 30,  danger: 80  },
  dm:       { warn: 10,  danger: 30  },
  like:     { warn: 50,  danger: 150 },
  callRate: { warn: 3.0, danger: 8.0 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseEndpoints(snapshot: string): { operationName: string; date: string }[] {
  try { return JSON.parse(snapshot) ?? []; } catch { return []; }
}

function getCallRateNum(snapshot: string): number {
  const eps = parseEndpoints(snapshot);
  if (eps.length < 2) return 0;
  const dates = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (dates.length < 2) return 0;
  const spanMs = dates[dates.length - 1] - dates[0];
  if (spanMs <= 0) return 0;
  return eps.length / (spanMs / 60000);
}

function getCallRateStr(snapshot: string): string {
  const r = getCallRateNum(snapshot);
  return r > 0 ? `${r.toFixed(1)}/min` : "—";
}

function topEndpoints(entries: AnalyticsEntry[]): EndpointFreq[] {
  const map = new Map<string, number>();
  for (const entry of entries) {
    for (const ep of parseEndpoints(entry.endpointSnapshot)) {
      map.set(ep.operationName, (map.get(ep.operationName) ?? 0) + 1);
    }
  }
  const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
  return Array.from(map.entries())
    .map(([operationName, count]) => ({ operationName, count, pct: total ? Math.round(count / total * 100) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function matchKb(name: string) {
  for (const [key, val] of Object.entries(ENDPOINT_KB)) {
    if (name.includes(key)) return val;
  }
  return null;
}

function categoryCounts(eps: { operationName: string; date: string }[]) {
  const counts: Record<string, number> = { follow: 0, unfollow: 0, dm: 0, like: 0, session: 0, auth: 0, other: 0 };
  for (const ep of eps) {
    const kb = matchKb(ep.operationName);
    const cat = kb?.category ?? "other";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

// ── Per-entry diagnosis engine ───────────────────────────────────────────────
function diagnoseEntry(entry: AnalyticsEntry, allSameType: AnalyticsEntry[]): Diagnosis {
  const eps = parseEndpoints(entry.endpointSnapshot);
  const cats = categoryCounts(eps);
  const callRate = getCallRateNum(entry.endpointSnapshot);
  const findings: string[] = [];
  let severity: "high" | "medium" | "low" = "low";
  let dominantCause = "Unknown activity pattern";

  // ── Call rate check ──
  if (callRate >= THRESHOLDS.callRate.danger) {
    findings.push(`Extremely high API call rate: ${callRate.toFixed(1)} calls/min — Instagram's anti-bot systems flag sustained rates above ${THRESHOLDS.callRate.danger}/min as non-human.`);
    severity = "high";
  } else if (callRate >= THRESHOLDS.callRate.warn) {
    findings.push(`Elevated API call rate: ${callRate.toFixed(1)} calls/min — this is above typical human browsing patterns.`);
    if (severity === "low") severity = "medium";
  }

  // ── Follow tool check ──
  if (cats.follow >= THRESHOLDS.follow.danger) {
    findings.push(`Mass follow activity detected: ${cats.follow} follow calls. Instagram typically enforces hard blocks at 60–100 follows/hour. This is almost certainly the primary trigger.`);
    dominantCause = "Mass follow tool — too many follow API calls in a short window";
    severity = "high";
  } else if (cats.follow >= THRESHOLDS.follow.warn) {
    findings.push(`High follow count: ${cats.follow} follow calls. This is in the range where Instagram starts applying friction (action blocks, CAPTCHAs).`);
    if (dominantCause === "Unknown activity pattern") dominantCause = "Follow tool — close to Instagram's daily follow limits";
    if (severity === "low") severity = "medium";
  }

  // ── Unfollow tool check ──
  if (cats.unfollow >= THRESHOLDS.unfollow.danger) {
    findings.push(`Mass unfollow activity detected: ${cats.unfollow} unfollow calls. Instagram treats bulk unfollowing the same as bulk following — both can trigger automated-behaviour flags.`);
    if (dominantCause === "Unknown activity pattern") dominantCause = "Mass unfollow tool";
    severity = "high";
  } else if (cats.unfollow >= THRESHOLDS.unfollow.warn) {
    findings.push(`Elevated unfollow count: ${cats.unfollow} unfollow calls.`);
    if (severity === "low") severity = "medium";
  }

  // ── DM tool check ──
  if (cats.dm >= THRESHOLDS.dm.danger) {
    findings.push(`Mass DM activity detected: ${cats.dm} DM-related calls. Sending bulk direct messages is one of the fastest ways to trigger spam detection on Instagram.`);
    if (dominantCause === "Unknown activity pattern") dominantCause = "DM / Contact tool — bulk messaging flagged as spam";
    severity = "high";
  } else if (cats.dm >= THRESHOLDS.dm.warn) {
    findings.push(`Elevated DM count: ${cats.dm} DM-related calls. This is approaching Instagram's soft limit for new-ish accounts.`);
    if (severity === "low") severity = "medium";
  }

  // ── Like tool check ──
  if (cats.like >= THRESHOLDS.like.danger) {
    findings.push(`Mass like activity: ${cats.like} like/unlike calls. High-volume liking is a known trigger for "Automated Behaviour Detected" on Instagram.`);
    if (dominantCause === "Unknown activity pattern") dominantCause = "Like tool — bulk liking flagged";
    severity = "high";
  } else if (cats.like >= THRESHOLDS.like.warn) {
    findings.push(`Notable like volume: ${cats.like} like calls.`);
  }

  // ── Cross-account pattern check ──
  const others = allSameType.filter(e => e.id !== entry.id && e.proxyHost && e.proxyHost === entry.proxyHost);
  if (others.length > 0) {
    findings.push(`${others.length} other account${others.length !== 1 ? "s" : ""} on the same proxy (${entry.proxyHost}) also flagged — possible shared proxy risk or coordinated over-use.`);
    if (severity === "low") severity = "medium";
  }

  // ── Auth/session anomaly ──
  if (cats.auth > 5) {
    findings.push(`High auth-related endpoint activity (${cats.auth} calls): repeated session syncs or login attempts can indicate session instability, which Instagram treats as suspicious.`);
  }

  // ── Low data notice ──
  if (eps.length < 10) {
    findings.push(`Only ${eps.length} API calls captured — the flag may have been triggered before significant activity was recorded, or the account session was very short.`);
    if (dominantCause === "Unknown activity pattern") dominantCause = "Insufficient data — session too short to identify cause";
  }

  if (findings.length === 0) {
    findings.push("No specific high-risk pattern identified. The flag may be due to account age, prior history, or IP reputation rather than recent in-session activity.");
    dominantCause = "No clear activity trigger — possible IP/account reputation issue";
  }

  // ── Summary sentence ──
  const totalActions = cats.follow + cats.unfollow + cats.dm + cats.like;
  const summary = totalActions > 0
    ? `${entry.endpointCount} API calls captured. Primary actions: ${[
        cats.follow > 0 ? `${cats.follow} follows` : "",
        cats.unfollow > 0 ? `${cats.unfollow} unfollows` : "",
        cats.dm > 0 ? `${cats.dm} DMs` : "",
        cats.like > 0 ? `${cats.like} likes` : "",
      ].filter(Boolean).join(", ")}. Rate: ${callRate > 0 ? `${callRate.toFixed(1)}/min` : "—"}.`
    : `${entry.endpointCount} API calls captured — mostly session/auth activity. Rate: ${callRate > 0 ? `${callRate.toFixed(1)}/min` : "—"}.`;

  return { summary, findings, severity, dominantCause };
}

function buildProxyRiskMap(
  bans: AnalyticsEntry[],
  automated: AnalyticsEntry[],
  captcha: AnalyticsEntry[],
  locked: AnalyticsEntry[],
): ProxyRisk[] {
  const map = new Map<string, ProxyRisk>();
  const add = (entries: AnalyticsEntry[], key: keyof Pick<ProxyRisk, "banCount" | "automatedCount" | "captchaCount" | "lockedCount">) => {
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!map.has(host)) map.set(host, { host, banCount: 0, automatedCount: 0, captchaCount: 0, lockedCount: 0, total: 0, accounts: [] });
      const r = map.get(host)!;
      r[key]++;
      r.total++;
      if (!r.accounts.includes(e.username)) r.accounts.push(e.username);
    }
  };
  add(bans, "banCount");
  add(automated, "automatedCount");
  add(captcha, "captchaCount");
  add(locked, "lockedCount");
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function buildConcurrencyAlerts(
  bans: AnalyticsEntry[],
  automated: AnalyticsEntry[],
  captcha: AnalyticsEntry[],
  locked: AnalyticsEntry[],
): ConcurrencyAlert[] {
  const alerts: ConcurrencyAlert[] = [];
  const groups: { entries: AnalyticsEntry[]; label: string }[] = [
    { entries: bans, label: "Ban" },
    { entries: automated, label: "Automated" },
    { entries: captcha, label: "Captcha" },
    { entries: locked, label: "Locked" },
  ];
  for (const { entries, label } of groups) {
    const byProxy = new Map<string, AnalyticsEntry[]>();
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!byProxy.has(host)) byProxy.set(host, []);
      byProxy.get(host)!.push(e);
    }
    for (const [host, es] of byProxy) {
      if (es.length < 2) continue;
      const sorted = [...es].sort((a, b) => {
        const ta = new Date(a.flaggedAt ?? a.bannedAt ?? 0).getTime();
        const tb = new Date(b.flaggedAt ?? b.bannedAt ?? 0).getTime();
        return ta - tb;
      });
      for (let i = 0; i < sorted.length - 1; i++) {
        const ta = new Date(sorted[i].flaggedAt ?? sorted[i].bannedAt ?? 0).getTime();
        const tb = new Date(sorted[i + 1].flaggedAt ?? sorted[i + 1].bannedAt ?? 0).getTime();
        if (Math.abs(tb - ta) <= 30 * 60 * 1000) {
          alerts.push({
            proxyHost: host,
            accounts: [sorted[i].username, sorted[i + 1].username],
            times: [sorted[i].flaggedAt ?? sorted[i].bannedAt ?? "", sorted[i + 1].flaggedAt ?? sorted[i + 1].bannedAt ?? ""],
            category: label,
          });
        }
      }
    }
  }
  return alerts.slice(0, 20);
}

// ── Global trend: find endpoints that appear in >X% of events ───────────────
function buildCrossTrend(entries: AnalyticsEntry[]): Array<{ endpoint: string; label: string; accountCount: number; pct: number }> {
  if (entries.length < 2) return [];
  const epToAccounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const ep of parseEndpoints(entry.endpointSnapshot)) {
      if (!epToAccounts.has(ep.operationName)) epToAccounts.set(ep.operationName, new Set());
      epToAccounts.get(ep.operationName)!.add(entry.username);
    }
  }
  return Array.from(epToAccounts.entries())
    .map(([endpoint, accs]) => ({
      endpoint,
      label: matchKb(endpoint)?.label ?? endpoint,
      accountCount: accs.size,
      pct: Math.round(accs.size / entries.length * 100),
    }))
    .filter(t => t.pct >= 50)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10);
}

type Tab = "ban" | "automated" | "captcha" | "locked";

const TAB_CONFIG: Record<Tab, {
  label: string; accentClass: string; accentBg: string; barColor: string;
  severityBg: Record<string, string>; emptyMsg: string; flagMsg: string;
}> = {
  ban:       {
    label: "Ban Events", accentClass: "text-red-500",
    accentBg: "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",
    barColor: "bg-red-400",
    severityBg: { high: "border-red-300 bg-red-50 dark:bg-red-900/15", medium: "border-orange-200 bg-orange-50 dark:bg-orange-900/10", low: "border-border bg-muted/30" },
    emptyMsg: "No ban analytics yet", flagMsg: "Flag accounts as Banned from Accounts → Actions → Flag as Banned.",
  },
  automated: {
    label: "Automated Behaviour", accentClass: "text-orange-500",
    accentBg: "bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800",
    barColor: "bg-orange-400",
    severityBg: { high: "border-orange-300 bg-orange-50 dark:bg-orange-900/15", medium: "border-yellow-200 bg-yellow-50 dark:bg-yellow-900/10", low: "border-border bg-muted/30" },
    emptyMsg: "No automated behaviour events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Automated Behaviour.",
  },
  captcha:   {
    label: "Captcha Errors", accentClass: "text-yellow-500",
    accentBg: "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800",
    barColor: "bg-yellow-400",
    severityBg: { high: "border-yellow-300 bg-yellow-50 dark:bg-yellow-900/15", medium: "border-orange-200 bg-orange-50 dark:bg-orange-900/10", low: "border-border bg-muted/30" },
    emptyMsg: "No captcha events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Captcha Error.",
  },
  locked:    {
    label: "Locked Accounts", accentClass: "text-rose-500",
    accentBg: "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800",
    barColor: "bg-rose-400",
    severityBg: { high: "border-rose-300 bg-rose-50 dark:bg-rose-900/15", medium: "border-orange-200 bg-orange-50 dark:bg-orange-900/10", low: "border-border bg-muted/30" },
    emptyMsg: "No locked account events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Locked Account.",
  },
};

// ── Single-entry card with expanded diagnosis ────────────────────────────────
function EntryCard({
  entry, cfg, allSameType,
}: { entry: AnalyticsEntry; cfg: typeof TAB_CONFIG[Tab]; allSameType: AnalyticsEntry[] }) {
  const [open, setOpen] = useState(false);
  const diagnosis = diagnoseEntry(entry, allSameType);
  const ts = entry.flaggedAt ?? entry.bannedAt ?? "";
  const eps = parseEndpoints(entry.endpointSnapshot);
  const cats = categoryCounts(eps);
  const topEps = Array.from(
    eps.reduce((m, e) => { m.set(e.operationName, (m.get(e.operationName) ?? 0) + 1); return m; }, new Map<string, number>())
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const severityColour = diagnosis.severity === "high" ? "text-red-600 dark:text-red-400" : diagnosis.severity === "medium" ? "text-orange-500" : "text-muted-foreground";
  const severityLabel = diagnosis.severity === "high" ? "HIGH RISK" : diagnosis.severity === "medium" ? "MED RISK" : "LOW RISK";

  return (
    <div className={`border rounded-lg overflow-hidden ${cfg.severityBg[diagnosis.severity]}`}>
      <button className="w-full px-4 py-3 flex items-start gap-3 text-left" onClick={() => setOpen(o => !o)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">@{entry.username}</span>
            <span className={`text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded border ${cfg.accentBg}`}>{severityLabel}</span>
            {entry.proxyHost && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Globe className="w-3 h-3" />{entry.proxyHost}
              </span>
            )}
            {!entry.proxyHost && (
              <span className="text-[11px] text-muted-foreground italic">no proxy</span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto">{ts ? new Date(ts).toLocaleString() : "—"}</span>
          </div>

          <p className="text-xs text-muted-foreground mt-1 font-medium">{diagnosis.dominantCause}</p>

          <p className="text-[11px] text-muted-foreground mt-0.5">{diagnosis.summary}</p>

          {topEps.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {topEps.map(([name, cnt]) => (
                <span key={name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${cfg.accentBg}`}>
                  {matchKb(name)?.label ?? name} <span className="opacity-60">×{cnt}</span>
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
        <div className="border-t border-border px-4 py-3 space-y-3 bg-background/60">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5" /> Diagnosis
            </p>
            <ul className="space-y-1.5">
              {diagnosis.findings.map((f, i) => (
                <li key={i} className="text-xs text-foreground flex gap-2">
                  <span className={`shrink-0 mt-0.5 font-bold ${severityColour}`}>→</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { icon: <UserPlus className="w-3 h-3" />, label: "Follows",   val: cats.follow,   threshold: THRESHOLDS.follow },
              { icon: <UserMinus className="w-3 h-3" />, label: "Unfollows", val: cats.unfollow, threshold: THRESHOLDS.unfollow },
              { icon: <MessageSquare className="w-3 h-3" />, label: "DMs",  val: cats.dm,       threshold: THRESHOLDS.dm },
              { icon: <Zap className="w-3 h-3" />, label: "Likes",          val: cats.like,     threshold: THRESHOLDS.like },
            ].map(({ icon, label, val, threshold }) => {
              const colour = val >= threshold.danger ? "text-red-600 dark:text-red-400" : val >= threshold.warn ? "text-orange-500" : "text-foreground";
              return (
                <div key={label} className="border border-border rounded p-2 bg-background/80">
                  <div className="flex items-center gap-1 text-muted-foreground text-[10px] uppercase tracking-wide">
                    {icon} {label}
                  </div>
                  <p className={`text-lg font-bold mt-0.5 ${colour}`}>{val}</p>
                  <p className="text-[10px] text-muted-foreground">warn >{threshold.warn} / stop >{threshold.danger}</p>
                </div>
              );
            })}
          </div>

          {topEps.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <BarChart2 className="w-3.5 h-3.5" /> Top endpoints hit
              </p>
              <div className="space-y-0.5">
                {topEps.map(([name, cnt]) => {
                  const kb = matchKb(name);
                  return (
                    <div key={name} className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-muted-foreground truncate flex-1">{name}</span>
                      <span className={`shrink-0 px-1 rounded font-semibold ${cfg.accentBg}`}>{cnt}×</span>
                      {kb && <span className="shrink-0 text-muted-foreground">({kb.label})</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-4 text-[11px] text-muted-foreground border-t border-border pt-2">
            <span><Clock className="w-3 h-3 inline mr-0.5" />Rate: <strong>{getCallRateStr(entry.endpointSnapshot)}</strong></span>
            <span>Total calls: <strong>{entry.endpointCount}</strong></span>
            <span>Session: <strong>{cats.session} reads</strong></span>
            <span>Auth: <strong>{cats.auth} syncs</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab content panel ────────────────────────────────────────────────────────
function EntryList({ entries, cfg }: { entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[Tab] }) {
  if (entries.length === 0) return (
    <div className="border border-border rounded-lg p-10 text-center mt-4">
      <p className="text-sm font-medium">{cfg.emptyMsg}</p>
      <p className="text-xs text-muted-foreground mt-1">{cfg.flagMsg}</p>
    </div>
  );

  const tops = topEndpoints(entries);
  const totalHits = tops.reduce((a, b) => a + b.count, 0);
  const crossTrend = buildCrossTrend(entries);

  const highCount  = entries.filter(e => diagnoseEntry(e, entries).severity === "high").length;
  const medCount   = entries.filter(e => diagnoseEntry(e, entries).severity === "medium").length;
  const lowCount   = entries.length - highCount - medCount;

  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Events</p>
          <p className="text-3xl font-bold mt-1">{entries.length}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            <span className="text-red-500 font-semibold">{highCount} high</span> · <span className="text-orange-500 font-semibold">{medCount} med</span> · <span className="font-semibold">{lowCount} low</span>
          </p>
        </div>
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">API Calls Logged</p>
          <p className="text-3xl font-bold mt-1">{totalHits.toLocaleString()}</p>
        </div>
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Unique Endpoints</p>
          <p className="text-3xl font-bold mt-1">{new Set(tops.map(t => t.operationName)).size}</p>
        </div>
      </div>

      {crossTrend.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-cyan-500" />
            <span className="text-sm font-semibold">Common Pattern Across All Events</span>
            <span className="text-xs text-muted-foreground ml-auto">endpoints present in ≥50% of accounts flagged</span>
          </div>
          <div className="divide-y divide-border">
            {crossTrend.map(t => (
              <div key={t.endpoint} className="px-4 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground truncate">{t.endpoint}</span>
                    {t.label !== t.endpoint && <span className="text-xs text-foreground shrink-0">({t.label})</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full ${cfg.barColor} rounded-full`} style={{ width: `${t.pct}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-28 text-right">{t.accountCount}/{entries.length} accounts ({t.pct}%)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Event History — with Diagnosis</span>
          <span className="text-xs text-muted-foreground ml-auto">click any row to expand</span>
        </div>
        <div className="p-3 space-y-2">
          {[...entries].reverse().map(entry => (
            <EntryCard key={entry.id} entry={entry} cfg={cfg} allSameType={entries} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function BanAnalyticsPage() {
  const setSidebarSlot = useSidebarSetSlot();
  useEffect(() => { setSidebarSlot(null); return () => setSidebarSlot(null); }, []);

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

  const isLoading = banLoading || autoLoading || captchaLoading || lockedLoading;
  const proxyRisks = buildProxyRiskMap(banEntries, automatedEntries, captchaEntries, lockedEntries);
  const concurrencyAlerts = buildConcurrencyAlerts(banEntries, automatedEntries, captchaEntries, lockedEntries);
  const cfg = TAB_CONFIG[activeTab];
  const activeEntries = activeTab === "ban" ? banEntries : activeTab === "automated" ? automatedEntries : activeTab === "captcha" ? captchaEntries : lockedEntries;

  const TABS: Tab[] = ["ban", "automated", "captcha", "locked"];

  return (
    <AppLayout>
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto space-y-6">

          <div className="flex items-center gap-3">
            <svg className="w-6 h-6" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ color: "#1AD2F2" }}>
              <ellipse fill="currentColor" cx="12" cy="7.5" rx="8.5" ry="2"/>
              <path fill="currentColor" d="M7 7.5V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2.5H7z"/>
              <circle fill="currentColor" cx="12" cy="13.5" r="4"/>
              <rect fill="white" x="8" y="12.5" width="3.3" height="2.2" rx="0.8"/>
              <rect fill="white" x="12.7" y="12.5" width="3.3" height="2.2" rx="0.8"/>
              <rect fill="white" x="11.3" y="13" width="1.4" height="1" rx="0.3"/>
              <path fill="currentColor" d="M5.5 22c0-3.59 2.91-6.5 6.5-6.5s6.5 2.91 6.5 6.5H5.5z"/>
            </svg>
            <div>
              <h1 className="text-xl font-bold">Evasion Stats</h1>
              <p className="text-sm text-muted-foreground">Smart diagnosis — why each account was flagged, with cross-account pattern analysis</p>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading analytics…</span>
            </div>
          )}

          {!isLoading && (
            <div className="grid grid-cols-4 gap-3">
              <div className="border border-border rounded-lg p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Ban Events</p>
                <p className="text-3xl font-bold mt-1 text-red-500">{banEntries.length}</p>
              </div>
              <div className="border border-border rounded-lg p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Automated Detected</p>
                <p className="text-3xl font-bold mt-1 text-orange-500">{automatedEntries.length}</p>
              </div>
              <div className="border border-border rounded-lg p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Captcha Errors</p>
                <p className="text-3xl font-bold mt-1 text-yellow-500">{captchaEntries.length}</p>
              </div>
              <div className="border border-border rounded-lg p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Locked Accounts</p>
                <p className="text-3xl font-bold mt-1 text-rose-500">{lockedEntries.length}</p>
              </div>
            </div>
          )}

          {proxyRisks.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-500" />
                <span className="text-sm font-semibold">Proxy Risk Ranking</span>
                <span className="text-xs text-muted-foreground ml-auto">Ban / Automated / Captcha / Locked events per IP</span>
              </div>
              <div className="divide-y divide-border">
                {proxyRisks.map((pr, i) => (
                  <div key={pr.host} className="px-4 py-2.5 flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-6 text-right shrink-0">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="text-sm font-mono truncate">{pr.host}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{pr.accounts.slice(0, 5).map(a => `@${a}`).join(", ")}{pr.accounts.length > 5 ? ` +${pr.accounts.length - 5} more` : ""}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 font-semibold">{pr.banCount}B</span>
                      <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 font-semibold">{pr.automatedCount}A</span>
                      <span className="px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 font-semibold">{pr.captchaCount}C</span>
                      <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-600 font-semibold">{pr.lockedCount}L</span>
                      <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{pr.total} total</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {concurrencyAlerts.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-semibold">Concurrent Usage Alerts</span>
                <span className="text-xs text-muted-foreground ml-auto">Multiple accounts on same IP flagged within 30 min</span>
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
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        @{alert.accounts[0]} and @{alert.accounts[1]} — {alert.times[0] ? new Date(alert.times[0]).toLocaleTimeString() : "?"} & {alert.times[1] ? new Date(alert.times[1]).toLocaleTimeString() : "?"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex border-b border-border">
              {TABS.map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors ${activeTab === tab ? "bg-muted text-foreground border-b-2 border-cyan-500" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {TAB_CONFIG[tab].label}
                  <span className="ml-1.5 opacity-60">
                    ({tab === "ban" ? banEntries.length : tab === "automated" ? automatedEntries.length : tab === "captcha" ? captchaEntries.length : lockedEntries.length})
                  </span>
                </button>
              ))}
            </div>
            <div className="p-4">
              <EntryList entries={activeEntries} cfg={cfg} />
            </div>
          </div>

        </div>
      </div>
    </AppLayout>
  );
}
