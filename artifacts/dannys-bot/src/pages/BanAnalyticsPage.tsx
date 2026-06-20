import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useState, useMemo } from "react";
import { useLocation } from "wouter";
import {
  Loader2, BarChart2, Calendar, Globe, AlertTriangle, Shield,
  Clock, Award, RefreshCw, X, Activity, Hash, Sigma, Target,
  Flame, Cpu, Network, Layers, Zap, UserPlus, UserMinus,
  MessageSquare, ChevronDown, ChevronUp, TrendingUp, Eye,
  Star, Scale, FlaskConical, BadgeAlert, Download, Shuffle, Fingerprint,
} from "lucide-react";
import { getTrustScore, getTrustLevels } from "@/components/TrustScoreBadge";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProfileRow { id: number; username: string; accountLabel?: string | null; accountStatus?: string | null; tags?: string | null; notes?: string | null; proxyId?: number | null; proxyHost?: string | null; proxyPort?: number | null; }
interface ProxyRow { id: number; host: string | null; port: number | null; proxyHost?: string | null; proxyPort?: number | null; }
interface AnalyticsEntry { id: number; username: string; proxyHost: string; endpointCount: number; endpointSnapshot: string; bannedAt?: string; flaggedAt?: string; verifyCountLast24h?: number | null; accountAgeDays?: number | null; proxyAccountCount?: number | null; followCountBeforeBan?: number | null; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; }
interface SurvivorPattern { profileId: number; username: string; accountAgeDays: number | null; endpointCount: number; endpointSnapshot: string; capturedAt: string; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null; }
interface EpItem { operationName: string; date: string; source?: string | null; }
interface ProxyRisk { host: string; banCount: number; automatedCount: number; captchaCount: number; lockedCount: number; total: number; accounts: string[]; entryIds: { ban: number[]; automated: number[]; captcha: number[]; locked: number[] }; }
interface ConcurrencyAlert { proxyHost: string; accounts: string[]; times: string[]; category: string; }
interface SubnetGroup { subnet: string; events: number; accounts: string[]; flaggedAt: string[]; hosts: string[]; }
interface TrustInfo { levelId: string; label: string; rank: number; }

interface EntryMetrics {
  totalCalls: number; callsPerMin: number; avgInterCallSec: number; minInterCallSec: number; maxInterCallSec: number;
  timingCoV: number; shannonEntropy: number; uniqueEndpoints: number; endpointDiversity: number;
  burstCount: number; actionCount: number; sessionCount: number; authCount: number;
  sessionPerAction: number; sessionPerFollow: number; authPerAction: number;
  followCount: number; preActionWarmup: number; actionVelocityPerHour: number;
  spanMin: number; cats: Record<string, number>; anomalyScore: number; flagHour: number;
  activeTimeMin: number; activeCallRate_perMin: number; activeSessionCount: number;
}

interface Reliability { reAddCount: number; weight: number; label: string; }

interface CrossStats {
  n: number; weightedN: number;
  callRateMean: number; callRateMedian: number; callRateStdDev: number; callRateP90: number;
  sessionPerActionMean: number; sessionPerActionMedian: number; sessionPerActionStdDev: number;
  sessionPerFollowMean: number; sessionPerFollowMedian: number;
  timingCoVMean: number; timingCoVMedian: number; avgGapMean: number; minGapMean: number;
  entropyMean: number; entropyMedian: number; entropyStdDev: number;
  uniqueEpMean: number; endpointDiversityMean: number;
  warmupMean: number; warmupMedian: number; zeroWarmupPct: number;
  actionVelocityMean: number; actionVelocityMedian: number; authPerActionMean: number;
  burstPct: number; fastFlagPct: number; avgSpanMin: number;
  commonEndpoints: Array<{ name: string; label: string | null; pct: number; category: string; freq: number }>;
  proxyConcentration: number; topProxy: string;
  subnetGroups: SubnetGroup[]; topSubnet: string; subnetConcentration: number;
  hourBuckets: number[]; peakHour: number;
  avgAuthRatio: number; avgSessionRatio: number; avgActionRatio: number;
  roboticTimingPct: number; commonFirstEps: Array<{ name: string; label: string | null; pct: number }>;
  commonLastEps: Array<{ name: string; label: string | null; pct: number }>;
  // Trust
  trustRankMean: number; trustRankMedian: number; trustDistribution: Record<number, number>;
  lowTrustPct: number; highTrustPct: number;
  // Reliability
  unreliablePct: number; lowReliabilityEntries: number;
  // Verify-only bans
  verifyOnlyPct: number; verifyOnlyCount: number;
  // Proxy blast radius
  proxyBlastEntries: Array<{ proxy: string; count: number }>;
  // Verify clustering: multiple verify-only accounts on same proxy within 30 min
  verifyClusterGroups: Array<{ proxy: string; accounts: string[]; windowMinutes: number }>;
}

// ── Known Instagram mobile-API endpoint labels ────────────────────────────────
const EP_LABELS: Record<string, { label: string; category: "follow" | "unfollow" | "dm" | "like" | "session" | "auth" | "other" }> = {
  "friendships/create":   { label: "Follow",           category: "follow" },
  "friendships/destroy":  { label: "Unfollow",         category: "unfollow" },
  "direct_v2/threads":    { label: "DM Thread",        category: "dm" },
  "direct_v2/broadcast":  { label: "DM Send",          category: "dm" },
  "FollowedUser":         { label: "Follow",            category: "follow" },
  "UnfollowUser":         { label: "Unfollow",          category: "unfollow" },
  "media/like":           { label: "Like",              category: "like" },
  "media/unlike":         { label: "Unlike",            category: "like" },
  "LikeMedia":            { label: "Like",              category: "like" },
  "GetDirectMessages":    { label: "DM Thread",         category: "dm" },
  "feed/timeline":        { label: "Timeline Feed",     category: "session" },
  "ViewTimelineFeedSeen": { label: "Timeline Seen",     category: "session" },
  "feed/reels_tray":      { label: "Reels Tray",        category: "session" },
  "news/inbox":           { label: "Notifications",     category: "session" },
  "accounts/login":       { label: "Login",             category: "auth" },
  "qe/sync":              { label: "Session Sync",      category: "auth" },
  "launcher/sync":        { label: "Launcher Sync",     category: "auth" },
  "users/info":           { label: "User Info",         category: "session" },
  "discover/people":      { label: "People Discovery",  category: "follow" },
  "bloks":                { label: "Bloks (UI)",         category: "session" },
  "banyan":               { label: "Banyan Check",       category: "auth" },
  "topical_explore":      { label: "Explore",            category: "session" },
  "ProfileSync":          { label: "Profile Sync",       category: "session" },
  "friendships/following":{ label: "Following List",     category: "session" },
  "friendships/followers":{ label: "Followers List",     category: "session" },
  "push/register":        { label: "Push Register",      category: "auth" },
  "accounts/contact_point_prefill":  { label: "Contact Prefill",   category: "auth" },
  "accounts/get_prefill_candidates": { label: "Prefill Candidates", category: "auth" },
  "scores/bootstrap":     { label: "Scores Bootstrap",   category: "auth" },
  "location_search":      { label: "Location Search",    category: "session" },
  "tags/search":          { label: "Hashtag Search",     category: "session" },
  "users/search":         { label: "User Search",        category: "session" },
  "media/info":           { label: "Media Info",         category: "session" },
  "eb/auto-login":        { label: "EB Login Start",     category: "auth" },
  "eb/auto-login-result": { label: "EB Login Result",    category: "auth" },
};

function matchLabel(name: string) {
  for (const [key, val] of Object.entries(EP_LABELS)) {
    if (name === key || name.includes(key)) return val;
  }
  return null;
}

function parseEps(snapshot: string): EpItem[] { try { return JSON.parse(snapshot) ?? []; } catch { return []; } }
function filterHiker(eps: EpItem[]): EpItem[] { return eps.filter(e => e.source !== "HikerAPI"); }
function getEventTime(entry: AnalyticsEntry): string {
  const eps = filterHiker(parseEps(entry.endpointSnapshot));
  if (eps.length > 0) {
    const times = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t));
    if (times.length > 0) return new Date(Math.max(...times)).toISOString();
  }
  return entry.flaggedAt ?? entry.bannedAt ?? "";
}
function categorise(eps: EpItem[]): Record<string, number> {
  const c: Record<string, number> = { follow: 0, unfollow: 0, dm: 0, like: 0, session: 0, auth: 0, other: 0 };
  for (const ep of eps) { const m = matchLabel(ep.operationName); c[m?.category ?? "other"]++; }
  return c;
}
function topEps(eps: EpItem[], n = 20): Array<{ name: string; count: number; label: string | null; category: string }> {
  const map = new Map<string, number>();
  for (const e of eps) map.set(e.operationName, (map.get(e.operationName) ?? 0) + 1);
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count, label: matchLabel(name)?.label ?? null, category: matchLabel(name)?.category ?? "other" }));
}

// ── Pure maths ────────────────────────────────────────────────────────────────
function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
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
function zScore(val: number, m: number, sd: number): number { return sd > 0 ? (val - m) / sd : 0; }
function shannonEntropy(eps: EpItem[]): number {
  if (!eps.length) return 0;
  const counts = new Map<string, number>();
  for (const e of eps) counts.set(e.operationName, (counts.get(e.operationName) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) { const p = c / eps.length; h -= p * Math.log2(p); }
  return h;
}
function computeTimingCoV(timestamps: number[]): number {
  if (timestamps.length < 3) return -1;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  const m = mean(gaps);
  return m > 0 ? stddev(gaps) / m : -1;
}
function preActionWarmup(eps: EpItem[]): number {
  // Returns the average number of calls that had already fired before each follow call.
  // -1 means no follow calls in this session.
  const indexes: number[] = [];
  for (let i = 0; i < eps.length; i++) {
    const cat = matchLabel(eps[i].operationName)?.category ?? "other";
    if (cat === "follow") indexes.push(i);
  }
  if (indexes.length === 0) return -1;
  return Math.round(indexes.reduce((a, b) => a + b, 0) / indexes.length);
}
function extractSubnet24(host: string): string {
  const ip = host.split(":")[0];
  const parts = ip.split(".");
  return parts.length === 4 && parts.every(p => !isNaN(Number(p))) ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : host;
}
function isIpAddr(host: string): boolean {
  const parts = host.split(":")[0].split(".");
  return parts.length === 4 && parts.every(p => !isNaN(Number(p)) && Number(p) >= 0 && Number(p) <= 255);
}

// ── Trust score helpers ───────────────────────────────────────────────────────
function buildTrustMap(profiles: ProfileRow[]): Map<number, TrustInfo> {
  const levels = getTrustLevels();
  const map = new Map<number, TrustInfo>();
  for (const p of profiles) {
    const levelId = getTrustScore(p.id);
    if (levelId) {
      const rank = levels.findIndex(l => l.id === levelId);
      const label = levels[rank]?.label ?? levelId.toUpperCase();
      map.set(p.id, { levelId, label, rank: rank >= 0 ? rank + 1 : 1 });
    }
  }
  return map;
}

// ── Reliability helpers ───────────────────────────────────────────────────────
function computeReliability(notes: string | null | undefined): Reliability {
  const allDates = parseAllAddedDates(notes);
  const reAddCount = Math.max(0, allDates.length - 1);
  const weight = reAddCount === 0 ? 1.0 : reAddCount === 1 ? 0.75 : reAddCount === 2 ? 0.5 : 0.3;
  const label = reAddCount === 0 ? "RELIABLE" : reAddCount === 1 ? "RE-ADDED 1×" : reAddCount === 2 ? "RE-ADDED 2×" : `RE-ADDED ${reAddCount}×`;
  return { reAddCount, weight, label };
}

// ── Per-entry metrics ─────────────────────────────────────────────────────────
function computeMetrics(eps: EpItem[], flagTime?: string): EntryMetrics {
  const cats = categorise(eps);
  const timestamps = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  const spanMs = timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const spanMin = spanMs / 60000;
  const callsPerMin = spanMin > 0 ? eps.length / spanMin : 0;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  const avgInterCallSec = gaps.length ? mean(gaps) / 1000 : 0;
  const minInterCallSec = gaps.length ? Math.min(...gaps) / 1000 : 0;
  const maxInterCallSec = gaps.length ? Math.max(...gaps) / 1000 : 0;
  const coV = computeTimingCoV(timestamps);
  const entropy = shannonEntropy(eps);
  const uniqueEndpoints = new Set(eps.map(e => e.operationName)).size;
  const endpointDiversity = eps.length ? uniqueEndpoints / eps.length : 0;
  let burstCount = 0;
  for (let i = 1; i < timestamps.length; i++) { if (timestamps[i] - timestamps[i - 1] <= 60000) burstCount++; }
  const actionCount = cats.follow + cats.unfollow + cats.dm + cats.like;
  const sessionCount = cats.session;
  const authCount = cats.auth;
  const sessionPerAction = actionCount > 0 ? sessionCount / actionCount : sessionCount;
  const sessionPerFollow = cats.follow > 0 ? sessionCount / cats.follow : -1;
  const authPerAction = actionCount > 0 ? authCount / actionCount : authCount;
  const warmup = preActionWarmup(eps);
  const actionVelocityPerHour = spanMin > 0 ? actionCount / (spanMin / 60) : 0;
  const ft = flagTime ? new Date(flagTime) : null;
  const flagHour = ft && !isNaN(ft.getTime()) ? ft.getUTCHours() : -1;
  // Active session metrics: group consecutive calls with gap < 5 min into sessions,
  // then sum only the session durations (ignoring idle gaps between sessions).
  let activeTimeMin = 0;
  let activeSessionCount = 0;
  if (timestamps.length >= 2) {
    const SESSION_GAP_MS = 5 * 60 * 1000;
    let sessStart = timestamps[0];
    for (let i = 1; i <= timestamps.length; i++) {
      const gap = i < timestamps.length ? timestamps[i] - timestamps[i - 1] : SESSION_GAP_MS + 1;
      if (gap > SESSION_GAP_MS) {
        const dur = (timestamps[i - 1] - sessStart) / 60000;
        if (dur > 0) { activeTimeMin += dur; activeSessionCount++; }
        if (i < timestamps.length) sessStart = timestamps[i];
      }
    }
  }
  const activeCallRate_perMin = activeTimeMin > 0 ? eps.length / activeTimeMin : 0;
  return {
    totalCalls: eps.length, callsPerMin, avgInterCallSec, minInterCallSec, maxInterCallSec,
    timingCoV: coV, shannonEntropy: entropy, uniqueEndpoints, endpointDiversity,
    burstCount, actionCount, sessionCount, authCount,
    sessionPerAction, sessionPerFollow: sessionPerFollow >= 0 ? sessionPerFollow : 0,
    authPerAction, followCount: cats.follow, preActionWarmup: warmup,
    actionVelocityPerHour, spanMin, cats, anomalyScore: 0, flagHour,
    activeTimeMin, activeCallRate_perMin, activeSessionCount,
  };
}

// ── Cross-account stats ───────────────────────────────────────────────────────
function computeCrossStats(entries: AnalyticsEntry[], trustMap: Map<number, TrustInfo>, profileMap: Map<string, number>, profileNotesMap: Map<string, string | null>): CrossStats {
  const emptyStats: CrossStats = {
    n: 0, weightedN: 0, callRateMean: 0, callRateMedian: 0, callRateStdDev: 0, callRateP90: 0,
    sessionPerActionMean: 0, sessionPerActionMedian: 0, sessionPerActionStdDev: 0,
    sessionPerFollowMean: 0, sessionPerFollowMedian: 0,
    timingCoVMean: 0, timingCoVMedian: 0, avgGapMean: 0, minGapMean: 0,
    entropyMean: 0, entropyMedian: 0, entropyStdDev: 0, uniqueEpMean: 0, endpointDiversityMean: 0,
    warmupMean: 0, warmupMedian: 0, zeroWarmupPct: 0,
    actionVelocityMean: 0, actionVelocityMedian: 0, authPerActionMean: 0,
    burstPct: 0, fastFlagPct: 0, avgSpanMin: 0,
    commonEndpoints: [], proxyConcentration: 0, topProxy: "",
    subnetGroups: [], topSubnet: "", subnetConcentration: 0,
    hourBuckets: Array(24).fill(0), peakHour: -1,
    avgAuthRatio: 0, avgSessionRatio: 0, avgActionRatio: 0, roboticTimingPct: 0,
    commonFirstEps: [], commonLastEps: [],
    trustRankMean: 0, trustRankMedian: 0, trustDistribution: {}, lowTrustPct: 0, highTrustPct: 0,
    unreliablePct: 0, lowReliabilityEntries: 0,
    verifyOnlyPct: 0, verifyOnlyCount: 0,
    proxyBlastEntries: [],
    verifyClusterGroups: [],
  };
  if (!entries.length) return emptyStats;

  const reliabilities = entries.map(e => computeReliability(profileNotesMap.get(e.username)));
  const metricsList   = entries.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot)), e.flaggedAt ?? e.bannedAt));
  const weightedN     = reliabilities.reduce((s, r) => s + r.weight, 0);
  const lowReliabilityEntries = reliabilities.filter(r => r.weight < 0.6).length;
  const unreliablePct = entries.length ? Math.round(lowReliabilityEntries / entries.length * 100) : 0;

  // Weighted arrays for key stats
  const callRates  = metricsList.map(m => m.callsPerMin).filter(v => v > 0);
  const spaList    = metricsList.map(m => m.sessionPerAction).filter(v => v >= 0);
  const spfList    = metricsList.map(m => m.sessionPerFollow > 0 ? m.sessionPerFollow : -1).filter(v => v >= 0);
  const spanList   = metricsList.map(m => m.spanMin).filter(v => v > 0);
  const covList    = metricsList.map(m => m.timingCoV).filter(v => v >= 0);
  const gapList    = metricsList.map(m => m.avgInterCallSec).filter(v => v > 0);
  const minGapList = metricsList.map(m => m.minInterCallSec).filter(v => v >= 0);
  const entropyList = metricsList.map(m => m.shannonEntropy);
  const warmupList = metricsList.map(m => m.preActionWarmup).filter(v => v >= 0);
  const velList    = metricsList.map(m => m.actionVelocityPerHour).filter(v => v > 0);
  const uniqueEpList = metricsList.map(m => m.uniqueEndpoints);
  const diversityList = metricsList.map(m => m.endpointDiversity);
  const authList   = metricsList.map(m => m.authPerAction);
  const authRatios    = metricsList.map(m => m.totalCalls > 0 ? m.authCount / m.totalCalls : 0);
  const sessionRatios = metricsList.map(m => m.totalCalls > 0 ? m.sessionCount / m.totalCalls : 0);
  const actionRatios  = metricsList.map(m => m.totalCalls > 0 ? m.actionCount / m.totalCalls : 0);

  const burstCount    = metricsList.filter(m => m.burstCount > 0).length;
  const fastFlagCount = metricsList.filter(m => m.spanMin > 0 && m.spanMin < 60).length;
  const roboticCount  = covList.filter(v => v < 0.5).length;

  // Common endpoints
  const epToAccounts = new Map<string, Set<string>>();
  const firstEpCounts = new Map<string, number>();
  const lastEpCounts  = new Map<string, number>();
  for (const entry of entries) {
    const eps = filterHiker(parseEps(entry.endpointSnapshot));
    for (const ep of eps) {
      if (!epToAccounts.has(ep.operationName)) epToAccounts.set(ep.operationName, new Set());
      epToAccounts.get(ep.operationName)!.add(entry.username);
    }
    const firstAction = eps.find(e => { const c = matchLabel(e.operationName)?.category ?? "other"; return c !== "auth" && c !== "other" && c !== "session"; });
    if (firstAction) firstEpCounts.set(firstAction.operationName, (firstEpCounts.get(firstAction.operationName) ?? 0) + 1);
    const last = eps[eps.length - 1];
    if (last) lastEpCounts.set(last.operationName, (lastEpCounts.get(last.operationName) ?? 0) + 1);
  }
  const commonEndpoints = Array.from(epToAccounts.entries())
    .map(([name, accs]) => ({ name, label: matchLabel(name)?.label ?? null, category: matchLabel(name)?.category ?? "other", pct: Math.round(accs.size / entries.length * 100), freq: accs.size }))
    .filter(t => t.pct >= 40).sort((a, b) => b.pct - a.pct).slice(0, 20);
  const commonFirstEps = Array.from(firstEpCounts.entries()).map(([name, count]) => ({ name, label: matchLabel(name)?.label ?? null, pct: Math.round(count / entries.length * 100) })).sort((a, b) => b.pct - a.pct).slice(0, 8);
  const commonLastEps  = Array.from(lastEpCounts.entries()).map(([name, count]) => ({ name, label: matchLabel(name)?.label ?? null, pct: Math.round(count / entries.length * 100) })).sort((a, b) => b.pct - a.pct).slice(0, 8);

  // Proxy / subnet
  const proxyCounts = new Map<string, number>();
  for (const e of entries) { const h = e.proxyHost || "(no proxy)"; proxyCounts.set(h, (proxyCounts.get(h) ?? 0) + 1); }
  const topProxyEntry = Array.from(proxyCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  const subnetMap = new Map<string, { accounts: string[]; flaggedAt: string[]; hosts: string[] }>();
  for (const e of entries) {
    if (!e.proxyHost) continue;
    const sn = isIpAddr(e.proxyHost) ? extractSubnet24(e.proxyHost) : `hostname:${e.proxyHost.split(":")[0]}`;
    if (!subnetMap.has(sn)) subnetMap.set(sn, { accounts: [], flaggedAt: [], hosts: [] });
    const sg = subnetMap.get(sn)!;
    if (!sg.accounts.includes(e.username)) sg.accounts.push(e.username);
    sg.flaggedAt.push(e.flaggedAt ?? e.bannedAt ?? "");
    if (!sg.hosts.includes(e.proxyHost)) sg.hosts.push(e.proxyHost);
  }
  const subnetGroups = Array.from(subnetMap.entries()).map(([subnet, d]) => ({ subnet, events: d.accounts.length, accounts: d.accounts, flaggedAt: d.flaggedAt, hosts: d.hosts })).filter(sg => sg.events > 1).sort((a, b) => b.events - a.events);
  const topSubnetEntry = subnetGroups[0];

  // Time of day
  const hourBuckets = Array(24).fill(0);
  for (const m of metricsList) { if (m.flagHour >= 0) hourBuckets[m.flagHour]++; }
  const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

  // Trust ranks
  const trustRanks = entries.map(e => trustMap.get(profileMap.get(e.username) ?? -1)?.rank ?? -1).filter(r => r >= 0);
  const trustDistribution: Record<number, number> = {};
  for (const r of trustRanks) trustDistribution[r] = (trustDistribution[r] ?? 0) + 1;
  const lowTrustPct  = trustRanks.length ? Math.round(trustRanks.filter(r => r <= 4).length / trustRanks.length * 100) : 0;
  const highTrustPct = trustRanks.length ? Math.round(trustRanks.filter(r => r >= 9).length / trustRanks.length * 100) : 0;

  // Verify-only bans: accounts where every recorded endpoint came from the Verify process (no tool activity at all)
  const verifyOnlyCount = entries.filter(e => {
    const eps = filterHiker(parseEps(e.endpointSnapshot));
    if (eps.length === 0) return false;
    return eps.every(ep => { const s = (ep.source ?? "").toLowerCase(); return s === "verify" || s === "eb" || s === ""; });
  }).length;

  // Proxy blast radius: proxies with 3+ bans on the exact same IP
  const proxyBlastEntries = Array.from(proxyCounts.entries())
    .filter(([proxy, count]) => proxy !== "(no proxy)" && count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([proxy, count]) => ({ proxy, count }));

  // Verify clustering: detect multiple verify-only accounts on the same proxy whose
  // verify sequences overlapped within a 30-minute window.
  // Each verify-only entry contributes its earliest endpoint timestamp as "verify start time".
  const CLUSTER_WINDOW_MS = 30 * 60 * 1000;
  const verifyOnlyEntries = entries.filter(e => {
    const eps = filterHiker(parseEps(e.endpointSnapshot));
    return eps.length > 0 && eps.every(ep => { const s = (ep.source ?? "").toLowerCase(); return s === "verify" || s === "eb" || s === ""; });
  });
  const verifyByProxy = new Map<string, Array<{ username: string; firstTs: number }>>();
  for (const e of verifyOnlyEntries) {
    if (!e.proxyHost) continue;
    const eps = filterHiker(parseEps(e.endpointSnapshot));
    const timestamps = eps.map(ep => new Date(ep.date).getTime()).filter(t => !isNaN(t));
    if (timestamps.length === 0) continue;
    const firstTs = Math.min(...timestamps);
    if (!verifyByProxy.has(e.proxyHost)) verifyByProxy.set(e.proxyHost, []);
    verifyByProxy.get(e.proxyHost)!.push({ username: e.username, firstTs });
  }
  const verifyClusterGroups: Array<{ proxy: string; accounts: string[]; windowMinutes: number }> = [];
  for (const [proxy, items] of verifyByProxy.entries()) {
    if (items.length < 2) continue;
    const sorted = items.slice().sort((a, b) => a.firstTs - b.firstTs);
    // Sliding window: find the tightest cluster of 2+ accounts within CLUSTER_WINDOW_MS
    for (let i = 0; i < sorted.length - 1; i++) {
      const windowAccounts = [sorted[i].username];
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].firstTs - sorted[i].firstTs <= CLUSTER_WINDOW_MS) {
          windowAccounts.push(sorted[j].username);
        } else break;
      }
      if (windowAccounts.length >= 2) {
        const spanMs = sorted[Math.min(i + windowAccounts.length - 1, sorted.length - 1)].firstTs - sorted[i].firstTs;
        verifyClusterGroups.push({ proxy, accounts: windowAccounts, windowMinutes: Math.round(spanMs / 60000) });
        break; // one cluster report per proxy
      }
    }
  }

  return {
    n: entries.length, weightedN,
    callRateMean: mean(callRates), callRateMedian: median(callRates), callRateStdDev: stddev(callRates), callRateP90: pctile(callRates, 90),
    sessionPerActionMean: mean(spaList), sessionPerActionMedian: median(spaList), sessionPerActionStdDev: stddev(spaList),
    sessionPerFollowMean: mean(spfList), sessionPerFollowMedian: median(spfList),
    timingCoVMean: mean(covList), timingCoVMedian: median(covList), avgGapMean: mean(gapList), minGapMean: mean(minGapList),
    entropyMean: mean(entropyList), entropyMedian: median(entropyList), entropyStdDev: stddev(entropyList),
    uniqueEpMean: mean(uniqueEpList), endpointDiversityMean: mean(diversityList),
    warmupMean: mean(warmupList), warmupMedian: median(warmupList), zeroWarmupPct: entries.length ? Math.round(warmupList.filter(v => v < 5).length / entries.length * 100) : 0,
    actionVelocityMean: mean(velList), actionVelocityMedian: median(velList), authPerActionMean: mean(authList),
    burstPct: entries.length ? Math.round(burstCount / entries.length * 100) : 0,
    fastFlagPct: entries.length ? Math.round(fastFlagCount / entries.length * 100) : 0, avgSpanMin: mean(spanList),
    commonEndpoints, proxyConcentration: entries.length ? Math.round((topProxyEntry?.[1] ?? 0) / entries.length * 100) : 0, topProxy: topProxyEntry?.[0] ?? "",
    subnetGroups, topSubnet: topSubnetEntry?.subnet ?? "", subnetConcentration: entries.length && topSubnetEntry ? Math.round(topSubnetEntry.events / entries.length * 100) : 0,
    hourBuckets, peakHour,
    avgAuthRatio: mean(authRatios), avgSessionRatio: mean(sessionRatios), avgActionRatio: mean(actionRatios),
    roboticTimingPct: covList.length ? Math.round(roboticCount / covList.length * 100) : 0,
    commonFirstEps, commonLastEps,
    trustRankMean: mean(trustRanks), trustRankMedian: median(trustRanks), trustDistribution,
    lowTrustPct, highTrustPct,
    unreliablePct, lowReliabilityEntries,
    verifyOnlyPct: entries.length ? Math.round(verifyOnlyCount / entries.length * 100) : 0,
    verifyOnlyCount,
    proxyBlastEntries,
    verifyClusterGroups,
  };
}

// ── Anomaly scoring (0–100) ─────────────────────────────────────────────────
function computeAnomalyScore(m: EntryMetrics, cross: CrossStats): number {
  if (cross.n < 2) return 0;
  let s = 0;
  if (cross.callRateStdDev > 0) s += Math.min(20, Math.max(0, zScore(m.callsPerMin, cross.callRateMean, cross.callRateStdDev) * 8));
  if (cross.sessionPerActionStdDev > 0) s += Math.min(20, Math.max(0, zScore(cross.sessionPerActionMean, m.sessionPerAction, cross.sessionPerActionStdDev) * 8));
  if (m.timingCoV >= 0 && m.timingCoV < 0.3) s += 15; else if (m.timingCoV >= 0 && m.timingCoV < 0.5) s += 8;
  if (cross.entropyStdDev > 0) s += Math.min(12, Math.max(0, zScore(cross.entropyMean, m.shannonEntropy, cross.entropyStdDev) * 6));
  if (m.burstCount > 5) s += 10; else if (m.burstCount > 0) s += 5;
  if (m.preActionWarmup >= 0 && m.preActionWarmup < 5 && m.cats.follow > 0) s += 10;
  if (m.spanMin > 0 && m.spanMin < 30) s += 10; else if (m.spanMin > 0 && m.spanMin < 60) s += 5;
  if (m.avgInterCallSec > 0 && m.avgInterCallSec < 0.5) s += 8;
  return Math.min(100, Math.round(s));
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function buildProxyRiskMap(bans: AnalyticsEntry[], automated: AnalyticsEntry[], captcha: AnalyticsEntry[], locked: AnalyticsEntry[]): ProxyRisk[] {
  const map = new Map<string, ProxyRisk>();
  const empty = (): ProxyRisk => ({ host: "", banCount: 0, automatedCount: 0, captchaCount: 0, lockedCount: 0, total: 0, accounts: [], entryIds: { ban: [], automated: [], captcha: [], locked: [] } });
  const add = (entries: AnalyticsEntry[], countKey: keyof Pick<ProxyRisk, "banCount" | "automatedCount" | "captchaCount" | "lockedCount">, idKey: keyof ProxyRisk["entryIds"]) => {
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!map.has(host)) { const r = empty(); r.host = host; map.set(host, r); }
      const r = map.get(host)!;
      r[countKey]++; r.total++; r.entryIds[idKey].push(e.id);
      if (!r.accounts.includes(e.username)) r.accounts.push(e.username);
    }
  };
  add(bans, "banCount", "ban"); add(automated, "automatedCount", "automated");
  add(captcha, "captchaCount", "captcha"); add(locked, "lockedCount", "locked");
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function buildConcurrencyAlerts(bans: AnalyticsEntry[], automated: AnalyticsEntry[], captcha: AnalyticsEntry[], locked: AnalyticsEntry[]): ConcurrencyAlert[] {
  const alerts: ConcurrencyAlert[] = [];
  for (const { entries, label } of [{ entries: bans, label: "Ban" }, { entries: automated, label: "Automated" }, { entries: captcha, label: "Captcha" }, { entries: locked, label: "Locked" }]) {
    const byProxy = new Map<string, AnalyticsEntry[]>();
    for (const e of entries) { const h = e.proxyHost || "(no proxy)"; if (!byProxy.has(h)) byProxy.set(h, []); byProxy.get(h)!.push(e); }
    for (const [host, es] of byProxy) {
      if (es.length < 2) continue;
      const sorted = [...es].sort((a, b) => new Date(getEventTime(a)).getTime() - new Date(getEventTime(b)).getTime());
      for (let i = 0; i < sorted.length - 1; i++) {
        const ta = new Date(getEventTime(sorted[i])).getTime();
        const tb = new Date(getEventTime(sorted[i + 1])).getTime();
        if (Math.abs(tb - ta) <= 30 * 60 * 1000) alerts.push({ proxyHost: host, accounts: [sorted[i].username, sorted[i + 1].username], times: [getEventTime(sorted[i]), getEventTime(sorted[i + 1])], category: label });
      }
    }
  }
  return alerts.slice(0, 20);
}

function parseFirstAddedDate(notes: string | null | undefined): Date | null {
  if (!notes) return null;
  const matches = [...notes.matchAll(/Added:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/gi)];
  if (!matches.length) return null;
  const dates = matches.map(m => new Date(m[1].replace(" UTC", "Z").replace(" ", "T"))).filter(d => !isNaN(d.getTime()));
  return dates.length ? dates.reduce((e, d) => d < e ? d : e) : null;
}
function parseAllAddedDates(notes: string | null | undefined): Date[] {
  if (!notes) return [];
  return [...notes.matchAll(/(?:Added|Re-added|Re-imported):\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/gi)]
    .map(m => new Date(m[1].replace(" UTC", "Z").replace(" ", "T")))
    .filter(d => !isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime());
}
function formatDuration(ms: number): string {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  if (d >= 1) return `${d}d ${h}h`;
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

function getFollowCount(entry: AnalyticsEntry): number {
  if (entry.followCountBeforeBan !== null && entry.followCountBeforeBan !== undefined) {
    return entry.followCountBeforeBan;
  }
  const eps = filterHiker(parseEps(entry.endpointSnapshot));
  const m = computeMetrics(eps, entry.flaggedAt ?? entry.bannedAt);
  return m.cats.follow ?? 0;
}

function groupByFollowCount(entries: AnalyticsEntry[]) {
  const neverRan: AnalyticsEntry[] = [];
  const firstFollow: AnalyticsEntry[] = [];
  const longRunner: AnalyticsEntry[] = [];
  for (const e of entries) {
    const n = getFollowCount(e);
    if (n === 0) neverRan.push(e);
    else if (n <= 9) firstFollow.push(e);
    else longRunner.push(e);
  }
  return { neverRan, firstFollow, longRunner };
}

function UsernameLink({ username, profileMap }: { username: string; profileMap: Map<string, number> }) {
  const [, navigate] = useLocation();
  const id = profileMap.get(username);
  if (!id) return <span className="font-semibold">@{username}</span>;
  return <button onClick={() => navigate(`/profiles/${id}`)} className="font-semibold hover:text-cyan-400 hover:underline underline-offset-2 transition-colors cursor-pointer">@{username}</button>;
}

type Tab = "ban" | "automated" | "captcha" | "locked" | "survivors";
type ErrorTab = Exclude<Tab, "survivors">;
type InnerTab = "data" | "theories";
type GroupFilter = "all" | "never-ran" | "first-follow" | "long-runner";

const TAB_CONFIG: Record<ErrorTab, {
  label: string; accentBg: string; emptyMsg: string; flagMsg: string; deleteEndpoint: string; queryKey: string;
  causeTitle: string; causeTheory: string; causeSignals: string[];
}> = {
  ban: {
    label: "Banned Accounts", accentBg: "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",
    emptyMsg: "No ban analytics yet", flagMsg: "Flag accounts as Banned from Accounts → Actions → Flag as Banned.", deleteEndpoint: "/api/analytics/ban-patterns", queryKey: "/api/analytics/ban-patterns",
    causeTitle: "What mathematically separates a BAN from other errors",
    causeTheory: "A permanent ban is Instagram's highest-confidence outcome. It is NOT issued on first suspicion. It indicates either (a) repeated automated-behaviour detections that crossed a threshold, (b) a pre-flagged account or IP with a damaged trust history, or (c) an extreme single-session behaviour violation (very high action ratio, very high velocity). High-TrustScore accounts being banned is significant. The trigger had to be severe to overcome their earned reputation.",
    causeSignals: ["Action ratio > 40% of all API calls (session is task-only, no human reads)", "Action velocity > 50/hr sustained over > 60 minutes", "IP reputation pre-flagged (fast-ban in < 30 min = the IP, not the behaviour)", "Low TrustScore accounts: ban threshold is much lower under existing scrutiny", "Multiple consecutive flag events on same proxy (escalation chain)"],
  },
  automated: {
    label: "Automated Behaviour", accentBg: "bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800",
    emptyMsg: "No automated behaviour events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Automated Behaviour.", deleteEndpoint: "/api/analytics/automated-patterns", queryKey: "/api/analytics/automated-patterns",
    causeTitle: "What mathematically separates AUTOMATED BEHAVIOUR from other errors",
    causeTheory: "Automated Behaviour is a soft block triggered by Instagram's session-level pattern classifier. It is about HOW actions are performed, not IP reputation or account history. This is the purest signal of timing/noise issues. Unlike bans (reputation-based), ABD is triggered by a single session's behavioural fingerprint. It is reversible: fix the pattern and the account continues. The key factors are timing regularity (CoV), session noise ratio, and burst patterns.",
    causeSignals: ["Timing CoV < 0.5 machine-uniform intervals no human variance", "Session noise < 5 reads per action not enough human reads between actions", "Burst count high rapid consecutive calls with no breathing room", "First logged call was already an action endpoint no other calls preceded it", "Endpoint diversity (entropy) very low hammering 2-3 endpoints repeatedly"],
  },
  captcha: {
    label: "Captcha Errors", accentBg: "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800",
    emptyMsg: "No captcha events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Captcha Error.", deleteEndpoint: "/api/analytics/captcha-patterns", queryKey: "/api/analytics/captcha-patterns",
    causeTitle: "What mathematically separates CAPTCHA from other errors",
    causeTheory: "A captcha challenge means Instagram is uncertain. It suspects automation but won't commit to blocking. This is usually IP-level or device-fingerprint uncertainty rather than session-behaviour analysis. Captchas frequently co-occur with proxy rotation (IP mismatch detected between sessions), new device fingerprint, or geographic inconsistency. Unlike ABD (pattern-based), captchas are triggered BEFORE the action pattern is established often at session startup.",
    causeSignals: ["Auth call ratio unusually high device fingerprint negotiation at session start", "Fast session start-to-first-captcha triggered before actions (IP reputation check)", "Proxy/IP change between sessions location inconsistency", "Few calls logged before the challenge fired session was cut short early", "High auth per action repeated login verification mid-session"],
  },
  locked: {
    label: "Locked Accounts", accentBg: "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800",
    emptyMsg: "No locked account events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Locked Account.", deleteEndpoint: "/api/analytics/locked-patterns", queryKey: "/api/analytics/locked-patterns",
    causeTitle: "What mathematically separates LOCKED ACCOUNTS from other errors",
    causeTheory: "Account locking is Instagram's security protocol. It is not purely behaviour-based. It primarily triggers on device or session anomalies: a login from an unrecognized device fingerprint, a geographic location change, or a session that looks physically impossible (simultaneous logins from different locations). It can also be triggered by a rapid escalation from suspicious activity. Locked accounts require user action to unlock. They are identity challenges, not automation blocks.",
    causeSignals: ["Device fingerprint mismatch ig_did/mid changed between sessions (check Device IDs)", "Geographic anomaly proxy location inconsistent with account history", "Concurrent session detection two sessions open simultaneously on same account", "High action rate immediately after session start", "Auth calls repeated mid-session Instagram re-challenging device identity"],
  },
};

const CAT_META: Record<string, { label: string; color: string }> = {
  follow: { label: "Follow", color: "bg-cyan-400" }, unfollow: { label: "Unfollow", color: "bg-orange-400" },
  dm: { label: "DM", color: "bg-purple-400" }, like: { label: "Like", color: "bg-pink-400" },
  session: { label: "Session", color: "bg-blue-400" }, auth: { label: "Auth", color: "bg-slate-400" },
  other: { label: "Other", color: "bg-muted-foreground" },
};

// ── MiniHistogram ─────────────────────────────────────────────────────────────
function MiniHistogram({ buckets, note }: { buckets: { label: string; count: number; color?: string }[]; note?: string }) {
  const max = Math.max(...buckets.map(b => b.count), 1);
  return (
    <div className="space-y-1">
      {buckets.map(b => (
        <div key={b.label} className="flex items-center gap-2 text-[10px]">
          <span className="text-muted-foreground w-28 shrink-0 truncate">{b.label}</span>
          <div className="flex-1 h-3 bg-muted rounded-sm overflow-hidden">
            <div className={`h-full rounded-sm ${b.color ?? "bg-cyan-400"}`} style={{ width: `${Math.round(b.count / max * 100)}%` }} />
          </div>
          <span className="w-6 text-right font-mono font-semibold">{b.count}</span>
        </div>
      ))}
      {note && <p className="text-[10px] text-muted-foreground italic mt-1">{note}</p>}
    </div>
  );
}

function StatRow({ label, val, warn }: { label: string; val: string; warn?: boolean }) {
  return (
    <div className="flex justify-between items-baseline gap-2 py-0.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <span className={`font-mono font-semibold text-[11px] ${warn ? "text-amber-600" : ""}`}>{val}</span>
    </div>
  );
}

// ── Causation Panel (per-tab theory + data validation) ─────────────────────
function CausationPanel({ tabKey, cross, cfg }: { tabKey: ErrorTab; cross: CrossStats; cfg: typeof TAB_CONFIG[ErrorTab] }) {
  const [expanded, setExpanded] = useState(false);

  // Validate theory signals against actual data
  const validations: Array<{ signal: string; status: "confirmed" | "partial" | "not_seen"; value: string }> = [];

  if (tabKey === "ban") {
    validations.push({ signal: "High action ratio (>40%)", status: cross.avgActionRatio > 0.4 ? "confirmed" : cross.avgActionRatio > 0.2 ? "partial" : "not_seen", value: `${(cross.avgActionRatio * 100).toFixed(1)}%` });
    validations.push({ signal: "High action velocity", status: cross.actionVelocityMean > 50 ? "confirmed" : cross.actionVelocityMean > 20 ? "partial" : "not_seen", value: `${cross.actionVelocityMean.toFixed(1)}/hr avg` });
    validations.push({ signal: "Fast-flagged (<30 min)", status: cross.fastFlagPct >= 50 ? "confirmed" : cross.fastFlagPct >= 20 ? "partial" : "not_seen", value: `${cross.fastFlagPct}% of events` });
    validations.push({ signal: "Low TrustScore accounts", status: cross.lowTrustPct >= 50 ? "confirmed" : cross.lowTrustPct >= 20 ? "partial" : "not_seen", value: cross.n > 0 && Object.keys(cross.trustDistribution).length > 0 ? `${cross.lowTrustPct}% at rank ≤4` : "no trust data" });
    validations.push({ signal: "Proxy concentration", status: cross.proxyConcentration >= 60 ? "confirmed" : cross.proxyConcentration >= 30 ? "partial" : "not_seen", value: `${cross.proxyConcentration}% on top IP` });
  } else if (tabKey === "automated") {
    validations.push({ signal: "Robotic timing (CoV<0.5)", status: cross.roboticTimingPct >= 50 ? "confirmed" : cross.roboticTimingPct >= 20 ? "partial" : "not_seen", value: `${cross.roboticTimingPct}% of events` });
    validations.push({ signal: "Low session noise (<5)", status: cross.sessionPerActionMedian < 5 ? "confirmed" : cross.sessionPerActionMedian < 10 ? "partial" : "not_seen", value: `median ${cross.sessionPerActionMedian.toFixed(2)}/action` });
    validations.push({ signal: "High burst rate (>30%)", status: cross.burstPct >= 50 ? "confirmed" : cross.burstPct >= 20 ? "partial" : "not_seen", value: `${cross.burstPct}% of events` });
    validations.push({ signal: "Follows with <5 prior calls", status: cross.zeroWarmupPct >= 50 ? "confirmed" : cross.zeroWarmupPct >= 20 ? "partial" : "not_seen", value: `${cross.zeroWarmupPct}% of sessions` });
    validations.push({ signal: "Low entropy (<1.5 bits)", status: cross.entropyMedian < 1.5 ? "confirmed" : cross.entropyMedian < 2.5 ? "partial" : "not_seen", value: `median ${cross.entropyMedian.toFixed(3)} bits` });
  } else if (tabKey === "captcha") {
    validations.push({ signal: "High auth ratio", status: cross.avgAuthRatio > 0.2 ? "confirmed" : cross.avgAuthRatio > 0.08 ? "partial" : "not_seen", value: `${(cross.avgAuthRatio * 100).toFixed(1)}% auth calls` });
    validations.push({ signal: "Fast session challenge (<30m)", status: cross.fastFlagPct >= 50 ? "confirmed" : cross.fastFlagPct >= 20 ? "partial" : "not_seen", value: `${cross.fastFlagPct}% flagged <60m` });
    validations.push({ signal: "Low avg calls before follow", status: cross.warmupMedian < 3 ? "confirmed" : cross.warmupMedian < 8 ? "partial" : "not_seen", value: `median ${cross.warmupMedian.toFixed(1)} calls before each follow` });
    validations.push({ signal: "High auth per action", status: cross.authPerActionMean > 2 ? "confirmed" : cross.authPerActionMean > 0.5 ? "partial" : "not_seen", value: `${cross.authPerActionMean.toFixed(3)} auth/action` });
    validations.push({ signal: "Min gap issues", status: cross.minGapMean < 0.5 ? "confirmed" : cross.minGapMean < 2 ? "partial" : "not_seen", value: cross.minGapMean < 1 ? `${(cross.minGapMean * 1000).toFixed(0)}ms avg min gap` : `${cross.minGapMean.toFixed(1)}s avg min gap` });
  } else {
    validations.push({ signal: "High auth ratio (fingerprint renegotiation)", status: cross.avgAuthRatio > 0.25 ? "confirmed" : cross.avgAuthRatio > 0.1 ? "partial" : "not_seen", value: `${(cross.avgAuthRatio * 100).toFixed(1)}% auth calls` });
    validations.push({ signal: "Follows with <5 prior calls", status: cross.zeroWarmupPct >= 50 ? "confirmed" : cross.zeroWarmupPct >= 20 ? "partial" : "not_seen", value: `${cross.zeroWarmupPct}% of sessions` });
    validations.push({ signal: "Fast lock (<30 min)", status: cross.fastFlagPct >= 50 ? "confirmed" : cross.fastFlagPct >= 20 ? "partial" : "not_seen", value: `${cross.fastFlagPct}% flagged <60m` });
    validations.push({ signal: "Concurrent sessions / subnet", status: cross.subnetGroups.length > 0 ? (cross.subnetConcentration >= 50 ? "confirmed" : "partial") : "not_seen", value: cross.subnetGroups.length > 0 ? `${cross.subnetGroups.length} shared subnet${cross.subnetGroups.length !== 1 ? "s" : ""}` : "none" });
    validations.push({ signal: "Short avg session span", status: cross.avgSpanMin > 0 && cross.avgSpanMin < 15 ? "confirmed" : cross.avgSpanMin < 30 ? "partial" : "not_seen", value: cross.avgSpanMin > 0 ? (cross.avgSpanMin < 60 ? `${cross.avgSpanMin.toFixed(1)}m avg` : `${(cross.avgSpanMin/60).toFixed(2)}h avg`) : "—" });
  }

  const confirmedCount = validations.filter(v => v.status === "confirmed").length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button className="w-full px-4 py-3 flex items-center gap-2 hover:bg-muted/30 transition-colors text-left" onClick={() => setExpanded(o => !o)}>
        <FlaskConical className="w-4 h-4 text-indigo-500 shrink-0" />
        <div className="flex-1">
          <span className="text-sm font-semibold">{cfg.causeTitle}</span>
          <span className="text-xs text-muted-foreground ml-2">{confirmedCount}/{validations.length} signals confirmed by your data</span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          <div className="px-4 py-3 bg-indigo-50 dark:bg-indigo-900/15">
            <p className="text-[11px] text-foreground leading-relaxed">{cfg.causeTheory}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Theory signals vs your data</p>
            <div className="space-y-1.5">
              {validations.map(v => (
                <div key={v.signal} className="flex items-center gap-2 text-[11px]">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${v.status === "confirmed" ? "bg-green-500" : v.status === "partial" ? "bg-amber-400" : "bg-muted"}`} />
                  <span className="flex-1">{v.signal}</span>
                  <span className={`font-mono font-semibold shrink-0 ${v.status === "confirmed" ? "text-green-600" : v.status === "partial" ? "text-amber-600" : "text-muted-foreground"}`}>{v.value}</span>
                  <span className={`text-[9px] font-bold px-1 rounded ${v.status === "confirmed" ? "bg-green-100 text-green-700" : v.status === "partial" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>{v.status === "confirmed" ? "YES" : v.status === "partial" ? "PARTIAL" : "NO"}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3 bg-muted/20">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Known causal signals for this error type</p>
            <div className="space-y-1">
              {cfg.causeSignals.map((s, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="text-muted-foreground shrink-0 mt-0.5">→</span>
                  <span className="text-muted-foreground">{s}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TrustScore panel ──────────────────────────────────────────────────────────
function TrustScorePanel({ entries, survivingAccounts, trustMap, profileMap, tabKey }: {
  entries: AnalyticsEntry[];
  survivingAccounts: Array<{ username: string; runMs: number | null }>;
  trustMap: Map<number, TrustInfo>;
  profileMap: Map<string, number>;
  tabKey: ErrorTab;
}) {
  const flaggedTrusts = entries.map(e => trustMap.get(profileMap.get(e.username) ?? -1)).filter(Boolean) as TrustInfo[];
  const survivorTrusts = survivingAccounts.map(a => trustMap.get(profileMap.get(a.username) ?? -1)).filter(Boolean) as TrustInfo[];

  if (flaggedTrusts.length === 0 && survivorTrusts.length === 0) return null;

  const flaggedRanks    = flaggedTrusts.map(t => t.rank);
  const survivorRanks   = survivorTrusts.map(t => t.rank);
  const flaggedMedRank  = median(flaggedRanks);
  const survivorMedRank = median(survivorRanks);

  // Distribution: group into 4 tiers
  const tiers = [
    { label: "Rank 1–4 (highest scrutiny)", min: 1, max: 4, color: "bg-red-400" },
    { label: "Rank 5–8 (moderate scrutiny)", min: 5, max: 8, color: "bg-orange-400" },
    { label: "Rank 9–12 (trusted)", min: 9, max: 12, color: "bg-blue-400" },
    { label: "Rank 13+ (high trust)", min: 13, max: 99, color: "bg-green-400" },
  ];

  // Insights
  const insights: Array<{ severity: "critical" | "warning" | "info"; text: string }> = [];

  if (flaggedTrusts.length > 0) {
    const lowPct = flaggedRanks.length ? Math.round(flaggedRanks.filter(r => r <= 4).length / flaggedRanks.length * 100) : 0;
    const highPct = flaggedRanks.length ? Math.round(flaggedRanks.filter(r => r >= 9).length / flaggedRanks.length * 100) : 0;

    if (lowPct >= 70)
      insights.push({ severity: "info", text: `${lowPct}% of flagged accounts are at TrustScore rank 1–4 (highest scrutiny). These accounts are under baseline Instagram scrutiny regardless of behaviour — the flag threshold is lower for them. Lower activity levels on these accounts before escalating to higher ranks.` });
    else if (highPct >= 40)
      insights.push({ severity: "critical", text: `${highPct}% of flagged accounts are at TrustScore rank 9+ (trusted tier). High-trust accounts require a more severe trigger to flag — the behaviour that caused this was significant. Look for extreme velocity or IP reputation issues.` });

    if (survivorTrusts.length > 0 && flaggedMedRank < survivorMedRank - 2)
      insights.push({ severity: "warning", text: `Flagged accounts average TrustScore rank ${flaggedMedRank.toFixed(1)} vs surviving accounts at ${survivorMedRank.toFixed(1)}. Lower-ranked accounts are being flagged more — consider running aggressive tools only on higher-ranked accounts.` });
    else if (survivorTrusts.length > 0 && Math.abs(flaggedMedRank - survivorMedRank) <= 2)
      insights.push({ severity: "info", text: `Flagged (rank ${flaggedMedRank.toFixed(1)}) and surviving (rank ${survivorMedRank.toFixed(1)}) accounts have similar TrustScore distributions — the flag trigger is not selective to low-trust accounts. The issue affects all accounts equally.` });

    // Note: captcha/automated don't necessarily reduce TrustScore
    if (tabKey === "captcha" || tabKey === "automated")
      insights.push({ severity: "info", text: `Note: ${tabKey === "captcha" ? "Captcha challenges" : "Automated Behaviour blocks"} do not always reduce TrustScore permanently — they may reflect transient conditions. Account rank data shown here is current (may differ from rank at time of event).` });
    if (tabKey === "locked")
      insights.push({ severity: "info", text: `Locked accounts are security-locked, not trust-demoted. TrustScore at time of locking may have been higher — device fingerprint or session anomalies cause locks independent of rank.` });
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Star className="w-4 h-4 text-yellow-500" />
        <span className="text-sm font-semibold">TrustScore Correlation</span>
        <span className="text-xs text-muted-foreground ml-auto">{flaggedTrusts.length} of {entries.length} flagged accounts have TrustScore data</span>
      </div>

      {flaggedTrusts.length > 0 && (
        <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
          {/* Flagged distribution */}
          <div className="p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Flagged accounts TrustScore</p>
            <MiniHistogram buckets={tiers.map(t => ({ label: t.label, count: flaggedRanks.filter(r => r >= t.min && r <= t.max).length, color: t.color }))} note={`Median rank: ${flaggedMedRank.toFixed(1)}`} />
          </div>
          {/* Survivor distribution */}
          <div className="p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Surviving accounts TrustScore</p>
            {survivorTrusts.length > 0
              ? <MiniHistogram buckets={tiers.map(t => ({ label: t.label, count: survivorRanks.filter(r => r >= t.min && r <= t.max).length, color: t.color }))} note={`Median rank: ${survivorMedRank.toFixed(1)}`} />
              : <p className="text-[11px] text-muted-foreground italic">No valid surviving accounts found</p>}
          </div>
        </div>
      )}

      {/* Insights */}
      {insights.length > 0 && (
        <div className="divide-y divide-border">
          {insights.map((f, i) => (
            <div key={i} className="px-4 py-3 flex gap-3">
              <span className={`shrink-0 mt-1 w-2 h-2 rounded-full ${f.severity === "critical" ? "bg-red-500" : f.severity === "warning" ? "bg-amber-500" : "bg-blue-400"}`} />
              <p className="text-[11px] text-foreground leading-relaxed">{f.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* Per-account trust list */}
      {flaggedTrusts.length > 0 && (
        <div className="border-t border-border">
          <div className="px-4 py-2 bg-muted/20 text-[10px] text-muted-foreground">Current TrustScore per flagged account — ranks shown reflect the current score, which may have changed since the flag event.</div>
          <div className="flex flex-wrap gap-2 px-4 py-3">
            {entries.map(e => {
              const ti = trustMap.get(profileMap.get(e.username) ?? -1);
              if (!ti) return null;
              return (
                <div key={e.id} className="flex items-center gap-1.5 text-[10px] bg-muted rounded px-2 py-1">
                  <span className="font-semibold">@{e.username}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={`font-bold ${ti.rank <= 4 ? "text-red-500" : ti.rank <= 8 ? "text-orange-500" : ti.rank <= 12 ? "text-blue-500" : "text-green-500"}`}>{ti.label}</span>
                  <span className="text-muted-foreground text-[9px]">#{ti.rank}</span>
                </div>
              );
            }).filter(Boolean)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reliability panel ─────────────────────────────────────────────────────────
function ReliabilityPanel({ entries, profileNotesMap }: { entries: AnalyticsEntry[]; profileNotesMap: Map<string, string | null> }) {
  const rels = entries.map(e => ({ username: e.username, ...computeReliability(profileNotesMap.get(e.username)) }));
  const unreliable = rels.filter(r => r.reAddCount >= 2);
  if (entries.length < 2 || unreliable.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <BadgeAlert className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-semibold">Data Reliability Warning</span>
        <span className="text-xs text-muted-foreground ml-auto">{unreliable.length} of {entries.length} events from accounts with repeated re-adds</span>
      </div>
      <div className="px-4 py-3 text-[11px] leading-relaxed">
        <p className="text-foreground mb-2">
          Accounts that have been re-added to the software multiple times are <strong>lower-confidence data points</strong>. Re-adds typically happen because an account keeps running into issues — meaning the account itself may be compromised, shadow-flagged, or operated by someone making repeated mistakes. Their endpoint patterns reflect an account already under stress, not a clean baseline.
        </p>
        <div className="flex flex-wrap gap-2 mt-2">
          {rels.sort((a, b) => b.reAddCount - a.reAddCount).map(r => (
            <span key={r.username} className={`text-[10px] px-2 py-0.5 rounded font-mono ${r.reAddCount >= 3 ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300" : r.reAddCount >= 2 ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>
              @{r.username} {r.reAddCount > 0 ? `[${r.label}]` : "[first add]"}
            </span>
          ))}
        </div>
        <p className="text-muted-foreground mt-2">Cross-account statistics above incorporate reliability weighting — accounts with more re-adds contribute less to the aggregate figures. Effective weighted n={rels.reduce((s, r) => s + r.weight, 0).toFixed(2)} vs raw n={entries.length}.</p>
      </div>
    </div>
  );
}

// ── Per-entry card ────────────────────────────────────────────────────────────
function EntryCard({ entry, cfg, cross, profileMap, trustMap, reliability }: {
  entry: AnalyticsEntry; cfg: typeof TAB_CONFIG[ErrorTab]; cross: CrossStats;
  profileMap: Map<string, number>; trustMap: Map<number, TrustInfo>; reliability: Reliability;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Remove this log entry for @${entry.username}?`)) return;
    setDeleting(true);
    try {
      await fetch(`${cfg.deleteEndpoint}/${entry.id}`, { method: "DELETE", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: [cfg.queryKey] });
    } finally { setDeleting(false); }
  }

  const allEps = parseEps(entry.endpointSnapshot);
  const eps    = filterHiker(allEps);
  const hikerN = allEps.length - eps.length;
  const ts     = entry.flaggedAt ?? entry.bannedAt ?? "";
  const m      = computeMetrics(eps, ts);
  const anomaly = computeAnomalyScore(m, cross);
  const top5    = topEps(eps, 5);
  const topFull = topEps(eps, 30);
  const ti      = trustMap.get(profileMap.get(entry.username) ?? -1);
  const subnet  = entry.proxyHost && isIpAddr(entry.proxyHost) ? extractSubnet24(entry.proxyHost) : null;
  const anomalyLabel = anomaly >= 70 ? "HIGH" : anomaly >= 40 ? "MED" : "LOW";
  const spanStr = m.spanMin < 1 ? `${Math.round(m.spanMin * 60)}s` : m.spanMin < 60 ? `${m.spanMin.toFixed(1)}m` : `${(m.spanMin / 60).toFixed(2)}h`;
  const covLabel = m.timingCoV < 0 ? "—" : m.timingCoV < 0.3 ? "ROBOTIC" : m.timingCoV < 0.5 ? "LOW" : m.timingCoV < 1.0 ? "MODERATE" : "HUMAN";
  const covColor = m.timingCoV < 0 ? "" : m.timingCoV < 0.3 ? "text-red-500" : m.timingCoV < 0.5 ? "text-amber-600" : "text-green-600";

  return (
    <div className={`border border-border rounded-lg overflow-hidden relative ${reliability.weight < 0.6 ? "border-amber-300 dark:border-amber-700/50" : ""}`}>
      <button onClick={handleDelete} disabled={deleting} title="Remove this log entry"
        className="absolute top-2 right-2 z-10 flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-500 hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors disabled:opacity-40">
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
      </button>

      <button className="w-full px-4 py-3 pr-9 flex items-start gap-3 text-left hover:bg-muted/30 transition-colors" onClick={() => setOpen(o => !o)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <UsernameLink username={entry.username} profileMap={profileMap} />
            {ti && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ti.rank <= 4 ? "bg-red-50 border-red-200 text-red-600" : ti.rank <= 8 ? "bg-orange-50 border-orange-200 text-orange-600" : ti.rank <= 12 ? "bg-blue-50 border-blue-200 text-blue-500" : "bg-green-50 border-green-200 text-green-600"}`}>{ti.label} #{ti.rank}</span>}
            {reliability.reAddCount >= 2 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-600">{reliability.label}</span>}
            {cross.n >= 2 && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${anomaly >= 70 ? "bg-red-50 border-red-200 text-red-600" : anomaly >= 40 ? "bg-amber-50 border-amber-200 text-amber-600" : "bg-green-50 border-green-200 text-green-600"}`}>ANOMALY {anomalyLabel} {anomaly}</span>}
            {m.timingCoV >= 0 && m.timingCoV < 0.5 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-red-50 border-red-200 text-red-600">ROBOTIC TIMING</span>}
            {m.preActionWarmup >= 0 && m.preActionWarmup < 3 && m.cats.follow > 0 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-orange-50 border-orange-200 text-orange-600">FOLLOW EARLY</span>}
            <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{ts ? new Date(ts).toLocaleString() : "—"}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {entry.proxyHost ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Globe className="w-3 h-3" />{entry.proxyHost}{subnet ? ` [${subnet}]` : ""}</span> : <span className="text-[11px] text-muted-foreground italic">no proxy</span>}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
            <span>{eps.length} calls{hikerN > 0 ? ` +${hikerN} HikerAPI` : ""}</span>
            {m.callsPerMin > 0 && <span><Clock className="w-3 h-3 inline mr-0.5" />{m.callsPerMin.toFixed(3)}/min</span>}
            {m.spanMin > 0 && <span>{spanStr}</span>}
            {m.avgInterCallSec > 0 && <span>avg gap: {m.avgInterCallSec < 60 ? `${m.avgInterCallSec.toFixed(1)}s` : `${(m.avgInterCallSec/60).toFixed(1)}m`}</span>}
            {eps.length > 1 && <span>min gap: {m.minInterCallSec < 1 ? `${Math.round(m.minInterCallSec * 1000)}ms` : `${m.minInterCallSec.toFixed(1)}s`}</span>}
            {m.burstCount > 0 && <span className="text-amber-600 font-semibold">{m.burstCount} burst{m.burstCount !== 1 ? "s" : ""}</span>}
            {m.cats.follow > 0 && <span><UserPlus className="w-3 h-3 inline mr-0.5" />{m.cats.follow}</span>}
            {m.cats.unfollow > 0 && <span><UserMinus className="w-3 h-3 inline mr-0.5" />{m.cats.unfollow}</span>}
            {m.cats.dm > 0 && <span><MessageSquare className="w-3 h-3 inline mr-0.5" />{m.cats.dm}</span>}
            {m.cats.like > 0 && <span><Zap className="w-3 h-3 inline mr-0.5" />{m.cats.like}</span>}
          </div>
          {top5.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {top5.map(ep => <span key={ep.name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${cfg.accentBg}`}>{ep.label ?? ep.name} <span className="opacity-60">×{ep.count}</span></span>)}
            </div>
          )}
        </div>
        <div className="shrink-0 mt-0.5 text-muted-foreground">{open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</div>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/20 divide-y divide-border">
          {eps.length >= 3 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><Sigma className="w-3.5 h-3.5" /> All Computed Metrics</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[11px]">
                {([
                  ["Call rate", m.callsPerMin > 0 ? `${m.callsPerMin.toFixed(5)}/min` : "—"],
                  ["Session span", m.spanMin > 0 ? spanStr : "—"],
                  ["Avg inter-call gap", m.avgInterCallSec > 0 ? (m.avgInterCallSec < 60 ? `${m.avgInterCallSec.toFixed(2)}s` : `${(m.avgInterCallSec/60).toFixed(2)}m`) : "—"],
                  ["Min gap", eps.length > 1 ? (m.minInterCallSec < 1 ? `${Math.round(m.minInterCallSec * 1000)}ms` : `${m.minInterCallSec.toFixed(2)}s`) : "—"],
                  ["Max gap", m.maxInterCallSec > 0 ? (m.maxInterCallSec < 60 ? `${m.maxInterCallSec.toFixed(1)}s` : m.maxInterCallSec < 3600 ? `${(m.maxInterCallSec/60).toFixed(1)}m` : `${(m.maxInterCallSec/3600).toFixed(2)}h`) : "—"],
                  ["Timing CoV (σ/μ)", m.timingCoV >= 0 ? `${m.timingCoV.toFixed(4)} [${covLabel}]` : "—"],
                  ["Shannon entropy", `${m.shannonEntropy.toFixed(4)} bits`],
                  ["Unique endpoints", `${m.uniqueEndpoints} (${(m.endpointDiversity * 100).toFixed(1)}% diverse)`],
                  ["Burst windows (≤60s)", `${m.burstCount}`],
                  ["Avg calls before each follow", m.preActionWarmup >= 0 ? `${m.preActionWarmup}` : "—"],
                  ["Action velocity", m.actionVelocityPerHour > 0 ? `${m.actionVelocityPerHour.toFixed(2)}/hr` : "—"],
                  ["Session / action", m.actionCount > 0 ? `${m.sessionPerAction.toFixed(3)}  (median: ${cross.sessionPerActionMedian.toFixed(3)})` : "no actions"],
                  ["Session / follow", m.sessionPerFollow > 0 ? `${m.sessionPerFollow.toFixed(3)}` : "—"],
                  ["Auth / action", m.actionCount > 0 ? `${m.authPerAction.toFixed(3)}` : "—"],
                  ["Flag hour (UTC)", m.flagHour >= 0 ? `${String(m.flagHour).padStart(2,"0")}:00` : "—"],
                  ["TrustScore rank", ti ? `${ti.label} (rank #${ti.rank})` : "—"],
                  ["Re-add count", reliability.reAddCount > 0 ? `${reliability.reAddCount}× (weight: ${reliability.weight})` : "first add (full weight)"],
                  cross.n >= 2 ? ["Anomaly score", `${anomaly}/100 (${anomalyLabel})`] : null,
                ] as ([string, string] | null)[]).filter((x): x is [string, string] => x !== null).map(([label, val]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-mono font-semibold ${label === "Timing CoV (σ/μ)" ? covColor : ""}`}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {eps.length >= 5 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Call composition</p>
              <div className="flex h-4 rounded overflow-hidden">
                {Object.entries(CAT_META).map(([cat, meta]) => { const pct = eps.length ? (m.cats[cat] ?? 0) / eps.length * 100 : 0; return pct > 0 ? <div key={cat} className={`${meta.color}`} style={{ width: `${pct}%` }} title={`${meta.label}: ${m.cats[cat]} (${pct.toFixed(1)}%)`} /> : null; })}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
                {Object.entries(CAT_META).map(([cat, meta]) => { const count = m.cats[cat] ?? 0; const pct = eps.length ? count / eps.length * 100 : 0; return count > 0 ? <span key={cat} className="flex items-center gap-1 text-[10px] text-muted-foreground"><span className={`w-2 h-2 rounded-sm ${meta.color}`} />{meta.label}: {count} ({pct.toFixed(1)}%)</span> : null; })}
              </div>
            </div>
          )}
          {topFull.length > 0 && (
            <div className="px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><BarChart2 className="w-3.5 h-3.5" /> All endpoints by count</p>
              <div className="space-y-0.5">
                {topFull.map(ep => (
                  <div key={ep.name} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CAT_META[ep.category]?.color ?? "bg-muted-foreground"}`} />
                    <span className="font-mono text-muted-foreground truncate flex-1">{ep.name}</span>
                    {ep.label && <span className="text-muted-foreground shrink-0 text-[10px]">({ep.label})</span>}
                    <span className={`shrink-0 px-1 rounded font-semibold ${cfg.accentBg}`}>{ep.count}×</span>
                  </div>
                ))}
              </div>
              {hikerN > 0 && <p className="text-[10px] text-muted-foreground mt-2 italic">{hikerN} HikerAPI call{hikerN !== 1 ? "s" : ""} excluded.</p>}
            </div>
          )}
          <div className="px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span>Session: <strong>{m.sessionCount}</strong></span>
            <span>Auth: <strong>{m.authCount}</strong></span>
            <span>Actions: <strong>{m.actionCount}</strong></span>
            <span>Total: <strong>{eps.length}</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pattern Intelligence ──────────────────────────────────────────────────────
function PatternIntelligence({ entries, tabKey, cfg, survivingAccounts, trustMap, profileNotesMap, profileMap }: {
  entries: AnalyticsEntry[]; tabKey: ErrorTab; cfg: typeof TAB_CONFIG[ErrorTab];
  survivingAccounts: Array<{ username: string; runMs: number | null }>;
  trustMap: Map<number, TrustInfo>; profileNotesMap: Map<string, string | null>; profileMap: Map<string, number>;
}) {
  if (!entries.length) return null;
  const cross = computeCrossStats(entries, trustMap, profileMap, profileNotesMap);

  const allMetrics = entries.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot)), e.flaggedAt ?? e.bannedAt));
  const spaValues   = allMetrics.map(m => m.sessionPerAction);
  const callRates   = allMetrics.map(m => m.callsPerMin).filter(v => v > 0);
  const covValues   = allMetrics.map(m => m.timingCoV).filter(v => v >= 0);
  const entropyVals = allMetrics.map(m => m.shannonEntropy);
  const warmupVals  = allMetrics.map(m => m.preActionWarmup);

  const spaBuckets = [
    { label: "<3 (critical)",  min: 0,  max: 3,        color: "bg-red-500" },
    { label: "3–8 (low)",      min: 3,  max: 8,        color: "bg-orange-400" },
    { label: "8–15 (warn)",    min: 8,  max: 15,       color: "bg-yellow-400" },
    { label: "15–30 (ok)",     min: 15, max: 30,       color: "bg-green-400" },
    { label: ">30 (good)",     min: 30, max: Infinity,  color: "bg-blue-400" },
  ].map(b => ({ ...b, count: spaValues.filter(v => v >= b.min && v < b.max).length }));

  const maxRate = Math.max(...callRates, 0.001);
  const rateBW  = maxRate / 5;
  const rateBuckets = [0,1,2,3,4].map(i => ({ label: `${(i*rateBW).toFixed(3)}–${((i+1)*rateBW).toFixed(3)}/min`, count: callRates.filter(v => v >= i*rateBW && v < (i+1)*rateBW).length, color: "bg-cyan-400" }));
  const covBuckets = [
    { label: "<0.3 (robotic)",    min: 0,   max: 0.3,     color: "bg-red-500" },
    { label: "0.3–0.5 (low)",     min: 0.3, max: 0.5,     color: "bg-orange-400" },
    { label: "0.5–1.0 (normal)",  min: 0.5, max: 1.0,     color: "bg-yellow-400" },
    { label: ">1.0 (human)",      min: 1.0, max: Infinity, color: "bg-green-400" },
  ].map(b => ({ ...b, count: covValues.filter(v => v >= b.min && v < b.max).length }));
  const maxEntropy = Math.max(...entropyVals, 1);
  const entropyBW  = maxEntropy / 5;
  const entropyBuckets = [0,1,2,3,4].map(i => ({ label: `${(i*entropyBW).toFixed(2)}–${((i+1)*entropyBW).toFixed(2)} bits`, count: entropyVals.filter(v => v >= i*entropyBW && v < (i+1)*entropyBW).length, color: "bg-purple-400" }));
  const warmupBuckets = [
    { label: "0 (none)",    min: 0,  max: 1,        color: "bg-red-500" },
    { label: "1–5",         min: 1,  max: 6,        color: "bg-orange-400" },
    { label: "6–15",        min: 6,  max: 16,       color: "bg-yellow-400" },
    { label: "16–30",       min: 16, max: 31,       color: "bg-green-400" },
    { label: ">30",         min: 31, max: Infinity,  color: "bg-blue-400" },
  ].map(b => ({ ...b, count: warmupVals.filter(v => v >= b.min && v < b.max).length }));

  const hourBlocks = [
    { label: "00–06 (night)",      hours: [0,1,2,3,4,5],      color: "bg-slate-400" },
    { label: "06–12 (morning)",    hours: [6,7,8,9,10,11],    color: "bg-blue-400" },
    { label: "12–18 (afternoon)",  hours: [12,13,14,15,16,17], color: "bg-cyan-400" },
    { label: "18–24 (evening)",    hours: [18,19,20,21,22,23], color: "bg-orange-400" },
  ].map(b => ({ ...b, count: b.hours.reduce((s, h) => s + cross.hourBuckets[h], 0) }));

  // Derived findings
  const findings: Array<{ severity: "critical" | "warning" | "info" | "neutral"; text: string }> = [];
  if (cross.n >= 2) {
    if (cross.sessionPerActionMedian < 3) findings.push({ severity: "critical", text: `Session noise median ${cross.sessionPerActionMedian.toFixed(2)} reads/action (σ=${cross.sessionPerActionStdDev.toFixed(2)}) — Instagram classifier expects ≥10–15. ${spaBuckets[0].count + spaBuckets[1].count}/${cross.n} events are below 8.` });
    else if (cross.sessionPerActionMedian < 8) findings.push({ severity: "warning", text: `Session noise median ${cross.sessionPerActionMedian.toFixed(2)} reads/action — below safe threshold of 10–15.` });
    if (cross.timingCoVMedian >= 0 && cross.timingCoVMedian < 0.3) findings.push({ severity: "critical", text: `Robotic timing: median CoV=${cross.timingCoVMedian.toFixed(4)}. Human behaviour produces CoV >0.8. Machine-uniform intervals are a tier-1 bot classifier signal.` });
    else if (cross.roboticTimingPct >= 40) findings.push({ severity: "warning", text: `${cross.roboticTimingPct}% of events show robotic timing (CoV<0.5).` });
    if (cross.burstPct >= 70) findings.push({ severity: "critical", text: `Burst patterns in ${cross.burstPct}% of events — consecutive API calls ≤60s apart.` });
    else if (cross.burstPct >= 30) findings.push({ severity: "warning", text: `Burst patterns in ${cross.burstPct}% of events.` });
    if (cross.zeroWarmupPct >= 60) findings.push({ severity: "critical", text: `${cross.zeroWarmupPct}% of sessions with follows had an average of fewer than 5 calls already logged before each follow.` });
    else if (cross.zeroWarmupPct >= 30) findings.push({ severity: "warning", text: `${cross.zeroWarmupPct}% of sessions with follows had fewer than 5 calls logged before each follow on average.` });
    if (cross.entropyMedian < 1.5) findings.push({ severity: "warning", text: `Low endpoint diversity — median Shannon entropy ${cross.entropyMedian.toFixed(4)} bits. Humans mix feed reads, profile views, stories, explore.` });
    if (cross.fastFlagPct >= 50) findings.push({ severity: "critical", text: `${cross.fastFlagPct}% flagged within 60 minutes of session start — IP/account reputation likely pre-damaged.` });
    if (cross.minGapMean < 0.5) findings.push({ severity: "critical", text: `Average minimum inter-call gap ${(cross.minGapMean * 1000).toFixed(0)}ms — sub-second gaps are physically impossible for humans.` });
    if (cross.avgActionRatio > 0.4) findings.push({ severity: "critical", text: `${Math.round(cross.avgActionRatio * 100)}% of all calls are actions. A human session should be <10% actions with the rest being reads.` });
    if (cross.subnetGroups.length > 0 && cross.subnetConcentration >= 50) findings.push({ severity: "warning", text: `Subnet /24 concurrency: ${cross.subnetConcentration}% of events on the same /24 block (${cross.topSubnet}).` });
    if (cross.callRateStdDev < cross.callRateMean * 0.2 && cross.n >= 3) findings.push({ severity: "info", text: `Consistent call rates across accounts (σ/μ=${cross.callRateMean > 0 ? (cross.callRateStdDev/cross.callRateMean).toFixed(4) : "—"}) — systemic tool config issue, not account-specific.` });
    if (cross.unreliablePct >= 40) findings.push({ severity: "info", text: `${cross.unreliablePct}% of events from accounts with 2+ re-adds — lower confidence data. See Reliability section above.` });
    if (cross.highTrustPct >= 30 && Object.keys(cross.trustDistribution).length > 0) findings.push({ severity: "info", text: `${cross.highTrustPct}% of flagged accounts are at TrustScore rank 9+ — high-trust accounts being flagged indicates a severe trigger, not baseline scrutiny.` });
    if (cross.verifyOnlyCount >= 2) findings.push({ severity: "warning", text: `${cross.verifyOnlyCount} account${cross.verifyOnlyCount !== 1 ? "s" : ""} (${cross.verifyOnlyPct}%) were banned with zero tool activity — Verify calls only. These accounts were already dead before any tool ran. Don't waste time debugging tool behaviour on them.` });
    else if (cross.verifyOnlyCount === 1) findings.push({ severity: "info", text: `1 account was banned with only Verify calls recorded — it was already flagged before any tool ran.` });
    for (const g of cross.verifyClusterGroups) findings.push({ severity: "critical", text: `Verify cluster on ${g.proxy}: ${g.accounts.length} accounts all verified within ${g.windowMinutes === 0 ? "<1" : g.windowMinutes} min of each other (${g.accounts.slice(0, 3).map(a => `@${a}`).join(", ")}${g.accounts.length > 3 ? ` +${g.accounts.length - 3}` : ""}). Rapid concurrent verify sessions on the same IP are a high-signal bot cluster pattern — stagger verifications by at least 10 min per account.` });
    for (const blast of cross.proxyBlastEntries) findings.push({ severity: "critical", text: `Proxy blast: ${blast.count} accounts banned on the same IP ${blast.proxy}. That proxy is burned — stop assigning new accounts to it.` });
  }

  return (
    <div className="space-y-4">
      {/* Error-type causation */}
      <CausationPanel tabKey={tabKey} cross={cross} cfg={cfg} />

      {/* TrustScore */}
      <TrustScorePanel entries={entries} survivingAccounts={survivingAccounts} trustMap={trustMap} profileMap={profileMap} tabKey={tabKey} />

      {/* Reliability */}
      <ReliabilityPanel entries={entries} profileNotesMap={profileNotesMap} />

      {/* Statistical summary */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Sigma className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Cross-Account Statistical Summary</span>
          <span className="text-xs text-muted-foreground ml-auto">{cross.n} events, weighted n={cross.weightedN.toFixed(2)}</span>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border">
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><Activity className="w-3 h-3" /> Call Rate</p>
            <StatRow label="Mean"   val={cross.callRateMean.toFixed(5) + "/min"} />
            <StatRow label="Median" val={cross.callRateMedian.toFixed(5) + "/min"} />
            <StatRow label="σ"      val={cross.callRateStdDev.toFixed(5)} />
            <StatRow label="P90"    val={cross.callRateP90.toFixed(5) + "/min"} />
            <StatRow label="Avg span" val={cross.avgSpanMin > 0 ? (cross.avgSpanMin < 60 ? `${cross.avgSpanMin.toFixed(2)}m` : `${(cross.avgSpanMin/60).toFixed(3)}h`) : "—"} />
          </div>
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><Target className="w-3 h-3" /> Session Noise</p>
            <StatRow label="Session/action mean"    val={cross.sessionPerActionMean.toFixed(4)} />
            <StatRow label="Session/action median"  val={cross.sessionPerActionMedian.toFixed(4)} warn={cross.sessionPerActionMedian < 8} />
            <StatRow label="σ"                      val={cross.sessionPerActionStdDev.toFixed(4)} />
            <StatRow label="Session/follow median"  val={cross.sessionPerFollowMedian > 0 ? cross.sessionPerFollowMedian.toFixed(4) : "—"} />
            <StatRow label="Auth/action mean"       val={cross.authPerActionMean.toFixed(4)} />
          </div>
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><Clock className="w-3 h-3" /> Timing</p>
            <StatRow label="CoV mean"     val={cross.timingCoVMean >= 0 ? cross.timingCoVMean.toFixed(4) : "—"}  warn={cross.timingCoVMean >= 0 && cross.timingCoVMean < 0.5} />
            <StatRow label="CoV median"   val={cross.timingCoVMedian >= 0 ? cross.timingCoVMedian.toFixed(4) : "—"} warn={cross.timingCoVMedian >= 0 && cross.timingCoVMedian < 0.5} />
            <StatRow label="Avg gap mean" val={cross.avgGapMean > 0 ? (cross.avgGapMean < 60 ? `${cross.avgGapMean.toFixed(2)}s` : `${(cross.avgGapMean/60).toFixed(2)}m`) : "—"} />
            <StatRow label="Min gap mean" val={cross.minGapMean >= 0 ? (cross.minGapMean < 1 ? `${(cross.minGapMean*1000).toFixed(0)}ms` : `${cross.minGapMean.toFixed(2)}s`) : "—"} warn={cross.minGapMean < 0.5} />
            <StatRow label="Robotic %"   val={`${cross.roboticTimingPct}%`} warn={cross.roboticTimingPct >= 30} />
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><Layers className="w-3 h-3" /> Diversity</p>
            <StatRow label="Entropy mean"   val={cross.entropyMean.toFixed(4) + " bits"} />
            <StatRow label="Entropy median" val={cross.entropyMedian.toFixed(4) + " bits"} warn={cross.entropyMedian < 1.5} />
            <StatRow label="Entropy σ"      val={cross.entropyStdDev.toFixed(4)} />
            <StatRow label="Unique ep mean" val={cross.uniqueEpMean.toFixed(1)} />
            <StatRow label="Diversity ratio" val={(cross.endpointDiversityMean * 100).toFixed(2) + "%"} />
          </div>
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Session Structure</p>
            <StatRow label="Auth (% of calls)"    val={(cross.avgAuthRatio * 100).toFixed(2) + "%"} />
            <StatRow label="Session (% of calls)" val={(cross.avgSessionRatio * 100).toFixed(2) + "%"} />
            <StatRow label="Action (% of calls)"  val={(cross.avgActionRatio * 100).toFixed(2) + "%"} warn={cross.avgActionRatio > 0.4} />
            <StatRow label="Avg calls before follow (mean)"  val={cross.n > 0 ? cross.warmupMean.toFixed(1) : "—"} />
            <StatRow label="Follow sessions with <5 prior calls"  val={`${cross.zeroWarmupPct}%`} />
          </div>
          <div className="p-3 space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1"><Flame className="w-3 h-3" /> Risk Indicators</p>
            <StatRow label="Burst events"         val={`${cross.burstPct}%`} warn={cross.burstPct >= 30} />
            <StatRow label="Fast-flagged (<60m)"  val={`${cross.fastFlagPct}%`} warn={cross.fastFlagPct >= 30} />
            <StatRow label="Action velocity mean" val={cross.actionVelocityMean > 0 ? `${cross.actionVelocityMean.toFixed(2)}/hr` : "—"} />
            <StatRow label="Low-trust flagged"    val={`${cross.lowTrustPct}%`} />
            <StatRow label="High-trust flagged"   val={`${cross.highTrustPct}%`} warn={cross.highTrustPct >= 30} />
          </div>
        </div>
      </div>

      {/* Distributions */}
      {cross.n >= 2 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-semibold">Metric Distributions</span>
          </div>
          <div className="grid grid-cols-2 gap-0 divide-x divide-y divide-border">
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Session noise (reads/action)</p><MiniHistogram buckets={spaBuckets} note="Target: 15–30/action" /></div>
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Timing CoV (σ/μ of gaps)</p><MiniHistogram buckets={covBuckets} note="CoV <0.3 = machine-uniform" /></div>
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">API call rate (calls/min)</p><MiniHistogram buckets={rateBuckets} /></div>
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Shannon entropy (bits)</p><MiniHistogram buckets={entropyBuckets} note="Higher = more diverse = more human" /></div>
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Avg calls before each follow</p><MiniHistogram buckets={warmupBuckets} note="Sessions with no follow calls are excluded" /></div>
            <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Flag time of day (UTC blocks)</p><MiniHistogram buckets={hourBlocks} note={cross.peakHour >= 0 ? `Peak: ${String(cross.peakHour).padStart(2,"0")}:00 UTC` : ""} /></div>
          </div>
        </div>
      )}

      {/* Findings */}
      {findings.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-semibold">Data-Derived Findings</span>
            <span className="text-xs text-muted-foreground ml-auto">computed from actual data</span>
          </div>
          <div className="divide-y divide-border">
            {findings.map((f, i) => (
              <div key={i} className="px-4 py-3 flex gap-3">
                <span className={`shrink-0 mt-1 w-2 h-2 rounded-full ${f.severity === "critical" ? "bg-red-500" : f.severity === "warning" ? "bg-amber-500" : f.severity === "info" ? "bg-blue-400" : "bg-muted-foreground"}`} />
                <p className="text-[11px] text-foreground leading-relaxed">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Common endpoints */}
      {cross.commonEndpoints.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Hash className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-semibold">Common Endpoint Denominators</span>
            <span className="text-xs text-muted-foreground ml-auto">≥40% of flagged accounts</span>
          </div>
          <div className="divide-y divide-border">
            {cross.commonEndpoints.map(ep => (
              <div key={ep.name} className="px-4 py-2 flex items-center gap-3">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CAT_META[ep.category]?.color ?? "bg-muted-foreground"}`} />
                <span className="font-mono text-[11px] flex-1 truncate">{ep.name}</span>
                {ep.label && <span className="text-[11px] text-muted-foreground shrink-0">({ep.label})</span>}
                <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0"><div className="h-full bg-purple-400 rounded-full" style={{ width: `${ep.pct}%` }} /></div>
                <span className="text-[11px] font-mono font-semibold w-10 text-right shrink-0">{ep.pct}%</span>
                <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{ep.freq}/{cross.n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sequence patterns */}
      {(cross.commonFirstEps.length > 0 || cross.commonLastEps.length > 0) && cross.n >= 3 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Eye className="w-4 h-4 text-cyan-500" />
            <span className="text-sm font-semibold">Session Sequence Patterns</span>
          </div>
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">First action endpoint</p>
              {cross.commonFirstEps.map(ep => (
                <div key={ep.name} className="flex items-center gap-2 text-[10px] mb-1">
                  <span className="font-mono flex-1 truncate">{ep.label ?? ep.name}</span>
                  <div className="w-20 h-2 bg-muted rounded-sm overflow-hidden"><div className="h-full bg-cyan-400 rounded-sm" style={{ width: `${ep.pct}%` }} /></div>
                  <span className="font-semibold w-8 text-right">{ep.pct}%</span>
                </div>
              ))}
            </div>
            <div className="p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Last endpoint before flag</p>
              {cross.commonLastEps.map(ep => (
                <div key={ep.name} className="flex items-center gap-2 text-[10px] mb-1">
                  <span className="font-mono flex-1 truncate">{ep.label ?? ep.name}</span>
                  <div className="w-20 h-2 bg-muted rounded-sm overflow-hidden"><div className="h-full bg-orange-400 rounded-sm" style={{ width: `${ep.pct}%` }} /></div>
                  <span className="font-semibold w-8 text-right">{ep.pct}%</span>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-2 bg-muted/20 text-[10px] text-muted-foreground">Last endpoint before flag may indicate which specific call triggers the classifier.</div>
        </div>
      )}

      {/* Subnet concurrency */}
      {cross.subnetGroups.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Network className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-semibold">Subnet /24 Concurrency</span>
            <span className="text-xs text-muted-foreground ml-auto">multiple accounts on same /24 block</span>
          </div>
          {cross.subnetGroups.map(sg => {
            const times = sg.flaggedAt.filter(Boolean).map(t => new Date(t).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
            const windowMs = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
            const windowStr = windowMs < 60000 ? `${Math.round(windowMs/1000)}s` : windowMs < 3600000 ? `${Math.round(windowMs/60000)}m` : `${(windowMs/3600000).toFixed(1)}h`;
            return (
              <div key={sg.subnet} className="px-4 py-3 border-b border-border last:border-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-sm font-semibold">{sg.subnet}</span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${sg.events >= 4 ? "bg-red-50 border-red-200 text-red-600" : "bg-amber-50 border-amber-200 text-amber-600"}`}>{sg.events} EVENTS</span>
                  {windowMs > 0 && <span className="text-[10px] text-muted-foreground ml-auto">span: {windowStr}</span>}
                </div>
                <p className="text-[10px] text-muted-foreground">{sg.accounts.join(", ")} — {sg.hosts.length > 1 ? `${sg.hosts.length} IPs` : sg.hosts[0]}</p>
              </div>
            );
          })}
          <div className="px-4 py-2 bg-muted/20 text-[10px] text-muted-foreground">Instagram scores /24 subnets — a flagged /24 raises risk for all accounts on it, not just the specific IP.</div>
        </div>
      )}

      {/* Anomaly scoring note */}
      {cross.n >= 3 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2"><Cpu className="w-4 h-4 text-red-500" /><span className="text-sm font-semibold">Per-Event Anomaly Scoring (0–100)</span></div>
          <div className="p-4 text-[11px] text-muted-foreground leading-relaxed">Z-score against group median across 8 dimensions: call rate, session noise, timing CoV, Shannon entropy, burst presence, avg calls before each follow, session span, min inter-call gap. Scores shown on each event card below. High score = deviates most from the others.</div>
        </div>
      )}

      {/* Pre-event Endpoint Risk Ranking */}
      {(() => {
        const RISK_WINDOW = 20;
        const counts = new Map<string, number>();
        let valid = 0;
        for (const entry of entries) {
          const eps = filterHiker(parseEps(entry.endpointSnapshot));
          if (eps.length === 0) continue;
          valid++;
          const lastN = eps.slice(-RISK_WINDOW);
          const seen = new Set(lastN.map((e: any) => e.operationName));
          for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        const top = Array.from(counts.entries())
          .map(([name, count]) => ({ name, count, pct: valid > 0 ? Math.round(count / valid * 100) : 0, label: matchLabel(name)?.label ?? null, category: matchLabel(name)?.category ?? "other" }))
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 15);
        if (valid < 1 || top.length === 0) return null;
        const errorTypeLower = tabKey === "ban" ? "ban" : tabKey === "automated" ? "automated flag" : tabKey === "captcha" ? "captcha challenge" : "account lock";
        const errorTypeLabel = tabKey === "ban" ? "Ban" : tabKey === "automated" ? "Automated Flag" : tabKey === "captcha" ? "Captcha" : "Lock";
        return (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Flame className="w-4 h-4 text-red-500" />
              <span className="text-sm font-semibold">Pre-{errorTypeLabel} Endpoint Risk Ranking</span>
              <span className="text-xs text-muted-foreground ml-auto">last {RISK_WINDOW} calls · {valid} account{valid !== 1 ? "s" : ""}</span>
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wide w-6">#</th>
                  <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wide">Endpoint</th>
                  <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Category</th>
                  <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wide">Accounts</th>
                  <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground uppercase tracking-wide">Pre-{errorTypeLabel} %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {top.map((ep, i) => {
                  const riskColor = ep.pct >= 50 ? "#dc2626" : ep.pct >= 25 ? "#d97706" : "#6b7280";
                  const catMeta = CAT_META[ep.category] ?? CAT_META["other"];
                  return (
                    <tr key={ep.name} className={i % 2 === 0 ? "" : "bg-muted/20"}>
                      <td className="px-3 py-1.5 text-muted-foreground font-mono">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono font-semibold text-foreground max-w-[180px] truncate" title={ep.name}>{ep.label ?? ep.name}</td>
                      <td className="px-3 py-1.5 hidden sm:table-cell">
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
                          <span className={`w-1.5 h-1.5 rounded-full ${catMeta.color}`} />
                          {catMeta.label}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{ep.count}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold" style={{ color: riskColor }}>{ep.pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-3 py-1.5 border-t border-border/40 bg-muted/20">
              <p className="text-[10px] text-muted-foreground"><strong>Pre-{errorTypeLabel} %</strong> — share of {valid} accounts where this endpoint appeared in their final {RISK_WINDOW} calls before the {errorTypeLower}. Higher = more correlated. Red ≥50%, amber ≥25%.</p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Tab content ───────────────────────────────────────────────────────────────
function EntryList({ entries, cfg, tabKey, profileMap, trustMap, profileNotesMap, survivingAccounts }: {
  entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[ErrorTab];
  tabKey: ErrorTab; profileMap: Map<string, number>;
  trustMap: Map<number, TrustInfo>; profileNotesMap: Map<string, string | null>;
  survivingAccounts: Array<{ username: string; runMs: number | null }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const cross = useMemo(() => computeCrossStats(entries, trustMap, profileMap, profileNotesMap), [entries, trustMap, profileMap, profileNotesMap]);

  if (!entries.length) return (
    <div className="border border-border rounded-lg p-10 text-center">
      <p className="text-sm font-medium">{cfg.emptyMsg}</p>
      <p className="text-xs text-muted-foreground mt-1">{cfg.flagMsg}</p>
    </div>
  );
  const reversed = [...entries].reverse();
  const visible  = showAll ? reversed : reversed.slice(0, 3);

  return (
    <div className="space-y-4">
      <PatternIntelligence entries={entries} tabKey={tabKey} cfg={cfg} survivingAccounts={survivingAccounts} trustMap={trustMap} profileNotesMap={profileNotesMap} profileMap={profileMap} />
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Event History</span>
          <span className="text-xs text-muted-foreground ml-auto">{showAll ? `${entries.length} events` : `${Math.min(3, entries.length)} of ${entries.length}`} — click to expand</span>
        </div>
        <div className="p-3 space-y-2">
          {visible.map(entry => (
            <EntryCard key={entry.id} entry={entry} cfg={cfg} cross={cross} profileMap={profileMap} trustMap={trustMap} reliability={computeReliability(profileNotesMap.get(entry.username))} />
          ))}
        </div>
        {entries.length > 3 && (
          <div className="px-4 py-2 border-t border-border flex justify-center">
            <button onClick={() => setShowAll(o => !o)} className="text-xs text-cyan-500 hover:text-cyan-400 font-semibold flex items-center gap-1">
              {showAll ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all {entries.length} events</>}
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
    if (!confirm(`Delete all ${pr.total} log entries for ${pr.host}?`)) return;
    setDeleting(true);
    try {
      await Promise.all([
        ...pr.entryIds.ban.map(id => fetch(`/api/analytics/ban-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.automated.map(id => fetch(`/api/analytics/automated-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.captcha.map(id => fetch(`/api/analytics/captcha-patterns/${id}`, { method: "DELETE", credentials: "include" })),
        ...pr.entryIds.locked.map(id => fetch(`/api/analytics/locked-patterns/${id}`, { method: "DELETE", credentials: "include" })),
      ]);
      ["ban-patterns","automated-patterns","captcha-patterns","locked-patterns"].forEach(k => queryClient.invalidateQueries({ queryKey: [`/api/analytics/${k}`] }));
    } finally { setDeleting(false); }
  }
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 relative group">
      <span className="text-xs text-muted-foreground w-6 text-right shrink-0">#{i + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-sm font-mono truncate">{pr.host}</span>
          {isIpAddr(pr.host) && <span className="text-[10px] text-muted-foreground">[{extractSubnet24(pr.host)}]</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 font-semibold">{pr.banCount}B</span>
        <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 font-semibold">{pr.automatedCount}A</span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 font-semibold">{pr.captchaCount}C</span>
        <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-600 font-semibold">{pr.lockedCount}L</span>
        <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{pr.total}</span>
      </div>
      <button onClick={handleDelete} disabled={deleting} title="Delete all entries for this proxy"
        className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-500 hover:bg-red-200 dark:hover:bg-red-800/60 transition-all disabled:opacity-40 shrink-0">
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
      </button>
    </div>
  );
}

// ── Theories Tab ──────────────────────────────────────────────────────────────
function TheoriesTab({ forTab, primaryEntries, banEntries, automatedEntries, captchaEntries, lockedEntries }: {
  forTab: ErrorTab;
  primaryEntries: AnalyticsEntry[];
  banEntries: AnalyticsEntry[]; automatedEntries: AnalyticsEntry[];
  captchaEntries: AnalyticsEntry[]; lockedEntries: AnalyticsEntry[];
}) {
  const total = primaryEntries.length;
  const primaryMetrics = useMemo(() => primaryEntries.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot)), e.flaggedAt ?? e.bannedAt)), [primaryEntries]);
  const proxyRisks = useMemo(() => buildProxyRiskMap(banEntries, automatedEntries, captchaEntries, lockedEntries), [banEntries, automatedEntries, captchaEntries, lockedEntries]);

  const { data: verifyFpData, isLoading: fpLoading } = useQuery<Array<{ id: number; username: string; bannedAt: string | null; proxyHost: string | null; leakData: any }>>({
    queryKey: ["/api/analytics/verify-fingerprint"],
    queryFn: async () => (await fetch("/api/analytics/verify-fingerprint", { credentials: "include" })).json(),
    enabled: forTab === "ban",
    refetchInterval: 30000,
  });

  const hotProxyHosts = useMemo(() => new Set(proxyRisks.filter(pr => pr.total >= 2).map(pr => pr.host)), [proxyRisks]);
  const onHotProxy = primaryEntries.filter(e => hotProxyHosts.has(e.proxyHost || "(no proxy)")).length;
  const ipTrustPct = total > 2 ? Math.round((onHotProxy / total) * 100) : -1;

  const lowWarmupCount = primaryMetrics.filter(m => m.preActionWarmup >= 0 && m.preActionWarmup < 5).length;
  const warmupPct = total > 2 ? Math.round((lowWarmupCount / total) * 100) : -1;

  const roboticCount = primaryMetrics.filter(m => m.timingCoV >= 0 && m.timingCoV < 0.5).length;
  const roboticPct = total > 2 ? Math.round((roboticCount / total) * 100) : -1;

  const highAuthCount = primaryMetrics.filter(m => m.authPerAction > 0.3).length;
  const authPct = total > 2 ? Math.round((highAuthCount / total) * 100) : -1;

  const highVelocityCount = primaryMetrics.filter(m => m.actionVelocityPerHour > 40).length;
  const velocityPct = total > 2 ? Math.round((highVelocityCount / total) * 100) : -1;

  const banUsernames = useMemo(() => new Set(banEntries.map(e => e.username)), [banEntries]);
  const autoUsernames = useMemo(() => new Set(automatedEntries.map(e => e.username)), [automatedEntries]);

  // Trust Decay Chain — cross-tab percentage, computed relative to primaryEntries
  const decayCount = forTab === "ban"
    ? primaryEntries.filter(e => autoUsernames.has(e.username)).length   // banned accounts that also had an automated flag
    : forTab === "automated"
      ? primaryEntries.filter(e => banUsernames.has(e.username)).length  // automated accounts that later escalated to ban
      : forTab === "captcha"
        ? primaryEntries.filter(e => banUsernames.has(e.username) || autoUsernames.has(e.username)).length // captcha accounts that escalated further
        : primaryEntries.filter(e => banUsernames.has(e.username) || autoUsernames.has(e.username)).length; // locked accounts that also appear in other error types
  const decayPct = total > 2 ? Math.round((decayCount / total) * 100) : -1;

  const decayEvidenceText = forTab === "ban"
    ? `${decayCount} of ${total} banned accounts (${decayPct >= 0 ? decayPct + "%" : "n/a"}) also have an Automated Behaviour flag in your history — consistent with an escalation chain.`
    : forTab === "automated"
      ? `${decayCount} of ${total} automated-flag accounts (${decayPct >= 0 ? decayPct + "%" : "n/a"}) later escalated to a full ban — consistent with an escalation ladder.`
      : forTab === "captcha"
        ? `${decayCount} of ${total} captcha accounts (${decayPct >= 0 ? decayPct + "%" : "n/a"}) also appear in the Automated or Banned lists — showing escalation beyond captcha.`
        : `${decayCount} of ${total} locked accounts (${decayPct >= 0 ? decayPct + "%" : "n/a"}) also appear in Automated or Banned lists — showing escalation beyond a lock.`;

  const verifyClusterData = useMemo(() => {
    const WINDOW_MS = 30 * 60 * 1000;
    const noToolEntries = primaryEntries.filter(e => {
      const eps = filterHiker(parseEps(e.endpointSnapshot));
      return eps.length > 0 && eps.every(ep => { const s = (ep.source ?? "").toLowerCase(); return s === "verify" || s === "eb" || s === ""; });
    });
    const byProxy = new Map<string, Array<{ username: string; firstTs: number }>>();
    for (const e of noToolEntries) {
      if (!e.proxyHost) continue;
      const eps = filterHiker(parseEps(e.endpointSnapshot));
      const ts = eps.map(ep => new Date(ep.date).getTime()).filter(t => !isNaN(t));
      if (ts.length === 0) continue;
      if (!byProxy.has(e.proxyHost)) byProxy.set(e.proxyHost, []);
      byProxy.get(e.proxyHost)!.push({ username: e.username, firstTs: Math.min(...ts) });
    }
    let clusteredAccounts = 0;
    for (const items of byProxy.values()) {
      if (items.length < 2) continue;
      const sorted = items.slice().sort((a, b) => a.firstTs - b.firstTs);
      for (let i = 0; i < sorted.length - 1; i++) {
        let inWindow = 1;
        for (let j = i + 1; j < sorted.length; j++) {
          if (sorted[j].firstTs - sorted[i].firstTs <= WINDOW_MS) inWindow++;
          else break;
        }
        if (inWindow >= 2) { clusteredAccounts += inWindow; break; }
      }
    }
    return clusteredAccounts;
  }, [primaryEntries]);
  const verifyClusterPct = total > 2 ? Math.round((verifyClusterData / total) * 100) : -1;

  // Theory 2: Session-to-Action Ratio extremes (two distinct failure modes)
  const highSarCount = primaryEntries.filter(e => {
    const r = parseFloat(e.sessionToActionRatio ?? "");
    return !isNaN(r) && r > 30;
  }).length;
  const lowSarWithActionsCount = primaryEntries.filter((e, i) => {
    const r = parseFloat(e.sessionToActionRatio ?? "");
    return !isNaN(r) && r < 1 && (primaryMetrics[i]?.actionCount ?? 0) > 0;
  }).length;
  const sarPct = total > 2
    ? forTab === "locked"
      ? Math.round((lowSarWithActionsCount / total) * 100)
      : Math.round((highSarCount / total) * 100)
    : -1;

  // Theory 5: Low endpoint diversity + high follow ratio
  const lowDivHighFollowCount = primaryEntries.filter((_, i) => {
    const m = primaryMetrics[i];
    if (!m) return false;
    const followRatio = m.totalCalls > 0 ? m.cats.follow / m.totalCalls : 0;
    return m.endpointDiversity < 0.25 && followRatio > 0.10;
  }).length;
  const lowDivHighFollowPct = total > 2 ? Math.round((lowDivHighFollowCount / total) * 100) : -1;

  // Endpoint Risk theory — pre-[errorType] endpoint presence in last 20 calls
  const RISK_WINDOW = 20;
  const endpointRiskData = useMemo(() => {
    const counts = new Map<string, number>();
    let valid = 0;
    for (const entry of primaryEntries) {
      const eps = filterHiker(parseEps(entry.endpointSnapshot));
      if (eps.length === 0) continue;
      valid++;
      const lastN = eps.slice(-RISK_WINDOW);
      const seen = new Set(lastN.map(e => e.operationName));
      for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const top = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, pct: valid > 0 ? Math.round(count / valid * 100) : 0, label: matchLabel(name)?.label ?? null, category: matchLabel(name)?.category ?? "other" }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 8);
    return { top, valid };
  }, [primaryEntries]);
  const errorTypeLabel = forTab === "ban" ? "Ban" : forTab === "automated" ? "Automated Flag" : forTab === "captcha" ? "Captcha" : "Lock";
  const errorTypeLower = forTab === "ban" ? "ban" : forTab === "automated" ? "automated flag" : forTab === "captcha" ? "captcha challenge" : "account lock";
  const endpointRiskPct = total > 2 && endpointRiskData.valid > 0 ? (endpointRiskData.top[0]?.pct ?? -1) : -1;

  // Login Rate Limit Per IP theory
  // Counts accounts that were flagged with ONLY verify/system-source endpoint calls —
  // no follow, DM, or any tool activity whatsoever.  An account that gets banned
  // purely from login events is direct evidence of an IP-level login rate budget.
  const loginRateLimitCount = primaryEntries.filter(e => {
    const eps = filterHiker(parseEps(e.endpointSnapshot));
    if (eps.length === 0) return false;
    return eps.every(ep => {
      const s = (ep.source ?? "").toLowerCase();
      return s === "verify" || s === "system" || s === "eb" || s === "hiker_api" || s === "";
    });
  }).length;
  const loginRateLimitPct = total > 2 ? Math.round((loginRateLimitCount / total) * 100) : -1;

  // Theory: Overall API call rate too high (>0.15 calls/min)
  // Survivor baseline: emilee 0.099/min, francoise 0.058/min. Banned median: 0.3–9/min.
  const highCallRateCount = primaryEntries.filter((_, i) => {
    const m = primaryMetrics[i];
    return m && m.callsPerMin > 0.15;
  }).length;
  const highCallRatePct = total > 2 ? Math.round((highCallRateCount / total) * 100) : -1;

  // Theory: Passive-call density before first follow below survivor threshold
  // Survivor baseline: 100–185 total session ops before first follow (preActionWarmup).
  // Banned accounts: median 0–5. Threshold 50 = halfway point.
  const belowSurvivorWarmupCount = primaryEntries.filter((_, i) => {
    const m = primaryMetrics[i];
    return m && m.cats.follow > 0 && (m.preActionWarmup ?? 0) < 50;
  }).length;
  const belowSurvivorWarmupPct = total > 2 ? Math.round((belowSurvivorWarmupCount / total) * 100) : -1;

  // Theory: Continuous session pattern (no burst-idle gaps)
  // Survivor baseline: active only 3.9h out of 69.9h (94% idle). avgInterCallSec ~600s (1 call/10min).
  // Flagging: callsPerMin > 0.2 with span > 20min = account called too often without long idle gaps.
  const continuousSessionCount = primaryEntries.filter((_, i) => {
    const m = primaryMetrics[i];
    return m && m.callsPerMin > 0.2 && m.spanMin > 20;
  }).length;
  const continuousSessionPct = total > 2 ? Math.round((continuousSessionCount / total) * 100) : -1;

  function LikelihoodBar({ pct }: { pct: number }) {
    if (pct < 0) return <span className="text-xs text-muted-foreground italic">— need 3+ events to compute</span>;
    const color = pct >= 70 ? "bg-red-500" : pct >= 45 ? "bg-orange-400" : pct >= 25 ? "bg-yellow-400" : "bg-blue-400";
    const labelStr = pct >= 70 ? "HIGH" : pct >= 45 ? "MODERATE" : pct >= 25 ? "PLAUSIBLE" : "LOW";
    const textColor = pct >= 70 ? "text-red-500" : pct >= 45 ? "text-orange-500" : pct >= 25 ? "text-yellow-500" : "text-blue-400";
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <span className={`text-[10px] font-bold w-24 text-right shrink-0 ${textColor}`}>{labelStr} · {pct}%</span>
        </div>
        <p className="text-[10px] text-muted-foreground">{pct}% of your {total} account{total !== 1 ? "s" : ""} in this error type match this pattern</p>
      </div>
    );
  }

  const theories: Array<{ id: string; Icon: typeof Globe; title: string; tagline: string; likelihood: number; description: string; evidence: string; advice: string }> = [
    {
      id: "ip-trust", Icon: Globe,
      title: "IP TrustScore Budget",
      tagline: "Each IP has a shared daily action budget across all accounts using it",
      likelihood: ipTrustPct,
      description: "What is being theorised is that Instagram assigns an implicit trust budget to each IP address that limits the total daily action-endpoint calls across all accounts sharing that IP. Under this model the budget is per-IP, not per-account, meaning multiple accounts on one IP compete for the same pool rather than each having their own independent limit. The data pattern supporting this: accounts flagged on proxies that had already accumulated 2 or more bans represent a disproportionate share of events in this dataset. If flagging were purely per-account, proxy history would not correlate with new account flags on the same IP.",
      evidence: ipTrustPct >= 0 ? `${onHotProxy} of ${total} flagged events (${ipTrustPct}%) occurred on proxies that flagged 2+ accounts. If account limits were fully independent, proxy reuse would not predict flags. The clustering around specific proxies is the observable signal.` : "Not enough data yet. Flag more accounts to measure proxy reuse patterns.",
      advice: "The data shows proxies that have accumulated 2 or more bans are disproportionately represented in subsequent flag events. Rotating to a fresh IP after 2+ bans on a proxy is the direct action reverse-engineered from this pattern.",
    },
    {
      id: "warmup-gate", Icon: Zap,
      title: "Follow Call Density",
      tagline: "How many calls were already logged before each follow, averaged across all follows",
      likelihood: warmupPct,
      description: "What is being theorised is that the average number of API calls already logged before each follow call is a metric Instagram may score when classifying a session. A low average means follows are occurring with very few other calls surrounding them. This metric is logged directly from session data and is factual as a measurement. Whether this number independently influences flag risk or is a side-effect of other patterns (short sessions, few passive calls, rapid action starts) cannot be determined from this data alone.",
      evidence: warmupPct >= 0 ? `${lowWarmupCount} of ${total} flagged sessions with follow operations (${warmupPct}%) had an average of fewer than 5 calls already logged before each follow. Whether this directly contributes to the flag or is correlated with other session properties is not established.` : "Not enough data yet.",
      advice: "Compare this value against the surviving accounts dataset. If surviving accounts consistently show higher pre-follow call density than flagged accounts, the gap is a data-derived signal to act on. The metric alone cannot prescribe a threshold without that comparison.",
    },
    {
      id: "timing-cov", Icon: Activity,
      title: "Robotic Timing Signature (CoV < 0.5)",
      tagline: "Fixed-interval schedulers are the most fingerprint-detectable automation pattern",
      likelihood: roboticPct,
      description: "What is being theorised is that Instagram's classifier measures the statistical variability of the gaps between successive API calls within a session. The Coefficient of Variation (CoV = standard deviation divided by mean) quantifies this. A low CoV means call gaps are nearly uniform, which is the signature output of a fixed-interval scheduler. The data from flagged accounts shows a higher proportion of sessions with CoV below 0.5 than would be expected from random variation. Whether this directly causes the flag or is correlated with other patterns is not definitively established from this data.",
      evidence: roboticPct >= 0 ? `${roboticCount} of ${total} flagged sessions (${roboticPct}%) had inter-call timing CoV below 0.5. Flagged sessions are concentrated at the low-CoV end of the distribution compared to what organic session variance would produce.` : "Not enough data yet.",
      advice: "Flagged sessions in this dataset cluster at CoV below 0.5. The data-derived action is to ensure delay ranges produce higher variance. A delay range at least as wide as the base value raises CoV. The surviving accounts in this dataset show higher CoV values than the flagged accounts on average.",
    },
    {
      id: "auth-overcall", Icon: Shield,
      title: "Auth Overcalling = Device Uncertainty Signal",
      tagline: "Repeated mid-session sync calls mean Instagram is questioning the device identity",
      likelihood: authPct,
      description: "What is being theorised is that repeated calls to device-verification endpoints (launcher/sync, qe/sync) within a single session signal that Instagram's server is repeatedly re-checking the device identity. Under normal session behaviour these endpoints fire once at session start. When they appear at a ratio above 0.3 per action call, the session has substantially more device re-checks than a clean baseline. The data shows accounts with high auth-to-action ratios appear in this error category at a measurable rate. The mechanism connecting re-verification frequency to the flag outcome is inferred from the ratio distribution in the flagged dataset.",
      evidence: authPct >= 0 ? `${highAuthCount} of ${total} flagged accounts (${authPct}%) had an auth-to-action ratio above 0.3. A clean session where device verification fires once at startup would produce a ratio near zero. The elevated ratio indicates the device verification sequence repeated mid-session.` : "Not enough data yet.",
      advice: "The data shows accounts with unstable device fingerprints (mid, ig_did, uuid changing between sessions) produce higher auth ratios in flagged datasets. Keeping device fingerprints constant across sessions is the direct action reverse-engineered from the auth-overcalling pattern.",
    },
    {
      id: "velocity-cap", Icon: Flame,
      title: "Per-Hour Velocity Cap (~20–30 actions/hr)",
      tagline: "The safe follow rate is far lower than most tools assume",
      likelihood: velocityPct,
      description: "What is being theorised is that Instagram enforces a rolling per-hour action limit rather than just a daily total. The evidence from this dataset: a measurable proportion of flagged accounts had sustained action velocities above 40 per hour. Cases where accounts with moderate daily totals concentrated into short bursts appear alongside accounts with higher daily totals spread across many hours without flagging, which is consistent with a short rolling window rather than a 24-hour budget. The specific threshold is inferred from the distribution of velocities in the flagged dataset, not from documented API limits.",
      evidence: velocityPct >= 0 ? `${highVelocityCount} of ${total} flagged accounts (${velocityPct}%) had a sustained action velocity above 40 per hour. The rolling window interpretation comes from the observation that burst-concentrated sessions appear in the flagged dataset at a higher rate than sessions with the same daily total spread over longer timeframes.` : "Not enough data yet.",
      advice: "The data shows accounts with velocity above 40 per hour appear in the flagged dataset at a higher rate. Keeping velocity below that threshold is the direct action reverse-engineered from the flagged distribution. Short micro-bursts followed by longer pauses are consistent with the surviving account patterns in this dataset.",
    },
    {
      id: "verify-cluster", Icon: Network,
      title: "Verify Cluster Fingerprint",
      tagline: "Verifying multiple accounts on the same IP within minutes signals a bot farm to Instagram",
      likelihood: verifyClusterPct,
      description: "What is being theorised is that Instagram's abuse detection identifies bot-farm behaviour by detecting multiple accounts executing the verify-sequence call pattern on the same IP address within a short time window. A single account verifying is normal. Multiple accounts verifying on the same IP in rapid succession produces a temporal cluster that does not occur in organic multi-account usage. The theory is supported by the observation that a share of accounts flagged in this dataset were verified within 30 minutes of at least one other account on the same proxy IP. The verify sequence has a distinctive endpoint structure (launcher/sync then tokens/keyed then users/info) which may allow IP-level pattern matching independent of individual device fingerprints.",
      evidence: verifyClusterPct >= 0 ? `${verifyClusterData} of ${total} flagged accounts (${verifyClusterPct}%) were verified within a 30-minute window of another account on the same proxy IP. The clustering pattern is the data signal, not the individual verify events themselves.` : "Not enough data yet.",
      advice: "The data shows verify clusters on the same IP within 30 minutes correlate with flags in this dataset. Staggering verifications so no two accounts use the same IP within that window is the direct action reverse-engineered from the cluster pattern.",
    },
    {
      id: "session-uniqueness", Icon: Fingerprint,
      title: "Session Uniqueness Fingerprint",
      tagline: "Identical API call sequences across accounts on the same IP or subnet is a bot-cluster signal",
      likelihood: (() => {
        if (total < 2) return -1;
        const sameSubnet = primaryEntries.filter(e => {
          if (!e.proxyHost) return false;
          const subnet = e.proxyHost.split(".").slice(0, 3).join(".");
          return primaryEntries.some(o => o.id !== e.id && o.proxyHost?.startsWith(subnet + "."));
        }).length;
        return Math.round((sameSubnet / total) * 100);
      })(),
      description: "What is being theorised is that when multiple accounts originating from the same IP or /24 subnet execute sessions with structurally identical API call sequences, Instagram's classifier can identify the bot framework itself rather than any individual account. A human's post-login session is never identical to another human's because notification counts, feed items, and stories queued differ. A fixed cold-start sequence produces a mathematically identical API pattern on every account. At the subnet level, multiple accounts producing identical call sequences within the same session window is consistent with batch-processing behaviour that organic users do not produce. IMPORTANT OBSERVATION FROM DATASET: accounts that fired diverse randomised endpoints (endpoint diversity 72-82%, human-level CoV 1.6-1.7) were still banned within minutes on proxies that already had 4-5 accounts flagged. This directly challenges the theory as a primary causal factor — diversifying the session fingerprint did not prevent the ban when the proxy was already saturated. This suggests that either (a) session uniqueness is only a secondary factor that matters only when the proxy is clean, (b) the proxy budget is the dominant variable and session uniqueness makes no difference once the IP is hot, or (c) another factor such as user agent, account age, or device fingerprint is the actual root cause that this theory does not address.",
      evidence: (() => {
        if (total < 2) return "Not enough data yet. Flag more accounts to measure subnet co-occurrence.";
        const sameSubnet = primaryEntries.filter(e => {
          if (!e.proxyHost) return false;
          const subnet = e.proxyHost.split(".").slice(0, 3).join(".");
          return primaryEntries.some(o => o.id !== e.id && o.proxyHost?.startsWith(subnet + "."));
        }).length;
        const pct = Math.round((sameSubnet / total) * 100);
        const subnetCounts: Record<string, string[]> = {};
        for (const e of primaryEntries) {
          if (!e.proxyHost) continue;
          const sn = e.proxyHost.split(".").slice(0, 3).join(".");
          if (!subnetCounts[sn]) subnetCounts[sn] = [];
          subnetCounts[sn].push(e.username);
        }
        const crowdedSubnets = Object.entries(subnetCounts).filter(([, accs]) => accs.length > 1).sort((a, b) => b[1].length - a[1].length);
        if (crowdedSubnets.length === 0) return "No subnet co-occurrence detected — each flagged account was on a unique /24 subnet.";
        const top = crowdedSubnets[0];
        return `${sameSubnet} of ${total} flagged accounts (${pct}%) share a /24 subnet with at least one other flagged account. Busiest subnet: ${top[0]}.x with ${top[1].length} flagged accounts. NOTE: recent data shows accounts with highly diverse session fingerprints (CoV > 1.6, diversity > 70%) still being banned on proxies with 4-5 flagged accounts already on them — suggesting subnet co-occurrence may be a proxy-budget signal more than a session-fingerprint signal.`;
      })(),
      advice: "The data now contains counter-evidence: accounts with fully randomised, highly diverse session fingerprints were still banned when the proxy already had 4-5 flagged accounts. This suggests session uniqueness alone is not sufficient when the proxy budget is exhausted. The primary action from this data is proxy rotation — move to a fresh IP before adding more accounts — not session diversification. Session diversification may still reduce risk on a clean proxy but cannot overcome a hot one.",
    },
    {
      id: "login-rate-limit", Icon: Clock,
      title: "IP Login Rate Limit (~1–2 Logins per 90 min)",
      tagline: "Each browser + API login pair counts as 2 logins against a shared per-IP quota",
      likelihood: loginRateLimitPct,
      description: "What is being theorised is that Instagram enforces a per-IP login rate budget independent of action endpoints. Every account verify produces two login events on the same IP: one browser login (Chrome cookie extraction) and one mobile API login (cold-start sequence). An IP that processes 5 verifies in one hour has generated 10 login events. The strongest evidence for this theory is the accounts that appear in the ban list with zero tool activity, flagged purely from verify-source endpoints. If there were no per-IP login budget, these accounts should not have been flagged at all since no automation tools ever ran on them. This is consistent with the observed data but has not been isolated in a controlled test.",
      evidence: loginRateLimitPct >= 0
        ? `${loginRateLimitCount} of ${total} flagged accounts (${loginRateLimitPct}%) show zero tool activity — banned purely from login/verify endpoints. This is the strongest signal for an IP-level login rate limit.`
        : "Not enough data yet. Flag more accounts to measure verify-only ban patterns.",
      advice: "The data shows accounts with zero tool activity being flagged purely from verify-source endpoints. This pattern is consistent with an IP being saturated by multiple verify events. The data-derived action is to space verifications on the same IP at least 90 minutes apart, or use a different IP for each account verification batch.",
    },
    {
      id: "concurrent-endpoints", Icon: Shuffle,
      title: "Concurrent Endpoint Monotony",
      tagline: "Repeating the same endpoint back-to-back is a stronger bot signal than mixing different endpoints",
      likelihood: -1,
      description: "What is being theorised is that Instagram's abuse detection scores endpoint diversity within a session in addition to action velocity. A session that issues the same API call type repeatedly produces a monotone call pattern that does not occur in organic usage because a human naturally interleaves different content types. A session that mixes endpoints looks structurally different at the same action rate. The weight of each endpoint type relative to detection risk is unknown from the data: this theory cannot be computed from current log data because the ban log records endpoint counts and types but not session-by-session ordering. This is inferred from the endpoint type distributions in flagged versus surviving sessions and has not been isolated in a controlled test.",
      evidence: "Cannot be computed from current data. This theory requires endpoint sequence analysis across sessions — the ban log records endpoint counts and types but not session-by-session ordering. Flag accounts and monitor whether zero-diversity endpoint snapshots (single endpoint repeated N times) appear more often than expected.",
      advice: "Interleave action endpoints with passive ones between every burst. After 3–5 follows, trigger a timeline view or profile lookup before the next follow batch. Configure tools to inject passive calls (view timeline, view story) as natural pauses between action sequences.",
    },
    {
      id: "new-account-budget", Icon: Clock,
      title: "New Account Trust Ramp (≤7 Days)",
      tagline: "Instagram enforces near-zero follow tolerance for accounts under a week old",
      likelihood: (() => {
        const newAccountWithFollows = primaryEntries.filter(e => {
          const age = e.accountAgeDays;
          const follows = e.followCountBeforeBan;
          if (age !== null && age !== undefined && follows !== null && follows !== undefined) {
            return age <= 7 && follows > 0;
          }
          const eps = filterHiker(parseEps(e.endpointSnapshot));
          const m = computeMetrics(eps, e.flaggedAt ?? e.bannedAt);
          return (m.cats.follow ?? 0) > 0 && eps.length < 25;
        }).length;
        return total > 2 ? Math.round((newAccountWithFollows / total) * 100) : -1;
      })(),
      description: "What is being theorised is that Instagram applies a trust ramp to newly created accounts, where the effective action budget starts very low and rises over the first 7-14 days of organic session activity. The data signal: accounts under 7 days old that had follow operations recorded appear in the flagged dataset at a higher rate than older accounts with similar session patterns. The specific ramp duration is inferred from the age distribution of flagged accounts in this dataset. Whether the ramp is time-based, engagement-based, or a combination is not determinable from this data.",
      evidence: (() => {
        const candidates = primaryEntries.filter(e => {
          const age = e.accountAgeDays;
          const follows = e.followCountBeforeBan;
          if (age !== null && age !== undefined && follows !== null && follows !== undefined) {
            return age <= 7 && follows > 0;
          }
          return false;
        });
        const fromSnapshot = primaryEntries.filter(e => {
          const eps = filterHiker(parseEps(e.endpointSnapshot));
          const m = computeMetrics(eps, e.flaggedAt ?? e.bannedAt);
          return (m.cats.follow ?? 0) > 0 && eps.length < 25;
        }).length;
        if (candidates.length > 0) {
          return `${candidates.length} of ${total} flagged accounts (${Math.round(candidates.length/total*100)}%) were under 7 days old and had at least 1 follow operation — the highest-risk combination for the "confirm you are human" ban.`;
        }
        return total > 2
          ? `No age data yet (flag more accounts to populate accountAgeDays). Proxy signal: ${fromSnapshot} of ${total} flagged accounts had follow operations with fewer than 25 total API calls — consistent with a new-account cold-start follow.`
          : "Not enough data yet. Flag more accounts to measure new-account ban patterns.";
      })(),
      advice: "The data shows accounts under 7 days old with follow operations appearing in the flagged dataset at a higher rate. Avoiding follow operations on accounts under 7 days old is the direct action reverse-engineered from the age distribution in the flagged dataset.",
    },
    {
      id: "trust-decay", Icon: TrendingUp,
      title: "Account TrustScore Decay Chain",
      tagline: "Automated → Captcha → Ban is a detectable escalation ladder, not independent events",
      likelihood: decayPct,
      description: "What is being theorised is that Instagram escalates accounts through progressively severe interventions rather than jumping directly to a permanent ban. Under this model each intervention permanently lowers the account's effective action threshold for all future sessions. The data evidence: a measurable share of accounts in this dataset appear in multiple error categories, with automated-behaviour events preceding ban events for the same account. This cross-tab overlap is consistent with a sequential escalation ladder but does not prove causation. It could also reflect underlying account-level properties that independently predict multiple types of flags.",
      evidence: decayPct >= 0 ? decayEvidenceText : total <= 2 ? "Not enough data yet to measure escalation overlap." : "No escalation overlap detected yet.",
      advice: "The data shows accounts appearing in multiple error categories (automated then banned) at a measurable rate. If an account has already appeared in a lower-severity category, the data pattern is consistent with higher flag risk on subsequent sessions. Reducing activity on previously flagged accounts is the action reverse-engineered from the cross-tab overlap.",
    },
    {
      id: "session-action-ratio", Icon: Scale,
      title: "Session-to-Action Ratio: Two Failure Modes",
      tagline: "Both extremes trigger detection — too few passive calls (raw spam) and too many (inactive lurker)",
      likelihood: sarPct,
      description: `What is being theorised is that Instagram runs two independent classifiers on the session-to-action ratio, the ratio of passive session calls (feed views, story views, timeline reads) to action calls (follows, DMs, likes). ${forTab === "locked" ? "Accounts flagged for Locking in this dataset tend to have ratios near zero: all actions and almost no passive session calls. This produces a session pattern consistent with a raw spam bot where every call is an action and nothing resembles organic browsing." : "Accounts flagged in this dataset can show the opposite extreme: extremely high ratios (50-200+) where the account makes many passive calls for every single action. An account running 60 feed views for every 1 follow produces a session pattern that does not match any organic usage distribution."} The data shows both extremes appear in flagged accounts, which is consistent with two separate detection thresholds rather than a single one-directional limit. This is derived from observed data patterns and has not been isolated in a controlled test.`,
      evidence: (() => {
        if (total <= 2) return "Not enough data yet. Flag more accounts to compute session-to-action ratios.";
        const withData = primaryEntries.filter(e => e.sessionToActionRatio !== null && e.sessionToActionRatio !== undefined && !isNaN(parseFloat(e.sessionToActionRatio ?? ""))).length;
        if (withData === 0) return "No session-to-action ratio data in current entries — ratios are captured for newly flagged accounts going forward.";
        if (forTab === "locked") {
          return lowSarWithActionsCount > 0
            ? `${lowSarWithActionsCount} of ${total} locked accounts (${Math.round(lowSarWithActionsCount / total * 100)}%) had a session-to-action ratio below 1 while having action calls recorded — near-zero passive noise with all-action sessions (raw spam pattern).`
            : `No locked accounts with a ratio below 1 and action calls found in current data (${withData}/${total} entries have ratio data).`;
        }
        return highSarCount > 0
          ? `${highSarCount} of ${total} ${forTab} accounts (${Math.round(highSarCount / total * 100)}%) had a session-to-action ratio above 30 — over-camouflaged sessions with disproportionately few real actions buried in passive calls.`
          : `No accounts with a ratio above 30 found in current data (${withData}/${total} entries have ratio data). This pattern may be more visible with more flagged accounts.`;
      })(),
      advice: forTab === "locked"
        ? "For locked accounts: add passive session calls (feed views, story views, profile lookups) between action bursts. A ratio of at least 3–5 passive calls per action reduces the raw-spam signal significantly."
        : "Keep session-to-action ratios in the 8–25 range. Below 3 looks like raw spam; above 50 looks like an inactive account with artificial noise injection. Both are detectable. Balance genuine passive browsing with actions — don't over-pad.",
    },
    {
      id: "low-diversity-action", Icon: Layers,
      title: "Low Endpoint Diversity + High Follow Ratio",
      tagline: "Repeating a small set of endpoints heavily — especially follows — triggers Automated Behaviour detection",
      likelihood: lowDivHighFollowPct,
      description: "What is being theorised is that automated behaviour detection does not fire primarily on timing regularity alone. The data from accounts flagged for automated behaviour in this dataset showed human-level CoV scores, meaning timing alone did not separate them. Instead the distinguishing pattern in this dataset appears to be a combination of low endpoint diversity (calling fewer than 25% of unique endpoints relative to total calls) combined with a high follow ratio (follow calls making up more than 10% of all API calls). A session that calls a small set of endpoints repeatedly while weighting those calls heavily toward follows produces a pattern not observed in any surviving account session in this dataset. This is derived from the automated-behaviour accounts in the current dataset and has not been isolated in a controlled test.",
      evidence: (() => {
        if (total <= 2) return "Not enough data yet. Flag more accounts to measure endpoint diversity and follow ratios.";
        return lowDivHighFollowCount > 0
          ? `${lowDivHighFollowCount} of ${total} ${forTab} accounts (${Math.round(lowDivHighFollowCount / total * 100)}%) had endpoint diversity below 25% and follow calls making up more than 10% of all API calls — the combined low-diversity + action-heavy pattern associated with automated-behaviour detection.`
          : `No accounts matching low diversity (<25%) + high follow ratio (>10%) found in current data. This pattern is most visible in Automated Behaviour accounts — check that tab if you are on a different error type.`;
      })(),
      advice: "Increase endpoint diversity by mixing in more varied passive calls between follow batches — profile lookups, story views, explore page fetches, notifications. The goal is for each session to call at least 40–50% unique endpoints relative to total call count. Reduce follow density: follows should represent less than 10% of total API calls in any given session window.",
    },
    {
      id: "endpoint-risk", Icon: Flame,
      title: `Pre-${errorTypeLabel} Endpoint Risk Pattern`,
      tagline: `Which endpoints appear most often in the final ${RISK_WINDOW} calls before each ${errorTypeLower}`,
      likelihood: endpointRiskPct,
      description: `What is being theorised is that specific endpoint calls appear disproportionately often in the final ${RISK_WINDOW} calls before a ${forTab} event. Under the Suspicion Budget model, each endpoint carries an implicit per-call risk cost — endpoints concentrated most heavily in pre-${forTab} windows may carry a higher cost than endpoints rarely seen in those windows. This is a correlation from your own dataset only. It does not establish that removing these endpoints would prevent the flag: it is equally possible that these endpoints are universal (present in every session, flagged or not), and the percentage reflects session structure rather than risk causation. The value of this data is in spotting outliers — endpoints that are rare in normal sessions but appear frequently before ${forTab} events are the most interesting candidates for removal or rate-limiting.`,
      evidence: (() => {
        if (total <= 2 || endpointRiskData.valid === 0) return "Not enough data yet. Flag more accounts to compute pre-event endpoint patterns.";
        const top3 = endpointRiskData.top.slice(0, 3);
        if (top3.length === 0) return "No endpoint snapshot data in current entries.";
        return `Top endpoints in the final ${RISK_WINDOW} calls across ${endpointRiskData.valid} ${forTab} account${endpointRiskData.valid !== 1 ? "s" : ""}: ${top3.map(e => `${e.label ?? e.name} (${e.pct}% of accounts)`).join(", ")}. The highest-presence endpoint — ${endpointRiskData.top[0]?.label ?? endpointRiskData.top[0]?.name} — appeared in the pre-${forTab} window for ${endpointRiskData.top[0]?.count ?? 0} of ${endpointRiskData.valid} account${endpointRiskData.valid !== 1 ? "s" : ""}. The percentage shown on the bar above is the top endpoint's account presence rate.`;
      })(),
      advice: (() => {
        if (endpointRiskData.valid === 0 || endpointRiskData.top.length === 0) return `Flag more accounts to generate endpoint risk data for this error type.`;
        const highRisk = endpointRiskData.top.filter(e => e.pct >= 50);
        const actionEps = endpointRiskData.top.filter(e => e.category === "follow" || e.category === "unfollow" || e.category === "dm" || e.category === "like");
        if (highRisk.length === 0) return `No endpoint appears in 50%+ of pre-${forTab} windows yet — keep collecting data. The pattern becomes meaningful once you have 5+ events and a clear dominant endpoint.`;
        if (actionEps.length > 0 && actionEps[0].pct >= highRisk[0]?.pct - 10) {
          return `Action endpoints (${actionEps.slice(0, 2).map(e => e.label ?? e.name).join(", ")}) dominate the pre-${forTab} window. This is expected — action calls appear right before the flag. Focus instead on non-action endpoints in the list: verify, session, or auth endpoints appearing at high rates may indicate specific call sequences to reduce or stagger.`;
        }
        return `${highRisk.slice(0, 2).map(e => e.label ?? e.name).join(" and ")} appear in ${highRisk[0].pct}%+ of pre-${forTab} sessions. If these are not core user-action endpoints, consider removing or staggering them in the session sequence to reduce the suspicion budget consumed before each ${errorTypeLower}.`;
      })(),
    },
    {
      id: "total-call-rate", Icon: Sigma,
      title: "Total API Call Rate Too High (>0.15 calls/min)",
      tagline: "Calling the API faster than 1 call per 7 seconds puts you well above the survivor ceiling",
      likelihood: highCallRatePct,
      description: "What is being theorised is that the overall rate at which an account makes ANY API call — passive or active — is an independent risk signal, separate from how many follows happen per hour. Survivor data from this dataset shows two accounts that remained unflagged had total call rates of 0.058–0.099 calls per minute (one call every 10–17 seconds on average). Banned accounts on the same proxies ran at 0.3–9 calls per minute. The pattern held across every proxy in the dataset: on every single IP, the account that lasted longest had a lower total call rate than the median account on that IP. This is about ALL calls, not just follows — the passive calls (feed views, story reads) also count toward this rate. The threshold of 0.15/min is the midpoint between the survivor ceiling (0.1/min) and the lowest banned-account rate (0.3/min).",
      evidence: highCallRatePct >= 0
        ? `${highCallRateCount} of ${total} flagged accounts (${highCallRatePct}%) had a total API call rate above 0.15 calls/min. The survivor accounts in this dataset ran at 0.058–0.099/min. Banned accounts on the same IPs ran at 0.3–9/min — 3 to 90× faster than the survivors.`
        : "Not enough data yet. Flag more accounts to measure call rate distribution.",
      advice: "Keep total call rate below 0.10 calls/min (one call every 10 seconds or slower). This applies to ALL calls including passive ones — slowing down feed views and story reads counts just as much as slowing down follows. The goal is an overall rhythm that averages one call every 10–15 seconds or slower across the entire session window.",
    },
    {
      id: "survivor-warmup-level", Icon: Target,
      title: "Below Survivor Warmup Threshold (<50 passive ops before first follow)",
      tagline: "Surviving accounts accumulated 100–185 passive calls before their first follow; most banned accounts had 0–5",
      likelihood: belowSurvivorWarmupPct,
      description: "What is being theorised is that a new account needs to build a session history of passive calls before Instagram will accept follow actions from it without flagging. The data from this dataset: both surviving accounts had accumulated over 100 passive session operations before their first follow call fired (emilee: 114 ops, francoise: 185 ops). The median pre-follow warmup across all banned accounts on the same proxies was 0 — meaning most banned accounts followed with no prior session history at all. This is a stronger finding than the existing Follow Call Density theory (which measures average warmup across all follows): this specifically measures the initial cold-start — how many calls happened before the account ever touched a follow for the first time. A threshold of 50 is used here as the halfway point between the typical banned-account level (0–5) and the survivor level (100–185).",
      evidence: belowSurvivorWarmupPct >= 0
        ? `${belowSurvivorWarmupCount} of ${total} flagged accounts with follow activity (${belowSurvivorWarmupPct}%) had fewer than 50 passive ops logged before their first follow. Survivor accounts in this dataset accumulated 114–185 ops before their first follow. The gap between 0 and 100+ ops is the clearest behavioural separator between banned and surviving accounts found in this dataset.`
        : "Not enough data yet. Flag more accounts with follow activity to measure pre-first-follow warmup.",
      advice: "Run 100–200 ViewTimelineFeedSeen calls before the first follow fires on any new account. ViewTimelineFeedSeen is the safest passive call — it made up 56% of survivor activity in this dataset. The account should spend at least one full session doing nothing but browsing the feed before any follow tool is activated.",
    },
    {
      id: "burst-idle-rhythm", Icon: Star,
      title: "No Burst-Idle Session Rhythm",
      tagline: "Surviving accounts were active for short bursts then idle for hours — not running continuously",
      likelihood: continuousSessionPct,
      description: "What is being theorised is that organic Instagram sessions are short bursts of activity separated by multi-hour idle periods, and that continuous-session patterns (calling the API at a steady rate for extended periods) are detectable as non-human. The data from this dataset: the surviving account (emilee) had 416 total calls over 70 hours, but only 3.9 hours of actual activity — 94% of the time was idle. She had 35 separate gaps of over 30 minutes between calls, with the longest being 18 hours. Banned accounts ran at call rates of 0.2–9/min sustained over their session spans — a continuous pattern that never produces multi-hour gaps. A human checks Instagram for a few minutes, leaves, comes back hours later. They do not maintain a steady 1-call-every-few-seconds rhythm for extended periods.",
      evidence: continuousSessionPct >= 0
        ? `${continuousSessionCount} of ${total} flagged accounts (${continuousSessionPct}%) had a call rate above 0.2/min sustained over a span of more than 20 minutes — consistent with continuous calling rather than burst-idle. The survivor in this dataset ran at 0.099/min overall but was truly idle for 94% of her 70-hour span, active only in short bursts before going silent for hours.`
        : "Not enough data yet. Flag more accounts with multi-minute session spans to measure burst-idle rhythm.",
      advice: "Structure sessions as short bursts (2–5 minutes of activity) followed by long idle gaps (2–8 hours). The engine should not call the API at a steady rate for 30+ continuous minutes. Schedule runs to mimic human check-in patterns: brief active window, then off for hours. This means lower daily call totals but a session shape that matches organic usage.",
    },
  ];

  return (
    <div className="space-y-4">
      {total === 0 && (
        <div className="border border-border rounded-lg p-10 text-center">
          <FlaskConical className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm font-medium">No data yet</p>
          <p className="text-xs text-muted-foreground mt-1">Flag accounts on the Data tab to populate theory likelihood counters.</p>
        </div>
      )}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-start gap-2">
          <FlaskConical className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold">Detection Theories</span>
            <p className="text-[11px] text-muted-foreground mt-0.5">Each theory's progress bar shows what percentage of <strong>this error type's</strong> accounts match the pattern. The more accounts you flag on the Data tab, the more accurate these percentages become. Theories are not mutually exclusive — multiple can be active simultaneously.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {total > 0 && <span className="text-[10px] text-muted-foreground pt-0.5">based on {total} accounts</span>}
          </div>
        </div>
        <div className="divide-y divide-border">
          {[...theories].sort((a, b) => {
            if (a.likelihood < 0 && b.likelihood < 0) return 0;
            if (a.likelihood < 0) return 1;
            if (b.likelihood < 0) return -1;
            return b.likelihood - a.likelihood;
          }).map(({ id, Icon, title, tagline, likelihood, description, evidence, advice }) => (
            <div key={id} className="p-4 space-y-2.5">
              <div className="flex items-start gap-2">
                <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-[11px] text-muted-foreground italic">{tagline}</p>
                </div>
              </div>
              <LikelihoodBar pct={likelihood} />
              <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
              <div className="bg-muted/30 rounded-md px-3 py-2 space-y-0.5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Evidence from your data</p>
                <p className="text-[11px]">{evidence}</p>
              </div>
              <div className="bg-cyan-50 dark:bg-cyan-900/10 rounded-md px-3 py-2 border border-cyan-200 dark:border-cyan-800">
                <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-600 dark:text-cyan-400 mb-0.5">Recommended action</p>
                <p className="text-[11px] text-cyan-700 dark:text-cyan-300">{advice}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Verify-Only Device Fingerprint card (ban tab only) ───────────── */}
      {forTab === "ban" && !fpLoading && (() => {
        const accounts = verifyFpData ?? [];
        const withLeak = accounts.filter(a => a.leakData && typeof a.leakData === "object" && a.leakData.results);
        const noLeak = accounts.filter(a => !a.leakData || !a.leakData.results);

        // Scored tests: keys that can actually produce fail/warn verdicts.
        // Info-only tests (Timezone, Navigator, Hardware, Canvas, Audio, WebGL, etc.)
        // are excluded from the bar chart — they capture fingerprint data but have
        // no pass/fail verdict, so counting them as "pass" (green) is misleading.
        const SCORED_KEYS = ["IPMatch", "WebRTC", "DNS", "UAMatch", "Bot", "Fonts"];

        const testStats = SCORED_KEYS.map(key => {
          let fail = 0, warn = 0, pass = 0, missing = 0;
          for (const a of withLeak) {
            const r = (a.leakData.results as Record<string, { status: string; label?: string }>)[key];
            if (!r) { missing++; continue; }
            const s = (r.status ?? "").toLowerCase();
            if (s === "fail") fail++;
            else if (s === "warn") warn++;
            else if (s === "pass") pass++;
            else missing++; // info or unknown = not a verdict
          }
          const n = withLeak.length;
          const label = (withLeak[0]?.leakData?.results as any)?.[key]?.label ?? key;
          const verdicted = fail + warn + pass;
          return { key, label, fail, warn, pass, missing, total: n, verdicted, failPct: verdicted > 0 ? Math.round(fail / verdicted * 100) : 0 };
        }).filter(t => t.verdicted > 0).sort((a, b) => b.failPct - a.failPct);

        const majorityFails = testStats.filter(t => t.failPct > 50);

        return (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-start gap-2">
              <Fingerprint className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold">Verify-Only Device Fingerprint</span>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Accounts banned having done nothing but the API bootstrap sequence (tokens/keyed → launcher/sync → users/info) — zero follow, DM, or tool activity. Tests whether the <em>verify handshake itself</em> or the device fingerprint at that moment triggered the ban.
                </p>
              </div>
              {accounts.length > 0 && <span className="text-[10px] text-muted-foreground pt-0.5 shrink-0">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</span>}
            </div>

            {accounts.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-xs text-muted-foreground">No verify-only bans yet. These are accounts banned with zero tool activity — only the verify handshake ran. Flag more accounts on the Data tab to populate this card.</p>
              </div>
            ) : withLeak.length === 0 ? (
              <div className="p-4 space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  {accounts.length} verify-only banned account{accounts.length !== 1 ? "s" : ""} found, but none have a leak snapshot. Re-verify these accounts to capture a device fingerprint:
                </p>
                <div className="flex flex-col gap-1">
                  {noLeak.map(a => (
                    <div key={a.id} className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-muted-foreground">@{a.username}</span>
                      {a.bannedAt && <span className="text-muted-foreground/60">· banned {new Date(a.bannedAt).toLocaleDateString()}</span>}
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground italic">Go to Accounts → click Verify on each account above. The leak check runs silently in the background and populates this analysis automatically.</p>
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <div className="space-y-2">
                  {testStats.map(t => (
                    <div key={t.key} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">{t.label}</span>
                        <span className={t.failPct > 50 ? "text-red-500 font-bold" : "text-muted-foreground"}>{t.failPct}% fail</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden flex">
                        <div className="h-full bg-red-500 transition-all" style={{ width: `${Math.round(t.fail / t.total * 100)}%` }} />
                        <div className="h-full bg-yellow-400 transition-all" style={{ width: `${Math.round(t.warn / t.total * 100)}%` }} />
                        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(t.pass / t.total * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-3 text-[9px] text-muted-foreground mt-1">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Fail</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />Warn</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />Pass</span>
                  </div>
                </div>

                <div className="bg-muted/30 rounded-md px-3 py-2 space-y-0.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Evidence from {withLeak.length} account{withLeak.length !== 1 ? "s" : ""}</p>
                  {majorityFails.length > 0 ? (
                    <p className="text-[11px]">
                      {majorityFails.map(t => t.label).join(", ")} fail{majorityFails.length === 1 ? "s" : ""} on the majority of verify-only banned accounts. These are the likely fingerprint detection signals — Instagram may have identified the device as non-human at verify time, before any tool ever ran.
                    </p>
                  ) : (
                    <p className="text-[11px]">No individual fingerprint test fails on more than 50% of verify-only banned accounts. The device fingerprint passed inspection — the ban trigger is more likely IP-level (login rate limit) than device-level. See the IP Login Rate Limit theory above.</p>
                  )}
                </div>

                <div className="bg-cyan-50 dark:bg-cyan-900/10 rounded-md px-3 py-2 border border-cyan-200 dark:border-cyan-800">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-600 dark:text-cyan-400 mb-0.5">Recommended action</p>
                  {majorityFails.length > 0 ? (
                    <p className="text-[11px] text-cyan-700 dark:text-cyan-300">
                      Fix the {majorityFails.map(t => t.label).join(" and ")} test{majorityFails.length !== 1 ? "s" : ""} in the Leak Test before verifying new accounts. A device that fails these checks at verify time is identifiable as non-human independent of any subsequent tool activity.
                    </p>
                  ) : (
                    <p className="text-[11px] text-cyan-700 dark:text-cyan-300">
                      Device fingerprint tests pass — the verify-only ban pattern points to the IP Login Rate Limit theory. Space verifications at least 90 minutes apart on the same proxy IP. Each verify generates two login events (browser + mobile API); too many on one IP trips the per-IP login budget.
                    </p>
                  )}
                </div>

                <details className="group">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground flex items-center gap-1 select-none list-none">
                    <ChevronDown className="w-3 h-3 group-open:hidden" /><ChevronUp className="w-3 h-3 hidden group-open:block" />
                    Per-account breakdown
                  </summary>
                  <div className="mt-2 space-y-2">
                    {[...withLeak, ...noLeak].map(a => {
                      const capturedAt = a.leakData?.capturedAt ? new Date(a.leakData.capturedAt).toLocaleString() : null;
                      const results: Record<string, { status: string; label?: string }> = a.leakData?.results ?? {};
                      return (
                        <div key={a.id} className="border border-border rounded-md p-3 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold font-mono">@{a.username}</span>
                            <div className="flex gap-2 text-[10px] text-muted-foreground">
                              {a.bannedAt && <span>banned {new Date(a.bannedAt).toLocaleDateString()}</span>}
                              {capturedAt && <span>· fingerprint {capturedAt}</span>}
                            </div>
                          </div>
                          {Object.keys(results).length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(results).map(([key, val]) => {
                                const s = (val.status ?? "").toLowerCase();
                                const color = s === "fail"
                                  ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                  : s === "warn"
                                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                  : s === "pass"
                                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                  : "bg-muted text-muted-foreground";
                                const displayVal = s === "info" ? (val as any).label ?? key : val.status?.toUpperCase();
                                return <span key={key} className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${color}`}>{key}: {displayVal}</span>;
                              })}
                            </div>
                          ) : (
                            <p className="text-[10px] text-muted-foreground italic">No leak snapshot — re-verify to capture fingerprint.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function BanAnalyticsPage() {
  const setSidebarSlot = useSidebarSetSlot();
  useEffect(() => { setSidebarSlot(null); return () => setSidebarSlot(null); }, []);

  const [activeTab, setActiveTab] = useState<Tab>("ban");
  const [innerTabs, setInnerTabs] = useState<Record<ErrorTab, InnerTab>>({ ban: "data", automated: "data", captcha: "data", locked: "data" });
  const [groupFilters, setGroupFilters] = useState<Record<ErrorTab, GroupFilter>>({ ban: "all", automated: "all", captcha: "all", locked: "all" });
  const [showAllProxy, setShowAllProxy] = useState(false);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  const { data: banEntries = [], isLoading: banLoading } = useQuery<AnalyticsEntry[]>({ queryKey: ["/api/analytics/ban-patterns"], queryFn: async () => (await fetch("/api/analytics/ban-patterns", { credentials: "include" })).json(), refetchInterval: 30000 });
  const { data: automatedEntries = [], isLoading: autoLoading } = useQuery<AnalyticsEntry[]>({ queryKey: ["/api/analytics/automated-patterns"], queryFn: async () => (await fetch("/api/analytics/automated-patterns", { credentials: "include" })).json(), refetchInterval: 30000 });
  const { data: captchaEntries = [], isLoading: captchaLoading } = useQuery<AnalyticsEntry[]>({ queryKey: ["/api/analytics/captcha-patterns"], queryFn: async () => (await fetch("/api/analytics/captcha-patterns", { credentials: "include" })).json(), refetchInterval: 30000 });
  const { data: lockedEntries = [], isLoading: lockedLoading } = useQuery<AnalyticsEntry[]>({ queryKey: ["/api/analytics/locked-patterns"], queryFn: async () => (await fetch("/api/analytics/locked-patterns", { credentials: "include" })).json(), refetchInterval: 30000 });
  const { data: allProfiles = [] } = useQuery<ProfileRow[]>({ queryKey: ["/api/profiles"], queryFn: async () => (await fetch("/api/profiles", { credentials: "include" })).json(), refetchInterval: 60000 });
  const { data: allProxies = [] } = useQuery<ProxyRow[]>({ queryKey: ["/api/proxies"], queryFn: async () => (await fetch("/api/proxies", { credentials: "include" })).json(), refetchInterval: 60000 });
  const { data: survivorPatterns = [], isLoading: survivorPatternsLoading } = useQuery<SurvivorPattern[]>({ queryKey: ["/api/analytics/survivor-call-patterns"], queryFn: async () => (await fetch("/api/analytics/survivor-call-patterns", { credentials: "include" })).json(), enabled: activeTab === "survivors", refetchInterval: 60000, staleTime: 30000 });

  const isLoading = banLoading || autoLoading || captchaLoading || lockedLoading;
  const profileMap   = useMemo(() => new Map<string, number>(allProfiles.map(p => [p.username, p.id])), [allProfiles]);
  const trustMap     = useMemo(() => buildTrustMap(allProfiles), [allProfiles]);
  const profileNotesMap = useMemo(() => new Map<string, string | null>(allProfiles.map(p => [p.username, p.notes ?? null])), [allProfiles]);

  const flaggedUsernames = useMemo(() => new Set([...banEntries, ...automatedEntries, ...captchaEntries, ...lockedEntries].map(e => e.username)), [banEntries, automatedEntries, captchaEntries, lockedEntries]);
  const now = Date.now();
  const survivingAccounts = useMemo(() => allProfiles
    .filter(p => (p.accountStatus ?? "").toLowerCase().replace(/_/g, " ") === "valid" && !flaggedUsernames.has(p.username))
    .map(p => {
      const firstDate = parseFirstAddedDate(p.notes);
      const allDates  = parseAllAddedDates(p.notes);
      const mostRecentDate = allDates.length > 0 ? allDates[allDates.length - 1] : firstDate;
      return { ...p, firstDate, allDates, runMs: mostRecentDate ? now - mostRecentDate.getTime() : null };
    })
    .filter(p => p.firstDate !== null)
    .sort((a, b) => (a.runMs ?? 0) > (b.runMs ?? 0) ? -1 : 1)
    .slice(0, 20), [allProfiles, flaggedUsernames]);

  const proxyRisks = useMemo(() => buildProxyRiskMap(banEntries, automatedEntries, captchaEntries, lockedEntries), [banEntries, automatedEntries, captchaEntries, lockedEntries]);
  const concurrencyAlerts = useMemo(() => buildConcurrencyAlerts(banEntries, automatedEntries, captchaEntries, lockedEntries), [banEntries, automatedEntries, captchaEntries, lockedEntries]);
  const TABS: Tab[] = ["ban", "automated", "captcha", "locked", "survivors"];
  const TAB_LABELS: Record<Tab, string> = { ban: "Banned", automated: "Automated", captcha: "Captcha", locked: "Locked", survivors: "Survivors" };
  const ERROR_TABS: ErrorTab[] = ["ban", "automated", "captcha", "locked"];

  async function handleExport() {
    const levels = getTrustLevels();

    // Run server-side proxy leak checks (no browser needed) for ALL accounts —
    // survivors AND every banned/automated/captcha/locked entry that still has a
    // profile record in the DB. Fires HTTPS requests through each account's proxy
    // to api.ipify.org, 1.1.1.1/cdn-cgi/trace, and api4.my-ip.io — zero Instagram
    // API calls, zero browsers opened. Results are saved to leakSnapshot in the DB.
    const allFlaggedEntries = [...banEntries, ...automatedEntries, ...captchaEntries, ...lockedEntries];
    const flaggedProfileIds = allFlaggedEntries
      .map(e => profileMap.get(e.username))
      .filter((id): id is number => id !== undefined);
    const survivorIds = survivingAccounts.map(p => p.id).filter(Boolean) as number[];
    const allProfileIds = [...new Set([...survivorIds, ...flaggedProfileIds])];

    const freshLeakMap = new Map<number, string>(); // profileId → snapshot JSON string
    if (allProfileIds.length > 0) {
      try {
        const lrResp = await fetch("/api/analytics/refresh-leak-snapshots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ profileIds: allProfileIds }),
        });
        if (lrResp.ok) {
          const lrData = await lrResp.json() as { ok: boolean; results: Record<string, { username: string; snapshot: string }> };
          for (const [idStr, val] of Object.entries(lrData.results ?? {})) {
            freshLeakMap.set(Number(idStr), val.snapshot);
          }
        }
      } catch { /* non-fatal — export proceeds without fresh leak data */ }
    }

    // Fetch live survivor endpoint data so survivors have full metrics in the export
    let survivorPatternData: SurvivorPattern[] = [];
    try {
      const resp = await fetch("/api/analytics/survivor-call-patterns", { credentials: "include" });
      if (resp.ok) survivorPatternData = await resp.json();
    } catch { /* non-fatal — survivors will export without endpoint data */ }
    const survivorPatternMap = new Map<string, SurvivorPattern>(survivorPatternData.map(sp => [sp.username, sp]));

    function makeEnrichFn(entries: AnalyticsEntry[]) {
      const cross = computeCrossStats(entries, trustMap, profileMap, profileNotesMap);
      return function enrichEntry(e: AnalyticsEntry) {
        // Use profileMap first (active accounts), fall back to e.id directly
        // for deleted accounts — evasion log entries always carry their own ID,
        // so we can read the trust score straight from localStorage even after
        // the profile has been deleted from the DB and removed from allProfiles.
        const id = profileMap.get(e.username) ?? e.id;
        const ti: TrustInfo | undefined = (() => {
          if (id === undefined) return undefined;
          if (trustMap.has(id)) return trustMap.get(id);
          const levelId = getTrustScore(id);
          if (!levelId) return undefined;
          const levels = getTrustLevels();
          const rank = levels.findIndex(l => l.id === levelId);
          return { levelId, label: levels[rank]?.label ?? levelId.toUpperCase(), rank: rank >= 0 ? rank + 1 : 1 };
        })();
        const eps = filterHiker(parseEps(e.endpointSnapshot));
        const ts = e.flaggedAt ?? e.bannedAt ?? "";
        const m = computeMetrics(eps, ts);
        const anomaly = cross.n >= 2 ? computeAnomalyScore(m, cross) : null;
        const topOps = topEps(eps, 10);
        const computedMetrics = {
          callRate_perMin: m.callsPerMin > 0 ? m.callsPerMin : null,
          activeCallRate_perMin: m.activeCallRate_perMin > 0 ? m.activeCallRate_perMin : null,
          activeTimeMin: m.activeTimeMin > 0 ? m.activeTimeMin : null,
          activeSessionCount: m.activeSessionCount > 0 ? m.activeSessionCount : null,
          spanMin: m.spanMin > 0 ? m.spanMin : null,
          avgInterCallSec: m.avgInterCallSec > 0 ? m.avgInterCallSec : null,
          minInterCallSec: eps.length > 1 ? m.minInterCallSec : null,
          timingCoV: m.timingCoV >= 0 ? m.timingCoV : null,
          timingCoV_label: m.timingCoV < 0 ? null : m.timingCoV < 0.3 ? "ROBOTIC" : m.timingCoV < 0.5 ? "LOW" : m.timingCoV < 1.0 ? "MODERATE" : "HUMAN",
          shannonEntropy_bits: m.shannonEntropy,
          uniqueEndpoints: m.uniqueEndpoints,
          endpointDiversity_pct: m.endpointDiversity * 100,
          burstWindows: m.burstCount,
          preActionWarmup: m.preActionWarmup,
          actionVelocity_perHour: m.actionVelocityPerHour > 0 ? m.actionVelocityPerHour : null,
          sessionPerAction: m.actionCount > 0 ? m.sessionPerAction : null,
          authPerAction: m.actionCount > 0 ? m.authPerAction : null,
          cats: m.cats,
          anomalyScore: anomaly,
          top10Endpoints: topOps.map(ep => ({ name: ep.name, label: ep.label ?? ep.name, count: ep.count })),
        };
        const fp = (e as any);
        return {
          ...e,
          trustScore: ti ? { rank: ti.rank, label: ti.label } : null,
          computedMetrics,
          deviceFingerprint: {
            userAgentApi: fp.userAgentApi ?? null,
            userAgentEmbedded: fp.userAgentEmbedded ?? null,
            igDeviceState: fp.igDeviceState ? (() => { try { return JSON.parse(fp.igDeviceState); } catch { return fp.igDeviceState; } })() : null,
            ebFingerprint: fp.ebFingerprint ? (() => { try { return JSON.parse(fp.ebFingerprint); } catch { return fp.ebFingerprint; } })() : null,
          },
          leakSnapshot: (() => { const pid = profileMap.get(e.username); const raw = (pid !== undefined ? freshLeakMap.get(pid) : undefined) ?? fp.leakSnapshot ?? null; if (!raw) return null; try { return JSON.parse(raw); } catch { return raw; } })(),
        };
      };
    }
    const payload = {
      _analysisNote: "MAKE ASSUMPTIONS FROM DATA ALONE. Never theorise from outside third-party theories or internet knowledge — only the raw data in this file.",
      _fieldNotes: {
        trustScore: "USER-ASSIGNED label — this is the operator's own estimate of the account's trust level on Instagram, not a score computed or returned by Instagram. null = no label assigned yet (account was banned before the user labelled it, or simply not labelled). NOOB = user's guess that the account is brand new / low trust. Do NOT treat trustScore as a signal from Instagram's systems.",
        proxyHost: "The proxy IP associated with the account at the time of the ban event. Empty string means the proxy was not recorded in the evasion log for this account — it does NOT mean the account ran without a proxy. All accounts require a proxy to run.",
        spanHours: "Time in hours between the FIRST and LAST logged endpoint call for this account. This is the full wall-clock survival window — it includes idle gaps between sessions where no API calls were made. Useful for comparing how long accounts survived, NOT for measuring how active they were. Only accounts that have endpoint snapshot data will have a spanHours value.",
        runningMs: "For survivor accounts: milliseconds since the account was first registered in the software. This is a wall-clock duration, not a measure of active API usage. An account can have a high runningMs without ever having made a mobile API call.",
        anomalyScore: "Computed from the endpoint timing and diversity of the account's logged API calls. Lower = more human-like. This is calculated from the app's own heuristics, not from Instagram.",
        callRate_perMin: "MISLEADING IF USED ALONE. Total API calls divided by total span minutes (first call to last call). This averages over all idle gaps between sessions and produces an artificially low number. Do NOT use this to compare how fast accounts were calling Instagram. Use activeCallRate_perMin instead.",
        activeCallRate_perMin: "Calls per minute during active session windows only. Sessions are defined as groups of consecutive calls with less than 5 minutes between each call. Idle gaps between sessions are excluded. This is the real API call speed when the account was actually running.",
        activeTimeMin: "Total minutes spent in active sessions (sum of all session durations, excluding idle gaps). Use this to understand how long the account was actually running, as opposed to spanHours which includes idle time.",
        activeSessionCount: "Number of distinct active sessions detected. A new session begins when a gap of more than 5 minutes occurs between consecutive API calls.",
        bannedAt: "The timestamp when the operator MANUALLY marked this account as banned in the software. This is NOT when Instagram banned the account. Do not use timestamp clustering or time-of-day patterns in bannedAt to infer Instagram server behaviour — clusters reflect when the operator sat down to mark bans, not Instagram sweep timing.",
        deviceFingerprint: "Device identity snapshot captured at the moment of the ban/flag event (or at last verification for survivors). userAgentApi = the mobile API user-agent string sent in HTTP headers to Instagram's private API. userAgentEmbedded = the user-agent string used by the embedded Chrome browser for web sessions. igDeviceState = the persistent mobile device identity (uuid, deviceId, phoneId, adid, igDid) — these MUST stay constant for the lifetime of an account. ebFingerprint = the full Chrome browser fingerprint object (screen resolution, platform, hardware concurrency, etc.) recorded at last EB session. null means the data was not recorded before the account was flagged.",
        leakSnapshot: "The last leak-check result set captured automatically when the embedded browser opened the Equinox Leak Test page for this account. Contains capturedAt timestamp, per-test pass/fail/warn/info results (IP, DNS, WebRTC, UA match, bot detection, etc.), proxy details, and user-agent strings active at the time of the test. null means no leak test has ever been run for this account.",
      },
      exportedAt: new Date().toISOString(),
      summary: {
        banned: banEntries.length,
        automated: automatedEntries.length,
        captcha: captchaEntries.length,
        locked: lockedEntries.length,
        survivors: survivingAccounts.length,
        totalFlagged: banEntries.length + automatedEntries.length + captchaEntries.length + lockedEntries.length,
      },
      trustScoreLevels: levels.map((l, i) => ({ rank: i + 1, id: l.id, label: l.label })),
      banned:    banEntries.map(makeEnrichFn(banEntries)),
      automated: automatedEntries.map(makeEnrichFn(automatedEntries)),
      captcha:   captchaEntries.map(makeEnrichFn(captchaEntries)),
      locked:    lockedEntries.map(makeEnrichFn(lockedEntries)),
      survivors: survivingAccounts.map(p => {
        const id = profileMap.get(p.username) ?? p.id;
        const ti: TrustInfo | undefined = (() => {
          if (id === undefined) return undefined;
          if (trustMap.has(id)) return trustMap.get(id);
          const levelId = getTrustScore(id);
          if (!levelId) return undefined;
          const levels = getTrustLevels();
          const rank = levels.findIndex(l => l.id === levelId);
          return { levelId, label: levels[rank]?.label ?? levelId.toUpperCase(), rank: rank >= 0 ? rank + 1 : 1 };
        })();
        const sp = survivorPatternMap.get(p.username);

        let computedMetrics = null;
        let endpointCount: number | null = null;
        let endpointSnapshot: string | null = null;
        let spanHours: number | null = null;
        let accountAgeDays: number | null = null;

        if (sp) {
          endpointCount = sp.endpointCount;
          endpointSnapshot = sp.endpointSnapshot;
          accountAgeDays = sp.accountAgeDays;
          const eps = filterHiker(parseEps(sp.endpointSnapshot));
          const m = computeMetrics(eps, sp.capturedAt);
          const topOps = topEps(eps, 10);
          spanHours = m.spanMin > 0 ? +(m.spanMin / 60).toFixed(4) : null;
          computedMetrics = {
            callRate_perMin: m.callsPerMin > 0 ? m.callsPerMin : null,
            activeCallRate_perMin: m.activeCallRate_perMin > 0 ? m.activeCallRate_perMin : null,
            activeTimeMin: m.activeTimeMin > 0 ? m.activeTimeMin : null,
            activeSessionCount: m.activeSessionCount > 0 ? m.activeSessionCount : null,
            spanMin: m.spanMin > 0 ? m.spanMin : null,
            avgInterCallSec: m.avgInterCallSec > 0 ? m.avgInterCallSec : null,
            minInterCallSec: eps.length > 1 ? m.minInterCallSec : null,
            timingCoV: m.timingCoV >= 0 ? m.timingCoV : null,
            timingCoV_label: m.timingCoV < 0 ? null : m.timingCoV < 0.3 ? "ROBOTIC" : m.timingCoV < 0.5 ? "LOW" : m.timingCoV < 1.0 ? "MODERATE" : "HUMAN",
            shannonEntropy_bits: m.shannonEntropy,
            uniqueEndpoints: m.uniqueEndpoints,
            endpointDiversity_pct: m.endpointDiversity * 100,
            burstWindows: m.burstCount,
            preActionWarmup: m.preActionWarmup,
            actionVelocity_perHour: m.actionVelocityPerHour > 0 ? m.actionVelocityPerHour : null,
            sessionPerAction: m.actionCount > 0 ? m.sessionPerAction : null,
            authPerAction: m.actionCount > 0 ? m.authPerAction : null,
            cats: m.cats,
            anomalyScore: null,
            top10Endpoints: topOps.map(ep => ({ name: ep.name, label: ep.label ?? ep.name, count: ep.count })),
          };
        }

        return {
          username: p.username,
          proxyHost: p.proxyHost ?? null,
          runningMs: p.runMs,
          accountAgeDays,
          endpointCount,
          endpointSnapshot,
          spanHours,
          trustScore: ti ? { rank: ti.rank, label: ti.label } : null,
          computedMetrics,
          deviceFingerprint: {
            userAgentApi: sp?.userAgentApi ?? (p as any).userAgentApi ?? null,
            userAgentEmbedded: sp?.userAgentEmbedded ?? (p as any).userAgentEmbedded ?? null,
            igDeviceState: (() => { const raw = sp?.igDeviceState ?? (p as any).igDeviceState ?? null; if (!raw) return null; try { return JSON.parse(raw); } catch { return raw; } })(),
            ebFingerprint: (() => { const raw = sp?.ebFingerprint ?? (p as any).ebFingerprint ?? null; if (!raw) return null; try { return JSON.parse(raw); } catch { return raw; } })(),
          },
          leakSnapshot: (() => { const raw = freshLeakMap.get(p.id) ?? sp?.leakSnapshot ?? (p as any).leakSnapshot ?? null; if (!raw) return null; try { return JSON.parse(raw); } catch { return raw; } })(),
        };
      }),
      proxyRisks:        proxyRisks.map(pr => ({ proxyHost: pr.host, totalEvents: pr.total, uniqueAccounts: pr.accounts.length, accounts: pr.accounts })),
      concurrencyAlerts: concurrencyAlerts,
      verifyTimeline: (() => {
        const allEntries = [...banEntries, ...automatedEntries, ...captchaEntries, ...lockedEntries];
        const byProxyDay = new Map<string, { proxy: string; date: string; accounts: { username: string; timestamp: string }[] }>();
        for (const e of allEntries) {
          if (!e.proxyHost || !e.endpointSnapshot) continue;
          let eps: Array<{ operationName: string; date: string; source?: string | null }> = [];
          try { eps = JSON.parse(e.endpointSnapshot); } catch { continue; }
          for (const ep of eps) {
            if (ep.source !== "Verify" && ep.source !== "System") continue;
            if (ep.operationName !== "VerifyAccount") continue;
            const day = ep.date ? ep.date.slice(0, 10) : null;
            if (!day) continue;
            const key = `${e.proxyHost}||${day}`;
            if (!byProxyDay.has(key)) byProxyDay.set(key, { proxy: e.proxyHost, date: day, accounts: [] });
            const entry = byProxyDay.get(key)!;
            if (!entry.accounts.some(a => a.username === e.username)) {
              entry.accounts.push({ username: e.username, timestamp: ep.date });
            }
          }
        }
        return Array.from(byProxyDay.values())
          .sort((a, b) => a.proxy.localeCompare(b.proxy) || a.date.localeCompare(b.date))
          .map(v => ({ proxy: v.proxy, date: v.date, verifyCount: v.accounts.length, accounts: v.accounts }));
      })(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href     = url;
    a.download = `evasion-stats-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ color: "#1AD2F2" }}>
              <path fill="currentColor" fillRule="evenodd" d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/>
              <rect fill="currentColor" x="14.8" y="14.2" width="8.5" height="3.8" rx="1.9" transform="rotate(45 14.8 14.2)"/>
            </svg>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold">Evasion Stats</h1>
              <p className="text-sm text-muted-foreground">Error-type causation · TrustScore correlation · Reliability weighting · Timing CoV · Session noise · Subnet concurrency</p>
            </div>
            <button
              onClick={handleExport}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-border bg-background hover:bg-muted transition-colors"
              title="Export all evasion stats as a JSON file"
            >
              <Download className="w-3.5 h-3.5" />
              Export Evasion Stats
            </button>
          </div>

          {isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading analytics…</span></div>}

          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex border-b border-border overflow-x-auto">
              {TABS.map(tab => {
                const count = tab === "ban" ? banEntries.length : tab === "automated" ? automatedEntries.length : tab === "captcha" ? captchaEntries.length : tab === "locked" ? lockedEntries.length : tab === "survivors" ? survivingAccounts.length : -1;
                return (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`flex-1 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors whitespace-nowrap flex items-center justify-center gap-1.5 ${activeTab === tab ? "bg-muted text-foreground border-b-2 border-cyan-500" : "text-muted-foreground hover:text-foreground"}`}>
                    {tab === "survivors" && <Award className="w-3 h-3 text-green-500 shrink-0" />}
                    {TAB_LABELS[tab]}{count >= 0 && <span className="opacity-60">({count})</span>}
                  </button>
                );
              })}
            </div>
            <div className="p-4">
              {ERROR_TABS.includes(activeTab as ErrorTab) ? (
                (() => {
                  const errTab = activeTab as ErrorTab;
                  const primaryEntries = errTab === "ban" ? banEntries : errTab === "automated" ? automatedEntries : errTab === "captcha" ? captchaEntries : lockedEntries;
                  const currentInner = innerTabs[errTab];
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-md w-fit">
                          {(["data", "theories"] as InnerTab[]).map(it => (
                            <button key={it} onClick={() => setInnerTabs(prev => ({ ...prev, [errTab]: it }))}
                              className={`px-4 py-1.5 text-sm font-semibold rounded transition-colors flex items-center gap-1.5 ${currentInner === it ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                              {it === "theories" && <FlaskConical className="w-3.5 h-3.5 text-violet-500" />}
                              {it === "data" ? "Data" : "Theories"}
                            </button>
                          ))}
                        </div>
                        {currentInner === "data" && (() => {
                          const { neverRan, firstFollow, longRunner } = groupByFollowCount(primaryEntries);
                          const groupCfg: Array<{ key: GroupFilter; label: string; count: number; title: string }> = [
                            { key: "all",          label: "All",          count: primaryEntries.length, title: "All flagged accounts (averages may be misleading — groups are very different)" },
                            { key: "never-ran",    label: "Never Ran",    count: neverRan.length,       title: "0 follows — banned during Verify before any tool ran" },
                            { key: "first-follow", label: "First Follow", count: firstFollow.length,    title: "1–9 follows — banned very early in first run" },
                            { key: "long-runner",  label: "Long Runners", count: longRunner.length,     title: "10+ follows — ran for extended time before ban" },
                          ];
                          return (
                            <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-md w-fit">
                              {groupCfg.map(g => (
                                <button key={g.key} onClick={() => setGroupFilters(prev => ({ ...prev, [errTab]: g.key }))}
                                  title={g.title}
                                  className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${groupFilters[errTab] === g.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                                  {g.label} <span className="opacity-60">({g.count})</span>
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      {currentInner === "data" ? (() => {
                        const { neverRan, firstFollow, longRunner } = groupByFollowCount(primaryEntries);
                        const currentGroup = groupFilters[errTab];
                        const filteredEntries = currentGroup === "never-ran" ? neverRan
                          : currentGroup === "first-follow" ? firstFollow
                          : currentGroup === "long-runner" ? longRunner
                          : primaryEntries;
                        return (
                          <>
                            {currentGroup === "all" && primaryEntries.length > 0 && (
                              <div className="border border-border rounded-lg overflow-hidden">
                                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                                  <Layers className="w-4 h-4 text-cyan-500" />
                                  <span className="text-sm font-semibold">Sub-Population Breakdown</span>
                                  <span className="text-xs text-muted-foreground ml-auto">click a group to compute stats for that population only</span>
                                </div>
                                <div className="grid grid-cols-3 divide-x divide-border">
                                  {[
                                    { key: "never-ran" as GroupFilter,    label: "Never Ran",    count: neverRan.length,    desc: "0 follows — banned at Verify",       dot: "bg-slate-400",  color: "text-slate-500" },
                                    { key: "first-follow" as GroupFilter, label: "First Follow", count: firstFollow.length, desc: "1–9 follows — early first-run ban",   dot: "bg-amber-400",  color: "text-amber-600" },
                                    { key: "long-runner" as GroupFilter,  label: "Long Runners", count: longRunner.length,  desc: "10+ follows — ran for extended time", dot: "bg-cyan-400",   color: "text-cyan-600"  },
                                  ].map(g => (
                                    <button key={g.key} onClick={() => setGroupFilters(prev => ({ ...prev, [errTab]: g.key }))}
                                      className="p-4 text-left hover:bg-muted/30 transition-colors">
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className={`w-2 h-2 rounded-full shrink-0 ${g.dot}`} />
                                        <span className={`text-[10px] font-bold uppercase tracking-wide ${g.color}`}>{g.label}</span>
                                      </div>
                                      <p className="text-2xl font-bold">{g.count}</p>
                                      <p className="text-[10px] text-muted-foreground mt-0.5">{g.desc}</p>
                                    </button>
                                  ))}
                                </div>
                                <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/10 border-t border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-300">
                                  <strong>Viewing all {primaryEntries.length} accounts together.</strong> These three groups have very different session profiles — averaging them together makes the stats misleading. Click a group above to see accurate stats for that population only.
                                </div>
                              </div>
                            )}
                            {currentGroup !== "all" && (
                              <div className={`px-3 py-2 rounded-md text-[11px] flex items-center gap-2 ${currentGroup === "never-ran" ? "bg-slate-50 dark:bg-slate-900/20 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300" : currentGroup === "first-follow" ? "bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300" : "bg-cyan-50 dark:bg-cyan-900/10 border border-cyan-200 dark:border-cyan-800 text-cyan-700 dark:text-cyan-300"}`}>
                                <span className={`w-2 h-2 rounded-full shrink-0 ${currentGroup === "never-ran" ? "bg-slate-400" : currentGroup === "first-follow" ? "bg-amber-400" : "bg-cyan-400"}`} />
                                <span>
                                  {currentGroup === "never-ran" && <><strong>Never Ran</strong> — 0 follows. Banned during Verify before any automation tool ran. Stats reflect IP/login-rate risk, not session behaviour.</>}
                                  {currentGroup === "first-follow" && <><strong>First Follow</strong> — 1–9 follows. Banned very early in first run. Stats reflect cold-start and new-account policies.</>}
                                  {currentGroup === "long-runner" && <><strong>Long Runners</strong> — 10+ follows. Ran for extended time before ban. Stats reflect sustained session patterns and rate limits.</>}
                                </span>
                              </div>
                            )}
                            <EntryList entries={filteredEntries} cfg={TAB_CONFIG[errTab]} tabKey={errTab} profileMap={profileMap} trustMap={trustMap} profileNotesMap={profileNotesMap} survivingAccounts={survivingAccounts} />
                          </>
                        );
                      })() : (
                        <TheoriesTab forTab={errTab} primaryEntries={primaryEntries} banEntries={banEntries} automatedEntries={automatedEntries} captchaEntries={captchaEntries} lockedEntries={lockedEntries} />
                      )}
                    </div>
                  );
                })()
              ) : activeTab === "survivors" ? (
                survivingAccounts.length === 0 ? (
                  <div className="border border-border rounded-lg p-10 text-center"><Award className="w-8 h-8 text-muted-foreground mx-auto mb-2" /><p className="text-sm font-medium">No surviving accounts tracked yet</p><p className="text-xs text-muted-foreground mt-1">Valid accounts with an "Added:" timestamp in Notes will appear here.</p></div>
                ) : (() => {
                  // ── Compute comparison metrics ──────────────────────────────
                  const allBanAll = [...banEntries, ...automatedEntries, ...captchaEntries, ...lockedEntries];
                  const banMetrics = allBanAll.map(e => computeMetrics(filterHiker(parseEps(e.endpointSnapshot)), e.flaggedAt ?? e.bannedAt));
                  const survMetrics = survivorPatterns.map(p => computeMetrics(filterHiker(parseEps(p.endpointSnapshot)), p.capturedAt));

                  const bWarmup = banMetrics.map(m => m.preActionWarmup).filter(v => v >= 0);
                  const sWarmup = survMetrics.map(m => m.preActionWarmup).filter(v => v >= 0);
                  const bRatio  = banMetrics.filter(m => m.actionCount > 0).map(m => m.sessionPerAction);
                  const sRatio  = survMetrics.filter(m => m.actionCount > 0).map(m => m.sessionPerAction);
                  const bFollow = banMetrics.map(m => m.cats.follow ?? 0);
                  const sFollow = survMetrics.map(m => m.cats.follow ?? 0);
                  const bCoV    = banMetrics.map(m => m.timingCoV).filter(v => v >= 0);
                  const sCoV    = survMetrics.map(m => m.timingCoV).filter(v => v >= 0);
                  const bCalls  = banMetrics.map(m => m.uniqueEndpoints);
                  const sCalls  = survivorPatterns.map(p => p.endpointCount);

                  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
                  const fmt = (v: number | null, dp = 1) => v === null ? "—" : v.toFixed(dp);

                  const hasComparison = banMetrics.length > 0 && survMetrics.length > 0;
                  const hasPatterns   = survivorPatterns.length > 0;

                  // Pattern map for per-account lookup
                  const patternByUsername = new Map(survivorPatterns.map(p => [p.username, p]));

                  function CompareRow({ label, banVal, survVal, higherIsBetter }: { label: string; banVal: number | null; survVal: number | null; higherIsBetter: boolean }) {
                    const bv = banVal ?? 0; const sv = survVal ?? 0;
                    const survWins = higherIsBetter ? sv > bv * 1.1 : sv < bv * 0.9;
                    const banWins  = higherIsBetter ? bv > sv * 1.1 : bv < sv * 0.9;
                    return (
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-muted-foreground w-36 shrink-0">{label}</span>
                        <span className={`font-mono font-bold w-16 text-right ${banWins ? "text-red-500" : ""}`}>{fmt(banVal, label.includes("ratio") ? 2 : 1)}</span>
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden relative">
                          {banVal !== null && survVal !== null && (() => {
                            const maxV = Math.max(bv, sv, 0.001);
                            return <>
                              <div className="absolute top-0 left-0 h-full bg-red-400/60 rounded-full" style={{ width: `${Math.min(bv/maxV*100, 100)}%` }} />
                              <div className="absolute top-0 left-0 h-full bg-green-400/80 rounded-full" style={{ width: `${Math.min(sv/maxV*100, 100)}%`, opacity: 0.8 }} />
                            </>;
                          })()}
                        </div>
                        <span className={`font-mono font-bold w-16 text-left ${survWins ? "text-green-600" : ""}`}>{fmt(survVal, label.includes("ratio") ? 2 : 1)}</span>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      {/* ── Comparison Panel ── */}
                      {hasComparison && (
                        <div className="border border-border rounded-lg overflow-hidden">
                          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                            <Activity className="w-4 h-4 text-cyan-500" />
                            <span className="text-sm font-semibold">Survivors vs Flagged — Call Pattern Comparison</span>
                            <span className="text-xs text-muted-foreground ml-auto">{survMetrics.length} survivors · {banMetrics.length} flagged events</span>
                          </div>
                          <div className="px-4 py-3 space-y-2.5">
                            <div className="flex items-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1 gap-2">
                              <span className="w-36 shrink-0"></span>
                              <span className="w-16 text-right text-red-500">FLAGGED avg</span>
                              <div className="flex-1"></div>
                              <span className="w-16 text-left text-green-600">SURVIVOR avg</span>
                            </div>
                            <CompareRow label="Avg calls before each follow" banVal={avg(bWarmup)} survVal={avg(sWarmup)} higherIsBetter={false} />
                            <CompareRow label="Session/action ratio" banVal={avg(bRatio)} survVal={avg(sRatio)} higherIsBetter={true} />
                            <CompareRow label="Follow count" banVal={avg(bFollow)} survVal={avg(sFollow)} higherIsBetter={false} />
                            <CompareRow label="Timing CoV" banVal={avg(bCoV)} survVal={avg(sCoV)} higherIsBetter={true} />
                            <CompareRow label="Total calls" banVal={avg(bCalls)} survVal={avg(sCalls)} higherIsBetter={false} />
                            <p className="text-[10px] text-muted-foreground pt-1">Green = survivor advantage. Red = flagged accounts had more. Call patterns are read live from the API call log — they reflect all recent activity, not just at the time of flagging.</p>
                          </div>
                        </div>
                      )}
                      {!hasComparison && hasPatterns && (
                        <div className="border border-border rounded-lg px-4 py-3 text-[11px] text-muted-foreground">
                          No flagged accounts yet — comparison will appear once accounts have been flagged.
                        </div>
                      )}
                      {/* ── Survivor list with call metrics ── */}
                      <div className="border border-border rounded-lg overflow-hidden">
                        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                          <Award className="w-4 h-4 text-green-500" />
                          <span className="text-sm font-semibold">Surviving Accounts — Live Call Patterns</span>
                          <span className="text-xs text-muted-foreground ml-auto">Re-added accounts show timer since most recent add{survivorPatternsLoading ? " · loading patterns…" : ""}</span>
                        </div>
                        <div className="divide-y divide-border">
                          {survivingAccounts.map((p, i) => {
                            const reAdded = p.allDates.length > 1;
                            const ti = trustMap.get(p.id);
                            const rel = computeReliability(p.notes);
                            const sp = patternByUsername.get(p.username);
                            const sm = sp ? computeMetrics(filterHiker(parseEps(sp.endpointSnapshot)), sp.capturedAt) : null;
                            const spCovLabel = sm && sm.timingCoV >= 0 ? sm.timingCoV < 0.3 ? "ROBOTIC" : sm.timingCoV < 0.5 ? "LOW" : sm.timingCoV < 1.0 ? "MODERATE" : "HUMAN" : null;
                            const spCovColor = sm && sm.timingCoV >= 0 ? sm.timingCoV < 0.3 ? "text-red-500" : sm.timingCoV < 0.5 ? "text-amber-500" : "text-green-600" : "text-muted-foreground";
                            const top3 = sp ? topEps(filterHiker(parseEps(sp.endpointSnapshot)), 3) : [];
                            return (
                              <div key={p.id} className="px-4 py-3">
                                <div className="flex items-start gap-3">
                                  <span className="text-xs text-muted-foreground w-6 text-right shrink-0 font-bold mt-0.5">#{i + 1}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <UsernameLink username={p.username} profileMap={profileMap} />
                                      {ti && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ti.rank <= 4 ? "bg-red-50 border-red-200 text-red-600" : ti.rank <= 8 ? "bg-orange-50 border-orange-200 text-orange-600" : ti.rank <= 12 ? "bg-blue-50 border-blue-200 text-blue-500" : "bg-green-50 border-green-200 text-green-600"}`}>{ti.label} #{ti.rank}</span>}
                                      {reAdded && <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 border border-blue-300 dark:border-blue-700 font-semibold shrink-0"><RefreshCw className="w-2.5 h-2.5" /> re-added {p.allDates.length - 1}×{rel.reAddCount >= 2 ? " ⚠" : ""}</span>}
                                      {sp && <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">{sp.endpointCount} calls</span>}
                                      {sp && sp.accountAgeDays !== null && <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">age {sp.accountAgeDays}d</span>}
                                    </div>
                                    <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
                                      <span>First added: {p.firstDate!.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                                      {reAdded && <span>Latest: {p.allDates[p.allDates.length - 1].toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>}
                                    </div>
                                    {sm && (
                                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Avg calls before each follow</span><span className="font-mono font-semibold">{sm.preActionWarmup >= 0 ? sm.preActionWarmup : "—"}</span></div>
                                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Session/action</span><span className={`font-mono font-semibold ${sm.actionCount > 0 ? sm.sessionPerAction >= 3 ? "text-green-600" : sm.sessionPerAction >= 1 ? "text-amber-500" : "text-red-500" : "text-muted-foreground"}`}>{sm.actionCount > 0 ? sm.sessionPerAction.toFixed(2) : "—"}</span></div>
                                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Follow ops</span><span className={`font-mono font-semibold ${(sm.cats.follow ?? 0) === 0 ? "text-green-600" : (sm.cats.follow ?? 0) <= 3 ? "text-amber-500" : "text-red-500"}`}>{sm.cats.follow ?? 0}</span></div>
                                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Timing CoV</span><span className={`font-mono font-semibold ${spCovColor}`}>{sm.timingCoV >= 0 ? `${sm.timingCoV.toFixed(2)} [${spCovLabel}]` : "—"}</span></div>
                                        {sm.actionVelocityPerHour > 0 && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Action velocity</span><span className={`font-mono font-semibold ${sm.actionVelocityPerHour <= 20 ? "text-green-600" : sm.actionVelocityPerHour <= 40 ? "text-amber-500" : "text-red-500"}`}>{sm.actionVelocityPerHour.toFixed(1)}/hr</span></div>}
                                        {sm.burstCount > 0 && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Bursts (≤60s)</span><span className={`font-mono font-semibold ${sm.burstCount === 0 ? "text-green-600" : sm.burstCount <= 2 ? "text-amber-500" : "text-red-500"}`}>{sm.burstCount}</span></div>}
                                      </div>
                                    )}
                                    {top3.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-1.5">
                                        {top3.map(ep => <span key={ep.name} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono bg-muted text-muted-foreground">{ep.label ?? ep.name} <span className="opacity-60">×{ep.count}</span></span>)}
                                      </div>
                                    )}
                                    {!sp && survivorPatternsLoading && <p className="text-[10px] text-muted-foreground mt-1 italic">loading call patterns…</p>}
                                    {!sp && !survivorPatternsLoading && survivorPatterns.length > 0 && <p className="text-[10px] text-muted-foreground mt-1 italic">no recent API calls in log</p>}
                                  </div>
                                  <div className="shrink-0 text-right ml-2"><p className="text-base font-bold text-green-600 dark:text-green-400">{formatDuration(p.runMs!)}</p><p className="text-[10px] text-muted-foreground">since last add</p></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* TrustScore distribution for survivors */}
                        {survivingAccounts.some(a => trustMap.has((a as any).id)) && (() => {
                          const ranks = survivingAccounts.map(a => trustMap.get((a as any).id)?.rank ?? -1).filter(r => r >= 0);
                          const tiers = [
                            { label: "Rank 1–4", min: 1, max: 4, color: "bg-red-400" },
                            { label: "Rank 5–8", min: 5, max: 8, color: "bg-orange-400" },
                            { label: "Rank 9–12", min: 9, max: 12, color: "bg-blue-400" },
                            { label: "Rank 13+", min: 13, max: 99, color: "bg-green-400" },
                          ].map(t => ({ ...t, count: ranks.filter(r => r >= t.min && r <= t.max).length }));
                          return (
                            <div className="border-t border-border px-4 py-3">
                              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1"><Scale className="w-3 h-3" /> Survivor TrustScore Distribution — median rank {median(ranks).toFixed(1)}</p>
                              <MiniHistogram buckets={tiers} note="Higher rank = more trust leeway from Instagram. These are your safe operating levels." />
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })()
              ) : null}
            </div>
          </div>

          {(activeTab === "survivors" || innerTabs[activeTab as ErrorTab] === "data") && proxyRisks.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-500" />
                <span className="text-sm font-semibold">Proxy Risk Ranking</span>
                <span className="text-xs text-muted-foreground ml-auto">B/A/C/L + /24 subnet shown</span>
              </div>
              <div className="divide-y divide-border">
                {(showAllProxy ? proxyRisks : proxyRisks.slice(0, 3)).map((pr, i) => <ProxyRankRow key={pr.host} pr={pr} i={i} profileMap={profileMap} />)}
              </div>
              {proxyRisks.length > 3 && (
                <button onClick={() => setShowAllProxy(v => !v)} className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border transition-colors flex items-center justify-center gap-1">
                  {showAllProxy ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show {proxyRisks.length - 3} more</>}
                </button>
              )}
            </div>
          )}

          {(activeTab === "survivors" || innerTabs[activeTab as ErrorTab] === "data") && concurrencyAlerts.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-semibold">Concurrent Usage Alerts</span>
                <span className="text-xs text-muted-foreground ml-auto">timing based on last API call, not mark time</span>
              </div>
              <div className="divide-y divide-border">
                {(showAllAlerts ? concurrencyAlerts : concurrencyAlerts.slice(0, 3)).map((alert, i) => (
                  <div key={i} className="px-4 py-3 flex items-start gap-3">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2"><span className="text-sm font-mono">{alert.proxyHost}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{alert.category}</span></div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 flex-wrap">
                        <UsernameLink username={alert.accounts[0]} profileMap={profileMap} /><span>and</span><UsernameLink username={alert.accounts[1]} profileMap={profileMap} />
                        <span>— {alert.times[0] ? new Date(alert.times[0]).toLocaleTimeString() : "?"} &amp; {alert.times[1] ? new Date(alert.times[1]).toLocaleTimeString() : "?"}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              {concurrencyAlerts.length > 3 && (
                <button onClick={() => setShowAllAlerts(v => !v)} className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border transition-colors flex items-center justify-center gap-1">
                  {showAllAlerts ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show {concurrencyAlerts.length - 3} more</>}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
