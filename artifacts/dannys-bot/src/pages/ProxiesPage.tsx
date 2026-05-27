import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProxies, useCreateProxy, useUpdateProxy, useDeleteProxy } from "@/hooks/use-proxies";
import { useProfiles, useCreatorProfiles, useUpdateProfile } from "@/hooks/use-profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Plus, Trash2, Shield, User, X, Wifi, WifiOff, Loader2,
  Upload, Download, Trash, Search,
  ArrowUp, ArrowDown, ArrowUpDown, Settings2, ChevronDown, ChevronUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Proxy, Profile } from "@shared/schema";

type PingResult = { alive: boolean; latencyMs: number; error?: string } | null;

type ProxyCol = "proxy" | "type" | "username" | "password" | "accounts" | "status";
const DEFAULT_PROXY_COL_ORDER: ProxyCol[] = ["proxy", "type", "username", "password", "accounts", "status"];
const DEFAULT_PROXY_COL_WIDTHS: Record<ProxyCol, number> = { proxy: 210, type: 90, username: 120, password: 120, accounts: 76, status: 88 };
const PROXY_COL_LABELS: Record<ProxyCol, string> = { proxy: "Proxy", type: "Type", username: "Username", password: "Password", accounts: "Accounts", status: "Status" };

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
}

function ProxyRow({
  proxy, allProfiles, unassignedProfiles, pingResult, pinging, onPing, even, colOrder, colWidths, keepValid,
}: ProxyRowProps) {
  const deleteProxyMutation = useDeleteProxy();
  const updateProxyMutation = useUpdateProxy();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();

  const [hostPort, setHostPort] = useState(`${proxy.host}:${proxy.port}`);
  const [username, setUsername] = useState(proxy.username ?? "");
  const [password, setPassword] = useState(proxy.password ?? "");
  const [proxyType, setProxyType] = useState<"http" | "socks5">((proxy.proxyType as "http" | "socks5") ?? "http");

  useEffect(() => {
    setHostPort(`${proxy.host}:${proxy.port}`);
    setUsername(proxy.username ?? "");
    setPassword(proxy.password ?? "");
    setProxyType((proxy.proxyType as "http" | "socks5") ?? "http");
  }, [proxy]);

  const saveField = useCallback((field: "hostPort" | "username" | "password" | "type") => {
    let data: Record<string, string | number | null> = {};
    if (field === "hostPort") {
      const parts = hostPort.split(":");
      const host = parts.slice(0, -1).join(":").trim();
      const port = parseInt(parts[parts.length - 1], 10);
      if (!host || isNaN(port)) {
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

  const assigned = allProfiles.filter(p => p.proxyId === proxy.id);
  const validCount = assigned.filter(p => p.accountStatus === "valid").length;
  const totalCount = assigned.length;

  const handleAssign = (profileId: number) => {
    updateProfileMutation.mutate({
      id: profileId,
      proxyId: proxy.id,
      ...(keepValid ? { preserveAccountStatus: true } : {}),
    } as any);
  };

  const handleUnassign = (profile: Profile) => {
    updateProfileMutation.mutate({
      id: profile.id,
      proxyId: null,
      ...(keepValid ? { preserveAccountStatus: true } : {}),
    } as any);
  };

  const rowBg = even ? "bg-slate-50/60" : "bg-white";

  return (
    <>
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-border/30 last:border-b-0 transition-colors hover:bg-slate-100/60 ${rowBg}`}>
        {colOrder.map(col => {
          if (col === "proxy") return (
            <div key={col} className="shrink-0" style={{ width: colWidths.proxy }}>
              <Input value={hostPort} onChange={e => setHostPort(e.target.value)} onBlur={() => saveField("hostPort")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} className="text-xs h-7 w-full" placeholder="host:port" />
            </div>
          );
          if (col === "type") return (
            <div key={col} className="shrink-0" style={{ width: colWidths.type }}>
              <select
                value={proxyType}
                onChange={e => { setProxyType(e.target.value as "http" | "socks5"); updateProxyMutation.mutate({ id: proxy.id, data: { proxyType: e.target.value } }); }}
                className="h-7 w-full rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
          );
          if (col === "username") return (
            <div key={col} className="shrink-0" style={{ width: colWidths.username }}>
              <Input value={username} onChange={e => setUsername(e.target.value)} onBlur={() => saveField("username")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} placeholder="username" className="text-xs h-7 w-full" />
            </div>
          );
          if (col === "password") return (
            <div key={col} className="shrink-0" style={{ width: colWidths.password }}>
              <Input value={password} onChange={e => setPassword(e.target.value)} onBlur={() => saveField("password")} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} placeholder="password" className="text-xs h-7 w-full" />
            </div>
          );
          if (col === "accounts") return (
            <div key={col} className="shrink-0 flex justify-center" style={{ width: colWidths.accounts }}>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${totalCount === 0 ? "bg-slate-100 text-slate-400" : validCount === totalCount ? "bg-emerald-50 text-emerald-700" : validCount === 0 ? "bg-slate-100 text-slate-500" : "bg-yellow-50 text-yellow-700"}`}>
                <User className="w-3 h-3" />{totalCount === 0 ? "0" : `${validCount}/${totalCount}`}
              </span>
            </div>
          );
          if (col === "status") return (
            <div key={col} className="shrink-0" style={{ width: colWidths.status }}>
              {pingResult ? (
                <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${pingResult.alive ? pingResult.latencyMs < 300 ? "bg-emerald-50 text-emerald-600" : pingResult.latencyMs < 800 ? "bg-yellow-50 text-yellow-600" : "bg-orange-50 text-orange-600" : "bg-red-50 text-red-500"}`}>
                  {pingResult.alive ? <><Wifi className="w-3 h-3" />{pingResult.latencyMs}ms</> : <><WifiOff className="w-3 h-3" />Dead</>}
                </span>
              ) : <span className="text-[11px] text-muted-foreground/40">—</span>}
            </div>
          );
          return null;
        })}
        {/* Actions — always last */}
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className={`h-7 w-7 ${pinging ? "text-primary" : "text-muted-foreground hover:text-primary hover:bg-primary/10"}`} onClick={() => onPing(proxy.id)} disabled={pinging} title="Ping proxy">
            {pinging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white bg-red-500 hover:bg-red-600" onClick={() => { if (confirm(`Delete proxy ${proxy.host}:${proxy.port}? Profiles using it will be unassigned.`)) { deleteProxyMutation.mutate(proxy.id); } }} title="Delete proxy">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Assigned accounts — always visible */}
      <div className="border-b border-border/40 bg-accent/10 px-4 py-2">
        <div className="flex flex-col gap-0.5">
          {assigned.map(profile => (
            <div key={profile.id} className="flex items-center justify-between gap-2 px-2 py-0.5 rounded hover:bg-accent/40 transition-colors group">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground min-w-0">
                <User className="w-3 h-3 shrink-0 text-primary" />
                <span className="truncate">{profile.username}</span>
              </div>
              <button
                onClick={() => handleUnassign(profile)}
                disabled={updateProfileMutation.isPending}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {unassignedProfiles.length > 0 && (
            <select
              className="mt-1 h-7 w-full rounded border border-dashed border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer hover:border-primary/50 transition-colors"
              value=""
              onChange={e => { if (e.target.value) handleAssign(Number(e.target.value)); }}
              disabled={updateProfileMutation.isPending}
            >
              <option value="">+ Assign account…</option>
              {unassignedProfiles.map(p => (
                <option key={p.id} value={p.id}>{p.username}</option>
              ))}
            </select>
          )}
          {assigned.length === 0 && unassignedProfiles.length === 0 && (
            <span className="text-xs text-muted-foreground italic px-2 py-0.5">All accounts assigned to proxies</span>
          )}
          {assigned.length === 0 && unassignedProfiles.length > 0 && (
            <span className="text-xs text-muted-foreground italic px-2 py-0.5">No accounts assigned — use dropdown to add</span>
          )}
        </div>
      </div>
    </>
  );
}

export function ProxiesPage() {
  const { data: proxies = [], isLoading: proxiesLoading } = useProxies();
  const { data: profiles = [] } = useProfiles();
  const { data: creatorProfiles = [] } = useCreatorProfiles();
  const allProfiles = [...profiles, ...creatorProfiles];
  const createProxyMutation = useCreateProxy();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [hostPort, setHostPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newProxyType, setNewProxyType] = useState<"http" | "socks5">("http");
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

  type SortKey = "proxy" | "username" | "accounts" | "status" | null;
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const v = localStorage.getItem("proxies:sortKey");
    return (v === "proxy" || v === "username" || v === "accounts" || v === "status") ? v : null;
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
  const manageProxyColsRef = useRef<HTMLDivElement>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === "asc") {
        setSortDir("desc");
        localStorage.setItem("proxies:sortDir", "desc");
      } else {
        setSortKey(null); setSortDir("asc");
        localStorage.removeItem("proxies:sortKey");
        localStorage.setItem("proxies:sortDir", "asc");
      }
    } else {
      setSortKey(key);
      setSortDir("asc");
      localStorage.setItem("proxies:sortKey", key ?? "");
      localStorage.setItem("proxies:sortDir", "asc");
    }
  };

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 opacity-30 inline ml-0.5" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 text-primary inline ml-0.5" />
      : <ArrowDown className="w-3 h-3 text-primary inline ml-0.5" />;
  }

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
      } else if (sortKey === "accounts") {
        const ac = allProfiles.filter(p => p.proxyId === a.id).length;
        const bc = allProfiles.filter(p => p.proxyId === b.id).length;
        cmp = ac - bc;
      } else if (sortKey === "status") {
        const ar = pingResults[a.id];
        const br = pingResults[b.id];
        const aMs = ar ? (ar.alive ? ar.latencyMs : 999999) : 9999999;
        const bMs = br ? (br.alive ? br.latencyMs : 999999) : 9999999;
        cmp = aMs - bMs;
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
    try {
      const results = await Promise.all(proxies.map(p => pingOne(p.id)));
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
    const handler = (e: MouseEvent) => {
      if (manageProxyColsRef.current && !manageProxyColsRef.current.contains(e.target as Node)) {
        setManageProxyColsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = hostPort.trim();
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon === -1) { toast({ title: "Invalid format", description: "Enter the proxy as IP:PORT", variant: "destructive" }); return; }
    const host = trimmed.slice(0, lastColon);
    const port = Number(trimmed.slice(lastColon + 1));
    if (!host || isNaN(port) || port < 1 || port > 65535) { toast({ title: "Invalid format", description: "Enter a valid IP:PORT", variant: "destructive" }); return; }
    createProxyMutation.mutate({ host, port, username: username || null, password: password || null, proxyType: newProxyType }, {
      onSuccess: () => { setIsAddOpen(false); setHostPort(""); setUsername(""); setPassword(""); setNewProxyType("http"); toast({ title: "Proxy Added" }); },
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
        assignments.map(a => new Promise<void>((resolve, reject) =>
          updateProfileMutation.mutate(
            { id: a.profileId, proxyId: a.proxyId, ...(keepValid ? { preserveAccountStatus: true } : {}) } as any,
            { onSuccess: () => resolve(), onError: reject }
          )
        ))
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
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="bg-sky-400 hover:bg-sky-500 text-white border-0 gap-1.5 shrink-0">
              <Plus className="w-4 h-4" /> Add Proxy
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add New Proxy</DialogTitle></DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="hostPort">IP Address &amp; Port</Label>
                  <Input id="hostPort" required value={hostPort} onChange={e => setHostPort(e.target.value)} placeholder="45.80.96.251:29842" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newProxyType">Proxy Type</Label>
                  <select
                    id="newProxyType"
                    value={newProxyType}
                    onChange={e => setNewProxyType(e.target.value as "http" | "socks5")}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="user">Username (Optional)</Label>
                  <Input id="user" value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pass">Password (Optional)</Label>
                  <PasswordInput id="pass" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={createProxyMutation.isPending}>
                {createProxyMutation.isPending ? "Adding..." : "Save Proxy"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

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
      </div>

      {/* ── Main card ──────────────────────────────────────────────────────── */}
      <div className="desktop-card overflow-hidden flex flex-col flex-1 min-h-0">

        {/* Column header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40 text-[12px] font-bold uppercase tracking-wide text-foreground select-none shrink-0">
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
            const sortable = col === "proxy" || col === "username" || col === "accounts" || col === "status";
            if (sortable) return (
              <button key={col} {...dragProps} onClick={() => handleSort(col as SortKey)} style={{ width: proxyColWidths[col] }} className={`shrink-0 flex items-center gap-0.5 hover:text-primary transition-colors cursor-default ${sortKey === col ? "text-primary" : ""} ${dragStyle}`}>
                {PROXY_COL_LABELS[col]}<SortIcon col={col as SortKey} />
              </button>
            );
            return (
              <div key={col} {...dragProps} style={{ width: proxyColWidths[col] }} className={`shrink-0 cursor-default ${dragStyle}`}>
                {PROXY_COL_LABELS[col]}
              </div>
            );
          })}
          <div className="shrink-0">Actions</div>
          <div className="flex-1" />
          <div ref={manageProxyColsRef} className="relative">
            <button onClick={() => setManageProxyColsOpen(o => !o)} className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-foreground hover:text-primary transition-colors">
              <Settings2 className="w-3 h-3" /> Columns
            </button>
            {manageProxyColsOpen && (
              <div className="absolute right-0 top-full mt-2 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-72">
                <p className="text-[11px] font-bold uppercase tracking-wide mb-3 text-muted-foreground">Columns</p>
                {proxyColOrder.map((key, ordIdx) => {
                  const updateWidth = (delta: number) => {
                    const v = Math.max(40, Math.min(400, proxyColWidths[key] + delta));
                    const next = { ...proxyColWidths, [key]: v };
                    setProxyColWidths(next);
                    localStorage.setItem("proxies_col_widths_px", JSON.stringify(next));
                  };
                  return (
                    <div key={key} className="flex items-center gap-1 mb-2">
                      <div className="flex flex-col mr-0.5">
                        <button onClick={() => moveProxyCol(key, -1)} disabled={ordIdx === 0} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronUp className="w-2.5 h-2.5" /></button>
                        <button onClick={() => moveProxyCol(key, 1)} disabled={ordIdx === proxyColOrder.length - 1} className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"><ChevronDown className="w-2.5 h-2.5" /></button>
                      </div>
                      <label className="text-xs w-20 text-muted-foreground shrink-0">{PROXY_COL_LABELS[key]}</label>
                      <button onClick={() => updateWidth(-10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronDown className="w-3 h-3" /></button>
                      <input type="number" min={40} max={400} value={proxyColWidths[key]} onChange={e => { const v = Math.max(40, Math.min(400, Number(e.target.value))); const next = { ...proxyColWidths, [key]: v }; setProxyColWidths(next); localStorage.setItem("proxies_col_widths_px", JSON.stringify(next)); }} className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center" />
                      <button onClick={() => updateWidth(10)} className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"><ChevronUp className="w-3 h-3" /></button>
                    </div>
                  );
                })}
                <button onClick={() => { setProxyColWidths(DEFAULT_PROXY_COL_WIDTHS); localStorage.removeItem("proxies_col_widths_px"); setProxyColOrder(DEFAULT_PROXY_COL_ORDER); localStorage.removeItem("proxies_col_order"); }} className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">Reset to defaults</button>
              </div>
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
                <Button onClick={handleSplitEvenly} disabled={splitting || !splitCandidates.length} className="shrink-0">
                  {splitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {splitting ? "Splitting…" : "Split Now"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/40 select-none shrink-0 flex-wrap">
          <button
            onClick={handlePingAll}
            disabled={pingingAll || !proxies.length}
            className="flex items-center gap-1 text-[13px] font-bold uppercase tracking-wide text-sky-500 hover:text-sky-600 transition-colors whitespace-nowrap disabled:opacity-50"
          >
            {pingingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            {pingingAll ? `Pinging… (${testedCount}/${proxies.length})` : "Ping All"}
          </button>
          <span className="text-border">|</span>
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
            {deletingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash className="w-3.5 h-3.5" />}
            {deletingAll ? "Deleting…" : "Delete All"}
          </button>
          <span className="text-border">|</span>
          <label className="flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={keepValid}
              onChange={e => { setKeepValid(e.target.checked); localStorage.setItem("proxies:keepAccountsValid", String(e.target.checked)); }}
              className="w-3.5 h-3.5 accent-sky-500"
            />
            <span className="text-[13px] font-bold uppercase tracking-wide text-foreground">Keep accounts valid</span>
          </label>
        </div>
      </div>
      </div>
    </AppLayout>
  );
}
