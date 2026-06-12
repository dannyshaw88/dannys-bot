import { useQuery } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useState } from "react";
import { Loader2, BarChart2, Calendar, Globe, AlertTriangle, Shield, Clock } from "lucide-react";
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
  total: number;
  accounts: string[];
}

interface ConcurrencyAlert {
  proxyHost: string;
  accounts: string[];
  times: string[];
  category: string;
}

function parseEndpoints(snapshot: string): { operationName: string; date: string }[] {
  try { return JSON.parse(snapshot) ?? []; } catch { return []; }
}

function getCallRate(snapshot: string): string {
  const eps = parseEndpoints(snapshot);
  if (eps.length < 2) return "—";
  const dates = eps.map(e => new Date(e.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  if (dates.length < 2) return "—";
  const spanMs = dates[dates.length - 1] - dates[0];
  if (spanMs <= 0) return "—";
  const perMin = (eps.length / (spanMs / 60000)).toFixed(1);
  return `${perMin}/min`;
}

function topEndpoints(entries: AnalyticsEntry[], accent: string): EndpointFreq[] {
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

type Tab = "ban" | "automated" | "captcha";

const TAB_CONFIG: Record<Tab, { label: string; accentClass: string; accentBg: string; barColor: string; emptyMsg: string; flagMsg: string }> = {
  ban:       { label: "Ban Events",             accentClass: "text-red-500",    accentBg: "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",       barColor: "bg-red-400",    emptyMsg: "No ban analytics yet",              flagMsg: "Flag accounts as Banned from Accounts → Actions → Flag as Banned." },
  automated: { label: "Automated Behaviour",    accentClass: "text-orange-500", accentBg: "bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800", barColor: "bg-orange-400", emptyMsg: "No automated behaviour events yet", flagMsg: "Flag accounts from Accounts → Actions → Flag as Automated Behaviour." },
  captcha:   { label: "Captcha Errors",         accentClass: "text-yellow-500", accentBg: "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800", barColor: "bg-yellow-400", emptyMsg: "No captcha events yet",             flagMsg: "Flag accounts from Accounts → Actions → Flag as Captcha Error." },
};

function EntryList({ entries, cfg }: { entries: AnalyticsEntry[]; cfg: typeof TAB_CONFIG[Tab] }) {
  if (entries.length === 0) return (
    <div className="border border-border rounded-lg p-10 text-center mt-4">
      <p className="text-sm font-medium">{cfg.emptyMsg}</p>
      <p className="text-xs text-muted-foreground mt-1">{cfg.flagMsg}</p>
    </div>
  );

  const tops = topEndpoints(entries, cfg.accentClass);
  const totalHits = tops.reduce((a, b) => a + b.count, 0);

  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Events</p>
          <p className="text-3xl font-bold mt-1">{entries.length}</p>
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

      {tops.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-cyan-500" />
            <span className="text-sm font-semibold">Top Endpoints Called Before Event</span>
          </div>
          <div className="divide-y divide-border">
            {tops.map((ep, i) => (
              <div key={ep.operationName} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-6 text-right shrink-0">#{i + 1}</span>
                <span className="text-sm font-mono flex-1 truncate">{ep.operationName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full ${cfg.barColor} rounded-full`} style={{ width: `${ep.pct}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-12 text-right">{ep.count.toLocaleString()}x</span>
                  <span className="text-xs text-muted-foreground w-8 text-right">{ep.pct}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-500" />
          <span className="text-sm font-semibold">Event History</span>
        </div>
        <div className="divide-y divide-border">
          {[...entries].reverse().map(entry => {
            const eps = parseEndpoints(entry.endpointSnapshot);
            const topEps = Array.from(
              eps.reduce((m, e) => { m.set(e.operationName, (m.get(e.operationName) ?? 0) + 1); return m; }, new Map<string, number>())
            ).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const ts = entry.flaggedAt ?? entry.bannedAt ?? "";
            return (
              <div key={entry.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">@{entry.username}</span>
                      {entry.proxyHost && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Globe className="w-3 h-3" />{entry.proxyHost}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <p className="text-[11px] text-muted-foreground">{entry.endpointCount} API calls · {ts ? new Date(ts).toLocaleString() : "—"}</p>
                      {entry.endpointSnapshot && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Clock className="w-3 h-3" />avg {getCallRate(entry.endpointSnapshot)}
                        </span>
                      )}
                    </div>
                    {topEps.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {topEps.map(([name, cnt]) => (
                          <span key={name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${cfg.accentBg}`}>
                            {name} <span className="opacity-60">×{cnt}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function buildProxyRiskMap(
  bans: AnalyticsEntry[],
  automated: AnalyticsEntry[],
  captcha: AnalyticsEntry[],
): ProxyRisk[] {
  const map = new Map<string, ProxyRisk>();
  const add = (entries: AnalyticsEntry[], key: keyof Pick<ProxyRisk, "banCount" | "automatedCount" | "captchaCount">) => {
    for (const e of entries) {
      const host = e.proxyHost || "(no proxy)";
      if (!map.has(host)) map.set(host, { host, banCount: 0, automatedCount: 0, captchaCount: 0, total: 0, accounts: [] });
      const r = map.get(host)!;
      r[key]++;
      r.total++;
      if (!r.accounts.includes(e.username)) r.accounts.push(e.username);
    }
  };
  add(bans, "banCount");
  add(automated, "automatedCount");
  add(captcha, "captchaCount");
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function buildConcurrencyAlerts(
  bans: AnalyticsEntry[],
  automated: AnalyticsEntry[],
  captcha: AnalyticsEntry[],
): ConcurrencyAlert[] {
  const alerts: ConcurrencyAlert[] = [];
  const groups: { entries: AnalyticsEntry[]; label: string }[] = [
    { entries: bans, label: "Ban" },
    { entries: automated, label: "Automated" },
    { entries: captcha, label: "Captcha" },
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

  const isLoading = banLoading || autoLoading || captchaLoading;
  const proxyRisks = buildProxyRiskMap(banEntries, automatedEntries, captchaEntries);
  const concurrencyAlerts = buildConcurrencyAlerts(banEntries, automatedEntries, captchaEntries);
  const cfg = TAB_CONFIG[activeTab];
  const activeEntries = activeTab === "ban" ? banEntries : activeTab === "automated" ? automatedEntries : captchaEntries;

  const TABS: Tab[] = ["ban", "automated", "captcha"];

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
              <p className="text-sm text-muted-foreground">Ban, automated-behaviour, and captcha patterns with IP and timing intelligence</p>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading analytics…</span>
            </div>
          )}

          {/* ── Summary row ── */}
          {!isLoading && (
            <div className="grid grid-cols-3 gap-3">
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
            </div>
          )}

          {/* ── Proxy risk table ── */}
          {proxyRisks.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Shield className="w-4 h-4 text-cyan-500" />
                <span className="text-sm font-semibold">Proxy Risk Ranking</span>
                <span className="text-xs text-muted-foreground ml-auto">Ban / Automated / Captcha events per IP</span>
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
                      <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">{pr.total} total</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Concurrency alerts ── */}
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

          {/* ── Tabs ── */}
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
                    ({tab === "ban" ? banEntries.length : tab === "automated" ? automatedEntries.length : captchaEntries.length})
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
