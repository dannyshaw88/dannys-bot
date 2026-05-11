import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProxies, useCreateProxy, useUpdateProxy, useDeleteProxy } from "@/hooks/use-proxies";
import { useProfiles, useCreatorProfiles, useUpdateProfile } from "@/hooks/use-profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Shield, User, X, Wifi, WifiOff, Loader2, Upload, Download, Trash } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Proxy, Profile } from "@shared/schema";

type PingResult = { alive: boolean; latencyMs: number; error?: string } | null;

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

interface ProxyCardProps {
  proxy: Proxy;
  allProfiles: Profile[];
  unassignedProfiles: Profile[];
  pingResult: PingResult;
  pinging: boolean;
  onPing: (proxyId: number) => void;
}

function ProxyCard({ proxy, allProfiles, unassignedProfiles, pingResult, pinging, onPing }: ProxyCardProps) {
  const deleteProxyMutation = useDeleteProxy();
  const updateProxyMutation = useUpdateProxy();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();

  const [hostPort, setHostPort] = useState(`${proxy.host}:${proxy.port}`);
  const [username, setUsername] = useState(proxy.username ?? "");
  const [password, setPassword] = useState(proxy.password ?? "");

  useEffect(() => {
    setHostPort(`${proxy.host}:${proxy.port}`);
    setUsername(proxy.username ?? "");
    setPassword(proxy.password ?? "");
  }, [proxy]);

  const saveField = useCallback((field: "hostPort" | "username" | "password") => {
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
    } else {
      data = { password: password || null };
    }
    updateProxyMutation.mutate({ id: proxy.id, data });
  }, [hostPort, username, password, proxy, updateProxyMutation, toast]);

  const assigned = allProfiles.filter(p => p.proxyId === proxy.id);
  const validCount = assigned.filter(p => p.accountStatus === "valid").length;
  const totalCount = assigned.length;

  const handleAssign = (profileId: number) => {
    updateProfileMutation.mutate({ id: profileId, proxyId: proxy.id });
  };

  const handleUnassign = (profile: Profile) => {
    updateProfileMutation.mutate({ id: profile.id, proxyId: null });
  };

  return (
    <div className="overflow-hidden">
      {/* Proxy fields row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
          <Input
            value={hostPort}
            onChange={e => setHostPort(e.target.value)}
            onBlur={() => saveField("hostPort")}
            onKeyDown={e => e.key === "Enter" && (e.currentTarget.blur())}
            className="font-mono text-sm h-8 w-48 shrink-0"
            placeholder="host:port"
          />
          <Input
            value={username}
            onChange={e => setUsername(e.target.value)}
            onBlur={() => saveField("username")}
            onKeyDown={e => e.key === "Enter" && (e.currentTarget.blur())}
            placeholder="username"
            className="font-mono text-sm h-8 w-32 shrink-0"
          />
          <Input
            value={password}
            onChange={e => setPassword(e.target.value)}
            onBlur={() => saveField("password")}
            onKeyDown={e => e.key === "Enter" && (e.currentTarget.blur())}
            placeholder="password"
            className="font-mono text-sm h-8 w-32 shrink-0"
          />
          {totalCount > 0 && (
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
              validCount === totalCount
                ? "bg-emerald-50 text-emerald-700"
                : validCount === 0
                ? "bg-slate-100 text-slate-500"
                : "bg-yellow-50 text-yellow-700"
            }`}>
              {validCount}/{totalCount}
            </span>
          )}
          {pingResult && (
            <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded shrink-0 ${
              pingResult.alive
                ? pingResult.latencyMs < 300 ? "bg-emerald-50 text-emerald-600"
                  : pingResult.latencyMs < 800 ? "bg-yellow-50 text-yellow-600"
                  : "bg-orange-50 text-orange-600"
                : "bg-red-50 text-red-500"
            }`}>
              {pingResult.alive
                ? <><Wifi className="w-3 h-3" />{pingResult.latencyMs}ms</>
                : <><WifiOff className="w-3 h-3" />Dead</>
              }
            </span>
          )}
          <Button
            variant="ghost" size="icon"
            className={`h-8 w-8 shrink-0 ${pinging ? "text-primary" : "text-muted-foreground hover:text-primary hover:bg-primary/10"}`}
            onClick={() => onPing(proxy.id)}
            disabled={pinging}
            title="Ping through this proxy"
          >
            {pinging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
          </Button>
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 shrink-0 text-white bg-red-500 hover:bg-red-600"
            onClick={() => {
              if (confirm(`Delete proxy ${proxy.host}:${proxy.port}? Profiles using it will be unassigned.`)) {
                deleteProxyMutation.mutate(proxy.id);
              }
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Assigned profiles */}
      <div className="border-t border-border/50 px-4 py-2 bg-accent/10">
        <div className="flex flex-col gap-0.5">
          {assigned.map(profile => (
            <div key={profile.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-accent/40 transition-colors group">
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
            <span className="text-xs text-muted-foreground italic px-2 py-1">All accounts assigned to proxies</span>
          )}
          {assigned.length === 0 && unassignedProfiles.length > 0 && (
            <span className="text-xs text-muted-foreground italic px-2 py-1">No accounts assigned use dropdown to add</span>
          )}
        </div>
      </div>
    </div>
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
  const [importing, setImporting] = useState(false);
  const [maxPerProxy, setMaxPerProxy] = useState(5);
  const [splitting, setSplitting] = useState(false);
  const [autoLinking, setAutoLinking] = useState(false);

  // Centralised ping state
  const [pingResults, setPingResults] = useState<Record<number, PingResult>>({});
  const [pingingIds, setPingingIds] = useState<Set<number>>(new Set());
  const [pingingAll, setPingingAll] = useState(false);
  const autoPingedRef = useRef(false);

  const unassignedProfiles = allProfiles.filter(p => !p.proxyId);

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

  const handleAutoLink = async () => {
    setAutoLinking(true);
    try {
      const res = await apiRequest("POST", "/api/proxies/auto-link");
      const { linked, created, skipped } = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      const parts: string[] = [];
      if (linked > 0) parts.push(`${linked} ${linked === 1 ? "account" : "accounts"} linked`);
      if (created > 0) parts.push(`${created} new ${created === 1 ? "proxy" : "proxies"} created`);
      toast({
        title: parts.length > 0 ? parts.join(", ") : "Nothing to link",
        description: parts.length > 0
          ? "All accounts with proxy data are now linked to Proxy Manager entries."
          : `${skipped} ${skipped === 1 ? "account" : "accounts"} already had proxies or had no proxy data.`,
      });
    } catch {
      toast({ title: "Auto-link failed", variant: "destructive" });
    } finally {
      setAutoLinking(false);
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
        title: `Ping complete ${alive} alive, ${dead} dead`,
        description: dead > 0 ? "Dead proxies are highlighted in red." : "All proxies are responding.",
      });
    } finally {
      setPingingAll(false);
    }
  };

  // Auto-ping all proxies once when the page first loads with data
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
    createProxyMutation.mutate({ host, port, username: username || null, password: password || null }, {
      onSuccess: () => { setIsAddOpen(false); setHostPort(""); setUsername(""); setPassword(""); toast({ title: "Proxy Added" }); },
    });
  };

  const handleSplitEvenly = async () => {
    if (!proxies.length) { toast({ title: "No proxies to assign to", variant: "destructive" }); return; }
    if (!unassignedProfiles.length) { toast({ title: "All accounts are already assigned to a proxy" }); return; }
    setSplitting(true);
    try {
      const slots = proxies.map(proxy => {
        const count = allProfiles.filter(p => p.proxyId === proxy.id).length;
        return { proxy, remaining: Math.max(0, maxPerProxy - count) };
      });
      const toAssign = [...unassignedProfiles];
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
          updateProfileMutation.mutate({ id: a.profileId, proxyId: a.proxyId }, { onSuccess: () => resolve(), onError: reject })
        ))
      );
      await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      const skipped = unassignedProfiles.length - assignments.length;
      toast({
        title: `Assigned ${assignments.length} ${assignments.length === 1 ? "account" : "accounts"} across ${proxies.length} proxies`,
        description: skipped > 0 ? `${skipped} accounts couldn't be assigned all proxies at the ${maxPerProxy} account limit.` : undefined,
      });
    } catch { toast({ title: "Split failed", variant: "destructive" }); }
    finally { setSplitting(false); }
  };

  const aliveCount = Object.values(pingResults).filter(r => r?.alive).length;
  const deadCount = Object.values(pingResults).filter(r => r !== null && !r?.alive).length;
  const testedCount = aliveCount + deadCount;

  return (
    <AppLayout>
      <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Proxy Manager</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
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

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={handleAutoLink}
            disabled={autoLinking}
          >
            {autoLinking ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {autoLinking ? "Linking…" : "Auto-link Accounts"}
          </Button>

          <Button
            variant="outline"
            onClick={handlePingAll}
            disabled={pingingAll || !proxies.length}
          >
            {pingingAll
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <Wifi className="w-4 h-4 mr-2" />
            }
            {pingingAll ? `Pinging… (${testedCount}/${proxies.length})` : "Ping All"}
          </Button>

          <label>
            <input type="file" accept=".txt" className="hidden" onChange={handleImport} disabled={importing} />
            <Button variant="outline" disabled={importing} asChild>
              <span className="cursor-pointer">
                {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                {importing ? "Importing…" : "Import Proxies"}
              </span>
            </Button>
          </label>

          <Button variant="outline" onClick={handleExport} disabled={!proxies.length}>
            <Download className="w-4 h-4 mr-2" /> Export Proxies
          </Button>

          <Button
            variant="outline"
            onClick={handleDeleteAll}
            disabled={deletingAll || !proxies.length}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
          >
            {deletingAll ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash className="w-4 h-4 mr-2" />}
            {deletingAll ? "Deleting…" : "Delete All"}
          </Button>

          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Proxy</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add New Proxy</DialogTitle></DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="hostPort">IP Address &amp; Port</Label>
                  <Input id="hostPort" required value={hostPort} onChange={e => setHostPort(e.target.value)} placeholder="45.80.96.251:29842" className="font-mono" />
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
        </div>
      </div>

      {proxiesLoading ? (
        <div className="desktop-card overflow-hidden divide-y divide-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="p-5 animate-pulse h-24 bg-muted/10" />
          ))}
        </div>
      ) : proxies.length === 0 ? (
        <div className="desktop-card px-6 py-16 text-center text-muted-foreground">
          <Shield className="w-10 h-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No proxies configured</p>
          <p className="text-sm mt-1">Import or add a proxy above to get started.</p>
        </div>
      ) : (
        <div className="desktop-card overflow-hidden divide-y divide-border">
          {proxies.map(proxy => (
            <ProxyCard
              key={proxy.id}
              proxy={proxy}
              allProfiles={allProfiles}
              unassignedProfiles={unassignedProfiles}
              pingResult={pingResults[proxy.id] ?? null}
              pinging={pingingIds.has(proxy.id)}
              onPing={pingOne}
            />
          ))}
        </div>
      )}

      {/* Split evenly panel */}
      {proxies.length > 0 && (
        <div className="desktop-card mt-6 px-5 py-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Split Unassigned Accounts Evenly Across All Proxies</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {unassignedProfiles.length} unassigned {unassignedProfiles.length === 1 ? "account" : "accounts"} will be distributed. Proxies already at the limit will be skipped.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex items-center gap-2">
                <Label htmlFor="maxPerProxy" className="text-sm whitespace-nowrap">Max per proxy</Label>
                <Input
                  id="maxPerProxy"
                  type="number"
                  min={1}
                  max={100}
                  value={maxPerProxy}
                  onChange={e => setMaxPerProxy(Math.max(1, Number(e.target.value)))}
                  className="w-20 h-8 text-sm"
                />
              </div>
              <Button onClick={handleSplitEvenly} disabled={splitting || !unassignedProfiles.length} className="shrink-0">
                {splitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {splitting ? "Splitting…" : "Split Now"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
