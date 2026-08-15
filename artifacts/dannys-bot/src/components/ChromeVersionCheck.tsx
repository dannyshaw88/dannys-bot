import { useState, useCallback } from "react";
import { Chrome, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info,
         ChevronDown, ChevronUp, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────

type CvStatus = "pass" | "warn" | "fail" | "info";

interface ChromeCheck {
  title:   string;
  status:  CvStatus;
  label:   string;
  detail:  Record<string, unknown>;
}

interface ChromeVersionCheckResponse {
  profileId:      number;
  storedMajor:    string | null;
  currentMajor:   string | null;
  storedUA:       string | null;
  isStale:        boolean;
  majorsBehind:   number;
  checks:         Record<string, ChromeCheck>;
  checkedAt:      string;
  error?:         string;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: CvStatus }) {
  switch (status) {
    case "pass": return <CheckCircle2  className="h-4 w-4 text-green-600 shrink-0" />;
    case "fail": return <XCircle       className="h-4 w-4 text-red-600 shrink-0" />;
    case "warn": return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    default:     return <Info          className="h-4 w-4 text-slate-400 shrink-0" />;
  }
}

function statusBg(s: CvStatus) {
  switch (s) {
    case "pass": return "bg-green-50 border-green-200";
    case "fail": return "bg-red-50 border-red-200";
    case "warn": return "bg-amber-50 border-amber-200";
    default:     return "bg-slate-50 border-slate-200";
  }
}

function statusText(s: CvStatus) {
  switch (s) {
    case "pass": return "text-green-700";
    case "fail": return "text-red-700";
    case "warn": return "text-amber-700";
    default:     return "text-slate-600";
  }
}

function statusPill(s: CvStatus) {
  switch (s) {
    case "pass": return "bg-green-100 text-green-800 border border-green-300";
    case "fail": return "bg-red-100 text-red-800 border border-red-300";
    case "warn": return "bg-amber-100 text-amber-800 border border-amber-300";
    default:     return "bg-slate-100 text-slate-600 border border-slate-300";
  }
}

function overallStatus(checks: Record<string, ChromeCheck>): CvStatus {
  const ss = Object.values(checks).map(c => c.status);
  if (ss.some(s => s === "fail")) return "fail";
  if (ss.some(s => s === "warn")) return "warn";
  if (ss.every(s => s === "pass" || s === "info")) return "pass";
  return "info";
}

// ── Detail viewer ─────────────────────────────────────────────────────────────

function DetailRow({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-slate-500 font-medium min-w-[120px] shrink-0">{k}</span>
      <span className="text-slate-800 font-mono break-all">{String(v)}</span>
    </div>
  );
}

function CheckCard({ check }: { check: ChromeCheck }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Object.keys(check.detail || {}).length > 0;

  return (
    <div className={`rounded-lg border p-3 ${statusBg(check.status)}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <StatusIcon status={check.status} />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-700 leading-tight">{check.title}</div>
            <div className={`text-xs font-medium mt-0.5 ${statusText(check.status)}`}>{check.label}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${statusPill(check.status)}`}>
            {check.status}
          </span>
          {hasDetail && (
            <button onClick={() => setOpen(o => !o)} className="p-0.5 text-slate-400 hover:text-slate-600">
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>
      {open && hasDetail && (
        <div className="mt-2 pt-2 border-t border-slate-200/60 space-y-1">
          {Object.entries(check.detail).map(([k, v]) => (
            <DetailRow key={k} k={k} v={v} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChromeVersionCheck({ profileId }: { profileId: number }) {
  const [result, setResult]     = useState<ChromeVersionCheckResponse | null>(null);
  const [loading, setLoading]   = useState(false);
  const [bumping, setBumping]   = useState(false);
  const [bumpMsg, setBumpMsg]   = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBumpMsg(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/chrome-version-check`);
      const data: ChromeVersionCheckResponse = await res.json();
      setResult(data);
      if (data.error) setError(data.error);
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  const bumpNow = useCallback(async () => {
    if (!result?.currentMajor || !result?.storedUA) return;
    setBumping(true);
    setBumpMsg(null);
    try {
      // Rewrite the Chrome version in the stored UA using the current major
      const bumpRes = await fetch(`/api/profiles/${profileId}/bump-chrome-ua`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestCurrentBump: true }),
      });
      const bumpData = await bumpRes.json();
      if (bumpData.ok) {
        setBumpMsg(`Bumped to Chrome ${bumpData.newMajor ?? result.currentMajor}`);
        // Re-run the check to show updated state
        await runCheck();
      } else {
        setBumpMsg(bumpData.error ?? "Bump failed");
      }
    } catch (e: any) {
      setBumpMsg(e?.message ?? "Request failed");
    } finally {
      setBumping(false);
    }
  }, [profileId, result, runCheck]);

  const overall = result?.checks ? overallStatus(result.checks) : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Chrome className="h-5 w-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-bold text-slate-800">Chrome Version Check</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Confirms the account's browser and API user-agents are running the current stable Chrome version.
              Real Android phones auto-update Chrome within days — a stale version is a static bot signal visible on every login.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {overall && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${statusPill(overall)}`}>
              {overall}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={runCheck} disabled={loading} className="text-xs h-7 gap-1">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {result ? "Re-check" : "Run Check"}
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 mb-3">
          {error}
        </div>
      )}

      {/* Results */}
      {result && !error && (
        <div className="space-y-2">
          {Object.values(result.checks).map(check => (
            <CheckCard key={check.title} check={check} />
          ))}

          {/* Bump button shown only when stale */}
          {result.isStale && (
            <div className="mt-3 flex items-center gap-3">
              <Button
                size="sm"
                onClick={bumpNow}
                disabled={bumping}
                className="text-xs h-7 gap-1 bg-blue-600 hover:bg-blue-700 text-white"
              >
                {bumping
                  ? <><Loader2 className="h-3 w-3 animate-spin" /> Bumping…</>
                  : <><Zap className="h-3 w-3" /> Bump to Chrome {result.currentMajor} Now</>
                }
              </Button>
              {bumpMsg && (
                <span className="text-xs text-slate-600">{bumpMsg}</span>
              )}
            </div>
          )}

          {/* Checked-at timestamp */}
          <div className="text-[10px] text-slate-400 mt-1">
            Checked at {new Date(result.checkedAt).toLocaleTimeString()}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-xs text-slate-400">
          Click "Run Check" to verify this account's Chrome version is current.
        </div>
      )}
    </div>
  );
}
