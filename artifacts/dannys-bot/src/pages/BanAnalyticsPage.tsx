import { useQuery } from "@tanstack/react-query";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useEffect } from "react";
import { Loader2, ShieldOff, BarChart2, Calendar, Globe } from "lucide-react";

interface BanEntry {
  id: number;
  username: string;
  proxyHost: string;
  bannedAt: string;
  endpointCount: number;
  endpointSnapshot: string;
}

interface EndpointFreq {
  operationName: string;
  count: number;
  pct: number;
}

function parseEndpoints(snapshot: string): { operationName: string; date: string }[] {
  try { return JSON.parse(snapshot) ?? []; } catch { return []; }
}

export function BanAnalyticsPage() {
  const setSidebarSlot = useSidebarSetSlot();
  useEffect(() => { setSidebarSlot(null); return () => setSidebarSlot(null); }, []);

  const { data: entries = [], isLoading } = useQuery<BanEntry[]>({
    queryKey: ["/api/analytics/ban-patterns"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/ban-patterns", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ban analytics");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const endpointMap = new Map<string, number>();
  for (const entry of entries) {
    for (const ep of parseEndpoints(entry.endpointSnapshot)) {
      endpointMap.set(ep.operationName, (endpointMap.get(ep.operationName) ?? 0) + 1);
    }
  }
  const totalEndpointHits = Array.from(endpointMap.values()).reduce((a, b) => a + b, 0);
  const topEndpoints: EndpointFreq[] = Array.from(endpointMap.entries())
    .map(([operationName, count]) => ({ operationName, count, pct: totalEndpointHits ? Math.round(count / totalEndpointHits * 100) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  return (
    <div className="ml-[133px] min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <ShieldOff className="w-6 h-6 text-red-500" />
          <div>
            <h1 className="text-xl font-bold">Ban Analytics</h1>
            <p className="text-sm text-muted-foreground">Endpoint patterns captured when accounts were flagged as banned</p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading analytics…</span>
          </div>
        )}

        {!isLoading && entries.length === 0 && (
          <div className="border border-border rounded-lg p-10 text-center">
            <ShieldOff className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium">No ban analytics yet</p>
            <p className="text-xs text-muted-foreground mt-1">Flag accounts as banned from Accounts → Actions → Flag as Banned to start collecting data.</p>
          </div>
        )}

        {entries.length > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Banned Accounts</p>
              <p className="text-3xl font-bold mt-1">{entries.length}</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Total Endpoints Logged</p>
              <p className="text-3xl font-bold mt-1">{totalEndpointHits.toLocaleString()}</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Unique Endpoints</p>
              <p className="text-3xl font-bold mt-1">{endpointMap.size}</p>
            </div>
          </div>
        )}

        {topEndpoints.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-cyan-500" />
              <span className="text-sm font-semibold">Top Endpoints Called Before Bans</span>
            </div>
            <div className="divide-y divide-border">
              {topEndpoints.map((ep, i) => (
                <div key={ep.operationName} className="px-4 py-2.5 flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-6 text-right shrink-0">#{i + 1}</span>
                  <span className="text-sm font-mono flex-1 truncate">{ep.operationName}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-red-400 rounded-full" style={{ width: `${ep.pct}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">{ep.count.toLocaleString()}x</span>
                    <span className="text-xs text-muted-foreground w-8 text-right">{ep.pct}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {entries.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Calendar className="w-4 h-4 text-cyan-500" />
              <span className="text-sm font-semibold">Banned Account History</span>
            </div>
            <div className="divide-y divide-border">
              {[...entries].reverse().map(entry => {
                const eps = parseEndpoints(entry.endpointSnapshot);
                const topEps = Array.from(
                  eps.reduce((m, e) => { m.set(e.operationName, (m.get(e.operationName) ?? 0) + 1); return m; }, new Map<string, number>())
                ).sort((a, b) => b[1] - a[1]).slice(0, 5);
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
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {entry.endpointCount} API calls recorded · {new Date(entry.bannedAt).toLocaleString()}
                        </p>
                        {topEps.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {topEps.map(([name, cnt]) => (
                              <span key={name} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 font-mono">
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
        )}
      </div>
    </div>
  );
}
