import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProxies, useCreateProxy, useDeleteProxy } from "@/hooks/use-proxies";
import { useProfiles, useUpdateProfile } from "@/hooks/use-profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Shield, Globe, User, X, UserPlus, Wifi, WifiOff, Loader2, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Proxy, Profile } from "@shared/schema";

type PingResult = { alive: boolean; latencyMs: number; error?: string } | null;

function ProxyCard({ proxy, profiles }: { proxy: Proxy; profiles: Profile[] }) {
  const deleteProxyMutation = useDeleteProxy();
  const updateProfileMutation = useUpdateProfile();
  const { toast } = useToast();
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult>(null);

  const handlePing = async () => {
    setPinging(true);
    setPingResult(null);
    try {
      const result = await apiRequest("POST", `/api/proxies/${proxy.id}/ping`);
      const data = await result.json();
      setPingResult(data);
    } catch {
      setPingResult({ alive: false, latencyMs: 0, error: "Request failed" });
    } finally {
      setPinging(false);
    }
  };

  const assigned = profiles.filter(p => p.proxyId === proxy.id);
  const available = profiles.filter(p => p.proxyId !== proxy.id);

  const handleAssign = (profileId: number) => {
    updateProfileMutation.mutate({ id: profileId, proxyId: proxy.id }, {
      onSuccess: () => toast({ title: "Profile assigned" }),
    });
  };

  const handleUnassign = (profile: Profile) => {
    updateProfileMutation.mutate({ id: profile.id, proxyId: null }, {
      onSuccess: () => toast({ title: "Profile removed", description: `${profile.username} unassigned from proxy` }),
    });
  };

  return (
    <div className="desktop-card overflow-hidden">
      {/* Proxy header */}
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Globe className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold font-mono truncate">{proxy.host}:{proxy.port}</p>
            {proxy.username && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <User className="w-3 h-3" />{proxy.username}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex flex-col items-end gap-1">
            {proxy.username
              ? <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 px-2 py-1 rounded">Auth</span>
              : <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-accent px-2 py-1 rounded">No Auth</span>
            }
            {pingResult && (
              <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded ${
                pingResult.alive
                  ? pingResult.latencyMs < 300
                    ? 'bg-emerald-50 text-emerald-600'
                    : pingResult.latencyMs < 800
                    ? 'bg-yellow-50 text-yellow-600'
                    : 'bg-orange-50 text-orange-600'
                  : 'bg-red-50 text-red-500'
              }`}>
                {pingResult.alive
                  ? <><Wifi className="w-3 h-3" /> {pingResult.latencyMs}ms</>
                  : <><WifiOff className="w-3 h-3" /> Dead</>
                }
              </span>
            )}
          </div>

          <Button
            variant="ghost" size="icon"
            className={`h-8 w-8 transition-colors ${
              pinging ? 'text-primary' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'
            }`}
            onClick={handlePing}
            disabled={pinging}
            title="Ping Instagram through this proxy"
          >
            {pinging
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Wifi className="w-3.5 h-3.5" />
            }
          </Button>

          <Button
            variant="ghost" size="icon"
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 w-8"
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

      {/* Profile assignment section */}
      <div className="border-t border-border/50 px-5 py-3 bg-accent/20">
        <div className="flex items-center gap-2 mb-2">
          <UserPlus className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assigned Profiles</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {assigned.map(profile => (
            <div key={profile.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
              <User className="w-3 h-3 shrink-0" />
              <span>{profile.username}</span>
              <button
                onClick={() => handleUnassign(profile)}
                disabled={updateProfileMutation.isPending}
                className="ml-0.5 hover:text-destructive transition-colors rounded-full"
                title="Remove from proxy"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {available.length > 0 && (
            <select
              className="h-7 rounded-full border border-dashed border-border bg-background px-3 text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer hover:border-primary/50 transition-colors"
              value=""
              onChange={e => {
                if (e.target.value) handleAssign(Number(e.target.value));
              }}
              disabled={updateProfileMutation.isPending}
            >
              <option value="">+ Assign profile…</option>
              {available.map(p => (
                <option key={p.id} value={p.id}>{p.username}</option>
              ))}
            </select>
          )}

          {assigned.length === 0 && available.length === 0 && (
            <span className="text-xs text-muted-foreground italic">No profiles added yet</span>
          )}

          {assigned.length > 0 && available.length === 0 && (
            <span className="text-xs text-muted-foreground italic">All profiles assigned</span>
          )}
        </div>
      </div>
    </div>
  );
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
      return {
        host,
        port,
        username: parts[1]?.trim() || null,
        password: parts[2]?.trim() || null,
      };
    })
    .filter(Boolean) as Array<{ host: string; port: number; username: string | null; password: string | null }>;
}

export function ProxiesPage() {
  const { data: proxies, isLoading: proxiesLoading } = useProxies();
  const { data: profiles = [] } = useProfiles();
  const createProxyMutation = useCreateProxy();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [hostPort, setHostPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [importing, setImporting] = useState(false);

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

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = hostPort.trim();
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon === -1) {
      toast({ title: "Invalid format", description: "Enter the proxy as IP:PORT (e.g. 45.80.96.251:29842)", variant: "destructive" });
      return;
    }

    const host = trimmed.slice(0, lastColon);
    const port = Number(trimmed.slice(lastColon + 1));

    if (!host || isNaN(port) || port < 1 || port > 65535) {
      toast({ title: "Invalid format", description: "Enter a valid IP:PORT", variant: "destructive" });
      return;
    }

    createProxyMutation.mutate({
      host,
      port,
      username: username || null,
      password: password || null,
    }, {
      onSuccess: () => {
        setIsAddOpen(false);
        setHostPort("");
        setUsername("");
        setPassword("");
        toast({ title: "Proxy Added" });
      },
    });
  };

  return (
    <AppLayout>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Proxy Manager</h1>
          <p className="text-muted-foreground mt-1">Manage proxies and assign them to accounts.</p>
        </div>

        <div className="flex items-center gap-2">
          <label>
            <input
              type="file"
              accept=".txt"
              className="hidden"
              onChange={handleImport}
              disabled={importing}
            />
            <Button variant="outline" disabled={importing} asChild>
              <span className="cursor-pointer">
                {importing
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Upload className="w-4 h-4 mr-2" />
                }
                {importing ? "Importing…" : "Import from Jarvee"}
              </span>
            </Button>
          </label>

          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Add Proxy</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Proxy</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="hostPort">IP Address &amp; Port</Label>
                <Input
                  id="hostPort"
                  required
                  value={hostPort}
                  onChange={e => setHostPort(e.target.value)}
                  placeholder="45.80.96.251:29842"
                  className="font-mono"
                />
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
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="desktop-card p-5 animate-pulse h-28 bg-muted/10" />
          ))}
        </div>
      ) : proxies?.length === 0 ? (
        <div className="desktop-card px-6 py-16 text-center text-muted-foreground">
          <Shield className="w-10 h-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No proxies configured</p>
          <p className="text-sm mt-1">Add a proxy above to assign it to your accounts.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {proxies?.map(proxy => (
            <ProxyCard key={proxy.id} proxy={proxy} profiles={profiles} />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
