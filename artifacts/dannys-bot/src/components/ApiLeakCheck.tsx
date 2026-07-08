import { useState, useCallback } from "react";
import { Shield, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "warn" | "na" | "info";

interface CheckResult {
  title: string;
  status: CheckStatus;
  label: string;
  detail: Record<string, unknown> | null;
}

interface ApiLeakCheckResponse {
  profileId: number;
  username: string | null;
  checkedAt: string;
  proxyConfigured: boolean;
  proxy: string | null;
  checks: {
    ip:        CheckResult;
    headers:   CheckResult;
    tls:       CheckResult;
    deviceIds: CheckResult;
  };
}

// ── Status helpers ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: CheckStatus }) {
  switch (status) {
    case "pass": return <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />;
    case "fail": return <XCircle      className="h-4 w-4 text-red-600 shrink-0" />;
    case "warn": return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    default:     return <Info          className="h-4 w-4 text-slate-400 shrink-0" />;
  }
}

function statusBg(status: CheckStatus) {
  switch (status) {
    case "pass": return "bg-green-50 border-green-200";
    case "fail": return "bg-red-50 border-red-200";
    case "warn": return "bg-amber-50 border-amber-200";
    default:     return "bg-slate-50 border-slate-200";
  }
}

function statusText(status: CheckStatus) {
  switch (status) {
    case "pass": return "text-green-700";
    case "fail": return "text-red-700";
    case "warn": return "text-amber-700";
    default:     return "text-slate-600";
  }
}

function statusPill(status: CheckStatus) {
  switch (status) {
    case "pass": return "bg-green-100 text-green-800 border border-green-300";
    case "fail": return "bg-red-100 text-red-800 border border-red-300";
    case "warn": return "bg-amber-100 text-amber-800 border border-amber-300";
    default:     return "bg-slate-100 text-slate-600 border border-slate-300";
  }
}

function overallStatus(checks: ApiLeakCheckResponse["checks"]): CheckStatus {
  const statuses = Object.values(checks).map(c => c.status);
  if (statuses.some(s => s === "fail")) return "fail";
  if (statuses.some(s => s === "warn")) return "warn";
  if (statuses.every(s => s === "pass")) return "pass";
  return "na";
}

// ── Detail viewer ────────────────────────────────────────────────────────────

function DetailRow({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    return (
      <div className="col-span-2">
        <span className="text-slate-500 text-xs font-medium">{k}</span>
        <div className="mt-1 pl-2 border-l-2 border-slate-200 space-y-1">
          {Object.entries(v as Record<string, unknown>).map(([kk, vv]) => (
            <DetailRow key={kk} k={kk} v={vv} />
          ))}
        </div>
      </div>
    );
  }
  if (Array.isArray(v)) {
    return (
      <div className="col-span-2">
        <span className="text-slate-500 text-xs font-medium">{k}</span>
        <div className="text-xs text-slate-700 mt-0.5">{(v as unknown[]).map(String).join(", ") || "(empty)"}</div>
      </div>
    );
  }
  return (
    <>
      <span className="text-slate-500 text-xs font-medium self-start">{k}</span>
      <span className="text-xs text-slate-800 font-mono break-all">{String(v)}</span>
    </>
  );
}

// ── Check Card ───────────────────────────────────────────────────────────────

function CheckCard({ check }: { check: CheckResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = check.detail && Object.keys(check.detail).length > 0;

  return (
    <div className={`rounded-xl border p-4 ${statusBg(check.status)}`}>
      <div className="flex items-start gap-3">
        <StatusIcon status={check.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-semibold text-sm text-slate-800">{check.title}</span>
            <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${statusPill(check.status)}`}>
              {check.status}
            </span>
          </div>
          <p className={`text-sm mt-1 ${statusText(check.status)}`}>{check.label}</p>
          {hasDetail && (
            <button
              onClick={() => setOpen(o => !o)}
              className="mt-2 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {open ? "Hide details" : "Show details"}
            </button>
          )}
          {open && check.detail && (
            <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 bg-white/70 rounded-lg p-3 border border-white">
              {Object.entries(check.detail).map(([k, v]) => (
                <DetailRow key={k} k={k} v={v} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ApiLeakCheck({ profileId }: { profileId: number }) {
  const [result, setResult]   = useState<ApiLeakCheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg]   = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/api-leak-check`, { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrMsg((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(body as ApiLeakCheckResponse);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  const overall = result ? overallStatus(result.checks) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Shield className="h-5 w-5 text-slate-600" />
            API Leak Check
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Verifies proxy routing, header geo-consistency, TLS fingerprint, and device ID integrity for mobile API calls — no browser required.
          </p>
        </div>
        <Button onClick={run} disabled={loading} className="shrink-0">
          {loading
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
            : <><RefreshCw className="h-4 w-4 mr-2" />{result ? "Re-run" : "Run Checks"}</>
          }
        </Button>
      </div>

      {/* Idle */}
      {!result && !loading && !errMsg && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center">
          <Shield className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">Ready to check</p>
          <p className="text-slate-400 text-xs mt-2 max-w-sm mx-auto">
            Click <strong>Run Checks</strong> to probe this account's API traffic integrity — proxy IP, header consistency, TLS fingerprint, and device IDs.
          </p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
          <Loader2 className="h-8 w-8 text-primary animate-spin mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">Running checks…</p>
          <p className="text-slate-400 text-xs mt-1">Sending probe through proxy + geo lookup (may take up to 15s)</p>
        </div>
      )}

      {/* Error */}
      {errMsg && !loading && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 flex items-start gap-3">
          <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Check failed</p>
            <p className="text-sm text-red-700 mt-0.5">{errMsg}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className={`rounded-xl border p-4 flex items-center justify-between gap-4 flex-wrap ${statusBg(overall!)}`}>
            <div className="flex items-center gap-3">
              <StatusIcon status={overall!} />
              <div>
                <p className="font-semibold text-sm text-slate-800">
                  Overall:{" "}
                  <span className={statusText(overall!)}>
                    {overall === "pass" ? "All checks passed" : overall === "fail" ? "Issues detected" : overall === "warn" ? "Warnings present" : "Incomplete"}
                  </span>
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(result.checkedAt).toLocaleTimeString()} · {result.proxy ?? "no proxy"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {Object.values(result.checks).map(c => (
                <span key={c.title} className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${statusPill(c.status)}`}>
                  {c.title}: {c.status.toUpperCase()}
                </span>
              ))}
            </div>
          </div>

          {/* Check cards — 2-column grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.values(result.checks).map(check => (
              <CheckCard key={check.title} check={check} />
            ))}
          </div>

          {/* Legend */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">What each check covers</p>
            <ul className="space-y-1.5 text-xs text-slate-500">
              <li><span className="font-medium text-slate-700">Proxy IP</span> — sends a live request through your proxy to an IP-echo service; confirms the exit IP isn't leaking through the server's real IP</li>
              <li><span className="font-medium text-slate-700">Header Consistency</span> — geo-resolves the proxy exit IP and verifies Accept-Language, X-IG-App-Locale, and X-IG-Timezone-Offset match the proxy's country — mismatches are a detectable bot signal</li>
              <li><span className="font-medium text-slate-700">TLS / JA3</span> — confirms CycleTLS (OkHttp4 Android JA3) is active; if missing, API calls expose a plain OpenSSL fingerprint that Instagram flags as a bot</li>
              <li><span className="font-medium text-slate-700">Device IDs</span> — validates uuid, phone_id, device_id, and igDid are properly-formatted, unique UUIDs — malformed or duplicate IDs signal automation</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
