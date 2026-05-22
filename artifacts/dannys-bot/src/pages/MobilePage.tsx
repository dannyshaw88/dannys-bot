import { useState, type ChangeEvent } from "react";
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
  ExternalLink, Shield, Plug, Search, Link2Off, Play,
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

type DeviceInfo  = { serial: string; state: string; product?: string; model?: string };
type ProxyEntry  = { id: number; name?: string | null; host: string; port: number; username?: string | null; password?: string | null };
type ConfigResp  = { instanceConfigs: Record<string, { proxyId?: number | null }>; proxies: ProxyEntry[] };

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

// ─── Proxy selector ────────────────────────────────────────────────────────────

function ProxySelector({ serial, proxies, savedProxyId }: { serial: string; proxies: ProxyEntry[]; savedProxyId?: number | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [ipResult, setIpResult] = useState<{ ip?: string; error?: string } | null>(null);
  const [checkingIp, setCheckingIp] = useState(false);

  const saveMut = useMutation({
    mutationFn: (proxyId: number | null) => api("POST", `/api/mobile/instances/${encodeURIComponent(serial)}/config`, { proxyId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mobile-config"] }); },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });
  const applyMut = useMutation({
    mutationFn: (proxyId: number | null) => api<{ relay?: string; upstream?: string }>("POST", `/api/mobile/devices/${serial}/proxy`, { proxyId }),
    onSuccess: (_d, id) => {
      toast({ title: id ? "Proxy applied to device" : "Proxy removed" });
      setIpResult(null);
    },
    onError: (e: any) => toast({ title: "Apply failed", description: e?.message, variant: "destructive" }),
  });

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value ? Number(e.target.value) : null;
    saveMut.mutate(id);
    applyMut.mutate(id);
    setIpResult(null);
  };

  const checkIp = async () => {
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

  const busy = saveMut.isPending || applyMut.isPending;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 items-center">
        <Shield className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <select
          className="flex-1 text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          value={savedProxyId ?? ""}
          onChange={handleChange}
          disabled={busy}
        >
          <option value="">No proxy</option>
          {proxies.map(px => <option key={px.id} value={px.id}>{px.name ? `${px.name} — ` : ""}{px.host}:{px.port}</option>)}
        </select>
        {busy && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />}
        {savedProxyId && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px] shrink-0" disabled={checkingIp || busy} onClick={checkIp} title="Test that the proxy is working and see the external IP">
            {checkingIp ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test IP"}
          </Button>
        )}
      </div>
      {ipResult && (
        <div className={`text-[10px] px-2 py-1 rounded ${ipResult.ip ? "bg-green-500/10 text-green-600 border border-green-500/20" : "bg-destructive/10 text-destructive border border-destructive/20"}`}>
          {ipResult.ip
            ? <><CheckCircle2 className="w-3 h-3 inline mr-1" />Proxy working — external IP: <span className="font-mono font-semibold">{ipResult.ip}</span></>
            : <>Proxy test failed: {ipResult.error}</>
          }
        </div>
      )}
    </div>
  );
}

// ─── Device card ───────────────────────────────────────────────────────────────

function DeviceCard({ device, idx, selected, proxies, savedProxyId, onSelect, onDisconnect }: {
  device: DeviceInfo; idx: number; selected: boolean;
  proxies: ProxyEntry[]; savedProxyId?: number | null;
  onSelect: () => void; onDisconnect: () => void;
}) {
  const { toast } = useToast();
  const id = useAndroidId(device.serial);
  const color = COLORS[idx % COLORS.length];
  const isOnline = device.state === "device";

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
        <button className="text-white/50 hover:text-white p-1" title="Disconnect" onClick={e => { e.stopPropagation(); onDisconnect(); }}>
          <Link2Off className="w-4 h-4" />
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
          <ProxySelector serial={device.serial} proxies={proxies} savedProxyId={savedProxyId} />
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

// ─── Device detail panel ───────────────────────────────────────────────────────

function DevicePanel({ device, onClose }: { device: DeviceInfo; onClose: () => void }) {
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

  // Spintax editor state (persisted per-device)
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

  const installMut = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/install`, { apkPath }), onSuccess: () => { toast({ title: "Instagram installed" }); qc.invalidateQueries({ queryKey: ["ig-installed", serial] }); }, onError: (e: any) => toast({ title: "Install failed", description: e?.message, variant: "destructive" }) });
  const launchMut  = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/instagram/launch`, {}), onSuccess: () => toast({ title: "Instagram launched" }), onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }) });
  const clearMut   = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/instagram/clear`, {}),   onSuccess: () => toast({ title: "App data cleared — fresh signup ready" }), onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }) });
  const mirrorMut  = useMutation({ mutationFn: () => api("POST", `/api/mobile/devices/${serial}/scrcpy/start`, {}),      onSuccess: () => toast({ title: "Screen mirror opened" }), onError: (e: any) => toast({ title: "Mirror failed — install scrcpy and add to PATH", description: e?.message, variant: "destructive" }) });
  const typeMut    = useMutation({ mutationFn: (text: string) => api("POST", `/api/mobile/devices/${serial}/input/text`, { text }), onError: (e: any) => toast({ title: "Type failed", description: e?.message, variant: "destructive" }) });
  const saveMut    = useMutation({
    mutationFn: () => api("POST", "/api/mobile/accounts", { username, password, email: email || null, phoneNumber: phone || null, dateOfBirth: dob || null, notes: notes || null, serial, avdName: null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profiles"] }); toast({ title: "Account saved", description: `@${username} added to Accounts.` }); setUsername(""); setPassword(""); setEmail(""); setPhone(""); setDob(""); setNotes(""); },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });

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
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={onClose}><X className="w-4 h-4" /></Button>
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
              </>
            ) : (
              <div className="space-y-1.5 mb-2">
                <Label className="text-xs">Install Instagram from APK</Label>
                <div className="flex gap-2">
                  <Input className="text-xs flex-1" placeholder="C:\Downloads\instagram.apk" value={apkPath} onChange={e => setApkPath(e.target.value)} />
                  <Button size="sm" disabled={!apkPath || installMut.isPending} onClick={() => installMut.mutate()}>
                    {installMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Or install directly inside the emulator's app store. APK from{" "}
                  <a className="underline hover:text-primary" href="https://www.apkmirror.com/apk/instagram/instagram-instagram/" target="_blank" rel="noreferrer">APKMirror <ExternalLink className="w-2.5 h-2.5 inline" /></a>
                </p>
              </div>
            )}
          </div>
          <Separator />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><Keyboard className="w-3.5 h-3.5" />Type into focused field</div>
            <div className="flex gap-2">
              <Input className="text-xs flex-1" placeholder="Text to inject…" value={typeText} onChange={e => setTypeText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && typeText) typeMut.mutate(typeText); }} />
              <Button size="sm" variant="outline" disabled={!typeText || typeMut.isPending} onClick={() => typeMut.mutate(typeText)}>
                {typeMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Keyboard className="w-3.5 h-3.5" />}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Tap a field in the Mirror window, then press Enter here to fill it.</p>
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

          {/* Generate all button */}
          <Button size="sm" variant="outline" className="w-full text-xs gap-1.5" onClick={() => {
            const u = (customSpin["u"] ?? "").trim() ? resolveSpintax(customSpin["u"]) : generateUsername();
            setUsername(u);
            setPassword((customSpin["pw"] ?? "").trim() ? resolveSpintax(customSpin["pw"]) : generatePassword());
            setEmail((customSpin["em"] ?? "").trim() ? resolveSpintax(customSpin["em"]) : generateEmail(u));
            setDob((customSpin["db"] ?? "").trim() ? resolveSpintax(customSpin["db"]) : generateDob());
          }}>
            <Shuffle className="w-3 h-3" />Generate all fields
          </Button>

          <div className="grid grid-cols-2 gap-2">
            {[
              { id: "u",  label: "Username",               val: username, set: setUsername, gen: () => generateUsername() },
              { id: "pw", label: "Password",               val: password, set: setPassword, gen: () => generatePassword() },
              { id: "em", label: "Email",                  val: email,    set: setEmail,    gen: () => generateEmail(username) },
              { id: "ph", label: "Phone",                  val: phone,    set: setPhone,    gen: null },
              { id: "db", label: "Date of birth (YYYY-MM-DD)", val: dob,  set: setDob,      gen: () => generateDob() },
            ].map(f => (
              <div key={f.id} className="space-y-1">
                <Label htmlFor={`sp-${f.id}`} className="text-[10px] text-muted-foreground">{f.label}</Label>
                <div className="flex gap-1">
                  <Input id={`sp-${f.id}`} className="text-xs h-8 flex-1" value={f.val} onChange={e => f.set(e.target.value)} />
                  {f.gen && (
                    <Button size="sm" variant="outline" className="h-8 w-8 p-0 shrink-0" title="Generate random value" onClick={() => shuffle(f.id, f.set, f.gen!)}>
                      <Shuffle className="w-3 h-3" />
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-8 px-2 text-[10px] shrink-0" disabled={!f.val || typeMut.isPending} onClick={() => typeMut.mutate(f.val)}>Type</Button>
                </div>
              </div>
            ))}
          </div>

          {/* Spintax editor */}
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

// ─── Setup guide ──────────────────────────────────────────────────────────────

function SetupGuide({ onConnected }: { onConnected: () => void }) {
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

  return (
    <div className="max-w-xl mx-auto space-y-6 py-4">
      {/* Steps */}
      <div className="space-y-4">
        {/* Step 1 */}
        <div className="flex gap-4 items-start">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0">1</div>
          <div className="flex-1">
            <div className="font-semibold text-sm">Install a free Android emulator</div>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              These work exactly like BlueStacks — install apps from their built-in Google Play Store. Both are completely free.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { name: "LDPlayer 9", desc: "Lightweight, great for multi-instance. Recommended.", url: "https://www.ldplayer.net/", color: "from-orange-500 to-orange-700", note: "ADB enabled by default — no settings needed" },
                { name: "BlueStacks 5", desc: "Most popular. 100% free (ads only).", url: "https://www.bluestacks.com/download.html", color: "from-blue-600 to-blue-800", note: 'Settings → Advanced → enable "Android Debug Bridge"' },
              ].map(em => (
                <a key={em.name} href={em.url} target="_blank" rel="noreferrer" className="block border border-border rounded-xl overflow-hidden hover:border-primary/50 hover:shadow-md transition-all group">
                  <div className={`bg-gradient-to-br ${em.color} px-3 py-2.5 flex items-center gap-2`}>
                    <Smartphone className="w-4 h-4 text-white shrink-0" />
                    <span className="font-semibold text-white text-sm">{em.name}</span>
                    <ExternalLink className="w-3 h-3 text-white/60 ml-auto group-hover:text-white" />
                  </div>
                  <div className="px-3 py-2 bg-card">
                    <p className="text-[10px] text-muted-foreground">{em.desc}</p>
                    <p className="text-[10px] text-primary/80 mt-1 font-medium">{em.note}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex gap-4 items-start">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0">2</div>
          <div className="flex-1">
            <div className="font-semibold text-sm">Open the emulator, then click Auto-detect</div>
            <p className="text-xs text-muted-foreground mt-1 mb-3">Equinox will find it automatically. If it doesn't, enter the address manually.</p>
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
                  placeholder="127.0.0.1:5555"
                  onKeyDown={e => { if (e.key === "Enter") connectMut.mutate(address); }}
                />
                <Button disabled={!address || connectMut.isPending} onClick={() => connectMut.mutate(address)}>
                  {connectMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
                  Connect
                </Button>
              </div>
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                <div>LDPlayer default address: <span className="font-mono text-foreground/70">127.0.0.1:5555</span></div>
                <div>BlueStacks default address: <span className="font-mono text-foreground/70">127.0.0.1:5555</span></div>
                <div>Nox default address: <span className="font-mono text-foreground/70">127.0.0.1:62001</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* Step 3 */}
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

  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);

  const devices  = devicesQ.data?.filter(d => d.state === "device" || d.state === "offline") ?? [];
  const proxies  = configQ.data?.proxies ?? [];
  const configs  = configQ.data?.instanceConfigs ?? {};
  const selected = devices.find(d => d.serial === selectedSerial) ?? null;

  const disconnectMut = useMutation({
    mutationFn: (address: string) => api("POST", "/api/mobile/disconnect", { address }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mobile-devices"] }); toast({ title: "Disconnected" }); },
    onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }),
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
            <Button size="sm" variant="outline" onClick={() => devicesQ.refetch()} disabled={devicesQ.isFetching}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${devicesQ.isFetching ? "animate-spin" : ""}`} />Refresh
            </Button>
          </div>

          {/* Devices connected */}
          {devicesQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />Scanning for devices…
            </div>
          ) : devices.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  {devices.length} device{devices.length !== 1 ? "s" : ""} connected
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelectedSerial(null)}>
                  <Plug className="w-3.5 h-3.5 mr-1.5" />Add another
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {devices.map((dev, i) => (
                  <DeviceCard
                    key={dev.serial}
                    device={dev}
                    idx={i}
                    selected={selectedSerial === dev.serial}
                    proxies={proxies}
                    savedProxyId={configs[dev.serial]?.proxyId}
                    onSelect={() => setSelectedSerial(selectedSerial === dev.serial ? null : dev.serial)}
                    onDisconnect={() => disconnectMut.mutate(dev.serial)}
                  />
                ))}
              </div>
              {selected && <DevicePanel device={selected} onClose={() => setSelectedSerial(null)} />}
            </div>
          ) : (
            <SetupGuide onConnected={() => devicesQ.refetch()} />
          )}

        </div>
      </main>
    </div>
  );
}
