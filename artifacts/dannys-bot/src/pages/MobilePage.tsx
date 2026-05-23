import { useState, useEffect, type ChangeEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/layout/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Download, MonitorPlay, RefreshCw, Save, Shuffle,
  CheckCircle2, Loader2, Copy, Settings, Keyboard, Trash2, X,
  ExternalLink, Shield, Plug, Search, Link2Off,
  AlertTriangle, Info, ChevronDown, ChevronUp, RotateCcw, Play,
} from "lucide-react";

// ─── API helper ───────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: any): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /**/ }
  if (!r.ok) throw new Error(data?.error ?? data?.message ?? r.statusText);
  return data as T;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type DeviceInfo   = { serial: string; state: string; product?: string; model?: string };
type ProxyEntry   = { id: number; name?: string | null; host: string; port: number; username?: string | null; password?: string | null };
type ConfigResp   = { instanceConfigs: Record<string, { proxyId?: number | null; sourceInterface?: string | null }>; proxies: ProxyEntry[] };
type DevicePropsResp = { manufacturer: string; model: string; androidVersion: string; sdkInt: string; density: string; width: string; height: string; board: string; deviceString: string; userAgent: string };

const randHex16 = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function proxyLabel(px: ProxyEntry): string {
  const addr = `${px.host}:${px.port}`;
  if (!px.name) return addr;
  const name = px.name.trim();
  if (!name || name === px.host || name === addr) return addr;
  return `${name} — ${addr}`;
}

// ─── Data hooks ───────────────────────────────────────────────────────────────

function useDevices() {
  return useQuery({
    queryKey: ["mobile-devices"],
    queryFn: () => api<{ avds: any[]; devices: DeviceInfo[] }>("GET", "/api/mobile/avds").then(r => r.devices ?? []),
    refetchInterval: 4000,
  });
}

function useAndroidId(serial: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["android-id", serial],
    queryFn: () => api<{ androidId: string | null }>("GET", `/api/mobile/devices/${serial}/android-id`),
  });
  const setMut = useMutation({
    mutationFn: (id: string) => api("POST", `/api/mobile/devices/${serial}/android-id`, { androidId: id }),
    onSuccess: (_d, id) => { qc.setQueryData(["android-id", serial], { androidId: id }); toast({ title: "Device ID updated" }); setEditing(null); },
    onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }),
  });
  const randomize = async () => {
    const { androidId } = await api<{ androidId: string }>("POST", "/api/mobile/android-id/random");
    setEditing(androidId);
  };
  return { androidId: q.data?.androidId ?? null, editing, setEditing, setMut, randomize };
}

// ─── Card colours ─────────────────────────────────────────────────────────────

const COLORS = [
  "from-blue-600 to-blue-800", "from-green-600 to-green-800",
  "from-violet-600 to-violet-800", "from-orange-500 to-orange-700",
  "from-pink-600 to-pink-800", "from-teal-600 to-teal-800",
];


function ProxySelector({ serial, proxies, savedProxyId, savedSourceInterface, onAutoSelect }: { serial: string; proxies: ProxyEntry[]; savedProxyId?: number | null; savedSourceInterface?: string | null; onAutoSelect?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [ipResult, setIpResult] = useState<{ ip?: string; error?: string } | null>(null);
  const [checkingIp, setCheckingIp] = useState(false);
  const [applyingProxy, setApplyingProxy] = useState(false);

  const saveMut = useMutation({
    mutationFn: (proxyId: number | null) => api("POST", `/api/mobile/instances/${encodeURIComponent(serial)}/config`, { proxyId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mobile-config"] }); },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value ? Number(e.target.value) : null;
    saveMut.mutate(id);
    setIpResult(null);
  };

  const checkProxyIp = async () => {
    setCheckingIp(true);
    setIpResult(null);
    try {
      const r = await api<{ ok: boolean; ip?: string; proxy?: string; error?: string }>("GET", `/api/mobile/devices/${serial}/check-ip`);
      if (r.ok && r.ip) setIpResult({ ip: r.ip });
      else setIpResult({ error: r.error ?? "No IP returned" });
    } catch (e: any) {
      setIpResult({ error: e?.message ?? "Check failed" });
    } finally {
      setCheckingIp(false);
    }
  };

  const applyProxyToDevice = async () => {
    setApplyingProxy(true);
    try {
      const r = await api<{ ok: boolean; message?: string; error?: string }>("POST", `/api/mobile/devices/${encodeURIComponent(serial)}/apply-proxy`);
      if (r.ok) toast({ title: "Proxy applied", description: r.message ?? "Proxy set on device via ADB" });
      else toast({ title: "Apply failed", description: r.error, variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Apply failed", description: e?.message ?? "Could not apply proxy", variant: "destructive" });
    } finally {
      setApplyingProxy(false);
    }
  };

  const uniqueProxies = proxies.filter((px, idx, arr) => arr.findIndex(p => p.id === px.id) === idx);

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 items-center">
        <Shield className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <select
          className="flex-1 text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          value={savedProxyId ?? ""}
          onChange={handleChange}
          disabled={saveMut.isPending}
        >
          <option value="">No proxy</option>
          {uniqueProxies.map(px => <option key={px.id} value={px.id}>{proxyLabel(px)}</option>)}
        </select>
        {saveMut.isPending && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      {savedProxyId && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1 h-7 text-[10px]" disabled={checkingIp} onClick={checkProxyIp} title="Confirms the proxy is reachable from this PC and shows its external IP">
            {checkingIp ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}Test proxy reachability
          </Button>
          <Button size="sm" className="flex-1 h-7 text-[10px] bg-green-600 hover:bg-green-700 text-white" disabled={applyingProxy} onClick={applyProxyToDevice} title="Push this proxy to the Android device via ADB — sets the system-level proxy so LD Player routes through it">
            {applyingProxy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}Apply IP to LD Player
          </Button>
        </div>
      )}

      {ipResult && (
        <div className={`text-[10px] px-2 py-1 rounded ${ipResult.ip ? "bg-green-500/10 text-green-600 border border-green-500/20" : "bg-destructive/10 text-destructive border border-destructive/20"}`}>
          {ipResult.ip
            ? <><CheckCircle2 className="w-3 h-3 inline mr-1" />Proxy reachable — external IP: <span className="font-mono font-semibold">{ipResult.ip}</span></>
            : <>Proxy test failed: {ipResult.error}</>
          }
        </div>
      )}

    </div>
  );
}

// ─── Device card ───────────────────────────────────────────────────────────────

function DeviceCard({ device, idx, selected, proxies, savedProxyId, savedSourceInterface, onSelect, onDisconnect, onAutoSelect }: {
  device: DeviceInfo; idx: number; selected: boolean;
  proxies: ProxyEntry[]; savedProxyId?: number | null; savedSourceInterface?: string | null;
  onSelect: () => void; onDisconnect: () => Promise<void>; onAutoSelect?: () => void;
}) {
  const { toast } = useToast();
  const id = useAndroidId(device.serial);
  const color = COLORS[idx % COLORS.length];
  const isOnline = device.state === "device";
  const [disconnecting, setDisconnecting] = useState(false);

  return (
    <div
      onClick={onSelect}
      className={`flex flex-col rounded-xl border overflow-hidden cursor-pointer transition-all hover:shadow-md ${selected ? "border-primary shadow-md ring-2 ring-primary/30" : "border-border hover:border-primary/40"}`}
    >
      <div className={`bg-gradient-to-br ${color} px-4 py-4 flex items-center gap-3`}>
        <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
          <Smartphone className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white text-sm truncate">{device.model ?? device.product ?? "Android Device"}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? "bg-green-400 animate-pulse" : "bg-white/30"}`} />
            <span className={`text-xs ${isOnline ? "text-green-200 font-medium" : "text-white/60"}`}>{isOnline ? "Connected" : device.state}</span>
          </div>
        </div>
        <button
          className="text-white/50 hover:text-white p-1 disabled:opacity-30"
          title="Disconnect device from ADB (LD Player may reconnect automatically)"
          disabled={disconnecting}
          onClick={async e => {
            e.stopPropagation();
            setDisconnecting(true);
            try {
              await onDisconnect();
              toast({ title: "Disconnected", description: "LD Player may reconnect automatically. Close LD Player first to prevent reconnection." });
            } catch (err: any) {
              toast({ title: "Disconnect failed", description: err?.message, variant: "destructive" });
            } finally { setDisconnecting(false); }
          }}
        >
          {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2Off className="w-4 h-4" />}
        </button>
      </div>
      <div className="bg-card px-4 py-3 space-y-3 flex-1">
        <div className="text-[10px] font-mono text-muted-foreground truncate">{device.serial}</div>
        {isOnline && (
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Spoofed Device ID</div>
            {id.editing !== null ? (
              <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                <Input className="h-7 text-xs font-mono" value={id.editing} onChange={e => id.setEditing(e.target.value)} maxLength={16} />
                <Button size="sm" className="h-7 px-2" disabled={id.setMut.isPending || id.editing.length !== 16} onClick={() => id.setMut.mutate(id.editing!)}>
                  {id.setMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Apply"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => id.setEditing(null)}><X className="w-3 h-3" /></Button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                <span className="font-mono text-xs text-foreground/80 truncate flex-1">{id.androidId ?? <span className="italic text-muted-foreground">Reading…</span>}</span>
                {id.androidId && <button onClick={() => navigator.clipboard.writeText(id.androidId!).then(() => toast({ title: "Copied" }))} className="p-0.5 shrink-0"><Copy className="w-3 h-3 text-muted-foreground hover:text-primary" /></button>}
                <button onClick={e => { e.stopPropagation(); id.setEditing(id.androidId ?? ""); }} className="p-0.5 shrink-0"><Settings className="w-3 h-3 text-muted-foreground hover:text-primary" /></button>
                <button title="Randomize" onClick={async e => { e.stopPropagation(); await id.randomize(); }} className="p-0.5 shrink-0"><Shuffle className="w-3 h-3 text-muted-foreground hover:text-primary" /></button>
              </div>
            )}
          </div>
        )}
        <div onClick={e => e.stopPropagation()}>
          <ProxySelector serial={device.serial} proxies={proxies} savedProxyId={savedProxyId} savedSourceInterface={savedSourceInterface} onAutoSelect={onAutoSelect} />
        </div>
      </div>
    </div>
  );
}

// ─── Random generators & spintax ──────────────────────────────────────────────

const RANDOM_NAMES = [
  "maia","mila","mira","neli","nina","nora","olga","rada","raya","roza","yana","zora","zana","jona","buna","arta",
  "luan","geni","enis","rion","erza","adea","bora","kida","vesa","besa","abby","aida","alba","alex","alia","ally",
  "alma","alva","amie","anja","anna","anne","anya","aria","arya","asia","aura","ayla","bebe","bell","bess","beth",
  "brea","bree","bria","bryn","cali","cami","cara","jade","jane","jean","jess","joan","joni","kate","kati","katy",
  "kyra","lana","lara","leah","lexi","lila","lily","lisa","lori","lucy","luna","maci","macy","maja","mali","mara",
  "mari","mary","maya","mela","meli","mika","mimi","mina","miri","mona","myra","nell","neve","nica","nico","nika",
  "niki","nila","noa","nola","nova","nyla","olga","oona","page","rana","reba","rica","rina","rita","riya","roma",
  "rosa","rose","rosy","ruby","ruth","sage","sara","sasha","shae","shea","sia","sina","skye","sofi","sola","sona",
  "tala","tali","tana","tara","taya","tess","thea","tia","tina","toya","tyra","uma","una","vale","vali","vera",
  "vika","vina","vita","viva","wren","xena","yael","yara","zoey","zola","zoya","zuri","blake","casey","drew",
  "emery","finley","grey","hayden","kai","lane","morgan","noel","peyton","quinn","reese","riley","sam","scout",
  "tate","alex","avery","brook","charlie","cloud","dana","eden","fern","glen","haven","indie","jade","juno",
  "kali","lake","lena","lola","luma","lyra","nova","opal","petra","piper","remi","rue","seren","sloane","winter",
];

function _rng<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function resolveSpintax(template: string): string {
  let s = template, prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\{(\d+)\.\.(\d+)\}/g, (_m, a, b) => {
      const min = parseInt(a), max = parseInt(b);
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    });
    s = s.replace(/\{([^{}]+)\}/g, (_m, inner) => {
      const opts = inner.split("|");
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return s;
}

function generateUsername(): string {
  const name = _rng(RANDOM_NAMES);
  const sep = _rng(["_", ".", ""]);
  const num = Math.floor(Math.random() * 9000) + 100;
  return name + sep + num;
}

function generatePassword(): string {
  const words = ["travel","sunset","coffee","garden","music","happy","lucky","bright","ocean","forest","light","dream","smile","river","cloud"];
  const word = _rng(words);
  const num = Math.floor(Math.random() * 900) + 100;
  const special = _rng(["!", "@", "#", "$", "&"]);
  return word.charAt(0).toUpperCase() + word.slice(1) + num + special;
}

function generateEmail(username: string): string {
  const domains = ["gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com","proton.me"];
  const base = (username || (_rng(RANDOM_NAMES) + Math.floor(Math.random() * 999 + 1)))
    .replace(/[^a-z0-9._-]/gi, "").toLowerCase();
  return base + "@" + _rng(domains);
}

function generateDob(): string {
  const year = 1982 + Math.floor(Math.random() * 22);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ─── Device props panel ────────────────────────────────────────────────────────

function DevicePropsPanel({ serial }: { serial: string }) {
  const { toast } = useToast();
  const propsQ = useQuery({
    queryKey: ["device-props", serial],
    queryFn: () => api<DevicePropsResp>("GET", `/api/mobile/devices/${serial}/device-props`),
    retry: false,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">BlueStacks Device Profile</div>
        <Button
          size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1"
          onClick={() => propsQ.refetch()}
          disabled={propsQ.isFetching}
          title="Re-read device properties from BlueStacks via ADB — use this after changing the device profile in BlueStacks Settings → Phone"
        >
          <RefreshCw className={`w-3 h-3 ${propsQ.isFetching ? "animate-spin" : ""}`} />
          {propsQ.isFetching ? "Reading…" : "Refresh"}
        </Button>
      </div>
      {propsQ.isError ? (
        <div className="text-[10px] text-muted-foreground/60 italic px-1">Could not read device props — is the device connected?</div>
      ) : propsQ.data ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {[
            ["Manufacturer", propsQ.data.manufacturer],
            ["Model", propsQ.data.model],
            ["Android", propsQ.data.androidVersion],
            ["Resolution", propsQ.data.width && propsQ.data.height ? `${propsQ.data.width}×${propsQ.data.height}` : "—"],
          ].map(([label, val]) => (
            <div key={label} className="flex flex-col">
              <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">{label}</span>
              <span className="text-[11px] font-medium text-foreground/80 truncate">{val || "—"}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          <Loader2 className="w-3 h-3 animate-spin" />Reading device profile…
        </div>
      )}
      <div className="text-[10px] text-muted-foreground/60 leading-relaxed">
        Change the device profile in <strong>BlueStacks → Settings → Phone → Device Profile</strong>, then click Refresh above to see the updated profile. The new fingerprint is captured automatically when you click <strong>Save to Accounts</strong>.
      </div>
    </div>
  );
}

// ─── Device detail panel ───────────────────────────────────────────────────────

function DevicePanel({ device, onClose, onReset }: { device: DeviceInfo; onClose: () => void; onReset?: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const serial = device.serial;
  const [apkPath, setApkPath]       = useState("");
  const [showReinstall, setShowReinstall] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail]       = useState("");
  const [phone, setPhone]       = useState("");
  const [dob, setDob]           = useState("");
  const [notes, setNotes]       = useState("");
  const [typeText, setTypeText] = useState("");

  const [customSpin, setCustomSpin] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("mobile_spin") ?? "{}"); } catch { return {}; }
  });
  const [showSpinEditor, setShowSpinEditor] = useState(false);
  const saveSpin = (id: string, val: string) => {
    const next = { ...customSpin, [id]: val };
    setCustomSpin(next);
    localStorage.setItem("mobile_spin", JSON.stringify(next));
  };
  const shuffle = (id: string, setter: (v: string) => void, fallback: () => string) => {
    const spin = (customSpin[id] ?? "").trim();
    setter(spin ? resolveSpintax(spin) : fallback());
  };

  const instQ = useQuery({
    queryKey: ["ig-installed", serial],
    queryFn: () => api<{ installed: boolean }>("GET", `/api/mobile/devices/${serial}/instagram-installed`),
    refetchInterval: 12000,
  });
  const apkCacheQ = useQuery({
    queryKey: ["apk-cache"],
    queryFn: () => api<{ cached: boolean; size?: number }>("GET", "/api/mobile/instagram-apk-cache"),
    refetchInterval: 20000,
  });

  const installMut = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/install`, { apkPath }), onSuccess: () => { toast({ title: "Instagram installed" }); qc.invalidateQueries({ queryKey: ["ig-installed", serial] }); }, onError: (e: any) => toast({ title: "Install failed", description: e?.message, variant: "destructive" }) });
  const installCachedMut = useMutation({
    mutationFn: () => api("POST", `/api/mobile/devices/${serial}/instagram/install-cached`),
    onSuccess: () => { toast({ title: "Instagram installed from cache" }); qc.invalidateQueries({ queryKey: ["ig-installed", serial] }); },
    onError: (e: any) => toast({ title: "Cached install failed", description: e?.message, variant: "destructive" }),
  });
  const [playStoreResult, setPlayStoreResult] = useState<{ ok: boolean; steps: string[]; error?: string } | null>(null);
  const playStoreMut = useMutation({
    mutationFn: () => api<{ ok: boolean; steps: string[]; error?: string }>("POST", `/api/mobile/devices/${serial}/instagram/install-from-play`, {}),
    onSuccess: (r) => {
      setPlayStoreResult(r);
      if (r.ok) {
        toast({ title: "Instagram installing via Play Store", description: "APK will be cached automatically after install — next time will be instant." });
        qc.invalidateQueries({ queryKey: ["ig-installed", serial] });
        setTimeout(() => qc.invalidateQueries({ queryKey: ["apk-cache"] }), 30000);
      } else {
        toast({ title: "Play Store install issue", description: r.error ?? "Check the steps below", variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: "Play Store install failed", description: e?.message, variant: "destructive" }),
  });
  const launchMut  = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/instagram/launch`, {}), onSuccess: () => toast({ title: "Instagram launched" }), onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }) });
  const clearMut   = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/instagram/clear`, {}),   onSuccess: () => toast({ title: "App data cleared — fresh signup ready" }), onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }) });
  const mirrorMut  = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/scrcpy/start`, {}),      onSuccess: () => toast({ title: "Screen mirror opened" }), onError: (e: any) => toast({ title: "Mirror failed — install scrcpy and add to PATH", description: e?.message, variant: "destructive" }) });
  const typeMut    = useMutation({
    mutationFn: (text: string) => api("POST", `/api/mobile/devices/${serial}/input/text`, { text }),
    onSuccess: () => toast({ title: "Text injected" }),
    onError: (e: any) => toast({ title: "Type failed — make sure a text field is focused in BlueStacks", description: e?.message, variant: "destructive" }),
  });
  const resetMut   = useMutation({
    mutationFn: () => api<{ ok: boolean; newAndroidId: string; gaidReset: boolean }>("POST", `/api/mobile/devices/${serial}/reset`),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["android-id", serial] });
      qc.invalidateQueries({ queryKey: ["mobile-config"] });
      qc.invalidateQueries({ queryKey: ["ig-installed", serial] });
      qc.invalidateQueries({ queryKey: ["mobile-devices"] });
      const gaidNote = d.gaidReset
        ? "Android ID + Advertising ID (GAID) reset automatically."
        : "Android ID reset. GAID could not be auto-reset — go to BlueStacks Settings → Google → Ads → Reset advertising ID manually.";
      toast({ title: "Reset complete", description: `${gaidNote} Proxy cleared. Change device profile in BlueStacks → Settings → Phone, then open Instagram.` });
      onReset?.();
    },
    onError: (e: any) => toast({ title: "Reset failed", description: e?.message, variant: "destructive" }),
  });
  const [deepResetSteps, setDeepResetSteps] = useState<string[] | null>(null);
  const deepResetMut = useMutation({
    mutationFn: () => api<{ ok: boolean; newAndroidId: string; steps: string[] }>("POST", `/api/mobile/devices/${serial}/deep-reset`),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["android-id", serial] });
      qc.invalidateQueries({ queryKey: ["mobile-config"] });
      qc.invalidateQueries({ queryKey: ["ig-installed", serial] });
      qc.invalidateQueries({ queryKey: ["mobile-devices"] });
      setDeepResetSteps(d.steps);
      onReset?.();
    },
    onError: (e: any) => toast({ title: "Deep reset failed", description: e?.message, variant: "destructive" }),
  });
  const [signupResult, setSignupResult] = useState<{ ok: boolean; steps: string[]; error?: string } | null>(null);
  const signupMut = useMutation({
    mutationFn: () => api<{ ok: boolean; steps: string[]; error?: string }>("POST", `/api/mobile/devices/${serial}/instagram/signup`, { email }),
    onSuccess: (r) => {
      setSignupResult(r);
      if (r.ok) toast({ title: "Instagram signup started", description: "Email filled — complete the remaining steps (name, OTP, password) in BlueStacks." });
      else toast({ title: "Signup automation had issues", description: r.error ?? "Check the steps below", variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Signup failed", description: e?.message, variant: "destructive" }),
  });
  const saveMut    = useMutation({
    mutationFn: async () => {
      let igDeviceState: string | null = null;
      let userAgentApi: string | null = null;
      try {
        const props = await api<DevicePropsResp>("GET", `/api/mobile/devices/${serial}/device-props`);
        igDeviceState = JSON.stringify({
          v: 3,
          deviceId: `android-${randHex16()}`,
          uuid: crypto.randomUUID(),
          phoneId: crypto.randomUUID(),
          adid: crypto.randomUUID(),
          deviceString: props.deviceString,
          igDid: crypto.randomUUID(),
        });
        userAgentApi = props.userAgent;
      } catch { /* device props non-critical — save proceeds without them */ }
      return api("POST", "/api/mobile/accounts", {
        username, password, email: email || null, phoneNumber: phone || null,
        dateOfBirth: dob || null, notes: notes || null, serial, avdName: null,
        igDeviceState, userAgentApi,
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profiles"] }); toast({ title: "Account saved", description: `@${username} added to Accounts — device fingerprint captured.` }); setUsername(""); setPassword(""); setEmail(""); setPhone(""); setDob(""); setNotes(""); },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });

  const fields = [
    { id: "u",  label: "Username",               val: username, set: setUsername, gen: () => generateUsername() },
    { id: "pw", label: "Password",               val: password, set: setPassword, gen: () => generatePassword() },
    { id: "em", label: "Email",                  val: email,    set: setEmail,    gen: () => generateEmail(username) },
    { id: "ph", label: "Phone",                  val: phone,    set: setPhone,    gen: null },
    { id: "db", label: "Date of birth (YYYY-MM-DD)", val: dob,  set: setDob,      gen: () => generateDob() },
  ];

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 bg-muted/40 border-b border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <Smartphone className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">{device.model ?? device.product ?? "Device"}</span>
          <Badge variant="secondary" className="text-[10px] font-mono">{serial}</Badge>
          {instQ.data?.installed === true  && <Badge className="bg-gradient-to-r from-purple-600 to-pink-600 text-white text-[10px] border-0">Instagram installed</Badge>}
          {instQ.data?.installed === false && <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">Instagram not installed</Badge>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[10px] border-orange-500/50 text-orange-600 hover:bg-orange-500/10 hover:border-orange-500 gap-1.5"
            disabled={resetMut.isPending || deepResetMut.isPending}
            title="Clears Instagram data, resets Android ID + GAID, clears proxy. Quick reset between accounts on the same device."
            onClick={() => resetMut.mutate()}
          >
            {resetMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Reset
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[10px] border-red-500/50 text-red-600 hover:bg-red-500/10 hover:border-red-500 gap-1.5"
            disabled={resetMut.isPending || deepResetMut.isPending}
            title="Nuclear reset: clears Instagram + ALL Google identifiers (GSF ID, GAID, Play Services). Stops Instagram from recognising the device across accounts. You must re-sign into your Google account in BlueStacks afterwards."
            onClick={() => {
              if (window.confirm("Deep Reset will clear ALL Google identifiers (GSF ID, GAID, Play Services) — this is the strongest possible device clean.\n\nAfterwards you MUST re-sign into your Google account in BlueStacks before using the Play Store again.\n\nInstagram can be re-installed from cache (no Play Store needed).\n\nContinue?")) {
                deepResetMut.mutate();
              }
            }}
          >
            {deepResetMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
            Deep Reset
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>
      </div>

      <div className="p-5 grid grid-cols-2 gap-6">
        {/* Left */}
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">App controls</div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <Button size="sm" variant="outline" className="text-xs" disabled={launchMut.isPending} onClick={() => launchMut.mutate()}><Play className="w-3.5 h-3.5 mr-1" />Launch</Button>
              <Button size="sm" variant="outline" className="text-xs" disabled={clearMut.isPending} title="Wipes Instagram data — next launch is a clean phone for a new signup" onClick={() => clearMut.mutate()}><Trash2 className="w-3.5 h-3.5 mr-1" />Clear data</Button>
              <Button size="sm" variant="outline" className="text-xs" disabled={mirrorMut.isPending} onClick={() => mirrorMut.mutate()}><MonitorPlay className="w-3.5 h-3.5 mr-1" />Mirror</Button>
            </div>
            {instQ.data?.installed ? (
              <>
                <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md bg-green-500/10 border border-green-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                  <span className="text-xs text-green-600 font-medium flex-1">Instagram installed</span>
                  <button className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0" onClick={() => setShowReinstall(v => !v)}>
                    {showReinstall ? "Cancel" : "Reinstall?"}
                  </button>
                </div>
                {showReinstall && (
                  <div className="space-y-1.5 mb-2">
                    <Label className="text-xs">Reinstall from APK</Label>
                    <div className="flex gap-2">
                      <Input className="text-xs flex-1" placeholder="C:\Downloads\instagram.apk" value={apkPath} onChange={e => setApkPath(e.target.value)} />
                      <Button size="sm" disabled={!apkPath || installMut.isPending} onClick={() => installMut.mutate()}>
                        {installMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      </Button>
                    </div>
                  </div>
                )}
                {/* Sign up button — reads email from the credentials form */}
                <div className="space-y-1 mb-2">
                  <Button
                    size="sm"
                    className="w-full h-8 text-xs gap-1.5 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white border-0"
                    disabled={signupMut.isPending || !email}
                    title={email ? `Open Instagram and start signup with ${email}` : "Enter an email in the Save Account Credentials section below first"}
                    onClick={() => { setSignupResult(null); signupMut.mutate(); }}
                  >
                    {signupMut.isPending
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Opening Instagram…</>
                      : <><Play className="w-3.5 h-3.5" />Open Instagram &amp; Sign Up</>}
                  </Button>
                  {!email && <p className="text-[9px] text-muted-foreground/60 text-center">Fill in an email below first</p>}
                  {signupMut.isPending && (
                    <p className="text-[9px] text-muted-foreground/60 text-center leading-tight">
                      BlueStacks will come to the front — tapping Get Started and filling your email automatically…
                    </p>
                  )}
                  {signupResult && (
                    <details className="text-[10px]" open={!signupResult.ok}>
                      <summary className="cursor-pointer text-muted-foreground/70 hover:text-muted-foreground select-none">
                        {signupResult.ok ? "✓" : "⚠"} Signup log ({signupResult.steps.length} steps)
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-2 border-l border-border/40">
                        {signupResult.steps.map((s, i) => (
                          <li key={i} className={`text-[9px] leading-tight ${s.startsWith("⚠") ? "text-amber-600" : "text-muted-foreground"}`}>{s}</li>
                        ))}
                        {signupResult.error && <li className="text-[9px] text-destructive leading-tight">{signupResult.error}</li>}
                      </ul>
                    </details>
                  )}
                  {deepResetSteps && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-semibold text-red-600">Deep Reset complete</p>
                        <button className="text-[9px] text-muted-foreground hover:text-foreground" onClick={() => setDeepResetSteps(null)}>dismiss</button>
                      </div>
                      <ul className="space-y-0.5">
                        {deepResetSteps.map((s, i) => (
                          <li key={i} className={`text-[9px] leading-tight ${s.startsWith("⚠") ? "text-amber-600" : "text-muted-foreground"}`}>{s}</li>
                        ))}
                      </ul>
                      <div className="border-t border-red-500/20 pt-2 space-y-1">
                        <p className="text-[9px] font-semibold text-foreground">Next steps — do these in order:</p>
                        <ol className="list-decimal list-inside space-y-0.5">
                          <li className="text-[9px] text-muted-foreground">Change phone model in BlueStacks → Settings → Phone</li>
                          <li className="text-[9px] text-muted-foreground">Open BlueStacks → sign into your Google account (Play Services needs to re-register)</li>
                          <li className="text-[9px] text-muted-foreground">Come back and install Instagram from cache (no Play Store needed)</li>
                          <li className="text-[9px] text-muted-foreground">Set a fresh proxy, then start the signup</li>
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-2 mb-2">
                <Label className="text-xs">Install Instagram</Label>

                {/* Option 1 — Cached APK (fast) or Play Store */}
                <div className="space-y-1">
                  {apkCacheQ.data?.cached ? (
                    <>
                      <Button
                        size="sm"
                        className="w-full h-8 text-xs gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white border-0"
                        disabled={installCachedMut.isPending}
                        onClick={() => installCachedMut.mutate()}
                      >
                        {installCachedMut.isPending
                          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Installing…</>
                          : <><Download className="w-3.5 h-3.5" />Install Instagram (~5s, cached)</>}
                      </Button>
                      <p className="text-[9px] text-muted-foreground/60 text-center leading-tight">
                        Using locally cached APK — no download needed.{" "}
                        <button className="underline hover:text-foreground" onClick={() => { setPlayStoreResult(null); playStoreMut.mutate(); }} disabled={playStoreMut.isPending}>
                          Re-download from Play Store
                        </button>
                      </p>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full h-8 text-xs gap-1.5"
                      disabled={playStoreMut.isPending}
                      onClick={() => { setPlayStoreResult(null); playStoreMut.mutate(); }}
                    >
                      {playStoreMut.isPending
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Opening Play Store…</>
                        : <><Download className="w-3.5 h-3.5" />Install via Google Play</>}
                    </Button>
                  )}
                  {playStoreMut.isPending && (
                    <p className="text-[9px] text-muted-foreground/60 text-center leading-tight">
                      BlueStacks will come to the front — Play Store will open and Install will be tapped automatically. APK will be cached for next time.
                    </p>
                  )}
                  {playStoreResult && (
                    <details className="text-[10px]" open={!playStoreResult.ok}>
                      <summary className="cursor-pointer text-muted-foreground/70 hover:text-muted-foreground select-none">
                        {playStoreResult.ok ? "✓" : "⚠"} Play Store log ({playStoreResult.steps.length} steps)
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-2 border-l border-border/40">
                        {playStoreResult.steps.map((s, i) => (
                          <li key={i} className={`text-[9px] leading-tight ${s.startsWith("⚠") ? "text-amber-600" : "text-muted-foreground"}`}>{s}</li>
                        ))}
                        {playStoreResult.error && <li className="text-[9px] text-destructive leading-tight">{playStoreResult.error}</li>}
                      </ul>
                    </details>
                  )}
                </div>

                {/* Divider */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-border/50" />
                  <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wide">or via APK</span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>

                {/* Option 2 — APK file */}
                <div className="space-y-1">
                  <div className="flex gap-2">
                    <Input className="text-xs flex-1" placeholder="C:\Downloads\instagram.apk" value={apkPath} onChange={e => setApkPath(e.target.value)} />
                    <Button size="sm" disabled={!apkPath || installMut.isPending} onClick={() => installMut.mutate()}>
                      {installMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    APK from{" "}
                    <a className="underline hover:text-primary" href="https://www.apkmirror.com/apk/instagram/instagram-instagram/" target="_blank" rel="noreferrer">APKMirror <ExternalLink className="w-2.5 h-2.5 inline" /></a>
                  </p>
                </div>
              </div>
            )}
          </div>

          <Separator />

          <DevicePropsPanel serial={serial} />

          <Separator />

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <Keyboard className="w-3.5 h-3.5" />Type into focused field
            </div>
            <div className="flex gap-2">
              <Input className="text-xs flex-1" placeholder="Text to inject…" value={typeText} onChange={e => setTypeText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && typeText) typeMut.mutate(typeText); }} />
              <Button size="sm" variant="outline" disabled={!typeText || typeMut.isPending} onClick={() => typeMut.mutate(typeText)}>
                {typeMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Keyboard className="w-3.5 h-3.5" />}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Open Mirror → tap a field inside BlueStacks to focus it → press Enter here or click the button to fill it.</p>
          </div>
        </div>

        {/* Right: signup */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save account credentials</div>
            <button
              className="text-[10px] text-primary/60 hover:text-primary underline"
              onClick={() => setShowSpinEditor(v => !v)}
            >{showSpinEditor ? "Hide spintax ↑" : "Custom spintax ↓"}</button>
          </div>

          <Button size="sm" variant="outline" className="w-full text-xs gap-1.5" onClick={() => {
            const u = (customSpin["u"] ?? "").trim() ? resolveSpintax(customSpin["u"]) : generateUsername();
            setUsername(u);
            setPassword((customSpin["pw"] ?? "").trim() ? resolveSpintax(customSpin["pw"]) : generatePassword());
            setEmail((customSpin["em"] ?? "").trim() ? resolveSpintax(customSpin["em"]) : generateEmail(u));
            setDob((customSpin["db"] ?? "").trim() ? resolveSpintax(customSpin["db"]) : generateDob());
          }}>
            <Shuffle className="w-3 h-3" />Generate all fields
          </Button>

          <p className="text-[10px] text-muted-foreground -mt-1">
            Generate fields, then use <strong>Type</strong> to inject each value directly into BlueStacks. Open Mirror first, focus the field in BlueStacks, then click Type.
          </p>

          <div className="grid grid-cols-2 gap-2">
            {fields.map(f => (
              <div key={f.id} className="space-y-1">
                <Label htmlFor={`sp-${f.id}`} className="text-[10px] text-muted-foreground">{f.label}</Label>
                <div className="flex gap-1">
                  <Input id={`sp-${f.id}`} className="text-xs h-8 flex-1" value={f.val} onChange={e => f.set(e.target.value)} />
                  {f.gen && (
                    <Button size="sm" variant="outline" className="h-8 w-8 p-0 shrink-0" title="Generate random value" onClick={() => shuffle(f.id, f.set, f.gen!)}>
                      <Shuffle className="w-3 h-3" />
                    </Button>
                  )}
                  <Button
                    size="sm" variant="outline" className="h-8 w-8 p-0 shrink-0"
                    title="Copy to clipboard"
                    disabled={!f.val}
                    onClick={() => navigator.clipboard.writeText(f.val).then(() => toast({ title: "Copied!", description: f.label }))}
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                  <Button
                    size="sm" variant="outline" className="h-8 px-2 text-[10px] shrink-0"
                    title="Focus a field in the Mirror window, then click this to type it in"
                    disabled={!f.val || typeMut.isPending}
                    onClick={() => typeMut.mutate(f.val)}
                  >
                    {typeMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Type"}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {showSpinEditor && (
            <div className="border border-border rounded-lg p-3 bg-muted/30 space-y-2">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Paste your own spintax for any field — e.g. <span className="font-mono bg-background px-1 rounded">{"{"} maia|nina|zara{"}"}_{"{"} 1..99{"}"}</span>. Leave blank to use the built-in generator. Saved automatically.
              </p>
              {[
                { id: "u",  label: "Username spintax" },
                { id: "pw", label: "Password spintax" },
                { id: "em", label: "Email spintax" },
                { id: "db", label: "Date of birth spintax" },
              ].map(f => (
                <div key={f.id} className="space-y-0.5">
                  <Label className="text-[10px] text-muted-foreground">{f.label}</Label>
                  <Input
                    className="text-xs h-7 font-mono"
                    placeholder="leave blank for auto-generate"
                    value={customSpin[f.id] ?? ""}
                    onChange={e => saveSpin(f.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Notes</Label>
            <Textarea rows={2} className="text-xs resize-none" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. phone used, recovery email…" />
          </div>
          <Button className="w-full" disabled={!username || !password || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Save to Accounts
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Connect form (reusable) ──────────────────────────────────────────────────

function ConnectForm({ onConnected, compact = false }: { onConnected: () => void; compact?: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [address, setAddress] = useState("127.0.0.1:5555");
  const [discovering, setDiscovering] = useState(false);

  const connectMut = useMutation({
    mutationFn: (addr: string) => api<{ ok: boolean; message: string }>("POST", "/api/mobile/connect", { address: addr }),
    onSuccess: data => {
      if (data.ok) { toast({ title: "Connected!" }); qc.invalidateQueries({ queryKey: ["mobile-devices"] }); onConnected(); }
      else toast({ title: "Could not connect", description: data.message, variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }),
  });

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await api<{ results: Array<{ address: string; connected: boolean }> }>("POST", "/api/mobile/discover");
      const found = r.results.filter(x => x.connected);
      if (found.length) { toast({ title: `Found ${found.length} emulator(s)!` }); qc.invalidateQueries({ queryKey: ["mobile-devices"] }); onConnected(); }
      else toast({ title: "None found", description: "Make sure your emulator is open, then try again.", variant: "destructive" });
    } catch (e: any) { toast({ title: "Scan failed", description: e?.message, variant: "destructive" }); }
    finally { setDiscovering(false); }
  };

  if (compact) {
    return (
      <div className="border border-border rounded-xl bg-card p-4 space-y-3">
        <div className="text-sm font-semibold">Connect another emulator</div>
        <div className="flex gap-2">
          <Button className="flex-1" disabled={discovering} onClick={discover} variant="outline">
            {discovering ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />}
            Auto-detect
          </Button>
          <span className="self-center text-xs text-muted-foreground">or</span>
          <Input
            className="text-xs font-mono flex-1"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="127.0.0.1:5555"
            onKeyDown={e => { if (e.key === "Enter") connectMut.mutate(address); }}
          />
          <Button disabled={!address || connectMut.isPending} onClick={() => connectMut.mutate(address)}>
            {connectMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
            Connect
          </Button>
        </div>
        <div className="text-[10px] text-muted-foreground space-y-0.5">
          <div>LD Player (default): <span className="font-mono text-foreground/70">127.0.0.1:5554</span></div>
          <div>LD Player (instance 2): <span className="font-mono text-foreground/70">127.0.0.1:5556</span></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button className="w-full" disabled={discovering} onClick={discover}>
        {discovering ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />}
        Auto-detect emulator
      </Button>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <div className="flex-1 h-px bg-border" />or type address manually<div className="flex-1 h-px bg-border" />
      </div>
      <div className="flex gap-2">
        <Input
          className="text-xs font-mono flex-1"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="127.0.0.1:5554"
          onKeyDown={e => { if (e.key === "Enter") connectMut.mutate(address); }}
        />
        <Button disabled={!address || connectMut.isPending} onClick={() => connectMut.mutate(address)}>
          {connectMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
          Connect
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <div>LD Player (default): <span className="font-mono text-foreground/70">127.0.0.1:5554</span></div>
        <div>LD Player (instance 2): <span className="font-mono text-foreground/70">127.0.0.1:5556</span></div>
      </div>
    </div>
  );
}

// ─── Setup guide ──────────────────────────────────────────────────────────────

function SetupGuide({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="max-w-xl mx-auto space-y-6 py-4">
      <div className="space-y-4">
        <div className="flex gap-4 items-start">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0">1</div>
          <div className="flex-1">
            <div className="font-semibold text-sm">Install LD Player</div>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              Free Android emulator — install Instagram from its built-in Google Play Store, or via APK.
            </p>
            <a href="https://www.ldplayer.net/download/" target="_blank" rel="noreferrer" className="block border border-border rounded-xl overflow-hidden hover:border-primary/50 hover:shadow-md transition-all group max-w-xs">
              <div className="bg-gradient-to-br from-green-600 to-teal-700 px-3 py-2.5 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-white shrink-0" />
                <span className="font-semibold text-white text-sm">LD Player</span>
                <ExternalLink className="w-3 h-3 text-white/60 ml-auto group-hover:text-white" />
              </div>
              <div className="px-3 py-2 bg-card">
                <p className="text-[10px] text-muted-foreground">Fast Android emulator. 100% free.</p>
                <p className="text-[10px] text-primary/80 mt-1 font-medium">After installing: Settings (gear) → Other Settings → enable "Open ADB debugging"</p>
              </div>
            </a>
          </div>
        </div>

        <div className="flex gap-4 items-start">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0">2</div>
          <div className="flex-1">
            <div className="font-semibold text-sm">Open the emulator, then click Auto-detect</div>
            <p className="text-xs text-muted-foreground mt-1 mb-3">Equinox will find it automatically. If it doesn't, enter the address manually.</p>
            <ConnectForm onConnected={onConnected} />
          </div>
        </div>

        <div className="flex gap-4 items-start opacity-50">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-bold text-sm shrink-0">3</div>
          <div>
            <div className="font-semibold text-sm">Install Instagram & create accounts</div>
            <p className="text-xs text-muted-foreground mt-1">
              Once connected, click a device card to install Instagram, mirror the screen, spoof the Device ID, and save the account — all from Equinox.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export function MobilePage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const devicesQ = useDevices();
  const configQ  = useQuery({ queryKey: ["mobile-config"], queryFn: () => api<ConfigResp>("GET", "/api/mobile/config") });

  const [selectedSerial, setSelectedSerial]         = useState<string | null>(null);
  const [showAddForm, setShowAddForm]               = useState(false);
  const [reconnectingSerial, setReconnectingSerial] = useState<string | null>(null);

  // Deduplicate: BlueStacks can appear in `adb devices` as both a TCP entry
  // (127.0.0.1:5555) and an emulator entry (emulator-5554) simultaneously.
  // Prefer the TCP entry when model/product names match.
  const rawDevices = devicesQ.data?.filter(d => d.state === "device" || d.state === "offline") ?? [];
  const tcpSerials = new Set(rawDevices.filter(d => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(d.serial)).map(d => `${d.model ?? ""}|${d.product ?? ""}`));
  const devices = rawDevices.filter(d => {
    if (!/^emulator-/.test(d.serial)) return true;
    // Drop emulator-XXXX if a TCP entry with same model+product already exists
    return !tcpSerials.has(`${d.model ?? ""}|${d.product ?? ""}`);
  });

  // Clear reconnecting state as soon as the device reappears in the ADB list
  useEffect(() => {
    if (reconnectingSerial && devices.some(d => d.serial === reconnectingSerial)) {
      setReconnectingSerial(null);
      setSelectedSerial(reconnectingSerial);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devicesQ.data, reconnectingSerial]);
  const proxies  = configQ.data?.proxies ?? [];
  const configs  = configQ.data?.instanceConfigs ?? {};
  const selected = devices.find(d => d.serial === selectedSerial) ?? null;

  const disconnectMut = useMutation({
    mutationFn: (address: string) => api("POST", "/api/mobile/disconnect", { address }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mobile-devices"] }); },
    onError: (e: any) => toast({ title: "Disconnect failed", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 ml-64 p-6 overflow-auto">
        <div className="max-w-5xl mx-auto space-y-6">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Smartphone className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Mobile</h1>
                <p className="text-xs text-muted-foreground">Run multiple Instagram mobile instances, each with its own device identity and proxy.</p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => { devicesQ.refetch(); qc.invalidateQueries({ queryKey: ["mobile-config"] }); }} disabled={devicesQ.isFetching}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${devicesQ.isFetching ? "animate-spin" : ""}`} />Refresh
            </Button>
          </div>

          {/* Devices connected */}
          {devicesQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />Scanning for devices…
            </div>
          ) : devices.length === 0 && reconnectingSerial ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
              <div>
                <div className="font-semibold text-sm">Reconnecting to LD Player…</div>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  ADB briefly dropped the connection. This is normal — it reconnects automatically in a few seconds.
                </p>
              </div>
            </div>
          ) : devices.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  {devices.length} device{devices.length !== 1 ? "s" : ""} connected
                </div>
                <Button size="sm" variant="outline" onClick={() => { setShowAddForm(v => !v); setSelectedSerial(null); }}>
                  {showAddForm
                    ? <><ChevronUp className="w-3.5 h-3.5 mr-1.5" />Cancel</>
                    : <><Plug className="w-3.5 h-3.5 mr-1.5" />Add another</>
                  }
                </Button>
              </div>

              {showAddForm && (
                <ConnectForm compact onConnected={() => { setShowAddForm(false); devicesQ.refetch(); }} />
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {devices.map((dev, i) => (
                  <DeviceCard
                    key={dev.serial}
                    device={dev}
                    idx={i}
                    selected={selectedSerial === dev.serial}
                    proxies={proxies}
                    savedProxyId={configs[dev.serial]?.proxyId}
                    savedSourceInterface={configs[dev.serial]?.sourceInterface}
                    onSelect={() => { setSelectedSerial(selectedSerial === dev.serial ? null : dev.serial); setShowAddForm(false); }}
                    onDisconnect={() => disconnectMut.mutateAsync(dev.serial).then(() => { /* void */ })}
                    onAutoSelect={() => { setSelectedSerial(dev.serial); setReconnectingSerial(dev.serial); setShowAddForm(false); }}
                  />
                ))}
              </div>
              {selected && <DevicePanel device={selected} onClose={() => setSelectedSerial(null)} onReset={() => setSelectedSerial(null)} />}
            </div>
          ) : (
            <SetupGuide onConnected={() => devicesQ.refetch()} />
          )}

        </div>
      </main>
    </div>
  );
}
