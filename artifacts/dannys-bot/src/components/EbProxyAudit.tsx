import { useState, useCallback } from "react";
import { RefreshCw, Shield, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EbIpAuditResult {
  profileId: number;
  username: string;
  serverIp: string;
  exitIp: string;
  proxy: string | null;
  proxyHost: string | null;
  leaking: boolean;
  checkedAt: string;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function EbProxyAudit() {
  const [audits, setAudits]   = useState<EbIpAuditResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/eb-ip-audits", { credentials: "include" });
      const data = await res.json() as { audits?: EbIpAuditResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAudits(data.audits ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Detect shared exit IPs (multiple accounts using the same proxy exit IP)
  const ipGroups = audits.reduce<Record<string, EbIpAuditResult[]>>((acc, a) => {
    const ip = a.exitIp;
    if (ip && !ip.startsWith("FETCH-FAILED") && ip !== "unknown") {
      acc[ip] = [...(acc[ip] ?? []), a];
    }
    return acc;
  }, {});
  const sharedIps  = new Set(Object.entries(ipGroups).filter(([, v]) => v.length > 1).map(([k]) => k));
  const leakCount  = audits.filter(a => a.leaking).length;
  const sharedCount = audits.filter(a => sharedIps.has(a.exitIp)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Shield className="h-5 w-5 text-slate-600" />
            EB Session Proxy Audit
          </h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Confirms the <strong>actual exit IP</strong> each open browser session uses — fetched through
            the Electron session proxy, before Instagram sees any traffic. Proves whether the proxy is routing
            correctly and flags shared IPs (multiple accounts on the same exit IP = ban risk even with a working proxy).
          </p>
        </div>
        <Button onClick={load} disabled={loading} className="shrink-0">
          {loading
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Loading…</>
            : <><RefreshCw className="h-4 w-4 mr-2" />{audits.length ? "Refresh" : "Load Audits"}</>}
        </Button>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex gap-2 items-start">
          <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Failed to load audits</p>
            <p className="text-sm text-red-700 mt-0.5">{error}</p>
            {error.includes("not in Electron") && (
              <p className="text-xs text-red-600 mt-1">
                Audit data is only available in the Electron desktop app — not when running the dev server on Replit.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Idle */}
      {audits.length === 0 && !loading && !error && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center">
          <Shield className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">No audit data yet</p>
          <p className="text-slate-400 text-xs mt-2 max-w-sm mx-auto">
            Audit results are captured automatically every time an EB session opens. Open some account browsers,
            then click <strong>Load Audits</strong> to see their exit IPs.
          </p>
          <p className="text-slate-400 text-xs mt-1">
            Results also appear in <code className="bg-slate-100 px-1 py-0.5 rounded text-[10px]">equinox-debug.log</code> immediately
            — search for <code className="bg-slate-100 px-1 py-0.5 rounded text-[10px]">EB-IP-AUDIT</code>.
          </p>
        </div>
      )}

      {/* Results */}
      {audits.length > 0 && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className={`rounded-xl border p-4 ${leakCount > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">IP Leaks</p>
              <p className={`text-3xl font-bold mt-1 ${leakCount > 0 ? "text-red-700" : "text-green-700"}`}>{leakCount}</p>
              <p className="text-xs text-slate-500 mt-0.5">sessions routing via server real IP</p>
            </div>
            <div className={`rounded-xl border p-4 ${sharedCount > 0 ? "bg-amber-50 border-amber-200" : "bg-green-50 border-green-200"}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shared Exit IPs</p>
              <p className={`text-3xl font-bold mt-1 ${sharedCount > 0 ? "text-amber-700" : "text-green-700"}`}>{sharedCount}</p>
              <p className="text-xs text-slate-500 mt-0.5">accounts competing for same proxy IP</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sessions Audited</p>
              <p className="text-3xl font-bold mt-1 text-slate-700">{audits.length}</p>
              <p className="text-xs text-slate-500 mt-0.5">total EB sessions since last app start</p>
            </div>
          </div>

          {/* Leak alert */}
          {leakCount > 0 && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4 flex gap-3">
              <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-bold text-red-900">⚠ Proxy not routing — server real IP exposed to Instagram</p>
                <p className="text-red-700 mt-1">
                  The browser exit IP matches the server's real IP for {leakCount} session(s). The proxy is NOT routing these accounts.
                  Instagram sees your server's IP on every request — account flagged immediately.
                </p>
                <p className="text-red-700 mt-1">
                  <strong>Fix:</strong> Close the browser, verify the proxy is reachable (try it in the Proxies list), then reopen. Check <code className="bg-red-100 px-1 rounded text-[11px]">equinox-debug.log</code> for the <code className="bg-red-100 px-1 rounded text-[11px]">[EB-IP-AUDIT]</code> line for the exact failure detail.
                </p>
              </div>
            </div>
          )}

          {/* Shared IP alert */}
          {sharedCount > 0 && leakCount === 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-bold text-amber-900">Multiple accounts sharing the same exit IP</p>
                <p className="text-amber-700 mt-1">
                  Instagram limits ~3 new account logins per IP per 6 hours. Accounts highlighted in amber are
                  competing for that limit — even with a correctly routing proxy, logging in too many accounts through
                  the same exit IP in a short window triggers bans. Assign separate proxies to these accounts.
                </p>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Account</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Proxy Configured</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Server Real IP</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Browser Exit IP</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Result</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {audits.map(a => {
                  const isShared  = sharedIps.has(a.exitIp);
                  const fetchFailed = a.exitIp.startsWith("FETCH-FAILED") || a.exitIp === "unknown";
                  const rowBg = a.leaking
                    ? "bg-red-50 hover:bg-red-100"
                    : isShared
                    ? "bg-amber-50 hover:bg-amber-100"
                    : "hover:bg-slate-50";
                  return (
                    <tr key={a.profileId} className={`transition-colors ${rowBg}`}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-800">@{a.username || `#${a.profileId}`}</div>
                        <div className="text-[11px] text-slate-400">id {a.profileId}</div>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-[11px] text-slate-600 font-mono break-all">{a.proxy ?? <span className="text-red-600 font-semibold">none</span>}</code>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-[11px] font-mono text-slate-600">{a.serverIp}</code>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className={`text-[11px] font-mono ${a.leaking ? "text-red-700 font-bold" : isShared ? "text-amber-700 font-semibold" : fetchFailed ? "text-slate-400 italic" : "text-slate-700"}`}>
                            {a.exitIp}
                          </code>
                          {isShared && !a.leaking && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                              SHARED ({ipGroups[a.exitIp]?.length} accounts)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {a.leaking ? (
                          <div className="flex items-center gap-1.5 text-red-700">
                            <XCircle className="h-4 w-4 shrink-0" />
                            <span className="text-xs font-bold uppercase">LEAK</span>
                          </div>
                        ) : isShared ? (
                          <div className="flex items-center gap-1.5 text-amber-700">
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span className="text-xs font-semibold">SHARED IP</span>
                          </div>
                        ) : fetchFailed ? (
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span className="text-xs">check failed</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-green-700">
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                            <span className="text-xs font-semibold">OK</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[11px] text-slate-400">
                          {new Date(a.checkedAt).toLocaleTimeString()}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">How this works</p>
            <ul className="space-y-1 text-xs text-slate-500">
              <li><span className="font-medium text-slate-700">Server Real IP</span> — fetched via a direct Node.js HTTPS request (bypasses all proxies) — this is what Instagram sees if a proxy fails</li>
              <li><span className="font-medium text-slate-700">Browser Exit IP</span> — fetched via <code className="bg-slate-100 px-0.5 rounded">ses.fetch()</code> scoped to the Electron session — routes through the configured proxy</li>
              <li><span className="font-medium text-slate-700">LEAK</span> — both IPs are identical → the proxy is not routing the session → Instagram sees the server's real IP</li>
              <li><span className="font-medium text-slate-700">SHARED IP</span> — multiple accounts have the same exit IP → they compete for Instagram's per-IP new-login quota</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
