import { useState, useEffect, useRef, useCallback } from "react";
import { BrowserPanel } from "@/components/BrowserPanel";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useProxies, useCreateProxy } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertCircle, Loader2, RefreshCw, Copy,
  User, Calendar, Globe, ShieldCheck, Mail,
  List, Trash2, UserPlus, Eye, EyeOff, Plus, X, Monitor, Zap,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type SignupResult = {
  status: "success" | "email_verification" | "phone_verification" | "error";
  steps: string[];
  message?: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  sessionCookies?: string[];
  rawResponse?: unknown;
  dbId?: number;
};

type CreatedAccount = {
  id: number;
  username: string;
  password: string;
  email: string;
  proxyHost: string | null;
  proxyPort: number | null;
  bio: string | null;
  status: string;
  instagramUserId: string | null;
  errorMessage: string | null;
  steps: string | null;
  addedToAccounts: boolean | null;
  profileId: number | null;
  userAgentApi: string | null;
  apiLimits: string | null;
  createdAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function randomUA(): string {
  // v428 targets Android 14 — only use Android 14+ (34/14 or 35/15) entries so the
  // UA is consistent with the app version. Android 13 + v428 triggers needs_upgrade.
  const eligible = UA_POOL.filter(e => parseInt(e.api.split("/")[0], 10) >= 34);
  const pool = eligible.length > 0 ? eligible : UA_POOL;
  return pool[Math.floor(Math.random() * pool.length)].api;
}

function parseSpin(template: string): string {
  let result = template.trim();
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\{([^{}]+)\}/g, (_, group: string) => {
      const opts = group.split("|");
      return opts[Math.floor(Math.random() * opts.length)].trim();
    });
  } while (result !== prev);
  return result;
}

function sanitizeUsername(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 30);
}

function randomDob(): { day: number; month: number; year: number } {
  const now = new Date();
  const maxYear = now.getFullYear() - 18;
  const minYear = now.getFullYear() - 45;
  const year  = minYear + Math.floor(Math.random() * (maxYear - minYear + 1));
  const month = Math.floor(Math.random() * 12) + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const day   = Math.floor(Math.random() * daysInMonth) + 1;
  return { day, month, year };
}

function generatePassword(): string {
  const lower   = "abcdefghijklmnopqrstuvwxyz";
  const upper   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits  = "0123456789";
  const symbols = "!@#$%^&*";
  const all = lower + upper + digits + symbols;
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  for (let i = 0; i < 10; i++) chars.push(pick(all));
  return chars.sort(() => Math.random() - 0.5).join("");
}

function stepClass(msg: string): string {
  const m = msg.toLowerCase();
  if (/\berror\b|fail|throw|blocked|reject|abort|invalid|exception/.test(m)) return "text-red-400";
  if (/http [45]\d\d/.test(m)) return "text-red-400";
  if (/✓|success|\bok\b|available|created!|harvested|seeded|obtained/.test(m)) return "text-green-400";
  if (/http [23]\d\d/.test(m)) return "text-emerald-400";
  if (/retry|non.fatal|warn|missing|skip|none|aborted|unknown/.test(m)) return "text-amber-300";
  if (/^eb:/.test(m)) return "text-sky-300";
  if (/^imap:/.test(m)) return "text-purple-300";
  if (/^library:/.test(m)) return "text-indigo-300";
  return "text-slate-300";
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
}

// ── Signup Browser Window ─────────────────────────────────────────────────────

const SIGNUP_WIN_W = 1100;
const SIGNUP_WIN_H = 680;

function SignupBrowserWindow({
  open, onClose, ebUA,
}: {
  open: boolean;
  onClose: () => void;
  ebUA: string;
}) {
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pos, setPos] = useState(() => ({
    x: Math.round((window.innerWidth - SIGNUP_WIN_W) / 2),
    y: Math.round((window.innerHeight - SIGNUP_WIN_H) / 2),
  }));
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (maximized) return;
    e.preventDefault();
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: ev.clientX - dragOffset.current.x, y: ev.clientY - dragOffset.current.y });
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [maximized, pos.x, pos.y]);

  if (!open) return null;

  const winStyle: React.CSSProperties = maximized
    ? { position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", zIndex: 200 }
    : minimized
    ? { position: "fixed", left: pos.x, top: pos.y, width: SIGNUP_WIN_W, height: "auto", zIndex: 200 }
    : { position: "fixed", left: pos.x, top: pos.y, width: SIGNUP_WIN_W, height: SIGNUP_WIN_H, zIndex: 200 };

  const btnBase = "w-8 h-8 flex items-center justify-center text-sm font-medium text-muted-foreground transition-colors";

  return (
    <div style={winStyle} className="flex flex-col overflow-hidden shadow-2xl border border-border bg-background select-none">
      {/* Title bar */}
      <div
        onMouseDown={onTitleMouseDown}
        className={`flex items-center px-2 h-9 bg-slate-100 dark:bg-slate-800 border-b border-border shrink-0 ${!maximized ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
      >
        <Monitor className="w-3.5 h-3.5 text-muted-foreground shrink-0 mr-2" />
        <span className="text-sm font-semibold text-foreground truncate flex-1">Signup Embedded Browser</span>
        {/* ─ Minimise */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => { setMinimized(m => !m); setMaximized(false); }}
          className={`${btnBase} hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-foreground`}
          title={minimized ? "Restore" : "Minimise"}
        >
          ─
        </button>
        {/* □ Maximise */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => { setMaximized(m => !m); setMinimized(false); }}
          className={`${btnBase} hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-foreground`}
          title={maximized ? "Restore" : "Maximise"}
        >
          {maximized ? "❐" : "□"}
        </button>
        {/* × Close */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onClose}
          className={`${btnBase} hover:bg-red-500 hover:text-white`}
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Browser content — hidden when minimised */}
      {!minimized && (
        <div className="flex-1 min-h-0">
          <BrowserPanel
            profileId={0}
            userAgent={ebUA}
            username="signup"
            streamUrl="/api/signup/browser/stream"
            inputUrl="/api/signup/browser/input"
            forceStream
          />
        </div>
      )}
    </div>
  );
}

// ── Live Trace ────────────────────────────────────────────────────────────────

function LiveTracePanel({ steps, loading }: { steps: Array<{msg: string; ts: number}>; loading: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [steps]);
  return (
    <div className="rounded-lg bg-[#0d1117] border border-[#30363d] overflow-hidden h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#21262d] bg-[#161b22] shrink-0">
        {loading
          ? <><span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse shrink-0" /><span className="text-[10px] font-mono text-slate-400">LIVE</span></>
          : <><span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" /><span className="text-[10px] font-mono text-slate-500">COMPLETE</span></>
        }
        <span className="ml-auto text-[10px] font-mono text-slate-600">{steps.length} lines</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[10.5px] leading-relaxed space-y-0.5">
        {steps.length === 0 && (
          <div className="text-slate-600 italic py-2 px-1">
            {loading ? "Waiting for first event…" : "No trace data."}
          </div>
        )}
        {steps.map((s, i) => (
          <div key={i} className="flex items-start gap-2 hover:bg-white/[0.02] px-1 rounded">
            <span className="text-slate-700 shrink-0 select-none">{fmtTs(s.ts)}</span>
            <span className={`break-all ${stepClass(s.msg)}`}>{s.msg}</span>
          </div>
        ))}
        {loading && steps.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 pt-1">
            <span className="inline-block w-2 h-3 bg-slate-400 animate-pulse rounded-sm" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Step Log (restored from session) ─────────────────────────────────────────

function StepLog({ steps }: { steps: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [steps]);
  return (
    <div className="space-y-1 font-mono text-xs max-h-52 overflow-y-auto">
      {steps.map((s, i) => (
        <div key={i} className="flex items-start gap-2 text-muted-foreground">
          <span className="text-sky-500 shrink-0 mt-px">→</span>
          <span>{s}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  success:            "bg-green-100 text-green-800 border-green-200",
  error:              "bg-red-100 text-red-800 border-red-200",
  failed:             "bg-red-100 text-red-800 border-red-200",
  email_verification: "bg-amber-100 text-amber-800 border-amber-200",
  phone_verification: "bg-amber-100 text-amber-800 border-amber-200",
  pending:            "bg-slate-100 text-slate-600 border-slate-200",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_STYLE[status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
      {status.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

// ── Created Accounts Tab ──────────────────────────────────────────────────────

function CreatedAccountsTab() {
  const [accounts, setAccounts]   = useState<CreatedAccount[]>([]);
  const [loading, setLoading]     = useState(true);
  const [adding, setAdding]       = useState<number | null>(null);
  const [deleting, setDeleting]   = useState<number | null>(null);
  const [expanded, setExpanded]   = useState<number | null>(null);
  const [showPass, setShowPass]   = useState<number | null>(null);
  const queryClient               = useQueryClient();

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/signup/created-accounts");
      setAccounts(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try {
      await fetch(`/api/signup/created-accounts/${id}`, { method: "DELETE" });
      setAccounts(a => a.filter(x => x.id !== id));
    } finally { setDeleting(null); }
  };

  const handleAdd = async (id: number) => {
    setAdding(id);
    try {
      const res = await fetch(`/api/signup/created-accounts/${id}/add-to-accounts`, { method: "POST" });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        setAccounts(a => a.map(x => x.id === id ? { ...x, addedToAccounts: true } : x));
      }
    } finally { setAdding(null); }
  };

  const success = accounts.filter(a => a.status === "success").length;
  const failed  = accounts.filter(a => a.status === "error" || a.status === "failed").length;
  const pending = accounts.filter(a => a.status === "pending" || a.status === "email_verification" || a.status === "phone_verification").length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Created", value: success, color: "text-green-600" },
          { label: "Failed",  value: failed,  color: "text-red-600"   },
          { label: "Pending", value: pending, color: "text-amber-600" },
        ].map(s => (
          <div key={s.label} className="desktop-card p-3 text-center">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{accounts.length} total attempts</p>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={load}>
          <RefreshCw className="w-3 h-3 mr-1" />Refresh
        </Button>
      </div>
      {loading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />Loading...
        </div>
      )}
      {!loading && accounts.length === 0 && (
        <div className="desktop-card p-8 text-center text-muted-foreground text-sm">
          No accounts created yet. Use the Create tab to make your first account.
        </div>
      )}
      <div className="space-y-2">
        {accounts.map(a => (
          <div key={a.id} className="desktop-card overflow-hidden">
            <div className="flex items-center gap-3 p-3">
              <div className="shrink-0">
                {a.status === "success"
                  ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                  : a.status === "error" || a.status === "failed"
                  ? <XCircle className="w-4 h-4 text-red-500" />
                  : <AlertCircle className="w-4 h-4 text-amber-500" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-sm">@{a.username}</span>
                  <StatusBadge status={a.status} />
                  {a.addedToAccounts && (
                    <span className="text-[10px] bg-sky-100 text-sky-700 border border-sky-200 px-1.5 py-0.5 rounded font-semibold">IN ACCOUNTS</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                  <span>{a.email}</span>
                  {a.proxyHost && <span>{a.proxyHost}:{a.proxyPort}</span>}
                  <span>{new Date(a.createdAt).toLocaleString()}</span>
                  {a.instagramUserId && <span className="text-green-600 font-medium">UID: {a.instagramUserId}</span>}
                </div>
                {a.errorMessage && <p className="text-xs text-red-600 mt-0.5 truncate">{a.errorMessage}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                  <List className="w-3.5 h-3.5" />
                </Button>
                {a.status === "success" && !a.addedToAccounts && (
                  <Button size="sm" className="h-7 px-2 text-xs bg-sky-500 hover:bg-sky-600 text-white border-0" onClick={() => handleAdd(a.id)} disabled={adding === a.id}>
                    {adding === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><UserPlus className="w-3 h-3 mr-1" />Add to Accounts</>}
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500" onClick={() => handleDelete(a.id)} disabled={deleting === a.id}>
                  {deleting === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>
            {expanded === a.id && (
              <div className="border-t border-border px-3 pb-3 pt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase text-muted-foreground">Username</p>
                    <p className="text-xs font-mono">{a.username}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase text-muted-foreground">Password</p>
                    <div className="flex items-center gap-1">
                      <p className="text-xs font-mono">{showPass === a.id ? a.password : "••••••••••••"}</p>
                      <button onClick={() => setShowPass(showPass === a.id ? null : a.id)} className="text-muted-foreground hover:text-foreground">
                        {showPass === a.id ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                  {a.bio && (
                    <div className="col-span-2 space-y-1">
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">Bio</p>
                      <p className="text-xs">{a.bio}</p>
                    </div>
                  )}
                </div>
                {a.steps && (() => {
                  let steps: string[] = [];
                  try { steps = JSON.parse(a.steps); } catch {}
                  return steps.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">API Log</p>
                      <StepLog steps={steps} />
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── LocalStorage / SessionStorage helpers ─────────────────────────────────────

const LS_KEY_USERNAME_SPIN     = "equinox_api_username_spin";
const LS_KEY_BIO_SPIN          = "equinox_api_bio_spin";
const LS_KEY_EMAIL      = "equinox_api_email";
const SS_KEY_PASSWORD   = "equinox_api_password";
const SS_KEY_FIRSTNAME  = "equinox_api_firstname";
const SS_KEY_DOB        = "equinox_api_dob";
const SS_KEY_PROXY_ID   = "equinox_api_proxy_id";
const SS_KEY_UA_API     = "equinox_api_ua_api";
const SS_KEY_TAB        = "equinox_api_tab";
const SS_KEY_RESULT     = "equinox_api_result";
const SS_KEY_VERIFY     = "equinox_api_verify_code";
const LS_KEY_API_LIMITS = "equinox_api_limits_v1";

function lsGet(key: string): string { return localStorage.getItem(key) ?? ""; }
function lsSet(key: string, v: string) { localStorage.setItem(key, v); }
function ssGet(key: string): string { return sessionStorage.getItem(key) ?? ""; }
function ssGetJson<T>(key: string, fallback: T): T {
  try { const r = sessionStorage.getItem(key); if (r) return JSON.parse(r) as T; } catch {}
  return fallback;
}
function ssSet(key: string, v: string) { sessionStorage.setItem(key, v); }
function ssSetJson(key: string, v: unknown) { sessionStorage.setItem(key, JSON.stringify(v)); }

const SS_ALL_KEYS = [
  SS_KEY_PASSWORD, SS_KEY_FIRSTNAME, SS_KEY_DOB, SS_KEY_PROXY_ID, SS_KEY_UA_API,
  SS_KEY_TAB, SS_KEY_RESULT, SS_KEY_VERIFY,
];
function ssClearAll() { SS_ALL_KEYS.forEach(k => sessionStorage.removeItem(k)); }

const DEFAULT_API_LIMITS = { requestsMin: 1, requestsMax: 2, everySecondsMin: 10, everySecondsMax: 30 };

function loadApiLimits() {
  try {
    const raw = localStorage.getItem(LS_KEY_API_LIMITS);
    if (raw) return { ...DEFAULT_API_LIMITS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_API_LIMITS;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function CreateAccountApiPage() {
  const setSlot = useSidebarSetSlot();
  useEffect(() => { setSlot(null); return () => setSlot(null); }, [setSlot]);

  const { data: proxies } = useProxies();

  // Tab state
  const [tab, setTabRaw] = useState<"create" | "accounts">(() =>
    (ssGet(SS_KEY_TAB) as "create" | "accounts") || "create"
  );
  const setTab = (v: "create" | "accounts") => { setTabRaw(v); ssSet(SS_KEY_TAB, v); };

  // ── Signup fields ──────────────────────────────────────────────────────────
  const [usernameSpin, setUsernameSpinRaw] = useState(() => lsGet(LS_KEY_USERNAME_SPIN));
  const [bioSpin, setBioSpinRaw]           = useState(() => lsGet(LS_KEY_BIO_SPIN));
  const setUsernameSpin = (v: string) => { setUsernameSpinRaw(v); lsSet(LS_KEY_USERNAME_SPIN, v); };
  const setBioSpin      = (v: string) => { setBioSpinRaw(v);      lsSet(LS_KEY_BIO_SPIN, v);      };

  const [password, setPasswordRaw]   = useState(() => ssGet(SS_KEY_PASSWORD) || generatePassword());
  const [email, setEmailRaw]         = useState(() => lsGet(LS_KEY_EMAIL));
  const [firstName, setFirstNameRaw] = useState(() => ssGet(SS_KEY_FIRSTNAME));
  const setPassword  = (v: string) => { setPasswordRaw(v);  ssSet(SS_KEY_PASSWORD,  v); };
  const setEmail     = (v: string) => { setEmailRaw(v);     lsSet(LS_KEY_EMAIL,      v); };
  const setFirstName = (v: string) => { setFirstNameRaw(v); ssSet(SS_KEY_FIRSTNAME, v); };

  const [dob, setDobRaw] = useState(() =>
    ssGetJson<{ day: number; month: number; year: number }>(SS_KEY_DOB, randomDob())
  );
  const setDob = (v: { day: number; month: number; year: number }) => { setDobRaw(v); ssSetJson(SS_KEY_DOB, v); };

  const [selectedProxyId, setSelectedProxyIdRaw] = useState<number | "">(() => {
    const s = ssGet(SS_KEY_PROXY_ID);
    return s ? Number(s) : "";
  });
  const setSelectedProxyId = (v: number | "") => {
    setSelectedProxyIdRaw(v);
    ssSet(SS_KEY_PROXY_ID, v === "" ? "" : String(v));
  };

  const [apiLimits, setApiLimitsRaw] = useState(loadApiLimits);
  const setApiLimits = (v: typeof DEFAULT_API_LIMITS) => {
    setApiLimitsRaw(v);
    localStorage.setItem(LS_KEY_API_LIMITS, JSON.stringify(v));
  };

  const [userAgentApi, setUserAgentApiRaw] = useState(() => ssGet(SS_KEY_UA_API) || UA_POOL[0].api);
  const setUserAgentApi = (v: string) => { setUserAgentApiRaw(v); ssSet(SS_KEY_UA_API, v); };

  // ── Runtime state ──────────────────────────────────────────────────────────
  const [loading, setLoading]     = useState(false);
  const [result, setResultRaw]    = useState<SignupResult | null>(() =>
    ssGetJson<SignupResult | null>(SS_KEY_RESULT, null)
  );
  const setResult = (v: SignupResult | null | ((prev: SignupResult | null) => SignupResult | null)) => {
    setResultRaw(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next === null) sessionStorage.removeItem(SS_KEY_RESULT);
      else ssSetJson(SS_KEY_RESULT, next);
      return next;
    });
  };
  const [verifyCode, setVerifyCodeRaw] = useState(() => ssGet(SS_KEY_VERIFY));
  const setVerifyCode = (v: string) => { setVerifyCodeRaw(v); ssSet(SS_KEY_VERIFY, v); };
  const [verifying, setVerifying]      = useState(false);
  const [copied, setCopied]            = useState(false);
  const [liveSteps, setLiveSteps]      = useState<Array<{msg: string; ts: number}>>([]);
  const [ebPanelOpen, setEbPanelOpen]  = useState(false);
  const [ebResetBusy, setEbResetBusy]  = useState(false);
  const [ebVisible, setEbVisible]      = useState(false);

  const createProxy = useCreateProxy();
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [newProxyHostPort, setNewProxyHostPort] = useState("");
  const [newProxyUser, setNewProxyUser] = useState("");
  const [newProxyPass, setNewProxyPass] = useState("");
  const [addProxyErr, setAddProxyErr]   = useState("");

  const handleAddProxy = async () => {
    setAddProxyErr("");
    const raw = newProxyHostPort.trim();
    const lastColon = raw.lastIndexOf(":");
    const host = lastColon > 0 ? raw.slice(0, lastColon).trim() : raw;
    const port = lastColon > 0 ? parseInt(raw.slice(lastColon + 1), 10) : NaN;
    if (!host) return setAddProxyErr("Enter host:port (e.g. 123.45.67.89:8080)");
    if (!port || port < 1 || port > 65535) return setAddProxyErr("Port must be 1–65535");
    try {
      const created = await createProxy.mutateAsync({
        host, port,
        username: newProxyUser.trim() || null,
        password: newProxyPass.trim() || null,
      });
      setSelectedProxyId(created.id);
      setShowAddProxy(false);
      setNewProxyHostPort(""); setNewProxyUser(""); setNewProxyPass("");
    } catch (e: any) {
      setAddProxyErr(e?.message ?? "Failed to save proxy");
    }
  };

  const years = Array.from({ length: 80 }, (_, i) => 2006 - i);
  const days  = Array.from({ length: 31 }, (_, i) => i + 1);

  const selectedProxy = proxies?.find(p => p.id === Number(selectedProxyId));
  const canSubmit = usernameSpin.trim() && password && email.trim() && selectedProxyId;

  const selectedDevice = UA_POOL.find(d => d.api === userAgentApi) ?? UA_POOL[0];
  const ebUA = selectedDevice.embedded;

  const IS_ELECTRON = typeof (window as any).electronAPI !== "undefined";

  const clearEbSession = useCallback(async () => {
    if (IS_ELECTRON) {
      try { await (window as any).electronAPI.clearSignupBrowserCache(); } catch {}
    } else {
      try { await fetch("/api/signup/browser/reset", { method: "POST" }); } catch {}
      setEbPanelOpen(false);
    }
  }, [IS_ELECTRON]);

  const handleResetBrowser = useCallback(async () => {
    setEbResetBusy(true);
    setEbVisible(false);
    await clearEbSession();
    setEbResetBusy(false);
  }, [clearEbSession]);

  const deviceLabel = (() => {
    const parts = userAgentApi.split(";").map(s => s.trim());
    const brand = parts[3] ?? "";
    const model = parts[4] ?? "";
    return [brand, model].filter(Boolean).join(" ");
  })();

  const handleBrowserMessage = useCallback((msg: any) => {
    if (msg.type === "signupStep") {
      setLiveSteps(prev => [...prev, { msg: msg.msg as string, ts: Date.now() }]);
    } else if (msg.type === "signupPaused") {
      setLoading(false);
      setResult({ status: "email_verification", steps: [], sessionId: "eb" });
    } else if (msg.type === "signupDone") {
      setLoading(false);
      setResult({
        status: msg.status === "success" ? "success" : "error",
        steps: [],
        message: msg.message,
        username: msg.username,
        userId: msg.userId,
      });
    }
  }, []);

  const handleCreate = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setResult(null);
    setVerifyCode("");
    setLiveSteps([]);
    const spunUsername = sanitizeUsername(parseSpin(usernameSpin));

    const proxyPayload = selectedProxy ? {
      proxyHost:     selectedProxy.host,
      proxyPort:     selectedProxy.port,
      proxyUsername: selectedProxy.username ?? undefined,
      proxyPassword: selectedProxy.password ?? undefined,
    } : {};

    // Step 1: open the signup browser (no-op if already running)
    setEbVisible(true);
    try {
      await fetch("/api/signup/browser/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...proxyPayload, userAgent: ebUA }),
      });
    } catch {}

    // Step 2: start the EB automation (fire-and-forget; results come via WS → handleBrowserMessage)
    try {
      const res = await fetch("/api/signup/browser/automate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email:     email.trim(),
          password,
          username:  spunUsername,
          firstName: firstName.trim() || undefined,
          dob,
          userAgent: ebUA,
          ...proxyPayload,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to start automation" }));
        throw new Error((err as any).message ?? "Failed to start automation");
      }
    } catch (e: any) {
      setResult({ status: "error", steps: [], message: e?.message ?? "Failed to start EB automation" });
      setLoading(false);
    }
    // loading stays true until signupDone or signupPaused arrives via WS
  };

  const handleVerify = async () => {
    if (!result?.sessionId || !verifyCode.trim()) return;
    setVerifying(true);

    if (result.sessionId === "eb") {
      // EB automation flow — unblock the automation with the email code
      try {
        await fetch("/api/signup/browser/automate-continue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: verifyCode.trim() }),
        });
        setVerifyCode("");
        setResult(null);
        setLoading(true);
      } catch (e: any) {
        setResult(prev => prev ? { ...prev, message: e?.message ?? "Network error" } : null);
      } finally {
        setVerifying(false);
      }
      return;
    }

    // Legacy API flow
    try {
      const res = await fetch("/api/signup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: result.sessionId, code: verifyCode.trim(), dbId: result.dbId }),
      });
      const data: SignupResult = await res.json();
      const newSteps = data.steps ?? [];
      setLiveSteps(prev => [...prev, ...newSteps.map(msg => ({ msg, ts: Date.now() }))]);
      setResult(prev => prev ? { ...data, steps: [...(prev.steps ?? []), ...newSteps] } : data);
    } catch (e: any) {
      setResult(prev => prev ? { ...prev, message: e?.message ?? "Network error" } : null);
    } finally {
      setVerifying(false);
    }
  };

  const handleReset = () => {
    ssClearAll();
    setResult(null);
    setVerifyCode("");
    setLiveSteps([]);
    setPassword(generatePassword());
    setDob(randomDob());
    setUserAgentApi(randomUA());
    setFirstName("");
    setSelectedProxyId("");
  };

  const locked = loading;

  const numInput = (val: number, onChange: (v: number) => void, min = 0) => (
    <Input
      type="number"
      min={min}
      value={val}
      onChange={e => onChange(Number(e.target.value))}
      className="h-7 w-[68px] text-sm"
      disabled={locked}
    />
  );

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an Account</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Creates an Instagram account via the mobile API using the embedded browser.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {result && tab === "create" && (
            <Button variant="outline" size="sm" onClick={handleReset} className="h-8">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />New Attempt
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3 border-b border-border">
        {(["create", "accounts"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-sky-500 text-sky-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "create"
              ? <><UserPlus className="w-3.5 h-3.5 inline mr-1.5" />Create</>
              : <><List className="w-3.5 h-3.5 inline mr-1.5" />Created Accounts</>
            }
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <div style={{ height: "calc(100vh - 200px)", overflowY: "auto" }}>
          <CreatedAccountsTab />
        </div>
      ) : (
        <div className="flex gap-3" style={{ height: "calc(100vh - 200px)" }}>
          {/* ── Left column: scrollable form ── */}
          <div className="overflow-y-auto shrink-0 w-[380px] space-y-2 pb-4 pr-1">

            {/* ── Browser / Device ── */}
            <div className="desktop-card p-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Monitor className="w-4 h-4 text-cyan-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate">{deviceLabel || "Unknown Device"}</p>
                    <p className="text-[10px] font-mono text-muted-foreground/70 truncate">{userAgentApi}</p>
                    <p className="text-[10px] font-mono text-muted-foreground truncate">{ebUA}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                    onClick={async () => {
                      setUserAgentApi(randomUA());
                      setPassword(generatePassword());
                      setDob(randomDob());
                      setFirstName("");
                      setEbVisible(false);
                      setLoading(false);
                      setResult(null);
                      setLiveSteps([]);
                      await clearEbSession();
                    }}
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />Randomise
                  </Button>
                </div>
              </div>
            </div>

            {/* ── Account Details ── */}
            <div className="desktop-card p-2.5 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Account Details</p>
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1"><User className="w-3 h-3" />Username Spin</Label>
                <Input
                  value={usernameSpin}
                  onChange={e => setUsernameSpin(e.target.value)}
                  placeholder="{Maia|Mila|Nina}_{fox|wolf}_{1234|5678}"
                  className="h-7 text-xs font-mono"
                  disabled={locked}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <Eye className="w-3 h-3" />Password
                  <span className="ml-1 text-[10px] text-muted-foreground">(auto-generated)</span>
                </Label>
                <Input value={password} onChange={e => setPassword(e.target.value)} className="h-7 text-xs font-mono" disabled={locked} />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <Mail className="w-3 h-3" />Email Address
                  <span className="ml-1 text-[10px] text-red-500 font-medium">required</span>
                </Label>
                <Input
                  value={email}
                  onChange={e => setEmail(e.target.value.trim())}
                  placeholder="e.g. user@gmail.com"
                  type="email"
                  className="h-7 text-xs"
                  disabled={locked}
                />
              </div>
            </div>

            {/* ── Profile Info ── */}
            <div className="desktop-card p-2.5 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] flex items-center gap-1">
                    <User className="w-3 h-3" />Full Name
                    <span className="ml-1 text-[10px] text-muted-foreground/60">(opt)</span>
                  </Label>
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Alex Johnson" className="h-7 text-xs" disabled={locked} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Bio Spin <span className="text-muted-foreground/60">(opt)</span></Label>
                  <Input
                    value={bioSpin}
                    onChange={e => setBioSpin(e.target.value)}
                    placeholder="Fitness lover 🌍"
                    className="h-7 text-xs font-mono"
                    disabled={locked}
                  />
                </div>
              </div>
            </div>

            {/* ── Date of Birth ── */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <Label className="text-[10px] flex items-center gap-1">
                <Calendar className="w-3 h-3" />Date of Birth
                <span className="ml-1 text-[10px] text-muted-foreground">(auto-randomised 18–45 yrs)</span>
              </Label>
              <div className="grid grid-cols-3 gap-2">
                <select value={dob.day}   onChange={e => setDob({ ...dob, day:   Number(e.target.value) })} disabled={locked} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {days.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={dob.month} onChange={e => setDob({ ...dob, month: Number(e.target.value) })} disabled={locked} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
                <select value={dob.year}  onChange={e => setDob({ ...dob, year:  Number(e.target.value) })} disabled={locked} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* ── Proxy ── */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] flex items-center gap-1"><Globe className="w-3 h-3" />Proxy <span className="text-red-500 ml-0.5">*</span></Label>
                {!locked && (
                  <button type="button" onClick={() => { setShowAddProxy(v => !v); setAddProxyErr(""); }} className="flex items-center gap-1 text-[10px] text-sky-500 hover:text-sky-600 font-medium">
                    {showAddProxy ? <><X className="w-3 h-3" />Cancel</> : <><Plus className="w-3 h-3" />Add new</>}
                  </button>
                )}
              </div>
              {proxies && proxies.length > 0 && !showAddProxy && (
                <select
                  value={selectedProxyId}
                  onChange={e => setSelectedProxyId(e.target.value ? Number(e.target.value) : "")}
                  disabled={locked}
                  className={`h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 ${!selectedProxyId ? "border-red-300 text-muted-foreground" : "border-input"}`}
                >
                  <option value="">— Select a proxy —</option>
                  {proxies.map(p => <option key={p.id} value={p.id}>{p.host}:{p.port}{p.username ? ` (${p.username})` : ""}</option>)}
                </select>
              )}
              {(!proxies || proxies.length === 0) && !showAddProxy && (
                <div className="flex items-center gap-2 text-xs text-cyan-700 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/20 border border-cyan-200 dark:border-cyan-800 rounded px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />No proxies yet — click <strong className="mx-0.5">Add new</strong> above.
                </div>
              )}
              {showAddProxy && (
                <div className="rounded-md border border-sky-200 bg-sky-50/40 dark:bg-sky-950/20 p-3 space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-[2] space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Host:Port</Label>
                      <Input value={newProxyHostPort} onChange={e => setNewProxyHostPort(e.target.value)} placeholder="123.45.67.89:8080" className="h-7 text-xs font-mono" disabled={createProxy.isPending} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Username <span className="font-normal">(optional)</span></Label>
                      <Input value={newProxyUser} onChange={e => setNewProxyUser(e.target.value)} placeholder="user" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Password <span className="font-normal">(optional)</span></Label>
                      <Input type="password" value={newProxyPass} onChange={e => setNewProxyPass(e.target.value)} placeholder="••••••" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                    <Button size="sm" className="h-7 text-xs bg-sky-500 hover:bg-sky-600 text-white border-0 shrink-0" onClick={handleAddProxy} disabled={createProxy.isPending || !newProxyHostPort.trim()}>
                      {createProxy.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Plus className="w-3 h-3 mr-1" />Save</>}
                    </Button>
                  </div>
                  {addProxyErr && <p className="text-[10px] text-red-600 flex items-center gap-1"><XCircle className="w-3 h-3 shrink-0" />{addProxyErr}</p>}
                </div>
              )}
            </div>

            {/* ── API Timing ── */}
            <div className="desktop-card p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-yellow-500" />
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">API Step Timing</p>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min Calls</Label>
                  <Input
                    type="number" min={1} max={99}
                    className="h-7 text-xs w-full"
                    value={apiLimits.requestsMin}
                    onChange={e => setApiLimits({ ...apiLimits, requestsMin: Math.max(1, Number(e.target.value)) })}
                    disabled={locked}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max Calls</Label>
                  <Input
                    type="number" min={1} max={99}
                    className="h-7 text-xs w-full"
                    value={apiLimits.requestsMax}
                    onChange={e => setApiLimits({ ...apiLimits, requestsMax: Math.max(1, Number(e.target.value)) })}
                    disabled={locked}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Min secs</Label>
                  <Input
                    type="number" min={1} max={3600}
                    className="h-7 text-xs w-full"
                    value={apiLimits.everySecondsMin}
                    onChange={e => setApiLimits({ ...apiLimits, everySecondsMin: Math.max(1, Number(e.target.value)) })}
                    disabled={locked}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Max secs</Label>
                  <Input
                    type="number" min={1} max={3600}
                    className="h-7 text-xs w-full"
                    value={apiLimits.everySecondsMax}
                    onChange={e => setApiLimits({ ...apiLimits, everySecondsMax: Math.max(1, Number(e.target.value)) })}
                    disabled={locked}
                  />
                </div>
              </div>
            </div>

            {/* ── Submit ── */}
            {!result && (
              <Button
                className="w-full h-9 bg-cyan-500 hover:bg-cyan-600 text-white border-0 text-sm font-semibold"
                onClick={handleCreate}
                disabled={loading || !canSubmit}
              >
                {loading ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating Account…</>
                ) : (
                  <><UserPlus className="w-4 h-4 mr-2" />Create Account</>
                )}
              </Button>
            )}

            {/* ── Inline result / verification ── */}
            {result && (
              <div className={`desktop-card p-4 space-y-3 border-2 ${
                result.status === "success"
                  ? "border-green-300 bg-green-50/40 dark:bg-green-950/20"
                  : result.status === "error"
                  ? "border-red-300 bg-red-50/40 dark:bg-red-950/20"
                  : "border-cyan-300 bg-cyan-50/40 dark:bg-cyan-950/20"
              }`}>
                <div className="flex items-center gap-2">
                  {result.status === "success"
                    ? <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
                    : result.status === "error"
                    ? <XCircle className="w-5 h-5 text-red-600 shrink-0" />
                    : <AlertCircle className="w-5 h-5 text-cyan-600 shrink-0" />
                  }
                  <p className="font-semibold text-sm">
                    {result.status === "success" ? "Account Created" :
                     result.status === "error"   ? "Creation Failed" :
                     "Verification Required"}
                  </p>
                </div>

                {result.message && (
                  <p className="text-sm text-foreground/80">{result.message}</p>
                )}

                {result.status === "success" && (
                  <div className="space-y-2">
                    {result.userId && (
                      <div className="flex items-center gap-2 text-xs font-mono bg-white/60 dark:bg-black/20 rounded px-2 py-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-green-600 shrink-0" />
                        <span className="text-muted-foreground">User ID:</span>
                        <span className="font-semibold">{result.userId}</span>
                      </div>
                    )}
                    {result.username && (
                      <div className="flex items-center gap-2 text-xs font-mono bg-white/60 dark:bg-black/20 rounded px-2 py-1.5">
                        <User className="w-3.5 h-3.5 text-green-600 shrink-0" />
                        <span className="text-muted-foreground">Username:</span>
                        <span className="font-semibold">@{result.username}</span>
                      </div>
                    )}
                    <Button size="sm" className="bg-sky-500 hover:bg-sky-600 text-white border-0 text-xs h-7" onClick={() => setTab("accounts")}>
                      <List className="w-3 h-3 mr-1" />View in Created Accounts
                    </Button>
                  </div>
                )}

                {result.status === "error" && result.rawResponse != null && (
                  <div className="pt-1 border-t border-border/60">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-muted-foreground">Raw Response</p>
                      <Button variant="ghost" size="sm" className="h-5 px-2 text-[10px]" onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(result!.rawResponse, null, 2));
                        setCopied(true); setTimeout(() => setCopied(false), 1500);
                      }}>
                        <Copy className="w-3 h-3 mr-1" />{copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <pre className="text-[10px] font-mono bg-black/10 rounded p-2 overflow-auto max-h-24 whitespace-pre-wrap break-all">
                      {JSON.stringify(result.rawResponse, null, 2)}
                    </pre>
                  </div>
                )}

                {(result.status === "email_verification" || result.status === "phone_verification") && result.sessionId && (
                  <div className="space-y-3 rounded-lg border-2 border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 p-4">
                    <div className="flex items-start gap-2">
                      <Mail className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                          {result.status === "email_verification" ? "Email Verification Required" : "Phone Verification Required"}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-400 leading-snug">
                          {result.status === "email_verification"
                            ? "Instagram sent a 6-digit code to your email address. Check your inbox, then enter it here to continue."
                            : "Instagram sent a 6-digit SMS code to your phone number. Enter it here to continue."}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Input
                        value={verifyCode}
                        onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        maxLength={6}
                        autoFocus
                        className="h-12 text-center text-2xl font-mono tracking-[0.5em] w-44 border-amber-400 focus:border-amber-500 bg-white dark:bg-black/20"
                      />
                      <Button
                        onClick={handleVerify}
                        disabled={verifying || verifyCode.length < 6}
                        className="h-12 px-6 bg-amber-500 hover:bg-amber-600 text-white border-0 font-semibold text-sm"
                      >
                        {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit Code"}
                      </Button>
                    </div>
                    <p className="text-[10px] text-amber-600/80 dark:text-amber-500/60">
                      The code expires in a few minutes. If it doesn't arrive, check your spam folder.
                    </p>
                  </div>
                )}

                <Button variant="outline" size="sm" className="h-7 text-xs w-full" onClick={handleReset}>
                  <RefreshCw className="w-3 h-3 mr-1.5" />New Attempt
                </Button>
              </div>
            )}
          </div>

          {/* ── Right column: inline embedded browser ── */}
          <div className="flex-1 min-w-0 rounded-lg border border-border overflow-hidden">
            {ebVisible ? (
              <BrowserPanel
                profileId={0}
                userAgent={ebUA}
                username="signup"
                streamUrl="/api/signup/browser/stream"
                inputUrl="/api/signup/browser/input"
                forceStream
                embedded
                onMessage={handleBrowserMessage}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <Monitor className="w-14 h-14 opacity-15" />
                <p className="text-sm">Browser opens when you click <strong className="text-foreground">Create Account</strong></p>
              </div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
