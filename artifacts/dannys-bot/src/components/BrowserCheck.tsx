import { useState, useCallback } from "react";
import { Monitor, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info,
         ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────

type BcStatus = "pass" | "fail" | "warn" | "info";

interface BcCheck {
  title:  string;
  status: BcStatus;
  label:  string;
  detail: Record<string, unknown>;
}

interface BrowserCheckResponse {
  open:      boolean;
  url?:      string;
  profileId?: number;
  checkedAt: string;
  error?:    string;
  checks:    Record<string, BcCheck> | null;
  raw?:      Record<string, unknown>;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: BcStatus }) {
  switch (status) {
    case "pass": return <CheckCircle2  className="h-4 w-4 text-green-600 shrink-0" />;
    case "fail": return <XCircle       className="h-4 w-4 text-red-600 shrink-0" />;
    case "warn": return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    default:     return <Info          className="h-4 w-4 text-slate-400 shrink-0" />;
  }
}

function statusBg(s: BcStatus) {
  switch (s) {
    case "pass": return "bg-green-50 border-green-200";
    case "fail": return "bg-red-50 border-red-200";
    case "warn": return "bg-amber-50 border-amber-200";
    default:     return "bg-slate-50 border-slate-200";
  }
}

function statusText(s: BcStatus) {
  switch (s) {
    case "pass": return "text-green-700";
    case "fail": return "text-red-700";
    case "warn": return "text-amber-700";
    default:     return "text-slate-600";
  }
}

function statusPill(s: BcStatus) {
  switch (s) {
    case "pass": return "bg-green-100 text-green-800 border border-green-300";
    case "fail": return "bg-red-100 text-red-800 border border-red-300";
    case "warn": return "bg-amber-100 text-amber-800 border border-amber-300";
    default:     return "bg-slate-100 text-slate-600 border border-slate-300";
  }
}

function overallStatus(checks: Record<string, BcCheck>): BcStatus {
  const ss = Object.values(checks).map(c => c.status);
  if (ss.some(s => s === "fail")) return "fail";
  if (ss.some(s => s === "warn")) return "warn";
  if (ss.every(s => s === "pass" || s === "info")) return "pass";
  return "info";
}

// ── Detail viewer ─────────────────────────────────────────────────────────────

function DetailRow({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    return (
      <>
        <span className="text-slate-500 text-xs font-medium self-start">{k}</span>
        <span className="text-xs text-slate-700 font-mono">{(v as unknown[]).map(String).join(", ") || "(empty)"}</span>
      </>
    );
  }
  if (typeof v === "object") {
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
  return (
    <>
      <span className="text-slate-500 text-xs font-medium self-start">{k}</span>
      <span className="text-xs text-slate-800 font-mono break-all">{String(v)}</span>
    </>
  );
}

// ── Check Card ────────────────────────────────────────────────────────────────

function BcCard({ check }: { check: BcCheck }) {
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

// ── Main Component ────────────────────────────────────────────────────────────

export function BrowserCheck({ profileId }: { profileId: number }) {
  const [result,  setResult]  = useState<BrowserCheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg,  setErrMsg]  = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res  = await fetch(`/api/profiles/${profileId}/browser-check`, { credentials: "include" });
      const body = await res.json().catch(() => ({})) as BrowserCheckResponse;
      if (!res.ok) { setErrMsg((body as any).error ?? `HTTP ${res.status}`); return; }
      setResult(body);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  const overall = result?.checks ? overallStatus(result.checks) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Monitor className="h-5 w-5 text-slate-600" />
            Browser Fingerprint Check
          </h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Runs inside the live EB window via JavaScript — captures what Instagram's login page
            actually sees: Electron leak flags, touch emulation, platform spoof, WebGL renderer,
            Chrome object integrity.{" "}
            <strong>The browser for this account must be open to run this check.</strong>
          </p>
        </div>
        <Button onClick={run} disabled={loading} className="shrink-0">
          {loading
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
            : <><RefreshCw className="h-4 w-4 mr-2" />{result ? "Re-run" : "Run Browser Check"}</>}
        </Button>
      </div>

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

      {/* Loading */}
      {loading && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
          <Loader2 className="h-8 w-8 text-primary animate-spin mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">Running checks inside EB window…</p>
          <p className="text-slate-400 text-xs mt-1">Executing JS in the live browser session</p>
        </div>
      )}

      {/* Idle */}
      {!result && !loading && !errMsg && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center">
          <Monitor className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">Open the browser for this account, then click Run</p>
          <p className="text-slate-400 text-xs mt-2 max-w-sm mx-auto">
            This check executes JavaScript <em>inside</em> the Electron browser window —
            it reads the signals Instagram's login page evaluates in real time.
          </p>
        </div>
      )}

      {/* Window not open */}
      {result && !result.open && !loading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">EB window not open</p>
            <p className="text-sm text-amber-700 mt-0.5">
              {result.error ?? "Open the browser for this account, then re-run the check."}
            </p>
          </div>
        </div>
      )}

      {/* Results */}
      {result?.open && result.checks && !loading && (
        <div className="space-y-4">
          {/* URL context */}
          {result.url && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 flex items-center gap-2 text-xs text-slate-500">
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span>Browser currently on:</span>
              <code className="font-mono text-slate-700 break-all">{result.url}</code>
            </div>
          )}

          {/* Summary bar */}
          <div className={`rounded-xl border p-4 flex items-center justify-between gap-4 flex-wrap ${statusBg(overall!)}`}>
            <div className="flex items-center gap-3">
              <StatusIcon status={overall!} />
              <div>
                <p className="font-semibold text-sm text-slate-800">
                  Overall:{" "}
                  <span className={statusText(overall!)}>
                    {overall === "pass" ? "All checks passed"
                     : overall === "fail" ? "Issues detected — ban risk"
                     : overall === "warn" ? "Warnings present"
                     : "Incomplete"}
                  </span>
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(result.checkedAt).toLocaleTimeString()}
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

          {/* Check cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.values(result.checks).map(c => (
              <BcCard key={c.title} check={c} />
            ))}
          </div>

          {/* Legend */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">What each check covers</p>
            <ul className="space-y-1.5 text-xs text-slate-500">
              <li><span className="font-medium text-slate-700">Electron Leak</span> — checks if <code className="bg-slate-100 px-0.5 rounded">window.process</code>, <code className="bg-slate-100 px-0.5 rounded">window.require</code>, <code className="bg-slate-100 px-0.5 rounded">navigator.webdriver</code> are exposed — Instagram's login JS probes these to detect Electron</li>
              <li><span className="font-medium text-slate-700">Touch Emulation</span> — <code className="bg-slate-100 px-0.5 rounded">maxTouchPoints</code> must be &gt; 0 for a mobile UA; 0 = touch emulation not applied = login events typed as keyboard, not taps</li>
              <li><span className="font-medium text-slate-700">Platform Spoof</span> — <code className="bg-slate-100 px-0.5 rounded">navigator.platform</code> must be Linux-based for Android UA; "Win32" contradicts the mobile claim</li>
              <li><span className="font-medium text-slate-700">Chrome Object</span> — <code className="bg-slate-100 px-0.5 rounded">window.chrome</code> and <code className="bg-slate-100 px-0.5 rounded">chrome.runtime</code> must exist and be structured like real Chrome</li>
              <li><span className="font-medium text-slate-700">WebGL Renderer</span> — software renderers (SwiftShader, Mesa, LLVM) flag as VM or headless to Instagram's fingerprinting</li>
              <li><span className="font-medium text-slate-700">Canvas Noise</span> — the canvas data URL snip; compare across two open account windows — they should differ if noise injection is working</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
