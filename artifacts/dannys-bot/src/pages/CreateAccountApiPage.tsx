import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useProxies } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import { useQueryClient } from "@tanstack/react-query";
import {
  Cpu, CheckCircle2, XCircle, AlertCircle, Loader2, RefreshCw, Copy,
  User, Mail, KeyRound, Calendar, Globe, ShieldCheck, Server, Lock,
  Zap, List, Trash2, UserPlus, Eye, EyeOff, Circle,
} from "lucide-react";

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

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const IG_PREFIX = "Instagram 378.1.0.45.111 Android (";

// Returns just the raw device descriptor — the server wraps the IG prefix at call time.
// This matches the format used by all existing accounts in the Accounts page.
function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)].api;
}

// Steps shown in the progress tracker while the API call is in flight
const PROGRESS_STEPS = [
  { label: "Fetching CSRF token (si/fetch_headers)", ms: 0 },
  { label: "Checking username availability", ms: 3000 },
  { label: "Submitting signup (accounts/create/)", ms: 5500 },
  { label: "Awaiting Instagram response…", ms: 8000 },
];

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

function detectImap(email: string): { server: string; port: number } {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { server: "imap.gmail.com", port: 993 };
  if (domain.startsWith("yahoo.")) return { server: "imap.mail.yahoo.com", port: 993 };
  if (["outlook.com","hotmail.com","live.com","msn.com"].includes(domain)) return { server: "imap-mail.outlook.com", port: 993 };
  if (domain === "icloud.com" || domain === "me.com") return { server: "imap.mail.me.com", port: 993 };
  return { server: "", port: 993 };
}

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

// Animated step-by-step progress tracker shown while the API call is in flight
function LiveProgressTracker({ loading }: { loading: boolean }) {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (!loading) { setVisibleCount(0); return; }
    setVisibleCount(1);
    const timers = PROGRESS_STEPS.slice(1).map((s, i) =>
      setTimeout(() => setVisibleCount(i + 2), s.ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  if (!loading) return null;

  return (
    <div className="desktop-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-sky-500 shrink-0" />
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Progress</p>
      </div>
      <div className="space-y-2.5">
        {PROGRESS_STEPS.map((s, i) => {
          const active  = i === visibleCount - 1;
          const done    = i < visibleCount - 1;
          const pending = i >= visibleCount;
          return (
            <div key={i} className="flex items-center gap-2.5">
              <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                {done    && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                {active  && <Loader2 className="w-4 h-4 text-sky-500 animate-spin" />}
                {pending && <Circle className="w-3.5 h-3.5 text-muted-foreground/30" />}
              </div>
              <span className={`text-xs transition-colors ${
                done    ? "text-green-600 font-medium" :
                active  ? "text-foreground font-medium" :
                          "text-muted-foreground/40"
              }`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

// ── Created Accounts Tab ─────────────────────────────────────────────────────

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
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try {
      await fetch(`/api/signup/created-accounts/${id}`, { method: "DELETE" });
      setAccounts(a => a.filter(x => x.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  const handleAdd = async (id: number) => {
    setAdding(id);
    try {
      const res = await fetch(`/api/signup/created-accounts/${id}/add-to-accounts`, { method: "POST" });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        setAccounts(a => a.map(x => x.id === id ? { ...x, addedToAccounts: true } : x));
      }
    } finally {
      setAdding(null);
    }
  };

  const success = accounts.filter(a => a.status === "success").length;
  const failed  = accounts.filter(a => a.status === "error" || a.status === "failed").length;
  const pending = accounts.filter(a => a.status === "pending" || a.status === "email_verification" || a.status === "phone_verification").length;

  return (
    <div className="space-y-3">
      {/* Summary */}
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
              {/* Status icon */}
              <div className="shrink-0">
                {a.status === "success"
                  ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                  : a.status === "error" || a.status === "failed"
                  ? <XCircle className="w-4 h-4 text-red-500" />
                  : <AlertCircle className="w-4 h-4 text-amber-500" />
                }
              </div>

              {/* Main info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-sm">@{a.username}</span>
                  <StatusBadge status={a.status} />
                  {a.addedToAccounts && (
                    <span className="text-[10px] bg-sky-100 text-sky-700 border border-sky-200 px-1.5 py-0.5 rounded font-semibold">
                      IN ACCOUNTS
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                  <span>{a.email}</span>
                  {a.proxyHost && <span>{a.proxyHost}:{a.proxyPort}</span>}
                  <span>{new Date(a.createdAt).toLocaleString()}</span>
                  {a.instagramUserId && <span className="text-green-600 font-medium">UID: {a.instagramUserId}</span>}
                </div>
                {a.errorMessage && (
                  <p className="text-xs text-red-600 mt-0.5 truncate">{a.errorMessage}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                  title="View log"
                >
                  <List className="w-3.5 h-3.5" />
                </Button>

                {a.status === "success" && !a.addedToAccounts && (
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs bg-sky-500 hover:bg-sky-600 text-white border-0"
                    onClick={() => handleAdd(a.id)}
                    disabled={adding === a.id}
                    title="Add to Accounts page for automation"
                  >
                    {adding === a.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <><UserPlus className="w-3 h-3 mr-1" />Add to Accounts</>
                    }
                  </Button>
                )}

                <Button
                  variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500"
                  onClick={() => handleDelete(a.id)}
                  disabled={deleting === a.id}
                  title="Delete this record"
                >
                  {deleting === a.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />
                  }
                </Button>
              </div>
            </div>

            {/* Expanded: credentials + log */}
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

// ── Main Page ────────────────────────────────────────────────────────────────

// These two are templates the user re-uses across many sessions — persist to
// localStorage so they survive page refreshes and are never wiped by New Attempt.
const LS_KEY_USERNAME_SPIN = "equinox_api_username_spin";
const LS_KEY_BIO_SPIN      = "equinox_api_bio_spin";
const SS_KEY_PASSWORD   = "equinox_api_password";
const SS_KEY_FIRSTNAME  = "equinox_api_firstname";
const SS_KEY_EMAIL      = "equinox_api_email";
const SS_KEY_EMAIL_PASS = "equinox_api_email_pass";
const SS_KEY_DOB        = "equinox_api_dob";
const SS_KEY_PROXY_ID   = "equinox_api_proxy_id";
const SS_KEY_UA_API     = "equinox_api_ua_api";
const SS_KEY_TAB        = "equinox_api_tab";
const SS_KEY_RESULT     = "equinox_api_result";
const SS_KEY_VERIFY     = "equinox_api_verify_code";
const LS_KEY_API_LIMITS = "equinox_api_limits_v1";
const LS_KEY_IMAP       = "equinox_api_imap_v1";

function lsGet(key: string): string { return localStorage.getItem(key) ?? ""; }
function lsSet(key: string, v: string) { localStorage.setItem(key, v); }
function ssGet(key: string): string { return sessionStorage.getItem(key) ?? ""; }
function ssGetJson<T>(key: string, fallback: T): T {
  try { const r = sessionStorage.getItem(key); if (r) return JSON.parse(r) as T; } catch {}
  return fallback;
}
function ssSet(key: string, v: string) { sessionStorage.setItem(key, v); }
function ssSetJson(key: string, v: unknown) { sessionStorage.setItem(key, JSON.stringify(v)); }
// Per-attempt fields only — username/bio spin are templates kept in localStorage
const SS_ALL_KEYS = [
  SS_KEY_PASSWORD, SS_KEY_FIRSTNAME, SS_KEY_EMAIL,
  SS_KEY_EMAIL_PASS, SS_KEY_DOB, SS_KEY_PROXY_ID, SS_KEY_UA_API, SS_KEY_TAB,
  SS_KEY_RESULT, SS_KEY_VERIFY,
];
function ssClearAll() { SS_ALL_KEYS.forEach(k => sessionStorage.removeItem(k)); }

const DEFAULT_API_LIMITS = { requestsMin: 5, requestsMax: 10, everySecondsMin: 30, everySecondsMax: 60 };

function loadApiLimits() {
  try {
    const raw = localStorage.getItem(LS_KEY_API_LIMITS);
    if (raw) return { ...DEFAULT_API_LIMITS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_API_LIMITS;
}

function loadImap() {
  try {
    const raw = localStorage.getItem(LS_KEY_IMAP);
    if (raw) return JSON.parse(raw) as { server: string; port: number };
  } catch {}
  return { server: "", port: 993 };
}

export function CreateAccountApiPage() {
  const setSlot = useSidebarSetSlot();
  useEffect(() => { setSlot(null); return () => setSlot(null); }, [setSlot]);

  const { data: proxies } = useProxies();

  // All form + result state is persisted in sessionStorage so navigating away
  // and back restores exactly where the user left off.
  const [tab, setTabRaw] = useState<"create" | "accounts">(() =>
    (ssGet(SS_KEY_TAB) as "create" | "accounts") || "create"
  );
  const setTab = (v: "create" | "accounts") => { setTabRaw(v); ssSet(SS_KEY_TAB, v); };

  // Account fields — spin templates live in localStorage so they outlive refreshes
  const [usernameSpin, setUsernameSpinRaw] = useState(() => lsGet(LS_KEY_USERNAME_SPIN));
  const [bioSpin, setBioSpinRaw]           = useState(() => lsGet(LS_KEY_BIO_SPIN));
  const setUsernameSpin = (v: string) => { setUsernameSpinRaw(v); lsSet(LS_KEY_USERNAME_SPIN, v); };
  const setBioSpin      = (v: string) => { setBioSpinRaw(v);      lsSet(LS_KEY_BIO_SPIN, v);      };

  const [password, setPasswordRaw]   = useState(() => ssGet(SS_KEY_PASSWORD) || generatePassword());
  const [firstName, setFirstNameRaw] = useState(() => ssGet(SS_KEY_FIRSTNAME));
  const [email, setEmailRaw]         = useState(() => ssGet(SS_KEY_EMAIL));
  const setPassword  = (v: string) => { setPasswordRaw(v);  ssSet(SS_KEY_PASSWORD,  v); };
  const setFirstName = (v: string) => { setFirstNameRaw(v); ssSet(SS_KEY_FIRSTNAME, v); };
  const setEmail     = (v: string) => { setEmailRaw(v);     ssSet(SS_KEY_EMAIL,     v); };

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

  // API Controller — persisted to localStorage so settings survive page reloads
  const [apiLimits, setApiLimitsRaw] = useState(loadApiLimits);
  const setApiLimits = (v: typeof DEFAULT_API_LIMITS) => {
    setApiLimitsRaw(v);
    localStorage.setItem(LS_KEY_API_LIMITS, JSON.stringify(v));
  };
  const [userAgentApi, setUserAgentApiRaw] = useState(() => ssGet(SS_KEY_UA_API) || UA_POOL[0].api);
  const setUserAgentApi = (v: string) => { setUserAgentApiRaw(v); ssSet(SS_KEY_UA_API, v); };

  // Email / IMAP — server+port persisted to localStorage
  const [emailPass, setEmailPassRaw] = useState(() => ssGet(SS_KEY_EMAIL_PASS));
  const setEmailPass = (v: string) => { setEmailPassRaw(v); ssSet(SS_KEY_EMAIL_PASS, v); };
  const _savedImap = loadImap();
  const [imapServer, setImapServerRaw] = useState(_savedImap.server);
  const [imapPort, setImapPortRaw]     = useState(_savedImap.port);
  const setImapServer = (v: string) => { setImapServerRaw(v); localStorage.setItem(LS_KEY_IMAP, JSON.stringify({ server: v, port: imapPort })); };
  const setImapPort   = (v: number) => { setImapPortRaw(v);   localStorage.setItem(LS_KEY_IMAP, JSON.stringify({ server: imapServer, port: v })); };

  // Runtime state — result + verifyCode persisted so verification can continue after navigation
  const [loading, setLoading]         = useState(false);
  const [result, setResultRaw]        = useState<SignupResult | null>(() =>
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

  const years = Array.from({ length: 80 }, (_, i) => 2006 - i);
  const days  = Array.from({ length: 31 }, (_, i) => i + 1);

  useEffect(() => {
    if (!email.includes("@")) return;
    const detected = detectImap(email);
    if (detected.server) { setImapServer(detected.server); setImapPort(detected.port); }
  }, [email]);

  const selectedProxy = proxies?.find(p => p.id === Number(selectedProxyId));
  // Full name is optional — not required for submission
  const canSubmit = usernameSpin.trim() && password && email && selectedProxyId;

  const handleCreate = async () => {
    if (!canSubmit) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
    setLoading(true);
    setResult(null);
    setVerifyCode("");
    const spunUsername = sanitizeUsername(parseSpin(usernameSpin));
    const spunBio      = bioSpin.trim() ? parseSpin(bioSpin) : undefined;
    try {
      const body: Record<string, unknown> = {
        username: spunUsername,
        password,
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        day: dob.day,
        month: dob.month,
        year: dob.year,
        bio: spunBio,
        userAgentApi,
        apiLimits,
        imapHost: imapServer.trim() || undefined,
        imapPort: imapServer.trim() ? imapPort : undefined,
        imapUser: imapServer.trim() ? email.trim() : undefined,
        imapPass: emailPass.trim() || undefined,
      };
      if (selectedProxy) {
        body.proxyHost     = selectedProxy.host;
        body.proxyPort     = selectedProxy.port;
        body.proxyUsername = selectedProxy.username ?? undefined;
        body.proxyPassword = selectedProxy.password ?? undefined;
      }
      const res = await fetch("/api/signup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: SignupResult = await res.json();
      setResult(data);
    } catch (e: any) {
      setResult({ status: "error", steps: [], message: e?.message ?? "Network error" });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!result?.sessionId || !verifyCode.trim()) return;
    setVerifying(true);
    try {
      const res = await fetch("/api/signup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: result.sessionId, code: verifyCode.trim(), dbId: result.dbId }),
      });
      const data: SignupResult = await res.json();
      setResult(prev => prev ? { ...data, steps: [...(prev.steps ?? []), ...(data.steps ?? [])] } : data);
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
    setPassword(generatePassword());
    setDob(randomDob());
    setUserAgentApi(randomUA());
    setEmail("");
    setFirstName("");
    setEmailPass("");
    setSelectedProxyId("");
  };

  const statusColors: Record<SignupResult["status"], string> = {
    success:            "border-green-200 bg-green-50",
    email_verification: "border-amber-200 bg-amber-50",
    phone_verification: "border-amber-200 bg-amber-50",
    error:              "border-red-200 bg-red-50",
  };
  const statusIcons: Record<SignupResult["status"], React.ReactNode> = {
    success:            <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />,
    email_verification: <AlertCircle  className="w-5 h-5 text-amber-600 shrink-0" />,
    phone_verification: <AlertCircle  className="w-5 h-5 text-amber-600 shrink-0" />,
    error:              <XCircle      className="w-5 h-5 text-red-600   shrink-0" />,
  };
  const statusLabels: Record<SignupResult["status"], string> = {
    success:            "Account Created",
    email_verification: "Email Verification Required",
    phone_verification: "Phone Verification Required",
    error:              "Creation Failed",
  };

  const locked = loading;

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="w-6 h-6 text-sky-500" />
            <h1 className="text-3xl font-bold tracking-tight text-foreground">API Account Creator</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Creates accounts via the Instagram mobile API — username &amp; bio auto-spun on submit.
          </p>
        </div>
        {result && tab === "create" && (
          <Button variant="outline" size="sm" onClick={handleReset} className="shrink-0">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />New Attempt
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 border-b border-border">
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
            {t === "create" ? <><Cpu className="w-3.5 h-3.5 inline mr-1.5" />Create</> : <><List className="w-3.5 h-3.5 inline mr-1.5" />Created Accounts</>}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <div style={{ height: "calc(100vh - 200px)", overflowY: "auto" }}>
          <CreatedAccountsTab />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ height: "calc(100vh - 200px)", overflow: "auto" }}>

          {/* ── LEFT: Form ── */}
          <div className="space-y-3">

            {/* Username spin + Password */}
            <div className="desktop-card p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account Details</p>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1"><User className="w-3 h-3" />Username Spin</Label>
                <Input
                  value={usernameSpin}
                  onChange={e => setUsernameSpin(e.target.value)}
                  placeholder="{Maia|Mila|Nina}_{fox|wolf}_{1234|5678}"
                  className="h-8 text-xs font-mono"
                  disabled={locked}
                />
                <p className="text-[10px] text-muted-foreground">Jarvee spin syntax — spun &amp; sanitised automatically on submit.</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <KeyRound className="w-3 h-3" />Password
                  <span className="ml-1 text-[10px] text-muted-foreground">(auto-generated)</span>
                </Label>
                <Input
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="h-8 text-sm font-mono"
                  disabled={locked}
                />
              </div>
            </div>

            {/* Full name + Email + Bio spin */}
            <div className="desktop-card p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1">
                    <User className="w-3 h-3" />Full Name
                    <span className="ml-1 text-[10px] text-muted-foreground">(optional)</span>
                  </Label>
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="e.g. Alex Johnson" className="h-8 text-sm" disabled={locked} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1">
                    <Mail className="w-3 h-3" />Email <span className="text-red-500 ml-0.5">*</span>
                  </Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="user@domain.com"
                    className="h-8 text-sm"
                    disabled={locked}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Bio Spin <span className="text-muted-foreground/60">(optional)</span></Label>
                <Input
                  value={bioSpin}
                  onChange={e => setBioSpin(e.target.value)}
                  placeholder="{Fitness lover|Coffee addict} 🌍 {Living life|Exploring the world} ✨"
                  className="h-8 text-xs font-mono"
                  disabled={locked}
                />
                <p className="text-[10px] text-muted-foreground">Spun on submit and set on the account if creation succeeds.</p>
              </div>
            </div>

            {/* DOB */}
            <div className="desktop-card p-4 space-y-2">
              <Label className="text-xs flex items-center gap-1">
                <Calendar className="w-3 h-3" />Date of Birth
                <span className="ml-1 text-[10px] text-muted-foreground">(auto-randomised 18–45 yrs)</span>
              </Label>
              <div className="grid grid-cols-3 gap-2">
                <select value={dob.day}   onChange={e => setDob({ ...dob, day:   Number(e.target.value) })} disabled={locked} className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {days.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={dob.month} onChange={e => setDob({ ...dob, month: Number(e.target.value) })} disabled={locked} className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
                <select value={dob.year}  onChange={e => setDob({ ...dob, year:  Number(e.target.value) })} disabled={locked} className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* Proxy */}
            <div className="desktop-card p-4 space-y-2">
              <Label className="text-xs flex items-center gap-1"><Globe className="w-3 h-3" />Proxy <span className="text-red-500 ml-0.5">*</span></Label>
              {!proxies || proxies.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />No proxies found — add proxies in the Proxy Manager tab first.
                </div>
              ) : (
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
            </div>

            {/* Email / IMAP */}
            <div className="desktop-card p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Email Access <span className="font-normal normal-case text-muted-foreground/70">(for auto-fetching verification codes)</span>
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1"><Lock className="w-3 h-3" />Email Password</Label>
                <Input type="password" value={emailPass} onChange={e => setEmailPass(e.target.value)} placeholder="Email account password" className="h-8 text-sm" disabled={locked} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-1.5">
                  <Label className="text-xs flex items-center gap-1"><Server className="w-3 h-3" />IMAP Server</Label>
                  <Input value={imapServer} onChange={e => setImapServer(e.target.value)} placeholder="imap.gmail.com" className="h-8 text-sm" disabled={locked} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Port</Label>
                  <Input type="number" value={imapPort} onChange={e => setImapPort(Number(e.target.value))} className="h-8 text-sm" disabled={locked} />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">If filled, the server polls your inbox automatically and submits the verification code — no manual entry needed.</p>
            </div>

            {/* API Controller */}
            <div className="desktop-card p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-yellow-500" />API Controller
              </p>
              <div className="flex gap-2 items-end flex-wrap">
                {[
                  { label: "Min Calls",   key: "requestsMin" as const },
                  { label: "Max Calls",   key: "requestsMax" as const },
                  { label: "Min (s)",     key: "everySecondsMin" as const },
                  { label: "Max (s)",     key: "everySecondsMax" as const },
                ].map(f => (
                  <div key={f.key} className="space-y-1">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{f.label}</Label>
                    <Input
                      type="number"
                      className="h-7 text-xs w-16"
                      value={apiLimits[f.key]}
                      onChange={e => setApiLimits({ ...apiLimits, [f.key]: Number(e.target.value) })}
                      disabled={locked}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">Allow x–y API calls every x–y seconds globally for this account.</p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">API User Agent — Device</Label>
                  <Button
                    variant="ghost" size="sm" className="h-6 px-2 text-[10px]"
                    disabled={locked}
                    onClick={() => setUserAgentApi(randomUA())}
                  >
                    Randomise
                  </Button>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground px-1 truncate select-none">{IG_PREFIX}…)</div>
                <Input value={userAgentApi} onChange={e => setUserAgentApi(e.target.value)} className="h-8 text-xs font-mono" disabled={locked} placeholder="API/ver; dpi; res; Brand; Model; codename; soc; en_US" />
                <p className="text-[10px] text-muted-foreground">The device descriptor — the Instagram prefix is added automatically by the server. Each account gets a unique device from a pool of {UA_POOL.length}.</p>
              </div>
              <div className="space-y-1.5 pt-1 border-t border-border/60">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Globe className="w-3 h-3" />EB User Agent — Cookie Harvest (Chrome)
                </Label>
                <div className="h-8 px-3 flex items-center rounded-md border border-border bg-muted/40 text-[10px] font-mono text-muted-foreground truncate select-all">
                  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36
                </div>
                <p className="text-[10px] text-muted-foreground">Chrome desktop UA used by the embedded browser to harvest <code className="font-mono">mid</code>, <code className="font-mono">ig_did</code> and <code className="font-mono">csrftoken</code> before signup.</p>
              </div>
            </div>

            {/* Submit */}
            {!result && (
              <Button
                className="w-full bg-sky-500 hover:bg-sky-600 text-white border-0 h-10"
                onClick={handleCreate}
                disabled={loading || !canSubmit}
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating Account…</>
                  : <><Cpu className="w-4 h-4 mr-2" />Create Account via API</>
                }
              </Button>
            )}
          </div>

          {/* ── RIGHT: Status + Log + Issues — always visible ── */}
          <div className="space-y-3">

            {/* STATUS — always shown */}
            <div className={`desktop-card p-4 border-2 transition-colors ${
              loading
                ? "border-sky-300 bg-sky-50/40"
                : result
                  ? statusColors[result.status]
                  : "border-border"
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {loading
                  ? <Loader2 className="w-5 h-5 text-sky-500 animate-spin shrink-0" />
                  : result
                    ? statusIcons[result.status]
                    : <Circle className="w-4 h-4 text-muted-foreground/30 shrink-0" />
                }
                <p className="font-semibold text-sm">
                  {loading ? "Creating Account…" : result ? statusLabels[result.status] : "Status"}
                </p>
                {!loading && !result && (
                  <span className="ml-auto text-[10px] text-muted-foreground/50 font-normal">Waiting for attempt</span>
                )}
              </div>

              {loading && <LiveProgressTracker loading={loading} />}

              {!loading && !result && (
                <p className="text-xs text-muted-foreground">Fill the form and click <strong>Create Account via API</strong> — the result will appear here.</p>
              )}

              {result && (
                <>
                  {result.message && <p className="text-sm text-foreground/80 mb-3">{result.message}</p>}

                  {result.status === "success" && (
                    <div className="space-y-2">
                      {result.userId && (
                        <div className="flex items-center gap-2 text-xs font-mono bg-white/60 rounded px-2 py-1.5">
                          <ShieldCheck className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          <span className="text-muted-foreground">User ID:</span>
                          <span className="font-semibold">{result.userId}</span>
                        </div>
                      )}
                      {result.username && (
                        <div className="flex items-center gap-2 text-xs font-mono bg-white/60 rounded px-2 py-1.5">
                          <User className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          <span className="text-muted-foreground">Username:</span>
                          <span className="font-semibold">@{result.username}</span>
                        </div>
                      )}
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm" className="bg-sky-500 hover:bg-sky-600 text-white border-0 text-xs h-7"
                          onClick={() => { setTab("accounts"); }}
                        >
                          <List className="w-3 h-3 mr-1" />View in Created Accounts
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Go to <strong>Created Accounts</strong> to add it to the automation accounts page.
                      </p>
                    </div>
                  )}

                  {(result.status === "email_verification" || result.status === "phone_verification") && result.sessionId && (
                    <div className="mt-3 p-3 rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 space-y-2">
                      <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                        {result.status === "email_verification"
                          ? "📧 Check your email for a 6-digit code from Instagram"
                          : "📱 Check your phone for a 6-digit SMS code from Instagram"}
                      </p>
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {result.status === "email_verification"
                          ? "Instagram sent a verification code to your email. Enter it below — no IMAP needed."
                          : "Instagram sent an SMS to your phone. Enter the code below."}
                      </p>
                      <div className="flex gap-2 items-center">
                        <Input
                          value={verifyCode}
                          onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          placeholder="000000"
                          maxLength={6}
                          autoFocus
                          className="h-10 text-center text-xl font-mono tracking-[0.4em] w-40 border-amber-400 focus:border-amber-500"
                        />
                        <Button
                          onClick={handleVerify}
                          disabled={verifying || verifyCode.length < 6}
                          className="h-10 px-5 bg-amber-500 hover:bg-amber-600 text-white border-0 font-semibold"
                        >
                          {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit Code"}
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* API CALL LOG — always shown */}
            <div className="desktop-card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">API Call Log</p>
                {result && result.steps?.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">{result.steps.length} steps</span>
                )}
              </div>
              {result && result.steps?.length > 0
                ? <StepLog steps={result.steps} />
                : (
                  <p className="text-xs text-muted-foreground/50 italic">
                    {loading ? "Waiting for server…" : "No log yet — step-by-step API trace will appear here."}
                  </p>
                )
              }
            </div>

            {/* ISSUE LOG — always shown, populated on error */}
            <div className="desktop-card p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Issue Log</p>
              {result?.status === "error" && result.message ? (
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2 text-xs">
                    <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-px" />
                    <span className="text-red-700 dark:text-red-400 font-mono break-all">{result.message}</span>
                  </div>
                  {!!result.rawResponse && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[10px] text-muted-foreground">Raw Response</p>
                        <Button variant="ghost" size="sm" className="h-5 px-2 text-[10px]" onClick={() => {
                          navigator.clipboard.writeText(JSON.stringify(result.rawResponse, null, 2));
                          setCopied(true); setTimeout(() => setCopied(false), 1500);
                        }}>
                          <Copy className="w-3 h-3 mr-1" />{copied ? "Copied" : "Copy"}
                        </Button>
                      </div>
                      <pre className="text-[10px] font-mono bg-black/5 rounded p-2 overflow-auto max-h-28 whitespace-pre-wrap break-all">
                        {JSON.stringify(result.rawResponse, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/50 italic">
                  {result && result.status !== "error" ? "No issues — attempt completed without errors." : "No issues logged."}
                </p>
              )}
            </div>

          </div>
        </div>
      )}
    </AppLayout>
  );
}
