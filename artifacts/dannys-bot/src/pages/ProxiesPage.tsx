import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";

function FilledPersonIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle fill="currentColor" cx="12" cy="7" r="4.5"/>
      <path fill="currentColor" d="M20.5 21c0-4.694-3.806-8.5-8.5-8.5S3.5 16.306 3.5 21h17z"/>
    </svg>
  );
}
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProxies, useCreateProxy, useUpdateProxy, useDeleteProxy } from "@/hooks/use-proxies";
import { useProfiles, useCreatorProfiles } from "@/hooks/use-profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Plus, Trash2, Shield, User, X, Wifi, WifiOff, Loader2,
  Upload, Download, Trash, Search,
  ArrowUp, ArrowDown, ArrowUpDown, Settings2, ChevronDown, ChevronUp, Smartphone,
  Usb, RotateCcw, Clock, Play, Square,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Proxy, Profile } from "@shared/schema";
import { TrustScoreBadge } from "@/components/TrustScoreBadge";

type PingResult = { alive: boolean; latencyMs: number; error?: string; adapterIp?: string } | null;

interface AdapterInfo { name: string; ip: string; family: string; internal: boolean; }

type ProxyCol = "proxy" | "type" | "username" | "password" | "status" | "accounts" | "acctStatus" | "acctTrustScore" | "rotate";
const DEFAULT_PROXY_COL_ORDER: ProxyCol[] = ["proxy", "type", "username", "password", "accounts", "status", "acctStatus", "acctTrustScore"];
const DEFAULT_PROXY_COL_WIDTHS: Record<ProxyCol, number> = { proxy: 210, type: 90, username: 120, password: 120, status: 110, accounts: 100, acctStatus: 90, acctTrustScore: 80, rotate: 130 };
const PROXY_COL_LABELS: Record<ProxyCol, string> = { proxy: "Proxy / Adapter", type: "Type", username: "Username", password: "Password", status: "Proxy Status", accounts: "Accounts", acctStatus: "Status", acctTrustScore: "Trust", rotate: "Rotate Every" };
const ACTIONS_COL_WIDTH = 100;

// Lightweight status pill for the proxy page (mirrors the full STATUS_META in ProfilesPage)
function acctStatusPill(s: string): string {
  if (s === "valid") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "banned" || s === "account_disabled" || s === "compromised" || s === "invalid_credentials") return "bg-red-50 text-red-700 border-red-200";
  if (s === "captcha" || s === "suspended" || s === "temporary_locked" || s === "automated_behaviour_detected" || s === "scrape_warning") return "bg-amber-50 text-amber-700 border-amber-200";
  if (s === "verifying") return "bg-sky-50 text-sky-700 border-sky-200";
  if (s === "logged_out" || s === "bad_password") return "bg-orange-50 text-orange-700 border-orange-200";
  if (s === "email_verification" || s === "phone_validation" || s === "password_reset" || s === "own_phone_verification") return "bg-blue-50 text-blue-700 border-blue-200";
  if (s === "selfie_verification") return "bg-purple-50 text-purple-700 border-purple-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}
function acctStatusLabel(s: string): string {
  const m: Record<string, string> = {
    valid: "Valid", pending: "Pending", banned: "Banned", verifying: "Verifying",
    captcha: "Captcha", bad_password: "Bad Pass", logged_out: "Logged Out",
    account_disabled: "Disabled", compromised: "Compromised", suspended: "Suspended",
    invalid_credentials: "Inv. Creds", temporary_locked: "Temp Locked",
    automated_behaviour_detected: "Auto Behav.", no_internet: "No Internet",
    email_verification: "Email Verify", phone_validation: "Phone Valid.",
    password_reset: "Pass Reset", scrape_warning: "Scrape Warn",
    selfie_verification: "Selfie Verify", own_phone_verification: "Phone Verify",
    email_connection: "Email Connect", captcha_disabled: "Captcha Off",
  };
  return m[s] ?? s;
}

function parseJarveeFile(buffer: ArrayBuffer): Array<{ host: string; port: number; username: string | null; password: string | null }> {
  const text = new TextDecoder("utf-16le").decode(buffer).replace(/^\ufeff/, "");
  return text
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("proxy-"))
    .map(line => {
      const parts = line.split("\t");
      const hostPort = parts[0].trim();
      const lastColon = hostPort.lastIndexOf(":");
      if (lastColon === -1) return null;
      const host = hostPort.slice(0, lastColon).trim();
      const port = Number(hostPort.slice(lastColon + 1).trim());
      if (!host || isNaN(port) || port < 1 || port > 65535) return null;
      return { host, port, username: parts[1]?.trim() || null, password: parts[2]?.trim() || null };
    })
    .filter(Boolean) as Array<{ host: string; port: number; username: string | null; password: string | null }>;
}

function exportProxies(proxies: Proxy[]) {
  const header = "proxy-ip:port\tproxy-username\tproxy-password";
  const rows = proxies.map(p => `${p.host}:${p.port}\t${p.username ?? ""}\t${p.password ?? ""}`);
  const text = [header, ...rows].join("\r\n");
  const buf = new ArrayBuffer(2 + text.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, 0xff);
  view.setUint8(1, 0xfe);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  const blob = new Blob([buf], { type: "text/plain;charset=utf-16le" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "proxies.txt";
  a.click();
  URL.revokeObjectURL(url);
}

interface ProxyRowProps {
  proxy: Proxy;
  allProfiles: Profile[];
  unassignedProfiles: Profile[];
  pingResult: PingResult;
  pinging: boolean;
  onPing: (proxyId: number) => void;
  even: boolean;
  colOrder: ProxyCol[];
  colWidths: Record<ProxyCol, number>;
  keepValid: boolean;
  adapters: AdapterInfo[];
}

function ProxyRow({
  proxy, allProfiles, unassignedProfiles, pingResult, pinging, onPing, even, colOrder, colWidths, keepValid, adapters,
}: ProxyRowProps) {
  const deleteProxyMutation = useDeleteProxy();
  const updateProxyMutation = useUpdateProxy();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAdapter = proxy.proxyType === "adapter";

  // Show blank when the proxy was just added with the default sentinel values
  const [hostPort, setHostPort] = useState(
    proxy.host === "0.0.0.0" && proxy.port === 8080 ? "" : `${proxy.host}:${proxy.port}`
  );
  const [username, setUsername] = useState(proxy.username ?? "");
  const [password, setPassword] = useState(proxy.password ?? "");
  const [proxyType, setProxyType] = useState<"http" | "socks5" | "adapter">((proxy.proxyType as "http" | "socks5" | "adapter") ?? "http");
  const [adapterName, setAdapterName] = useState(proxy.adapterName ?? "");
  const [customName, setCustomName] = useState((proxy as any).name ?? "");
  const [rotateMin, setRotateMin] = useState(proxy.rotateEveryMin ?? "");
  const [rotateMax, setRotateMax] = useState(proxy.rotateEveryMax ?? "");

  useEffect(() => {
    if (!isAdapter) {
      setHostPort(`${proxy.host}:${proxy.port}`);
    }
    setUsername(proxy.username ?? "");
    setPassword(proxy.password ?? "");
    setProxyType((proxy.proxyType as "http" | "socks5" | "adapter") ?? "http");
    setAdapterName(proxy.adapterName ?? "");
    setRotateMin(proxy.rotateEveryMin ?? "");
    setRotateMax(proxy.rotateEveryMax ?? "");
  }, [proxy, isAdapter]);

  const saveField = useCallback((field: "hostPort" | "username" | "password" | "type") => {
    let data: Record<string, string | number | null> = {};
    if (field === "hostPort") {
      let host: string;
      let port: number;
      if (!hostPort.includes(":")) {
        host = hostPort.trim();
        port = proxy.port;
      } else {
        const parts = hostPort.split(":");
        host = parts.slice(0, -1).join(":").trim();
        port = parseInt(parts[parts.length - 1], 10);
      }
      if (!host || isNaN(port) || port < 1 || port > 65535) {
        toast({ title: "Invalid format", description: "Use host:port format", variant: "destructive" });
        setHostPort(`${proxy.host}:${proxy.port}`);
        return;
      }
      data = { host, port };
    } else if (field === "username") {
      data = { username: username || null };
    } else if (field === "password") {
      data = { password: password || null };
    } else {
      data = { proxyType };
    }
    updateProxyMutation.mutate({ id: proxy.id, data });
  }, [hostPort, username, password, proxyType, proxy, updateProxyMutation, toast]);

  const saveAdapterName = useCallback((name: string) => {
    setAdapterName(name);
    updateProxyMutation.mutate({ id: proxy.id, data: { adapterName: name } }, {
      onSuccess: () => {
        if (name) {
          // Auto-start the tunnel whenever an adapter is (re-)selected
          apiRequest("POST", `/api/proxies/${proxy.id}/adapter/start`).catch(() => {});
        }
      },
    });
  }, [proxy.id, updateProxyMutation]);

  const saveCustomName = useCallback(() => {
    updateProxyMutation.mutate({ id: proxy.id, data: { name: customName || adapterName } });
  }, [proxy.id, customName, adapterName, updateProxyMutation]);

  const saveRotate = useCallback(() => {
    const min = rotateMin === "" ? null : Number(rotateMin);
    const max = rotateMax === "" ? null : Number(rotateMax);
    updateProxyMutation.mutate({ id: proxy.id, data: { rotateEveryMin: min, rotateEveryMax: max } });
  }, [proxy.id, rotateMin, rotateMax, updateProxyMutation]);

  const assigned = allProfiles.filter(p => p.proxyId === proxy.id);

  const [assignPending, setAssignPending] = useState(false);

  const handleAssign = async (profileId: number) => {
    setAssignPending(true);
    try {
      await fetch(`/api/profiles/${profileId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: proxy.id, ...(keepValid ? { preserveAccountStatus: true } : {}) }),
        credentials: "include",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    } finally { setAssignPending(false); }
  };

  const handleUnassign = async (profile: Profile) => {
    setAssignPending(true);
    try {
      await fetch(`/api/profiles/${profile.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: null, ...(keepValid ? { preserveAccountStatus: true } : {}) }),
        credentials: "include",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    } finally { setAssignPending(false); }
  };

  const rowBg = even ? "bg-slate-50/60" : "bg-white";

  const currentAdapterIp = adapters.find(a => a.name === adapterName)?.ip;

  return (
    <>
      {/* Main proxy row */}
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-border/30 transition-colors hover:bg-slate-100/60 ${rowBg} ${isAdapter ? "bg-violet-50/40 dark:bg-violet-950/10" : ""}`}>
        <div className="flex items-center gap-2 flex-1">
          {colOrder.map(col => {
            if (col === "acctStatus" || col === "acctTrustScore") return (
              <div key={col} className="shrink-0" style={{ width: colWidths[col] }} />
            );
            if (col === "accounts") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.accounts }}>
                {assigned.length > 0 ? (() => {
                  const validCount = assigned.filter(p => p.accountStatus === "valid").length;
                  return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-semibold">
                      <User className="w-3 h-3" />
                      <span className="text-emerald-600">{validCount}</span>
                      <span className="text-muted-foreground/60">/</span>
                      <span>{assigned.length}</span>
                    </span>
                  );
                })() : (
                  <span className="text-[11px] text-muted-foreground/40">—</span>
                )}
              </div>
            );
            if (col === "proxy") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.proxy }}>
                {isAdapter ? (
                  <div className="flex flex-col gap-0.5 w-full">
                    <input
                      type="text"
                      value={customName}
                      onChange={e => setCustomName(e.target.value)}
                      onBlur={saveCustomName}
                      onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                      className="h-6 w-full text-xs font-semibold bg-transparent border-0 border-b border-transparent hover:border-violet-300 focus:border-violet-500 focus:outline-none text-foreground px-0 placeholder:text-muted-foreground/40"
                      placeholder="Name this adapter…"
                    />
                    <div className="flex items-center gap-1">
                      <Usb className="w-3 h-3 text-violet-400 shrink-0" />
                      <select
                        value={adapterName}
                        onChange={e => saveAdapterName(e.target.value)}
                        className="flex-1 text-[10px] text-muted-foreground bg-transparent border-0 focus:outline-none cursor-pointer hover:text-violet-600 truncate"
                      >
                        <option value="">— select adapter —</option>
                        {adapters.map(a => (
                          <option key={a.name} value={a.name}>{a.name} {a.ip ? `(${a.ip})` : "(No IP)"}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : (
                  <Input value={hostPort} onChange={e => setHostPort(e.target.value)} onBlur={() => saveField("hostPort")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} className="text-xs h-7 w-full text-center text-foreground" placeholder="host:port" />
                )}
              </div>
            );
            if (col === "type") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.type }}>
                <select
                  value={proxyType}
                  onChange={e => { setProxyType(e.target.value as "http" | "socks5" | "adapter"); updateProxyMutation.mutate({ id: proxy.id, data: { proxyType: e.target.value } }); }}
                  className={`h-7 w-full rounded border border-input bg-background px-2 text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/20 ${isAdapter ? "text-violet-600 font-semibold border-violet-300 dark:border-violet-700" : ""}`}
                >
                  <option value="http">HTTP</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="adapter">Adapter</option>
                </select>
              </div>
            );
            if (col === "username") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.username }}>
                {isAdapter ? <span className="text-[11px] text-muted-foreground/40 text-center">—</span> : (
                  <Input value={username} onChange={e => setUsername(e.target.value)} onBlur={() => saveField("username")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} placeholder="username" className="text-xs h-7 w-full text-center text-foreground" />
                )}
              </div>
            );
            if (col === "password") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.password }}>
                {isAdapter ? <span className="text-[11px] text-muted-foreground/40 text-center">—</span> : (
                  <Input value={password} onChange={e => setPassword(e.target.value)} onBlur={() => saveField("password")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} placeholder="password" className="text-xs h-7 w-full text-center text-foreground" />
                )}
              </div>
            );
            if (col === "status") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.status }}>
                {isAdapter ? (
                  currentAdapterIp ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded bg-violet-50 text-violet-600 dark:bg-violet-950/40">
                      <Usb className="w-3 h-3" />{currentAdapterIp}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded bg-red-50 text-red-500">
                      <WifiOff className="w-3 h-3" />Unplugged
                    </span>
                  )
                ) : pingResult ? (
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${pingResult.alive ? pingResult.latencyMs < 300 ? "bg-emerald-50 text-emerald-600" : pingResult.latencyMs < 800 ? "bg-yellow-50 text-yellow-600" : "bg-orange-50 text-orange-600" : "bg-red-50 text-red-500"}`}>
                    {pingResult.alive ? <><Wifi className="w-3 h-3" />{pingResult.latencyMs}ms</> : <><WifiOff className="w-3 h-3" />Dead</>}
                  </span>
                ) : <span className="text-[11px] text-muted-foreground/40">—</span>}
              </div>
            );
            if (col === "rotate") return (
              <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.rotate }}>
                {isAdapter ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      placeholder="min"
                      value={rotateMin}
                      onChange={e => setRotateMin(e.target.value === "" ? "" : Number(e.target.value))}
                      onBlur={saveRotate}
                      className="h-7 w-14 text-xs border border-border rounded px-1.5 bg-background text-center"
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <input
                      type="number"
                      min={1}
                      placeholder="max"
                      value={rotateMax}
                      onChange={e => setRotateMax(e.target.value === "" ? "" : Number(e.target.value))}
                      onBlur={saveRotate}
                      className="h-7 w-14 text-xs border border-border rounded px-1.5 bg-background text-center"
                    />
                    <span className="text-[10px] text-muted-foreground">m</span>
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-foreground/40">—</span>
                )}
              </div>
            );
            return null;
          })}
          {/* Actions — inside the centered group so it aligns with the header */}
          <div className="shrink-0 flex items-center justify-center gap-1" style={{ width: ACTIONS_COL_WIDTH }}>
            <Button variant="ghost" size="icon" className={`h-7 w-7 ${pinging ? "text-primary" : "text-muted-foreground hover:text-primary hover:bg-primary/10"}`} onClick={() => onPing(proxy.id)} disabled={pinging} title={isAdapter ? "Ping via 4G tunnel" : "Ping proxy"}>
              {pinging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-white bg-red-500 hover:bg-red-600" onClick={() => { if (confirm(`Delete proxy ${proxy.host}:${proxy.port}? Profiles using it will be unassigned.`)) { deleteProxyMutation.mutate(proxy.id); } }} title="Delete proxy">
              <Trash className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Account sub-rows — aligned under the same column grid */}
      <div className="border-b border-border/40 bg-accent/10">
        {/* Assign dropdown — at the top, under the proxy field */}
        {unassignedProfiles.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-1">
            <div className="flex items-center gap-2 flex-1">
              <div className="shrink-0" style={{ width: colWidths.proxy }}>
                <select
                  className="h-7 w-full rounded border border-dashed border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer hover:border-primary/50 transition-colors"
                  value=""
                  onChange={e => { if (e.target.value) handleAssign(Number(e.target.value)); }}
                  disabled={assignPending}
                >
                  <option value="" className="text-muted-foreground">+ Assign account…</option>
                  {unassignedProfiles.map(p => (
                    <option key={p.id} value={p.id} style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>{p.accountLabel || p.username}</option>
                  ))}
                </select>
              </div>
              {colOrder.filter(c => c !== "proxy").map(col => (
                <div key={col} className="shrink-0" style={{ width: colWidths[col] }} />
              ))}
              <div className="shrink-0" style={{ width: ACTIONS_COL_WIDTH }} />
            </div>
          </div>
        )}
        {assigned.map(profile => (
          <div key={profile.id} className="flex items-center gap-2 px-3 py-1 group hover:bg-accent/30 transition-colors">
            <div className="flex items-center gap-2 flex-1">
              {colOrder.map(col => {
                if (col === "proxy") return (
                  <div key={col} className="shrink-0 flex items-center gap-1.5" style={{ width: colWidths.proxy }}>
                    <FilledPersonIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "#1AD2F2" }} />
                    <span className="text-[13px] font-medium text-foreground truncate">{profile.username}</span>
                  </div>
                );
                if (col === "acctStatus") return (
                  <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.acctStatus }}>
                    <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold rounded-full border whitespace-nowrap uppercase ${acctStatusPill(profile.accountStatus ?? "pending")}`}>
                      {acctStatusLabel(profile.accountStatus ?? "pending")}
                    </span>
                  </div>
                );
                if (col === "acctTrustScore") return (
                  <div key={col} className="shrink-0 flex items-center justify-center" style={{ width: colWidths.acctTrustScore }}>
                    <TrustScoreBadge profileId={profile.id} />
                  </div>
                );
                return <div key={col} className="shrink-0" style={{ width: colWidths[col] }} />;
              })}
              <div className="shrink-0 flex items-center justify-center" style={{ width: ACTIONS_COL_WIDTH }}>
                <button
                  onClick={() => handleUnassign(profile)}
                  disabled={assignPending}
                  title="Remove from proxy"
                  className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
        {assigned.length === 0 && unassignedProfiles.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-1">
            <div className="flex items-center gap-2 flex-1">
              <div className="shrink-0 flex items-center" style={{ width: colWidths.proxy }}>
                <span className="text-xs text-muted-foreground italic">All accounts assigned to proxies</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function ProxiesPage() {
  const { data: proxies = [], isLoading: proxiesLoading } = useProxies();
  const { data: profiles = [] } = useProfiles();
  const { data: creatorProfiles = [] } = useCreatorProfiles();
  const allProfiles = [...profiles, ...creatorProfiles].filter(p => !p.isTemplate);
  const createProxyMutation = useCreateProxy();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  useEffect(() => {
    apiRequest("GET", "/api/adapters").then(r => r.json()).then(setAdapters).catch(() => {});
    const interval = setInterval(() => {
      apiRequest("GET", "/api/adapters").then(r => r.json()).then(setAdapters).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const [importing, setImporting] = useState(false);
  const [maxPerProxy, setMaxPerProxy] = useState<number>(() => {
    const saved = localStorage.getItem("proxies:maxPerProxy");
    return saved ? parseInt(saved, 10) || 5 : 5;
  });
  const [keepValid, setKeepValid] = useState<boolean>(() => localStorage.getItem("proxies:keepAccountsValid") === "true");
  const [splitting, setSplitting] = useState(false);
  const [isPasteImportOpen, setIsPasteImportOpen] = useState(false);
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteImporting, setPasteImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [splitGroup, setSplitGroup] = useState<string>("");
  const [showPhone4gTip, setShowPhone4gTip] = useState(false);

  type SortKey = "proxy" | "username" | "status" | "accounts" | null;
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const v = localStorage.getItem("proxies:sortKey");
    return (v === "proxy" || v === "username" || v === "status" || v === "accounts") ? v : null;
  });
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    (localStorage.getItem("proxies:sortDir") as SortDir) === "desc" ? "desc" : "asc"
  );

  const [proxyColOrder, setProxyColOrder] = usePersistentSetting<ProxyCol[]>(
    "proxies_col_order",
    DEFAULT_PROXY_COL_ORDER,
    (stored, defaults) => {
      const storedSet = new Set(stored);
      const newKeys = defaults.filter(k => !storedSet.has(k));
      return [...stored, ...newKeys];
    },
  );

  const [proxyColWidths, setProxyColWidths] = usePersistentSetting<Record<ProxyCol, number>>(
    "proxies_col_widths_px",
    DEFAULT_PROXY_COL_WIDTHS,
    (s, d) => ({ ...d, ...s }),
  );

  const moveProxyCol = (key: ProxyCol, dir: -1 | 1) => {
    const idx = proxyColOrder.indexOf(key);
    if (idx === -1) return;
    const next = [...proxyColOrder];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setProxyColOrder(next);
    localStorage.setItem("proxies_col_order", JSON.stringify(next));
  };

  const proxyDragColRef = useRef<string | null>(null);
  const [proxyDragOverCol, setProxyDragOverCol] = useState<string | null>(null);
  const [manageProxyColsOpen, setManageProxyColsOpen] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      const next = sortDir === "asc" ? "desc" : "asc";
      setSortDir(next);
      localStorage.setItem("proxies:sortDir", next);
    } else {
      setSortKey(key);
      setSortDir("asc");
      localStorage.setItem("proxies:sortKey", key ?? "");
      localStorage.setItem("proxies:sortDir", "asc");
    }
  };

  function SortIcon(_: { col: SortKey }) { return null; }

  const [pingResults, setPingResults] = useState<Record<number, PingResult>>({});
  const [pingingIds, setPingingIds] = useState<Set<number>>(new Set());
  const [pingingAll, setPingingAll] = useState(false);
  const autoPingedRef = useRef(false);

  const validProxyIds = useMemo(() => new Set(proxies.map(px => px.id)), [proxies]);
  const unassignedProfiles = allProfiles.filter(p => !p.proxyId || !validProxyIds.has(p.proxyId));

  // Unique non-empty group names from ALL profiles (assigned or not)
  const allGroupNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of allProfiles) {
      const g = (p.tags ?? "").trim();
      if (g) names.add(g);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allProfiles]);

  // Unassigned profiles scoped to the selected group (or all if no group selected)
  const splitCandidates = useMemo(() => {
    if (!splitGroup) return unassignedProfiles;
    return unassignedProfiles.filter(p => (p.tags ?? "").trim() === splitGroup);
  }, [unassignedProfiles, splitGroup]);

  // || filter — match against host:port, username, or any assigned account username
  const filterTokens = useMemo(() =>
    search.split(/\|\|?/).map(t => t.trim().toLowerCase()).filter(Boolean),
    [search]
  );

  const filteredProxies = useMemo(() => {
    let list = proxies;
    if (filterTokens.length > 0) {
      list = proxies.filter(proxy => {
        const addr = `${proxy.host}:${proxy.port}`.toLowerCase();
        const user = (proxy.username ?? "").toLowerCase();
        const assignedNames = allProfiles
          .filter(p => p.proxyId === proxy.id)
          .map(p => p.username.toLowerCase());
        return filterTokens.some(t =>
          addr.includes(t) || user.includes(t) || assignedNames.some(n => n.includes(t))
        );
      });
    }
    if (!sortKey) return list;
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "proxy") {
        cmp = `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`);
      } else if (sortKey === "username") {
        cmp = (a.username ?? "").localeCompare(b.username ?? "");
      } else if (sortKey === "status") {
        const ar = pingResults[a.id];
        const br = pingResults[b.id];
        const aMs = ar ? (ar.alive ? ar.latencyMs : 999999) : 9999999;
        const bMs = br ? (br.alive ? br.latencyMs : 999999) : 9999999;
        cmp = aMs - bMs;
      } else if (sortKey === "accounts") {
        const aAssigned = allProfiles.filter(p => p.proxyId === a.id);
        const bAssigned = allProfiles.filter(p => p.proxyId === b.id);
        cmp = aAssigned.length - bAssigned.length;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [proxies, filterTokens, allProfiles, sortKey, sortDir, pingResults]);

  const pingOne = async (proxyId: number): Promise<PingResult> => {
    setPingingIds(prev => new Set(prev).add(proxyId));
    setPingResults(prev => ({ ...prev, [proxyId]: null }));
    try {
      const res = await apiRequest("POST", `/api/proxies/${proxyId}/ping`);
      const data: PingResult = await res.json();
      setPingResults(prev => ({ ...prev, [proxyId]: data }));
      return data;
    } catch {
      const result: PingResult = { alive: false, latencyMs: 0, error: "Request failed" };
      setPingResults(prev => ({ ...prev, [proxyId]: result }));
      return result;
    } finally {
      setPingingIds(prev => { const next = new Set(prev); next.delete(proxyId); return next; });
    }
  };

  const handlePasteImport = async () => {
    const lines = pasteRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
      toast({ title: "Nothing to import", description: "Paste at least one proxy line.", variant: "destructive" });
      return;
    }
    const parsed: { host: string; port: number; username: string | null; password: string | null }[] = [];
    const bad: string[] = [];
    for (const line of lines) {
      const parts = line.split(":");
      if (parts.length < 2) { bad.push(line); continue; }
      const port = Number(parts[1]);
      if (!parts[0] || isNaN(port) || port < 1 || port > 65535) { bad.push(line); continue; }
      parsed.push({
        host: parts[0].trim(),
        port,
        username: parts[2]?.trim() || null,
        password: parts[3]?.trim() || null,
      });
    }
    if (!parsed.length) {
      toast({ title: "No valid proxies found", description: `Expected format: ip:port or ip:port:user:pass`, variant: "destructive" });
      return;
    }
    setPasteImporting(true);
    try {
      const res = await apiRequest("POST", "/api/proxies/import", { proxies: parsed });
      const { imported, skipped } = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      toast({
        title: `Imported ${imported} ${imported === 1 ? "proxy" : "proxies"}`,
        description: [
          skipped > 0 ? `${skipped} already existed and were skipped.` : null,
          bad.length > 0 ? `${bad.length} line(s) could not be parsed.` : null,
        ].filter(Boolean).join(" ") || undefined,
      });
      setPasteRaw("");
      setIsPasteImportOpen(false);
    } catch {
      toast({ title: "Import failed", variant: "destructive" });
    } finally {
      setPasteImporting(false);
    }
  };

  const handlePingAll = async () => {
    if (!proxies.length) return;
    setPingingAll(true);
    // Clear all previous results upfront so the summary shows only THIS run's data.
    setPingResults({});
    try {
      // Run pings with a concurrency cap of 5 to avoid TCP starvation that
      // produces false "dead" results when many proxies are pinged at once.
      const CONCURRENCY = 5;
      const all = [...proxies];
      const results: PingResult[] = [];
      while (all.length > 0) {
        const batch = all.splice(0, CONCURRENCY);
        const batchResults = await Promise.all(batch.map(p => pingOne(p.id)));
        results.push(...batchResults);
      }
      const alive = results.filter(r => r?.alive).length;
      const dead = results.length - alive;
      toast({
        title: `Ping complete — ${alive} alive, ${dead} dead`,
        description: dead > 0 ? "Dead proxies are highlighted in red." : "All proxies are responding.",
      });
    } finally {
      setPingingAll(false);
    }
  };


  useEffect(() => {
    if (proxiesLoading || proxies.length === 0 || autoPingedRef.current) return;
    autoPingedRef.current = true;
    Promise.all(proxies.map(p => pingOne(p.id))).catch(() => {});
  }, [proxiesLoading, proxies]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseJarveeFile(buffer);
      if (parsed.length === 0) {
        toast({ title: "No valid proxies found in file", variant: "destructive" });
        return;
      }
      const res = await apiRequest("POST", "/api/proxies/import", { proxies: parsed });
      const { imported, skipped } = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      toast({
        title: `Imported ${imported} ${imported === 1 ? "proxy" : "proxies"}`,
        description: skipped > 0 ? `${skipped} already existed and were skipped.` : undefined,
      });
    } catch {
      toast({ title: "Import failed", description: "Could not parse or upload the file.", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const handleExport = () => {
    if (!proxies.length) { toast({ title: "No proxies to export", variant: "destructive" }); return; }
    exportProxies(proxies);
    toast({ title: `Exported ${proxies.length} proxies` });
  };

  const deleteProxyMutation = useDeleteProxy();
  const [deletingAll, setDeletingAll] = useState(false);

  const handleDeleteAll = async () => {
    if (!proxies.length) return;
    if (!confirm(`Delete all ${proxies.length} ${proxies.length === 1 ? "proxy" : "proxies"}? All account assignments will be cleared.`)) return;
    setDeletingAll(true);
    try {
      await Promise.all(proxies.map(p => apiRequest("DELETE", `/api/proxies/${p.id}`)));
      await queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      toast({ title: `Deleted all ${proxies.length} proxies` });
    } catch {
      toast({ title: "Delete all failed", variant: "destructive" });
    } finally {
      setDeletingAll(false);
    }
  };

  const handleAddEmpty = () => {
    createProxyMutation.mutate({ host: "0.0.0.0", port: 8080, username: null, password: null, proxyType: "http" }, {
      onSuccess: () => toast({ title: "Proxy added — fill in the details below" }),
    });
  };

  const handleAddAdapter = () => {
    createProxyMutation.mutate({ host: "127.0.0.1", port: 0, username: null, password: null, proxyType: "adapter", adapterName: null }, {
      onSuccess: () => toast({ title: "Local adapter proxy added — select your dongle adapter from the dropdown" }),
    });
  };

  const handleSplitEvenly = async () => {
    if (!proxies.length) { toast({ title: "No proxies to assign to", variant: "destructive" }); return; }
    if (!splitCandidates.length) {
      toast({
        title: splitGroup
          ? `No unassigned accounts in group "${splitGroup}"`
          : "All accounts are already assigned to a proxy",
      });
      return;
    }
    setSplitting(true);
    try {
      const slots = proxies.map(proxy => {
        const count = allProfiles.filter(p => p.proxyId === proxy.id).length;
        return { proxy, remaining: Math.max(0, maxPerProxy - count) };
      });
      const toAssign = [...splitCandidates];
      const assignments: Array<{ profileId: number; proxyId: number }> = [];
      let i = 0;
      while (toAssign.length > 0) {
        const slotIdx = i % slots.length;
        if (slots[slotIdx].remaining > 0) {
          const profile = toAssign.shift()!;
          assignments.push({ profileId: profile.id, proxyId: slots[slotIdx].proxy.id });
          slots[slotIdx].remaining--;
        }
        i++;
        if (slots.every(s => s.remaining === 0)) break;
      }
      if (!assignments.length) { toast({ title: "All proxies are already at the maximum account limit" }); setSplitting(false); return; }
      await Promise.all(
        assignments.map(a =>
          fetch(`/api/profiles/${a.profileId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxyId: a.proxyId, ...(keepValid ? { preserveAccountStatus: true } : {}) }),
            credentials: "include",
          }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
        )
      );
      await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      const skipped = splitCandidates.length - assignments.length;
      toast({
        title: `Assigned ${assignments.length} ${assignments.length === 1 ? "account" : "accounts"} across ${proxies.length} proxies`,
        description: skipped > 0
          ? `${skipped} couldn't be assigned — all proxies at the ${maxPerProxy} account limit.`
          : splitGroup ? `Group: "${splitGroup}"` : undefined,
      });
    } catch { toast({ title: "Split failed", variant: "destructive" }); }
    finally { setSplitting(false); }
  };

  const aliveCount = Object.values(pingResults).filter(r => r?.alive).length;
  const deadCount = Object.values(pingResults).filter(r => r !== null && !r?.alive).length;
  const testedCount = aliveCount + deadCount;

  return (
    <AppLayout>
      <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-3 flex-wrap shrink-0">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Proxy Manager</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-muted-foreground text-sm">
            {proxies.length} {proxies.length === 1 ? "proxy" : "proxies"} · {unassignedProfiles.length} unassigned {unassignedProfiles.length === 1 ? "account" : "accounts"}
          </p>
          {testedCount > 0 && (
            <div className="flex items-center gap-2 text-xs font-medium">
              {aliveCount > 0 && (
                <span className="flex items-center gap-1 bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">
                  <Wifi className="w-3 h-3" />{aliveCount} alive
                </span>
              )}
              {deadCount > 0 && (
                <span className="flex items-center gap-1 bg-red-50 text-red-500 px-2 py-0.5 rounded-full">
                  <WifiOff className="w-3 h-3" />{deadCount} dead
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Search + Add Proxy ──────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border bg-background flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search proxy, username, account… (use || for multiple)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-xs bg-transparent outline-none flex-1 text-foreground placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch("")}>
              <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>
        <Button size="sm" className="bg-sky-400 hover:bg-sky-500 text-white border-0 gap-1.5 shrink-0" onClick={handleAddEmpty} disabled={createProxyMutation.isPending}>
          <Plus className="w-4 h-4" /> Add Proxy
        </Button>
        <Button size="sm" className="bg-violet-500 hover:bg-violet-600 text-white border-0 gap-1.5 shrink-0" onClick={handleAddAdapter} disabled={createProxyMutation.isPending}>
          <Usb className="w-4 h-4" /> Add Local Adapter
        </Button>

        <Dialog open={isPasteImportOpen} onOpenChange={open => { setIsPasteImportOpen(open); if (!open) setPasteRaw(""); }}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0">
              <Upload className="w-4 h-4" /> Import Proxies
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Import Proxies</DialogTitle></DialogHeader>
            <div className="space-y-4 mt-2">
              <p className="text-sm text-muted-foreground">Paste one proxy per line. Supported formats:</p>
              <pre className="text-xs bg-muted rounded px-3 py-2 font-mono">ip:port{"\n"}ip:port:username:password</pre>
              <textarea
                className="w-full h-48 rounded border border-border bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder={"37.97.115.122:29842:afitne:1j3mz6nJ\n37.97.112.154:29842:afitne:1j3mz6nJ"}
                value={pasteRaw}
                onChange={e => setPasteRaw(e.target.value)}
                disabled={pasteImporting}
              />
              <Button className="w-full" onClick={handlePasteImport} disabled={pasteImporting || !pasteRaw.trim()}>
                {pasteImporting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing…</> : "Import"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 shrink-0"
          onClick={handlePingAll}
          disabled={pingingAll || !proxies.length}
        >
          {pingingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
          {pingingAll ? `Pinging… (${testedCount}/${proxies.length})` : "Ping All"}
        </Button>
      </div>

      {/* ── Main card ──────────────────────────────────────────────────────── */}
      <div className="desktop-card overflow-hidden flex flex-col flex-1 min-h-0">

        {/* Column header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40 text-[12px] font-bold uppercase tracking-wide text-foreground select-none shrink-0">
          <div className="flex items-center gap-2 flex-1">
          {proxyColOrder.map(col => {
            const isDragTarget = proxyDragOverCol === col;
            const dragProps = {
              draggable: true as const,
              onDragStart: (e: React.DragEvent) => { proxyDragColRef.current = col; e.dataTransfer.effectAllowed = "move"; },
              onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (proxyDragColRef.current && proxyDragColRef.current !== col) setProxyDragOverCol(col); },
              onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                const from = proxyDragColRef.current as ProxyCol | null;
                proxyDragColRef.current = null;
                setProxyDragOverCol(null);
                if (!from || from === col) return;
                const fromIdx = proxyColOrder.indexOf(from);
                const toIdx = proxyColOrder.indexOf(col);
                if (fromIdx === -1 || toIdx === -1) return;
                const next = [...proxyColOrder];
                next.splice(fromIdx, 1);
                next.splice(toIdx, 0, from);
                setProxyColOrder(next);
                localStorage.setItem("proxies_col_order", JSON.stringify(next));
              },
              onDragEnd: () => { proxyDragColRef.current = null; setProxyDragOverCol(null); },
            };
            const dragStyle = isDragTarget ? "border-l-2 border-primary bg-primary/5" : "";
            const sortable = col === "proxy" || col === "username" || col === "status" || col === "accounts";
            if (sortable) return (
              <button key={col} {...dragProps} onClick={() => handleSort(col as SortKey)} style={{ width: proxyColWidths[col] }} className={`shrink-0 flex items-center justify-center text-center gap-0.5 hover:text-primary transition-colors cursor-default whitespace-nowrap ${sortKey === col ? "text-primary" : ""} ${dragStyle}`}>
                {PROXY_COL_LABELS[col]}<SortIcon col={col as SortKey} />
              </button>
            );
            return (
              <div key={col} {...dragProps} style={{ width: proxyColWidths[col] }} className={`shrink-0 flex items-center justify-center text-center cursor-default whitespace-nowrap ${dragStyle}`}>
                {PROXY_COL_LABELS[col]}
              </div>
            );
          })}
          <div className="shrink-0 flex items-center justify-center" style={{ width: ACTIONS_COL_WIDTH }}>Actions</div>
          </div>
          <div>
            <button onClick={() => setManageProxyColsOpen(o => !o)} className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors">
              <Settings2 className="w-3 h-3" /> Columns
            </button>
            {manageProxyColsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setManageProxyColsOpen(false)} />
                <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto">
                  <div className="px-5 pt-4 pb-3 border-b border-border">
                    <p className="text-sm font-semibold">Columns</p>
                  </div>
                  <div className="p-4 grid grid-cols-2 gap-x-4 gap-y-1">
                    {proxyColOrder.map((key, ordIdx) => {
                      const updateWidth = (delta: number) => {
                        const v = Math.max(1, Math.min(400, proxyColWidths[key] + delta));
                        const next = { ...proxyColWidths, [key]: v };
                        setProxyColWidths(next);
                        localStorage.setItem("proxies_col_widths_px", JSON.stringify(next));
                      };
                      return (
                        <div key={key} className="flex items-center gap-1 mb-1">
                          <div className="flex flex-col mr-0.5">
                            <button onClick={() => moveProxyCol(key, -1)} disabled={ordIdx === 0} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronUp className="w-2.5 h-2.5" /></button>
                            <button onClick={() => moveProxyCol(key, 1)} disabled={ordIdx === proxyColOrder.length - 1} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronDown className="w-2.5 h-2.5" /></button>
                          </div>
                          <label className="text-xs w-16 text-muted-foreground shrink-0 truncate" title={PROXY_COL_LABELS[key]}>{PROXY_COL_LABELS[key]}</label>
                          <button onClick={() => updateWidth(-10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronDown className="w-3 h-3" /></button>
                          <input type="number" min={1} max={400} value={proxyColWidths[key]} onChange={e => { const v = Math.max(1, Math.min(400, Number(e.target.value))); const next = { ...proxyColWidths, [key]: v }; setProxyColWidths(next); localStorage.setItem("proxies_col_widths_px", JSON.stringify(next)); }} className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center" />
                          <button onClick={() => updateWidth(10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronUp className="w-3 h-3" /></button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="px-4 pb-4">
                    <button onClick={() => { setProxyColWidths(DEFAULT_PROXY_COL_WIDTHS); localStorage.removeItem("proxies_col_widths_px"); setProxyColOrder(DEFAULT_PROXY_COL_ORDER); localStorage.removeItem("proxies_col_order"); }} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Reset to defaults</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {proxiesLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse bg-muted/10 border-b border-border/30" />
            ))
          ) : proxies.length === 0 ? (
            <div className="flex flex-col items-center py-20 text-muted-foreground">
              <Shield className="w-10 h-10 mx-auto mb-4 opacity-20" />
              <p className="font-medium">No proxies configured</p>
              <p className="text-sm mt-1">Use "Add Proxy" below to get started.</p>
            </div>
          ) : filteredProxies.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-muted-foreground">
              <Search className="w-8 h-8 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No proxies match this filter</p>
              <button onClick={() => setSearch("")} className="text-sm mt-1 text-primary hover:underline">Clear search</button>
            </div>
          ) : (
            filteredProxies.map((proxy, idx) => (
              <ProxyRow
                key={proxy.id}
                proxy={proxy}
                allProfiles={allProfiles}
                unassignedProfiles={unassignedProfiles}
                pingResult={pingResults[proxy.id] ?? null}
                pinging={pingingIds.has(proxy.id)}
                onPing={pingOne}
                even={idx % 2 === 1}
                colOrder={proxyColOrder}
                colWidths={proxyColWidths}
                keepValid={keepValid}
                adapters={adapters}
              />
            ))
          )}
        </div>

        {/* ── Split evenly panel — inside card ───────────────────────────── */}
        {proxies.length > 0 && (
          <div className="border-t border-border bg-muted/20 px-5 py-3 shrink-0">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">Split Unassigned Accounts Evenly Across All Proxies</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {splitCandidates.length} unassigned {splitCandidates.length === 1 ? "account" : "accounts"}
                  {splitGroup ? <> in group <span className="font-semibold text-foreground">"{splitGroup}"</span></> : ""}{" "}
                  will be distributed. Accounts outside the selection are not touched.
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 flex-wrap">
                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">Group</Label>
                  <select
                    value={splitGroup}
                    onChange={e => setSplitGroup(e.target.value)}
                    className="h-8 rounded border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
                  >
                    <option value="">All accounts</option>
                    {allGroupNames.map(g => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="maxPerProxy" className="text-sm whitespace-nowrap">Max per proxy</Label>
                  <Input
                    id="maxPerProxy"
                    type="number"
                    min={1}
                    max={100}
                    value={maxPerProxy}
                    onChange={e => { const v = Math.max(1, Number(e.target.value)); setMaxPerProxy(v); localStorage.setItem("proxies:maxPerProxy", String(v)); }}
                    className="w-20 h-8 text-sm"
                  />
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Button onClick={handleSplitEvenly} disabled={splitting || !splitCandidates.length} className="shrink-0">
                    {splitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    {splitting ? "Splitting…" : "Split Now"}
                  </Button>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={keepValid}
                      onChange={e => { setKeepValid(e.target.checked); localStorage.setItem("proxies:keepAccountsValid", String(e.target.checked)); }}
                      className="w-3.5 h-3.5 accent-sky-500"
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Keep accounts valid</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/40 select-none shrink-0 flex-wrap">
          <label className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors cursor-pointer whitespace-nowrap">
            <input type="file" accept=".txt" className="hidden" onChange={handleImport} disabled={importing} />
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {importing ? "Importing…" : "Import"}
          </label>
          <span className="text-border">|</span>
          <button
            onClick={handleExport}
            disabled={!proxies.length}
            className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors whitespace-nowrap disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <span className="text-border">|</span>
          <button
            onClick={handleDeleteAll}
            disabled={deletingAll || !proxies.length}
            className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-destructive hover:text-destructive/80 transition-colors whitespace-nowrap disabled:opacity-50"
          >
            {deletingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash className="w-3.5 h-3.5 fill-red-500 text-red-500" />}
            {deletingAll ? "Deleting…" : "Delete All"}
          </button>
        </div>
      </div>
      </div>
    </AppLayout>
  );
}
