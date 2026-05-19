import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useSidebarSetSlot } from "@/contexts/SidebarSlotContext";
import { useProxies, useCreateProxy } from "@/hooks/use-proxies";
import { userAgents as UA_POOL } from "@/shared/userAgents";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertCircle, Loader2, RefreshCw, Copy,
  User, Mail, KeyRound, Calendar, Globe, ShieldCheck, Server, Lock,
  Zap, List, Trash2, UserPlus, Eye, EyeOff, Plus, X,
  Cookie, Clock, Link2, Shuffle, Monitor, ChevronRight,
  Youtube, Search,
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

const IG_PREFIX = "Instagram 378.1.0.45.111 Android (";

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)].api;
}

function deriveEbUA(descriptor: string): string {
  const parts    = descriptor.split(";").map(s => s.trim());
  const apiLevel = parseInt((parts[0] ?? "").split("/")[0] ?? "0", 10);
  const model    = parts[4] ?? "";
  const vmap: Record<number, string> = {
    21: "5.0", 22: "5.1", 23: "6.0", 24: "7.0", 25: "7.1.1",
    26: "8.0", 27: "8.1", 28: "9",   29: "10",  30: "11",
    31: "12",  32: "12",  33: "13",  34: "14",  35: "15",
  };
  const av = vmap[apiLevel] ?? (apiLevel >= 35 ? "15" : "12");
  return `Mozilla/5.0 (Linux; Android ${av}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36`;
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

function detectImap(email: string): { server: string; port: number } {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { server: "imap.gmail.com", port: 993 };
  if (domain.startsWith("yahoo.")) return { server: "imap.mail.yahoo.com", port: 993 };
  if (["outlook.com","hotmail.com","live.com","msn.com"].includes(domain)) return { server: "imap-mail.outlook.com", port: 993 };
  if (domain === "icloud.com" || domain === "me.com") return { server: "imap.mail.me.com", port: 993 };
  return { server: "", port: 993 };
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

// ── Signup Browser Live Panel ──────────────────────────────────────────────────

function SignupBrowserPanel({
  open, onClose, steps, loading,
}: {
  open: boolean;
  onClose: () => void;
  steps: Array<{msg: string; ts: number}>;
  loading: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingBitmapRef = useRef<ImageBitmap | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHasFrame(false);
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProto}//${window.location.host}/api/signup/browser/stream`);
    ws.binaryType = "blob";
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (evt.data instanceof Blob) {
        createImageBitmap(evt.data).then(bitmap => {
          pendingBitmapRef.current?.close();
          pendingBitmapRef.current = bitmap;
          if (rafIdRef.current === null) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = null;
              const bmp = pendingBitmapRef.current;
              if (!bmp) return;
              pendingBitmapRef.current = null;
              const canvas = canvasRef.current;
              if (!canvas) { bmp.close(); return; }
              const ctx = canvas.getContext("2d");
              if (!ctx) { bmp.close(); return; }
              ctx.drawImage(bmp, 0, 0, 1280, 760);
              bmp.close();
              setHasFrame(true);
            });
          }
        }).catch(() => {});
        return;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
      if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      pendingBitmapRef.current?.close();
      pendingBitmapRef.current = null;
    };
  }, [open]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [steps]);

  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: "transparent" }} onClick={onClose} />
      <div
        className="fixed top-0 right-0 z-50 h-full flex flex-col shadow-2xl border-l border-[#30363d]"
        style={{ width: "min(700px, 52vw)", background: "#0d1117" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#21262d] bg-[#161b22] shrink-0">
          <Monitor className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-sm font-semibold text-slate-200">EB — Live View</span>
          {loading && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-400 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />LIVE
            </span>
          )}
          <span className="ml-auto text-[10px] font-mono text-slate-600">{steps.length} events</span>
          <button onClick={onClose} className="ml-2 p-1 rounded hover:bg-white/10 text-slate-500 hover:text-slate-200 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Canvas — live browser view */}
        <div className="relative shrink-0 bg-black" style={{ aspectRatio: "1280/760" }}>
          <canvas ref={canvasRef} width={1280} height={760} className="w-full h-full" />
          {!hasFrame && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85">
              {loading
                ? <><Loader2 className="w-6 h-6 text-cyan-400 animate-spin" /><span className="text-[11px] text-slate-400 font-mono">Waiting for browser to start…</span></>
                : <span className="text-[11px] text-slate-600 font-mono">No active browser session</span>
              }
            </div>
          )}
        </div>

        {/* Step log */}
        <div className="flex-1 overflow-y-auto p-3 font-mono text-[10.5px] leading-relaxed space-y-0.5">
          {steps.length === 0 ? (
            <div className="text-slate-600 italic py-4 px-1 text-center">
              {loading ? "Starting…" : "No events yet. Start an account creation to see live activity here."}
            </div>
          ) : steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2 hover:bg-white/[0.02] px-1 py-0.5 rounded">
              <span className="text-slate-700 shrink-0 select-none">{fmtTs(s.ts)}</span>
              <span className={`break-all ${stepClass(s.msg)}`}>{s.msg}</span>
            </div>
          ))}
          {loading && steps.length > 0 && (
            <div className="flex items-center gap-1.5 px-1 pt-1">
              <span className="inline-block w-2 h-3 bg-slate-400 animate-pulse rounded-sm" />
            </div>
          )}
          <div ref={logEndRef} />
        </div>

        <div className="px-4 py-2 border-t border-[#21262d] bg-[#161b22] shrink-0 text-[10px] text-slate-600">
          Close this panel at any time — it won't affect the running process.
        </div>
      </div>
    </>
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
const LS_KEY_CB_SITES          = "equinox_signup_cb_sites";
const LS_KEY_CB_SITES_MIN      = "equinox_signup_cb_sitesMin";
const LS_KEY_CB_SITES_MAX      = "equinox_signup_cb_sitesMax";
const LS_KEY_CB_SCROLL_MIN     = "equinox_signup_cb_scrollMin";
const LS_KEY_CB_SCROLL_MAX     = "equinox_signup_cb_scrollMax";
const LS_KEY_CB_LINKS_MIN      = "equinox_signup_cb_linksMin";
const LS_KEY_CB_LINKS_MAX      = "equinox_signup_cb_linksMax";
const LS_KEY_CB_INT_SCROLL_MIN = "equinox_signup_cb_intScrollMin";
const LS_KEY_CB_INT_SCROLL_MAX = "equinox_signup_cb_intScrollMax";
const LS_KEY_CB_RANDOM         = "equinox_signup_cb_random";
const LS_KEY_CB_YOUTUBE        = "equinox_signup_cb_youtube";
const LS_KEY_CB_GOOGLE         = "equinox_signup_cb_google";
const LS_KEY_CB_YT_ITEMS_MIN   = "equinox_signup_cb_yt_items_min";
const LS_KEY_CB_YT_ITEMS_MAX   = "equinox_signup_cb_yt_items_max";
const LS_KEY_CB_YT_DELAY_MIN   = "equinox_signup_cb_yt_delay_min";
const LS_KEY_CB_YT_DELAY_MAX   = "equinox_signup_cb_yt_delay_max";
const LS_KEY_CB_GGL_ITEMS_MIN  = "equinox_signup_cb_ggl_items_min";
const LS_KEY_CB_GGL_ITEMS_MAX  = "equinox_signup_cb_ggl_items_max";
const LS_KEY_CB_GGL_DELAY_MIN  = "equinox_signup_cb_ggl_delay_min";
const LS_KEY_CB_GGL_DELAY_MAX  = "equinox_signup_cb_ggl_delay_max";
const LS_KEY_CB_PCT_SITES      = "equinox_signup_cb_pct_sites";
const LS_KEY_CB_PCT_YT         = "equinox_signup_cb_pct_yt";
const LS_KEY_CB_PCT_GOOGLE     = "equinox_signup_cb_pct_google";

const SS_KEY_PASSWORD   = "equinox_api_password";
const SS_KEY_FIRSTNAME  = "equinox_api_firstname";
const SS_KEY_EMAIL      = "equinox_api_email";
const SS_KEY_EMAIL_PASS = "equinox_api_email_pass";
const SS_KEY_DOB        = "equinox_api_dob";
const SS_KEY_PROXY_ID   = "equinox_api_proxy_id";
const SS_KEY_UA_API     = "equinox_api_ua_api";
const SS_KEY_UA_EB      = "equinox_api_ua_eb";
const SS_KEY_TAB        = "equinox_api_tab";
const SS_KEY_RESULT     = "equinox_api_result";
const SS_KEY_VERIFY     = "equinox_api_verify_code";
const LS_KEY_API_LIMITS = "equinox_api_limits_v1";
const LS_KEY_IMAP       = "equinox_api_imap_v1";

function lsGet(key: string): string { return localStorage.getItem(key) ?? ""; }
function lsSet(key: string, v: string) { localStorage.setItem(key, v); }
function lsGetNum(key: string, fallback: number): number {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
function ssGet(key: string): string { return sessionStorage.getItem(key) ?? ""; }
function ssGetJson<T>(key: string, fallback: T): T {
  try { const r = sessionStorage.getItem(key); if (r) return JSON.parse(r) as T; } catch {}
  return fallback;
}
function ssSet(key: string, v: string) { sessionStorage.setItem(key, v); }
function ssSetJson(key: string, v: unknown) { sessionStorage.setItem(key, JSON.stringify(v)); }

const SS_ALL_KEYS = [
  SS_KEY_PASSWORD, SS_KEY_FIRSTNAME, SS_KEY_EMAIL,
  SS_KEY_EMAIL_PASS, SS_KEY_DOB, SS_KEY_PROXY_ID, SS_KEY_UA_API, SS_KEY_UA_EB,
  SS_KEY_TAB, SS_KEY_RESULT, SS_KEY_VERIFY,
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

  // ── EB Activity panel ──────────────────────────────────────────────────────
  const [ebPanelOpen, setEbPanelOpen] = useState(false);

  // ── Cookie Baker template settings ────────────────────────────────────────
  const [cbSites, setCbSitesRaw]               = useState(() => lsGet(LS_KEY_CB_SITES));
  const [cbSitesMin, setCbSitesMinRaw]         = useState(() => lsGetNum(LS_KEY_CB_SITES_MIN, 3));
  const [cbSitesMax, setCbSitesMaxRaw]         = useState(() => lsGetNum(LS_KEY_CB_SITES_MAX, 5));
  const [cbScrollMin, setCbScrollMinRaw]       = useState(() => lsGetNum(LS_KEY_CB_SCROLL_MIN, 5));
  const [cbScrollMax, setCbScrollMaxRaw]       = useState(() => lsGetNum(LS_KEY_CB_SCROLL_MAX, 15));
  const [cbLinksMin, setCbLinksMinRaw]         = useState(() => lsGetNum(LS_KEY_CB_LINKS_MIN, 1));
  const [cbLinksMax, setCbLinksMaxRaw]         = useState(() => lsGetNum(LS_KEY_CB_LINKS_MAX, 3));
  const [cbIntScrollMin, setCbIntScrollMinRaw] = useState(() => lsGetNum(LS_KEY_CB_INT_SCROLL_MIN, 5));
  const [cbIntScrollMax, setCbIntScrollMaxRaw] = useState(() => lsGetNum(LS_KEY_CB_INT_SCROLL_MAX, 10));
  const [cbRandom, setCbRandomRaw]             = useState(() => localStorage.getItem(LS_KEY_CB_RANDOM) !== "false");

  const setCbSites       = (v: string)  => { setCbSitesRaw(v);          lsSet(LS_KEY_CB_SITES, v); };
  const setCbSitesMin    = (v: number)  => { setCbSitesMinRaw(v);       lsSet(LS_KEY_CB_SITES_MIN, String(v)); };
  const setCbSitesMax    = (v: number)  => { setCbSitesMaxRaw(v);       lsSet(LS_KEY_CB_SITES_MAX, String(v)); };
  const setCbScrollMin   = (v: number)  => { setCbScrollMinRaw(v);      lsSet(LS_KEY_CB_SCROLL_MIN, String(v)); };
  const setCbScrollMax   = (v: number)  => { setCbScrollMaxRaw(v);      lsSet(LS_KEY_CB_SCROLL_MAX, String(v)); };
  const setCbLinksMin    = (v: number)  => { setCbLinksMinRaw(v);       lsSet(LS_KEY_CB_LINKS_MIN, String(v)); };
  const setCbLinksMax    = (v: number)  => { setCbLinksMaxRaw(v);       lsSet(LS_KEY_CB_LINKS_MAX, String(v)); };
  const setCbIntScrollMin = (v: number) => { setCbIntScrollMinRaw(v);   lsSet(LS_KEY_CB_INT_SCROLL_MIN, String(v)); };
  const setCbIntScrollMax = (v: number) => { setCbIntScrollMaxRaw(v);   lsSet(LS_KEY_CB_INT_SCROLL_MAX, String(v)); };
  const setCbRandom      = (v: boolean) => { setCbRandomRaw(v);         lsSet(LS_KEY_CB_RANDOM, String(v)); };

  const [cbVisitYoutube,  setCbVisitYoutubeRaw]  = useState(() => localStorage.getItem(LS_KEY_CB_YOUTUBE) === "true");
  const [cbVisitGoogle,   setCbVisitGoogleRaw]   = useState(() => localStorage.getItem(LS_KEY_CB_GOOGLE)  === "true");
  const [cbYtItemsMin,    setCbYtItemsMinRaw]    = useState(() => lsGetNum(LS_KEY_CB_YT_ITEMS_MIN,  1));
  const [cbYtItemsMax,    setCbYtItemsMaxRaw]    = useState(() => lsGetNum(LS_KEY_CB_YT_ITEMS_MAX,  3));
  const [cbYtDelayMin,    setCbYtDelayMinRaw]    = useState(() => lsGetNum(LS_KEY_CB_YT_DELAY_MIN,  5));
  const [cbYtDelayMax,    setCbYtDelayMaxRaw]    = useState(() => lsGetNum(LS_KEY_CB_YT_DELAY_MAX, 30));
  const [cbGglItemsMin,   setCbGglItemsMinRaw]   = useState(() => lsGetNum(LS_KEY_CB_GGL_ITEMS_MIN, 1));
  const [cbGglItemsMax,   setCbGglItemsMaxRaw]   = useState(() => lsGetNum(LS_KEY_CB_GGL_ITEMS_MAX, 3));
  const [cbGglDelayMin,   setCbGglDelayMinRaw]   = useState(() => lsGetNum(LS_KEY_CB_GGL_DELAY_MIN, 5));
  const [cbGglDelayMax,   setCbGglDelayMaxRaw]   = useState(() => lsGetNum(LS_KEY_CB_GGL_DELAY_MAX, 30));
  const [cbPctSites,      setCbPctSitesRaw]      = useState(() => lsGetNum(LS_KEY_CB_PCT_SITES, 34));
  const [cbPctYt,         setCbPctYtRaw]         = useState(() => lsGetNum(LS_KEY_CB_PCT_YT, 33));
  const [cbPctGoogle,     setCbPctGoogleRaw]     = useState(() => lsGetNum(LS_KEY_CB_PCT_GOOGLE, 33));
  const setCbVisitYoutube  = (v: boolean) => { setCbVisitYoutubeRaw(v);  lsSet(LS_KEY_CB_YOUTUBE, String(v)); };
  const setCbVisitGoogle   = (v: boolean) => { setCbVisitGoogleRaw(v);   lsSet(LS_KEY_CB_GOOGLE,  String(v)); };
  const setCbYtItemsMin    = (v: number)  => { setCbYtItemsMinRaw(v);    lsSet(LS_KEY_CB_YT_ITEMS_MIN,  String(v)); };
  const setCbYtItemsMax    = (v: number)  => { setCbYtItemsMaxRaw(v);    lsSet(LS_KEY_CB_YT_ITEMS_MAX,  String(v)); };
  const setCbYtDelayMin    = (v: number)  => { setCbYtDelayMinRaw(v);    lsSet(LS_KEY_CB_YT_DELAY_MIN,  String(v)); };
  const setCbYtDelayMax    = (v: number)  => { setCbYtDelayMaxRaw(v);    lsSet(LS_KEY_CB_YT_DELAY_MAX,  String(v)); };
  const setCbGglItemsMin   = (v: number)  => { setCbGglItemsMinRaw(v);   lsSet(LS_KEY_CB_GGL_ITEMS_MIN, String(v)); };
  const setCbGglItemsMax   = (v: number)  => { setCbGglItemsMaxRaw(v);   lsSet(LS_KEY_CB_GGL_ITEMS_MAX, String(v)); };
  const setCbGglDelayMin   = (v: number)  => { setCbGglDelayMinRaw(v);   lsSet(LS_KEY_CB_GGL_DELAY_MIN, String(v)); };
  const setCbGglDelayMax   = (v: number)  => { setCbGglDelayMaxRaw(v);   lsSet(LS_KEY_CB_GGL_DELAY_MAX, String(v)); };
  const setCbPctSites      = (v: number)  => { setCbPctSitesRaw(v);      lsSet(LS_KEY_CB_PCT_SITES, String(v)); };
  const setCbPctYt         = (v: number)  => { setCbPctYtRaw(v);         lsSet(LS_KEY_CB_PCT_YT,    String(v)); };
  const setCbPctGoogle     = (v: number)  => { setCbPctGoogleRaw(v);     lsSet(LS_KEY_CB_PCT_GOOGLE,String(v)); };

  // ── Signup fields ──────────────────────────────────────────────────────────
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

  const [apiLimits, setApiLimitsRaw] = useState(loadApiLimits);
  const setApiLimits = (v: typeof DEFAULT_API_LIMITS) => {
    setApiLimitsRaw(v);
    localStorage.setItem(LS_KEY_API_LIMITS, JSON.stringify(v));
  };

  const [userAgentApi, setUserAgentApiRaw] = useState(() => ssGet(SS_KEY_UA_API) || UA_POOL[0].api);
  const setUserAgentApi = (v: string) => { setUserAgentApiRaw(v); ssSet(SS_KEY_UA_API, v); };
  const [userAgentEb, setUserAgentEbRaw]   = useState(() => ssGet(SS_KEY_UA_EB) || deriveEbUA(ssGet(SS_KEY_UA_API) || UA_POOL[0].api));
  const setUserAgentEb  = (v: string) => { setUserAgentEbRaw(v);  ssSet(SS_KEY_UA_EB,  v); };

  const [emailPass, setEmailPassRaw] = useState(() => ssGet(SS_KEY_EMAIL_PASS));
  const setEmailPass = (v: string) => { setEmailPassRaw(v); ssSet(SS_KEY_EMAIL_PASS, v); };
  const _savedImap = loadImap();
  const [imapServer, setImapServerRaw] = useState(_savedImap.server);
  const [imapPort, setImapPortRaw]     = useState(_savedImap.port);
  const setImapServer = (v: string) => { setImapServerRaw(v); localStorage.setItem(LS_KEY_IMAP, JSON.stringify({ server: v, port: imapPort })); };
  const setImapPort   = (v: number) => { setImapPortRaw(v);   localStorage.setItem(LS_KEY_IMAP, JSON.stringify({ server: imapServer, port: v })); };

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

  const createProxy = useCreateProxy();
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [newProxyHost, setNewProxyHost] = useState("");
  const [newProxyPort, setNewProxyPort] = useState("");
  const [newProxyUser, setNewProxyUser] = useState("");
  const [newProxyPass, setNewProxyPass] = useState("");
  const [addProxyErr, setAddProxyErr]   = useState("");

  const handleAddProxy = async () => {
    setAddProxyErr("");
    const host = newProxyHost.trim();
    const port = parseInt(newProxyPort, 10);
    if (!host) return setAddProxyErr("Host is required");
    if (!port || port < 1 || port > 65535) return setAddProxyErr("Port must be 1–65535");
    try {
      const created = await createProxy.mutateAsync({
        host, port,
        username: newProxyUser.trim() || null,
        password: newProxyPass.trim() || null,
      });
      setSelectedProxyId(created.id);
      setShowAddProxy(false);
      setNewProxyHost(""); setNewProxyPort(""); setNewProxyUser(""); setNewProxyPass("");
    } catch (e: any) {
      setAddProxyErr(e?.message ?? "Failed to save proxy");
    }
  };

  const years = Array.from({ length: 80 }, (_, i) => 2006 - i);
  const days  = Array.from({ length: 31 }, (_, i) => i + 1);

  useEffect(() => {
    if (!email.includes("@")) return;
    const detected = detectImap(email);
    if (detected.server) { setImapServer(detected.server); setImapPort(detected.port); }
  }, [email]);

  const selectedProxy = proxies?.find(p => p.id === Number(selectedProxyId));
  const canSubmit = usernameSpin.trim() && password && email && selectedProxyId;

  const handleCreate = async () => {
    if (!canSubmit) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
    setLoading(true);
    setResult(null);
    setVerifyCode("");
    setLiveSteps([]);
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
        userAgentEb,
        apiLimits,
        imapHost: imapServer.trim() || undefined,
        imapPort: imapServer.trim() ? imapPort : undefined,
        imapUser: imapServer.trim() ? email.trim() : undefined,
        imapPass: emailPass.trim() || undefined,
        preBakeSites: cbSites.trim() || undefined,
        preBakeSitesMin: cbSitesMin,
        preBakeSitesMax: cbSitesMax,
        preBakeScrollMin: cbScrollMin,
        preBakeScrollMax: cbScrollMax,
        preBakeLinksMin: cbLinksMin,
        preBakeLinksMax: cbLinksMax,
        preBakeInternalScrollMin: cbIntScrollMin,
        preBakeInternalScrollMax: cbIntScrollMax,
        preBakeRandom: cbRandom,
        preBakeYoutube: cbVisitYoutube,
        preBakeGoogle: cbVisitGoogle,
        preBakeYtItemsMin: cbYtItemsMin,
        preBakeYtItemsMax: cbYtItemsMax,
        preBakeYtDelayMin: cbYtDelayMin,
        preBakeYtDelayMax: cbYtDelayMax,
        preBakeGglItemsMin: cbGglItemsMin,
        preBakeGglItemsMax: cbGglItemsMax,
        preBakeGglDelayMin: cbGglDelayMin,
        preBakeGglDelayMax: cbGglDelayMax,
        preBakePctSites: cbPctSites,
        preBakePctYt: cbPctYt,
        preBakePctGoogle: cbPctGoogle,
      };
      if (selectedProxy) {
        body.proxyHost     = selectedProxy.host;
        body.proxyPort     = selectedProxy.port;
        body.proxyUsername = selectedProxy.username ?? undefined;
        body.proxyPassword = selectedProxy.password ?? undefined;
      }
      const res = await fetch("/api/signup/start-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.body) throw new Error("No streaming body from server");
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const dataLine = ev.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(6));
            if (data.type === "step") {
              setLiveSteps(prev => [...prev, { msg: data.msg, ts: data.ts ?? Date.now() }]);
            } else if (data.type === "done") {
              setResult(data.result as SignupResult);
              setLoading(false);
            }
          } catch {}
        }
      }
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
    const ua = randomUA(); setUserAgentApi(ua); setUserAgentEb(deriveEbUA(ua));
    setEmail("");
    setFirstName("");
    setEmailPass("");
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
      {/* EB Activity floating panel — rendered at root so it overlays everything */}
      <SignupBrowserPanel
        open={ebPanelOpen}
        onClose={() => setEbPanelOpen(false)}
        steps={liveSteps}
        loading={loading}
      />

      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an Account</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Visits websites to warm up cookies first, then creates the Instagram account via the mobile API.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* EB activity button — always visible so user can open it at any time */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEbPanelOpen(v => !v)}
            className={`h-8 text-xs gap-1.5 ${loading ? "border-cyan-500 text-cyan-500" : ""}`}
          >
            <Monitor className={`w-3.5 h-3.5 ${loading ? "text-cyan-500" : ""}`} />
            {loading && <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />}
            Watch EB
            <ChevronRight className="w-3 h-3 opacity-50" />
          </Button>
          {result && tab === "create" && (
            <Button variant="outline" size="sm" onClick={handleReset} className="h-8">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />New Attempt
            </Button>
          )}
        </div>
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
            {t === "create"
              ? <><Cookie className="w-3.5 h-3.5 inline mr-1.5" />Create</>
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
        <div className="overflow-auto" style={{ height: "calc(100vh - 200px)" }}>
          <div className="max-w-2xl space-y-3">

            {/* ── Cookie Baker Template ── */}
            <div className="desktop-card p-4 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-border">
                <Cookie className="w-4 h-4 text-cyan-500" />
                <p className="text-xs font-semibold uppercase tracking-wider text-foreground">Cookie Baker</p>
                <span className="text-[10px] text-muted-foreground font-normal normal-case ml-1">— warm up browser cookies before signup</span>
              </div>

              {/* Row 1: Sites to Visit + Visit Time */}
              <div className="flex flex-wrap gap-4">
                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    <Globe className="w-3 h-3 text-primary shrink-0" /> Sites to Visit
                  </p>
                  <div className="flex items-center gap-1">
                    {numInput(cbSitesMin, setCbSitesMin, 1)}
                    <span className="text-xs text-muted-foreground">–</span>
                    {numInput(cbSitesMax, setCbSitesMax, 1)}
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    <Clock className="w-3 h-3 text-violet-500 shrink-0" /> Visit Time
                  </p>
                  <div className="flex items-center gap-1">
                    {numInput(cbScrollMin, setCbScrollMin, 1)}
                    <span className="text-xs text-muted-foreground">–</span>
                    {numInput(cbScrollMax, setCbScrollMax, 1)}
                    <span className="text-[10px] text-muted-foreground">sec</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 justify-end">
                  <label className="flex items-center gap-2 cursor-pointer select-none mt-4">
                    <Checkbox
                      checked={cbRandom}
                      onCheckedChange={v => setCbRandom(!!v)}
                      disabled={locked}
                    />
                    <span className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                      <Shuffle className="w-3 h-3 text-cyan-500" /> Random order
                    </span>
                  </label>
                </div>
              </div>

              {/* Row 2: Internal Links + Internal Visit Time */}
              <div className="flex flex-wrap gap-4 pt-1 border-t border-border/50">
                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    <Link2 className="w-3 h-3 text-blue-500 shrink-0" /> Internal Links
                  </p>
                  <div className="flex items-center gap-1">
                    {numInput(cbLinksMin, setCbLinksMin, 0)}
                    <span className="text-xs text-muted-foreground">–</span>
                    {numInput(cbLinksMax, setCbLinksMax, 0)}
                    <span className="text-[10px] text-muted-foreground">links</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    <Clock className="w-3 h-3 text-teal-500 shrink-0" /> Internal Visit Time
                  </p>
                  <div className="flex items-center gap-1">
                    {numInput(cbIntScrollMin, setCbIntScrollMin, 1)}
                    <span className="text-xs text-muted-foreground">–</span>
                    {numInput(cbIntScrollMax, setCbIntScrollMax, 1)}
                    <span className="text-[10px] text-muted-foreground">sec</span>
                  </div>
                </div>
              </div>

              {/* Sites list */}
              <div>
                <Label className="text-xs flex items-center gap-1 mb-1.5">
                  <Globe className="w-3 h-3 text-primary" /> Website List
                </Label>
                <Textarea
                  placeholder={"www.reddit.com\nwww.bbc.co.uk\nhttps://news.ycombinator.com\nwww.wikipedia.org"}
                  value={cbSites}
                  onChange={e => setCbSites(e.target.value)}
                  className="font-mono text-xs min-h-[90px] resize-y"
                  disabled={locked}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  One URL per line. Visited using the account's proxy and user agent before signup begins. Leave empty to skip.
                </p>
              </div>

              {/* Platform quick-visit options */}
              <div className="space-y-2 pt-1 border-t border-border/50">
                {/* YouTube */}
                <div className={`rounded-lg border transition-colors ${
                  cbVisitYoutube ? "border-red-400 bg-red-50/40 dark:bg-red-950/20" : "border-border"
                } ${locked ? "opacity-50 pointer-events-none" : ""}`}>
                  <label className="flex items-center gap-3 p-3 cursor-pointer select-none">
                    <Checkbox
                      checked={cbVisitYoutube}
                      onCheckedChange={v => setCbVisitYoutube(!!v)}
                      disabled={locked}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <Youtube className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      <span className="text-xs font-semibold">Visit YouTube</span>
                      <span className="text-[10px] text-muted-foreground ml-1 truncate">
                        Searches, watches a video, scrolls the feed
                      </span>
                    </div>
                  </label>
                  {cbVisitYoutube && (
                    <div className="px-3 pb-3 grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Items (min–max)</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" min={1} max={20}
                            value={cbYtItemsMin}
                            onChange={e => setCbYtItemsMin(Math.max(1, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input
                            type="number" min={1} max={20}
                            value={cbYtItemsMax}
                            onChange={e => setCbYtItemsMax(Math.max(cbYtItemsMin, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Delay secs (min–max)</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" min={1} max={300}
                            value={cbYtDelayMin}
                            onChange={e => setCbYtDelayMin(Math.max(1, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input
                            type="number" min={1} max={300}
                            value={cbYtDelayMax}
                            onChange={e => setCbYtDelayMax(Math.max(cbYtDelayMin, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Google */}
                <div className={`rounded-lg border transition-colors ${
                  cbVisitGoogle ? "border-blue-400 bg-blue-50/40 dark:bg-blue-950/20" : "border-border"
                } ${locked ? "opacity-50 pointer-events-none" : ""}`}>
                  <label className="flex items-center gap-3 p-3 cursor-pointer select-none">
                    <Checkbox
                      checked={cbVisitGoogle}
                      onCheckedChange={v => setCbVisitGoogle(!!v)}
                      disabled={locked}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <Search className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                      <span className="text-xs font-semibold">Visit Google</span>
                      <span className="text-[10px] text-muted-foreground ml-1 truncate">
                        Searches, clicks a result, browses briefly
                      </span>
                    </div>
                  </label>
                  {cbVisitGoogle && (
                    <div className="px-3 pb-3 grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Items (min–max)</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" min={1} max={20}
                            value={cbGglItemsMin}
                            onChange={e => setCbGglItemsMin(Math.max(1, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input
                            type="number" min={1} max={20}
                            value={cbGglItemsMax}
                            onChange={e => setCbGglItemsMax(Math.max(cbGglItemsMin, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Delay secs (min–max)</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" min={1} max={300}
                            value={cbGglDelayMin}
                            onChange={e => setCbGglDelayMin(Math.max(1, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input
                            type="number" min={1} max={300}
                            value={cbGglDelayMax}
                            onChange={e => setCbGglDelayMax(Math.max(cbGglDelayMin, +e.target.value))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Order percentage randomiser */}
                {(cbSites.trim() || cbVisitYoutube || cbVisitGoogle) && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Shuffle className="w-3 h-3 text-cyan-500" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Visit Order — % Chance Each Source is First</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {cbSites.trim() && (
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground">Website List %</Label>
                          <Input
                            type="number" min={0} max={100}
                            value={cbPctSites}
                            onChange={e => setCbPctSites(Math.min(100, Math.max(0, +e.target.value)))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      )}
                      {cbVisitYoutube && (
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground">YouTube %</Label>
                          <Input
                            type="number" min={0} max={100}
                            value={cbPctYt}
                            onChange={e => setCbPctYt(Math.min(100, Math.max(0, +e.target.value)))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      )}
                      {cbVisitGoogle && (
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground">Google %</Label>
                          <Input
                            type="number" min={0} max={100}
                            value={cbPctGoogle}
                            onChange={e => setCbPctGoogle(Math.min(100, Math.max(0, +e.target.value)))}
                            className="h-7 text-xs text-center px-1" disabled={locked}
                          />
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Set the probability each source is visited first. Values don't need to sum to 100 — they're treated as weights.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ── Account Details ── */}
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
                <Input value={password} onChange={e => setPassword(e.target.value)} className="h-8 text-sm font-mono" disabled={locked} />
              </div>
            </div>

            {/* ── Profile Info ── */}
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
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@domain.com" className="h-8 text-sm" disabled={locked} />
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
              </div>
            </div>

            {/* ── Date of Birth ── */}
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

            {/* ── Proxy ── */}
            <div className="desktop-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs flex items-center gap-1"><Globe className="w-3 h-3" />Proxy <span className="text-red-500 ml-0.5">*</span></Label>
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
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400">New Proxy</p>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Host</Label>
                      <Input value={newProxyHost} onChange={e => setNewProxyHost(e.target.value)} placeholder="123.45.67.89" className="h-7 text-xs font-mono" disabled={createProxy.isPending} />
                    </div>
                    <div className="w-20 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Port</Label>
                      <Input value={newProxyPort} onChange={e => setNewProxyPort(e.target.value)} placeholder="8080" className="h-7 text-xs font-mono" disabled={createProxy.isPending} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Username <span className="font-normal">(optional)</span></Label>
                      <Input value={newProxyUser} onChange={e => setNewProxyUser(e.target.value)} placeholder="user" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Password <span className="font-normal">(optional)</span></Label>
                      <Input type="password" value={newProxyPass} onChange={e => setNewProxyPass(e.target.value)} placeholder="••••••" className="h-7 text-xs" disabled={createProxy.isPending} />
                    </div>
                  </div>
                  {addProxyErr && <p className="text-[10px] text-red-600 flex items-center gap-1"><XCircle className="w-3 h-3 shrink-0" />{addProxyErr}</p>}
                  <Button size="sm" className="h-7 text-xs bg-sky-500 hover:bg-sky-600 text-white border-0 w-full" onClick={handleAddProxy} disabled={createProxy.isPending || !newProxyHost.trim() || !newProxyPort.trim()}>
                    {createProxy.isPending ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Saving…</> : <><Plus className="w-3 h-3 mr-1.5" />Save &amp; Select Proxy</>}
                  </Button>
                </div>
              )}
            </div>

            {/* ── Email / IMAP ── */}
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
              <p className="text-[10px] text-muted-foreground">If filled, the server polls your inbox and submits the verification code automatically.</p>
            </div>

            {/* ── API Controller ── */}
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
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">API User Agent — Device</Label>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" disabled={locked} onClick={() => { const ua = randomUA(); setUserAgentApi(ua); setUserAgentEb(deriveEbUA(ua)); }}>
                    Randomise
                  </Button>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground px-1 truncate select-none">{IG_PREFIX}…)</div>
                <Input value={userAgentApi} onChange={e => setUserAgentApi(e.target.value)} className="h-8 text-xs font-mono" disabled={locked} />
                <p className="text-[10px] text-muted-foreground">Device descriptor — the Instagram prefix is added automatically. Pool of {UA_POOL.length} devices.</p>
              </div>
              <div className="space-y-1.5 pt-1 border-t border-border/60">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Globe className="w-3 h-3" />EB User Agent — Cookie Harvest (Chrome)
                </Label>
                <div className="h-8 px-3 flex items-center rounded-md border border-border bg-muted/40 text-[10px] font-mono text-muted-foreground truncate select-all">
                  {userAgentEb}
                </div>
              </div>
            </div>

            {/* ── Submit ── */}
            {!result && (
              <Button
                className="w-full h-11 bg-cyan-500 hover:bg-cyan-600 text-white border-0 text-sm font-semibold"
                onClick={handleCreate}
                disabled={loading || !canSubmit}
              >
                {loading ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating Account…</>
                ) : (
                  <><Cookie className="w-4 h-4 mr-2" />{cbSites.trim() ? "Bake Cookies + Create Account" : "Create Account via API"}</>
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
                     result.status === "email_verification" ? "Email Verification Required" :
                     "Phone Verification Required"}
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

                {result.status === "error" && result.rawResponse && (
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
                  <div className="space-y-2">
                    <p className="text-xs text-cyan-700 dark:text-cyan-400">
                      {result.status === "email_verification"
                        ? "Instagram sent a verification code to your email. Enter it below."
                        : "Instagram sent an SMS to your phone. Enter the code below."}
                    </p>
                    <div className="flex gap-2 items-center">
                      <Input
                        value={verifyCode}
                        onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        maxLength={6}
                        autoFocus
                        className="h-10 text-center text-xl font-mono tracking-[0.4em] w-40 border-cyan-400 focus:border-cyan-500"
                      />
                      <Button
                        onClick={handleVerify}
                        disabled={verifying || verifyCode.length < 6}
                        className="h-10 px-5 bg-cyan-500 hover:bg-cyan-600 text-white border-0 font-semibold"
                      >
                        {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit Code"}
                      </Button>
                    </div>
                  </div>
                )}

                <Button variant="outline" size="sm" className="h-7 text-xs w-full" onClick={handleReset}>
                  <RefreshCw className="w-3 h-3 mr-1.5" />New Attempt
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
