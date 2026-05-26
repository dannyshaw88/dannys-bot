import { useState, useEffect, useCallback } from "react";
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
  CheckCircle2, XCircle, AlertCircle, Loader2, RefreshCw,
  User, Calendar, Globe, Mail, Clipboard, ClipboardCheck,
  List, Trash2, UserPlus, Eye, EyeOff, Plus, X, Monitor,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Paste to focused EB field ─────────────────────────────────────────────────

async function fillEbField(text: string): Promise<void> {
  await fetch("/api/signup/browser/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fill", text }),
  });
}

// ── Paste button component ────────────────────────────────────────────────────

function PasteBtn({ value, onPaste }: { value: string; onPaste: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const handle = async () => {
    if (!value.trim() || state === "busy") return;
    setState("busy");
    try { await onPaste(); setState("done"); } catch { setState("idle"); }
    setTimeout(() => setState("idle"), 1200);
  };
  return (
    <button
      type="button"
      onClick={handle}
      title="Paste into focused EB field"
      className={`h-5 w-5 flex items-center justify-center rounded transition-colors shrink-0
        ${state === "done" ? "text-green-500" : "text-muted-foreground hover:text-foreground"}
        ${!value.trim() ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
    >
      {state === "done"
        ? <ClipboardCheck className="w-3 h-3" />
        : state === "busy"
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : <Clipboard className="w-3 h-3" />}
    </button>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: "bg-green-100 text-green-700 border-green-200",
    error:   "bg-red-100   text-red-700   border-red-200",
    failed:  "bg-red-100   text-red-700   border-red-200",
    pending: "bg-amber-100 text-amber-700 border-amber-200",
  };
  return (
    <span className={`text-[10px] border px-1.5 py-0.5 rounded font-semibold uppercase ${map[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
      {status}
    </span>
  );
}

// ── Step log ──────────────────────────────────────────────────────────────────

function StepLog({ steps }: { steps: string[] }) {
  return (
    <div className="bg-black/80 rounded p-2 max-h-40 overflow-y-auto font-mono text-[10px] space-y-0.5">
      {steps.map((s, i) => <div key={i} className="text-slate-300">{s}</div>)}
    </div>
  );
}

// ── Created Accounts Tab ──────────────────────────────────────────────────────

function CreatedAccountsTab() {
  const qc = useQueryClient();
  const [accounts, setAccounts] = useState<CreatedAccount[]>([]);
  const [loading, setLoading]   = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showPass, setShowPass] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [adding, setAdding]     = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/signup/created-accounts");
      const d = await r.json() as { accounts: CreatedAccount[] };
      setAccounts(d.accounts ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try { await fetch(`/api/signup/created-accounts/${id}`, { method: "DELETE" }); await load(); }
    finally { setDeleting(null); }
  };

  const handleAdd = async (id: number) => {
    setAdding(id);
    try {
      await fetch(`/api/signup/created-accounts/${id}/add-to-accounts`, { method: "POST" });
      await load();
      qc.invalidateQueries({ queryKey: ["/api/profiles"] });
    } finally { setAdding(null); }
  };

  const success = accounts.filter(a => a.status === "success").length;
  const failed  = accounts.filter(a => a.status === "error" || a.status === "failed").length;
  const pending = accounts.filter(a => a.status !== "success" && a.status !== "error" && a.status !== "failed").length;

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
          No accounts created yet.
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
                  : <AlertCircle className="w-4 h-4 text-amber-500" />}
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
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Log</p>
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

const LS_KEY_USERNAME_SPIN = "equinox_api_username_spin";
const LS_KEY_BIO_SPIN      = "equinox_api_bio_spin";
const LS_KEY_EMAIL         = "equinox_api_email";
const SS_KEY_PASSWORD      = "equinox_api_password";
const SS_KEY_FIRSTNAME     = "equinox_api_firstname";
const SS_KEY_DOB           = "equinox_api_dob";
const SS_KEY_PROXY_ID      = "equinox_api_proxy_id";
const SS_KEY_UA_API        = "equinox_api_ua_api";
const SS_KEY_TAB           = "equinox_api_tab";
const LS_KEY_EB_VISIBLE    = "equinox_eb_open";

function lsGet(key: string): string { return localStorage.getItem(key) ?? ""; }
function lsSet(key: string, v: string) { localStorage.setItem(key, v); }
function ssGet(key: string): string { return sessionStorage.getItem(key) ?? ""; }
function ssGetJson<T>(key: string, fallback: T): T {
  try { const r = sessionStorage.getItem(key); if (r) return JSON.parse(r) as T; } catch {}
  return fallback;
}
function ssSet(key: string, v: string) { sessionStorage.setItem(key, v); }
function ssSetJson(key: string, v: unknown) { sessionStorage.setItem(key, JSON.stringify(v)); }

// ── Main Page ─────────────────────────────────────────────────────────────────

export function CreateAccountApiPage() {
  const setSlot = useSidebarSetSlot();
  useEffect(() => { setSlot(null); return () => setSlot(null); }, [setSlot]);

  const { data: proxies } = useProxies();
  const createProxy = useCreateProxy();

  // Tab state
  const [tab, setTabRaw] = useState<"create" | "accounts">(() =>
    (ssGet(SS_KEY_TAB) as "create" | "accounts") || "create"
  );
  const setTab = (v: "create" | "accounts") => { setTabRaw(v); ssSet(SS_KEY_TAB, v); };

  // Signup fields
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

  // EB state
  const [userAgentApi, setUserAgentApi] = useState(() => ssGet(SS_KEY_UA_API) || randomUA());
  const [ebVisible, setEbVisible]       = useState(() => lsGet(LS_KEY_EB_VISIBLE) === "1");
  const [ebResetBusy, setEbResetBusy]   = useState(false);
  const [ebUA, setEbUA]                 = useState(userAgentApi);

  // Add proxy inline form
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [newProxyHostPort, setNewProxyHostPort] = useState("");
  const [newProxyUser, setNewProxyUser]         = useState("");
  const [newProxyPass, setNewProxyPass]         = useState("");
  const [addProxyErr, setAddProxyErr]           = useState("");

  // Day/year arrays
  const days  = Array.from({ length: 31 }, (_, i) => i + 1);
  const now   = new Date();
  const years = Array.from({ length: 80 }, (_, i) => now.getFullYear() - 10 - i);

  const deviceLabel = userAgentApi.match(/Android [\d.]+|iPhone OS [\d_]+/)?.[0] ?? "";

  const clearEbSession = async () => {
    await fetch("/api/signup/browser/close",  { method: "POST" });
    await fetch("/api/signup/browser/reset",  { method: "POST" });
  };

  const openEb = async () => {
    const proxy = proxies?.find(p => p.id === selectedProxyId);
    const ua = userAgentApi;
    setEbUA(ua);
    lsSet(LS_KEY_EB_VISIBLE, "1");
    setEbVisible(true);
    await fetch("/api/signup/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAgent: ua,
        proxyHost: proxy?.host,
        proxyPort: proxy?.port,
        proxyUsername: proxy?.username,
        proxyPassword: proxy?.password,
      }),
    });
  };

  const handleAddProxy = async () => {
    setAddProxyErr("");
    const [host, portStr] = newProxyHostPort.split(":");
    if (!host || !portStr) { setAddProxyErr("Format: host:port"); return; }
    const port = Number(portStr);
    if (!port) { setAddProxyErr("Invalid port"); return; }
    try {
      await createProxy.mutateAsync({ host, port, username: newProxyUser || undefined, password: newProxyPass || undefined, type: "http" });
      setNewProxyHostPort(""); setNewProxyUser(""); setNewProxyPass("");
      setShowAddProxy(false);
    } catch (e: any) { setAddProxyErr(e?.message ?? "Failed"); }
  };

  // Paste helpers — spin/sanitize then fill focused EB field
  const pasteUsername = () => fillEbField(sanitizeUsername(parseSpin(usernameSpin)));
  const pasteBio      = () => fillEbField(parseSpin(bioSpin));
  const pasteEmail    = () => fillEbField(email);
  const pastePassword = () => fillEbField(password);
  const pasteName     = () => fillEbField(firstName);

  return (
    <AppLayout>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an Account</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Open the embedded browser, navigate to Instagram, then use the paste icons to fill each field.
          </p>
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
              : <><List className="w-3.5 h-3.5 inline mr-1.5" />Created Accounts</>}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <div style={{ height: "calc(100vh - 200px)", overflowY: "auto" }}>
          <CreatedAccountsTab />
        </div>
      ) : (
        <div className="flex gap-3" style={{ height: "calc(100vh - 200px)" }}>

          {/* ── Left column: fields + paste icons ── */}
          <div className="overflow-y-auto shrink-0 w-[320px] space-y-2 pb-4 pr-1">

            {/* Device */}
            <div className="desktop-card p-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Monitor className="w-4 h-4 text-cyan-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate">{deviceLabel || "Unknown Device"}</p>
                    <p className="text-[10px] font-mono text-muted-foreground/70 truncate">{userAgentApi}</p>
                  </div>
                </div>
                <Button
                  variant="ghost" size="sm" className="h-7 px-2 text-[10px] shrink-0"
                  onClick={async () => {
                    const ua = randomUA();
                    setUserAgentApi(ua); ssSet(SS_KEY_UA_API, ua);
                    setPassword(generatePassword()); setDob(randomDob()); setFirstName("");
                    setEbVisible(false); lsSet(LS_KEY_EB_VISIBLE, "0");
                    setEbResetBusy(true);
                    await clearEbSession();
                    setEbResetBusy(false);
                  }}
                  disabled={ebResetBusy}
                >
                  {ebResetBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <><RefreshCw className="w-3 h-3 mr-1" />Randomise</>}
                </Button>
              </div>
            </div>

            {/* Account Details */}
            <div className="desktop-card p-2.5 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Account Details</p>

              {/* Username */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <User className="w-3 h-3" />Username Spin
                  <span className="ml-auto text-[9px] text-muted-foreground/60 font-normal italic">spun on paste</span>
                </Label>
                <div className="flex items-center gap-1">
                  <Input
                    value={usernameSpin}
                    onChange={e => setUsernameSpin(e.target.value)}
                    placeholder="{Maia|Mila|Nina}_{fox|wolf}_{1234|5678}"
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <PasteBtn value={usernameSpin} onPaste={pasteUsername} />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <Eye className="w-3 h-3" />Password
                  <span className="ml-1 text-[10px] text-muted-foreground">(auto-generated)</span>
                </Label>
                <div className="flex items-center gap-1">
                  <Input value={password} onChange={e => setPassword(e.target.value)} className="h-7 text-xs font-mono flex-1" />
                  <PasteBtn value={password} onPaste={pastePassword} />
                </div>
              </div>

              {/* Email */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <Mail className="w-3 h-3" />Email Address
                </Label>
                <div className="flex items-center gap-1">
                  <Input
                    value={email}
                    onChange={e => setEmail(e.target.value.trim())}
                    placeholder="e.g. user@gmail.com"
                    type="email"
                    className="h-7 text-xs flex-1"
                  />
                  <PasteBtn value={email} onPaste={pasteEmail} />
                </div>
              </div>
            </div>

            {/* Profile Info */}
            <div className="desktop-card p-2.5 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Profile Info</p>

              {/* Full Name */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  <User className="w-3 h-3" />Full Name
                  <span className="ml-1 text-[10px] text-muted-foreground/60">(opt)</span>
                </Label>
                <div className="flex items-center gap-1">
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Alex Johnson" className="h-7 text-xs flex-1" />
                  <PasteBtn value={firstName} onPaste={pasteName} />
                </div>
              </div>

              {/* Bio */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1">
                  Bio Spin
                  <span className="ml-1 text-muted-foreground/60">(opt)</span>
                  <span className="ml-auto text-[9px] text-muted-foreground/60 font-normal italic">spun on paste</span>
                </Label>
                <div className="flex items-center gap-1">
                  <Input
                    value={bioSpin}
                    onChange={e => setBioSpin(e.target.value)}
                    placeholder="Fitness lover 🌍"
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <PasteBtn value={bioSpin} onPaste={pasteBio} />
                </div>
              </div>
            </div>

            {/* Date of Birth */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <Label className="text-[10px] flex items-center gap-1">
                <Calendar className="w-3 h-3" />Date of Birth
                <span className="ml-1 text-[10px] text-muted-foreground">(auto-randomised 18–45 yrs)</span>
              </Label>
              <div className="grid grid-cols-3 gap-2">
                <select value={dob.day}   onChange={e => setDob({ ...dob, day:   Number(e.target.value) })} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring">
                  {days.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={dob.month} onChange={e => setDob({ ...dob, month: Number(e.target.value) })} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring">
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
                <select value={dob.year}  onChange={e => setDob({ ...dob, year:  Number(e.target.value) })} className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring">
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* Proxy */}
            <div className="desktop-card p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] flex items-center gap-1"><Globe className="w-3 h-3" />Proxy</Label>
                <button type="button" onClick={() => { setShowAddProxy(v => !v); setAddProxyErr(""); }} className="flex items-center gap-1 text-[10px] text-sky-500 hover:text-sky-600 font-medium">
                  {showAddProxy ? <><X className="w-3 h-3" />Cancel</> : <><Plus className="w-3 h-3" />Add new</>}
                </button>
              </div>
              {proxies && proxies.length > 0 && !showAddProxy && (
                <select
                  value={selectedProxyId}
                  onChange={e => setSelectedProxyId(e.target.value ? Number(e.target.value) : "")}
                  className={`h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring ${!selectedProxyId ? "border-red-300 text-muted-foreground" : "border-input"}`}
                >
                  <option value="">— Select a proxy —</option>
                  {proxies.map(p => <option key={p.id} value={p.id}>{p.host}:{p.port}{p.username ? ` (${p.username})` : ""}</option>)}
                </select>
              )}
              {(!proxies || proxies.length === 0) && !showAddProxy && (
                <div className="flex items-center gap-2 text-xs text-cyan-700 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/20 border border-cyan-200 dark:border-cyan-800 rounded px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />No proxies — click <strong className="mx-0.5">Add new</strong> above.
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
                      <Label className="text-[10px] text-muted-foreground">User</Label>
                      <Input value={newProxyUser} onChange={e => setNewProxyUser(e.target.value)} placeholder="user" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Pass</Label>
                      <Input type="password" value={newProxyPass} onChange={e => setNewProxyPass(e.target.value)} placeholder="••••" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                    <Button size="sm" className="h-7 text-xs bg-sky-500 hover:bg-sky-600 text-white border-0 shrink-0" onClick={handleAddProxy} disabled={createProxy.isPending || !newProxyHostPort.trim()}>
                      {createProxy.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Plus className="w-3 h-3 mr-1" />Save</>}
                    </Button>
                  </div>
                  {addProxyErr && <p className="text-[10px] text-red-600 flex items-center gap-1"><XCircle className="w-3 h-3 shrink-0" />{addProxyErr}</p>}
                </div>
              )}
            </div>

            {/* Open Browser button */}
            {!ebVisible && (
              <Button
                className="w-full h-9 bg-cyan-500 hover:bg-cyan-600 text-white border-0 text-sm font-semibold"
                onClick={openEb}
                disabled={ebResetBusy}
              >
                <Monitor className="w-4 h-4 mr-2" />Open Browser
              </Button>
            )}
            {ebVisible && (
              <Button
                variant="outline"
                className="w-full h-8 text-xs"
                onClick={async () => {
                  setEbVisible(false); lsSet(LS_KEY_EB_VISIBLE, "0");
                  setEbResetBusy(true);
                  await clearEbSession();
                  setEbResetBusy(false);
                }}
                disabled={ebResetBusy}
              >
                {ebResetBusy ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <X className="w-3 h-3 mr-1.5" />}
                Close &amp; Reset Browser
              </Button>
            )}

          </div>

          {/* ── Right column: embedded browser ── */}
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
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <Monitor className="w-14 h-14 opacity-15" />
                <p className="text-sm">Click <strong className="text-foreground">Open Browser</strong> to start</p>
                <p className="text-xs opacity-60">Then navigate to Instagram and use the <Clipboard className="w-3 h-3 inline mx-0.5" /> icons to paste each field</p>
              </div>
            )}
          </div>

        </div>
      )}
    </AppLayout>
  );
}
