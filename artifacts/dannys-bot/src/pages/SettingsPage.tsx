import { AppLayout } from "@/components/layout/AppLayout";
import { TrustScoresTabContent, BulkImportTabContent } from "@/pages/ToolsPage";
import ImagesPage from "@/pages/ImagesPage";
import { JarveeBinaryViewerContent } from "@/pages/JarveeBinaryViewerPage";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumField } from "@/components/ui/num-field";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { Users, Ban, Shield, ShieldAlert, CheckCircle2, XCircle, Loader2, RefreshCw, Database, KeyRound, Timer, FileText, AlertCircle, ScrollText, HardDrive, FolderOpen, RotateCcw, Trash2, Palette, Moon, Sun, BookOpen, ChevronRight, Phone, Power, Terminal, Download, Pencil, X, Crown, LogOut, UserCircle, Camera, Upload, Plus, Settings } from "lucide-react";
import type { GlobalSettings } from "@shared/schema";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTheme, THEME_COLORS } from "@/hooks/use-theme";

type BackupEntry = { id: string; date: string; size: number };
const eAPI = () => (window as any).electronAPI;
const isElectron = typeof window !== "undefined" && typeof eAPI()?.createBackup === "function";

const SETTINGS_TABS = [
  { label: "My Account", icon: UserCircle },
  { label: "General", icon: Settings },
  { label: "Trust Scores", icon: Shield },
  { label: "Fix Images", icon: Palette },
  { label: "Import", icon: Upload },
  { label: "Jarvee Import", icon: Upload },
  { label: "Scraping", icon: Database },
  { label: "Automation", icon: Timer },
  { label: "Security", icon: ShieldAlert },
  { label: "Data", icon: HardDrive },
] as const;

// ─── Jarvee parser helpers ───────────────────────────────────────────────────


function ThemePicker() {
  const { themeColor, themeMode, setThemeColor, setThemeMode } = useTheme();
  return (
    <div className="space-y-5">
      {/* Light / Dark toggle */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Mode</p>
        <div className="flex gap-2">
          {(["light", "dark"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setThemeMode(m)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                themeMode === m
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-accent/30"
              }`}
            >
              {m === "light" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {m === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      {/* Colour swatches */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Accent Colour</p>
        <div className="flex flex-wrap gap-2.5">
          {THEME_COLORS.map(({ key, label, primary }) => (
            <button
              key={key}
              title={label}
              onClick={() => setThemeColor(key)}
              className={`relative w-8 h-8 rounded-md border-2 transition-transform hover:scale-110 ${
                themeColor === key ? "border-foreground scale-110" : "border-transparent"
              }`}
              style={{ background: primary }}
            >
              {themeColor === key && (
                <span className="absolute inset-0 flex items-center justify-center text-white text-[10px] font-bold">✓</span>
              )}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {THEME_COLORS.find(t => t.key === themeColor)?.label ?? ""}
        </p>
      </div>
    </div>
  );
}

type FakePhoneEntry = { manufacturer: string; marketName: string; androidVersion: string };

const INJECTABLE_MODELS: Array<FakePhoneEntry & { label: string; image?: string }> = [
  { manufacturer: "Xiaomi", marketName: "Redmi 12 5G",   androidVersion: "13", label: "Redmi 12 5G",   image: "/phones/redmi-12.png"  },
  { manufacturer: "Xiaomi", marketName: "Redmi A5",      androidVersion: "13", label: "Redmi A5",      image: "/phones/redmi-a5.png"  },
  { manufacturer: "Xiaomi", marketName: "Redmi Note 12", androidVersion: "13", label: "Redmi Note 12"  },
  { manufacturer: "Xiaomi", marketName: "Redmi Note 14", androidVersion: "14", label: "Redmi Note 14"  },
  { manufacturer: "Xiaomi", marketName: "Redmi Note 13", androidVersion: "14", label: "Redmi Note 13"  },
  { manufacturer: "Xiaomi", marketName: "POCO X6",       androidVersion: "14", label: "POCO X6"        },
  { manufacturer: "Xiaomi", marketName: "Xiaomi 13T",    androidVersion: "13", label: "Xiaomi 13T"     },
  { manufacturer: "Xiaomi", marketName: "Redmi 13C",     androidVersion: "13", label: "Redmi 13C"      },
  { manufacturer: "Xiaomi", marketName: "Redmi A3",      androidVersion: "14", label: "Redmi A3"       },
  { manufacturer: "Xiaomi", marketName: "POCO M6 Pro",   androidVersion: "14", label: "POCO M6 Pro"    },
];

function JarveeImportTabContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<Array<{ file: string; username: string; ok: boolean; error?: string; sourcesImported?: number; followedImported?: number; dmRecipients?: number }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setImporting(true);
    setResults([]);
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    const nextResults: typeof results = [];
    try {
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          const res = await fetch("/api/profiles/import-jarvee", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ fileBase64: btoa(binary) }),
          });
          const data = await res.json();
          if (!res.ok) {
            failed++;
            errors.push(`${file.name}: ${data.error ?? "Unknown error"}`);
            nextResults.push({ file: file.name, username: "—", ok: false, error: data.error ?? "Import failed" });
          } else {
            imported += data.imported ?? 0;
            failed += data.failed ?? 0;
            for (const account of data.accounts ?? []) {
              nextResults.push({
                file: file.name,
                username: account.username ?? "—",
                ok: account.ok === true,
                error: account.error,
                sourcesImported: account.sourcesImported,
                followedImported: account.followedImported,
                dmRecipients: account.dmRecipients,
              });
            }
            if (data.failed > 0) errors.push(`${file.name}: some accounts failed`);
          }
        } catch (error: any) {
          failed++;
          errors.push(`${file.name}: ${error?.message ?? "Could not read file"}`);
          nextResults.push({ file: file.name, username: "—", ok: false, error: error?.message ?? "Could not read file" });
        }
      }
      setResults(nextResults);
      if (failed === 0) {
        toast({ title: "Jarvee import complete", description: `${imported} account${imported === 1 ? "" : "s"} imported successfully.` });
      } else {
        toast({ title: `Jarvee import: ${imported} imported, ${failed} failed`, description: errors.join("; "), variant: "destructive" });
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      await queryClient.refetchQueries({ queryKey: ["/api/profiles"], type: "active" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="desktop-card p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Jarvee Binary Import</h2>
        <p className="text-sm text-muted-foreground mt-1">Import Jarvee binary account files. Imported accounts are set to Pending and must be verified before use.</p>
      </div>
      <input ref={inputRef} type="file" accept="*" multiple className="hidden" onChange={importFiles} />
      <Button type="button" onClick={() => inputRef.current?.click()} disabled={importing}>
        {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing…</> : <><Upload className="w-4 h-4 mr-2" />Choose Jarvee Binary File{importing ? "" : "s"}</>}
      </Button>
      {results.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-muted/40 text-sm font-semibold">Import results</div>
          <div className="divide-y divide-border">
            {results.map((result, index) => (
              <div key={`${result.file}-${result.username}-${index}`} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={result.ok ? "text-emerald-600" : "text-destructive"}>{result.ok ? "✓" : "✕"}</span>
                  <span className="font-semibold">{result.username}</span>
                  <span className="text-xs text-muted-foreground">({result.file})</span>
                </div>
                {result.ok ? (
                  <div className="mt-1 ml-5 text-xs text-muted-foreground">
                    Follow sources: {result.sourcesImported ?? 0} · Followed users: {result.followedImported ?? 0} · DM recipients: {result.dmRecipients ?? 0}
                  </div>
                ) : (
                  <div className="mt-1 ml-5 text-xs text-destructive">{result.error ?? "Import failed"}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FakePhoneCard() {
  const { toast } = useToast();
  const [phones, setPhones]       = useState<FakePhoneEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    fetch("/api/mobile/fake-phone-list")
      .then(r => r.json())
      .then(d => setPhones(d.phones ?? []))
      .catch(() => setPhones([]))
      .finally(() => setLoading(false));
  }, []);

  const saveList = async (next: FakePhoneEntry[], label: string) => {
    setSaving(true);
    try {
      const res = await fetch("/api/mobile/fake-phone-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: next }),
      });
      const d = await res.json();
      if (d.ok) {
        setPhones(d.phones);
        toast({ title: label });
      } else {
        toast({ title: "Failed to update devices", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to update devices", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = (model: typeof INJECTABLE_MODELS[0]) => {
    if (phones.length >= 10) return;
    const next = [...phones, { manufacturer: model.manufacturer, marketName: model.marketName, androidVersion: model.androidVersion }];
    saveList(next, `${model.manufacturer} ${model.label} added to Phone Farm`);
    setShowPicker(false);
  };

  const handleRemoveOne = (index: number) => {
    saveList(phones.filter((_, i) => i !== index), "Device removed");
  };

  const handleRemoveAll = () => {
    saveList([], "All fake devices removed");
  };

  return (
    <div className="desktop-card p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-primary/10 text-primary mt-0.5 shrink-0">
            <Phone className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Inject Fake Phones</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Add simulated devices to the Phone Farm for UI testing without physical hardware.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => setShowPicker(v => !v)}
          disabled={loading || saving || phones.length >= 10}
          className="shrink-0"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Inject
        </Button>
      </div>

      {/* Active injected devices */}
      {phones.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {phones.map((p, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border/50">
              {(() => {
                const model = INJECTABLE_MODELS.find(m => m.marketName === p.marketName);
                return model?.image ? (
                  <img src={model.image} alt={p.marketName} className="w-5 h-7 object-contain shrink-0" />
                ) : (
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                );
              })()}
              <span className="text-xs font-medium text-foreground flex-1 truncate">
                {p.manufacturer} {p.marketName}
              </span>
              <span className="text-[10px] text-muted-foreground">Android {p.androidVersion}</span>
              <button
                onClick={() => handleRemoveOne(i)}
                disabled={saving}
                className="ml-1 text-muted-foreground hover:text-destructive transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Active-device actions */}
      {phones.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{phones.length} active</span>
          <Button size="sm" variant="outline" onClick={handleRemoveAll} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
            Remove All
          </Button>
        </div>
      )}

      {/* Device picker */}
      {showPicker && (
        <div className="mt-3 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">Choose a device to inject</p>
            <button onClick={() => setShowPicker(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {INJECTABLE_MODELS.map(model => (
              <button
                key={model.marketName}
                onClick={() => handleAdd(model)}
                disabled={saving}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted/50 transition-colors text-left border-b border-border/30 last:border-0 disabled:opacity-50"
              >
                {model.image ? (
                  <img src={model.image} alt={model.label} className="w-6 h-9 object-contain shrink-0" />
                ) : (
                  <div className="w-6 h-9 flex items-center justify-center shrink-0">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{model.manufacturer} {model.label}</p>
                  <p className="text-[10px] text-muted-foreground">Android {model.androidVersion}</p>
                </div>
                <Plus className="w-3.5 h-3.5 text-primary shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AutostartCard() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    eAPI().getAutostart().then((v: boolean) => setEnabled(v)).catch(() => setEnabled(false));
  }, []);

  const toggle = async (v: boolean) => {
    setSaving(true);
    try {
      const result: boolean = await eAPI().setAutostart(v);
      setEnabled(result);
      toast({ title: result ? "Aura Farming will start with Windows" : "Autostart disabled" });
    } catch {
      toast({ title: "Failed to update autostart", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="desktop-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-green-100 text-green-600 mt-0.5">
            <Power className="w-4 h-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Start with Windows</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Aura Farming will launch automatically when Windows starts. The app opens minimised to the tray.
            </p>
          </div>
        </div>
        <Switch
          checked={enabled ?? false}
          onCheckedChange={toggle}
          disabled={enabled === null || saving}
          className="data-[state=checked]:bg-green-500 shrink-0 mt-0.5"
        />
      </div>
    </div>
  );
}

async function fetchSettings(): Promise<GlobalSettings> {
  const res = await fetch("/api/settings", { credentials: "include" });
  return res.json();
}

async function saveSettings(body: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return res.json();
}

export function SettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [testingHiker, setTestingHiker] = useState(false);
  const [hikerStatus, setHikerStatus] = useState<"idle" | "ok" | "fail">("idle");
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const [twoCaptchaKeyDraft, setTwoCaptchaKeyDraft] = useState<string | null>(null);
  const [twoCaptchaKeyInitialized, setTwoCaptchaKeyInitialized] = useState(false);
  const [captchaTestState, setCaptchaTestState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [captchaTestResult, setCaptchaTestResult] = useState<string>("");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState<string | null>(null);
  const [geminiKeyInitialized, setGeminiKeyInitialized] = useState(false);
  const [geminiTestState, setGeminiTestState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [geminiTestResult, setGeminiTestResult] = useState<string>("");
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState<string | null>(null);
  const [openaiKeyInitialized, setOpenaiKeyInitialized] = useState(false);
  const [settingsTab, setSettingsTab] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab");
      if (tab) return tab;
    } catch {}
    return "my account";
  });
  const setTab = (slug: string) => {
    setSettingsTab(slug);
    try { window.history.replaceState(null, "", `?tab=${encodeURIComponent(slug)}`); } catch {}
  };

  // ─── Backup state ────────────────────────────────────────────────────────────
  const [backupList, setBackupList] = useState<BackupEntry[]>([]);
  const [backupListLoading, setBackupListLoading] = useState(false);
  const [backupCreating, setBackupCreating] = useState(false);
  const [backupRestoring, setBackupRestoring] = useState<string | null>(null);
  const [backupDeleting, setBackupDeleting] = useState<string | null>(null);

  const refreshBackupList = async () => {
    if (!isElectron) return;
    setBackupListLoading(true);
    try {
      const list: BackupEntry[] = await eAPI().listBackups();
      setBackupList(list);
    } catch {}
    setBackupListLoading(false);
  };

  useEffect(() => { refreshBackupList(); }, []);

  const { data: settings, isLoading } = useQuery<GlobalSettings>({
    queryKey: ["/api/settings"],
    queryFn: fetchSettings,
  });

  // Sync token inputs from DB on first load only (don't overwrite while user is typing)
  const [tokenInitialized, setTokenInitialized] = useState(false);
  if (settings && !tokenInitialized) {
    setTokenDraft(settings.hikerApiToken ?? "");
    setTwoCaptchaKeyDraft(settings.twoCaptchaApiKey ?? "");
    setTokenInitialized(true);
    setTwoCaptchaKeyInitialized(true);
  }
  if (settings && !geminiKeyInitialized) {
    setGeminiKeyDraft((settings as any).geminiApiKey ?? "");
    setGeminiKeyInitialized(true);
  }
  if (settings && !openaiKeyInitialized) {
    setOpenaiKeyDraft((settings as any).openaiApiKey ?? "");
    setOpenaiKeyInitialized(true);
  }

  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: (data) => {
      qc.setQueryData(["/api/settings"], data);
      if (isElectron && (data.backupEnabled !== undefined || data.backupIntervalDays !== undefined)) {
        try {
          eAPI().updateBackupSchedule(data.backupEnabled ?? false, data.backupIntervalDays ?? 7);
        } catch {}
      }
    },
    onError: () => {
      toast({ title: "Failed to save setting", variant: "destructive" });
    },
  });

  const toggle = (key: keyof GlobalSettings, value: boolean) => {
    mutation.mutate({ [key]: value });
  };

  const saveToken = (token: string) => {
    setHikerStatus("idle");
    mutation.mutate({ hikerApiToken: token });
  };

  const testHikerConnection = async () => {
    const token = tokenDraft ?? settings?.hikerApiToken;
    if (!token) {
      toast({ title: "No API token set", variant: "destructive" });
      return;
    }
    setTestingHiker(true);
    setHikerStatus("idle");
    try {
      const res = await fetch("/api/settings/test-hiker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.ok) {
        setHikerStatus("ok");
        toast({ title: "HikerAPI connected successfully" });
      } else {
        setHikerStatus("fail");
        toast({ title: "HikerAPI connection failed", description: data.error, variant: "destructive" });
      }
    } catch {
      setHikerStatus("fail");
      toast({ title: "Connection test failed", variant: "destructive" });
    } finally {
      setTestingHiker(false);
    }
  };

  return (
    <AppLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Global Settings</h1>
        <p className="text-muted-foreground mt-1">Configure application-wide preferences.</p>
      </div>

      <div className="flex items-center gap-0 mb-6 border-b border-border/60 flex-wrap">
        {SETTINGS_TABS.map(({ label, icon: TabIcon }) => (
          <button
            key={label}
            onClick={() => setTab(label.toLowerCase())}
            className={`inline-flex items-center gap-1.5 px-[18px] py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${settingsTab === label.toLowerCase() ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label}
            <TabIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          </button>
        ))}
      </div>

      {settingsTab === "my account" && (
        <div className="desktop-card p-6">
          <MyAccountTabContent />
        </div>
      )}

      {settingsTab === "trust scores" && (
        <div>
          <TrustScoresTabContent />
        </div>
      )}

      {settingsTab === "fix images" && (
        <ImagesPage embedded />
      )}

      {settingsTab === "import" && (
        <div>
          <BulkImportTabContent />
        </div>
      )}

      {settingsTab === "jarvee import" && <JarveeBinaryViewerContent />}

      <div className={`space-y-4 w-full ${["my account", "trust scores", "fix images", "import", "jarvee import"].includes(settingsTab) ? "hidden" : ""}`}>

        {/* Talk to Equinox Bot shortcut */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("aura-farming-bot-open", { detail: "open" }))}
          className="block w-full text-left"
          style={{ display: settingsTab !== "general" ? "none" : undefined }}
        >
          <div className="desktop-card p-4 flex items-center justify-between cursor-pointer hover:bg-accent/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <img src="/bot-logo.png" alt="" className="w-4 h-4 object-contain" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Talk to Aura Farming Bot</p>
                <p className="text-xs text-muted-foreground">Ask the AI assistant how to use any feature</p>
              </div>
            </div>
          </div>
        </button>

        {/* README & FAQ shortcut */}
        <Link href="/readme" className="block" style={{ display: settingsTab !== "general" ? "none" : undefined }}>
          <div className="desktop-card p-4 flex items-center justify-between cursor-pointer hover:bg-accent/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <BookOpen className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">README &amp; FAQ</p>
                <p className="text-xs text-muted-foreground">Getting started guide, tool docs, and common questions</p>
              </div>
            </div>
          </div>
        </Link>

        {/* Autostart — Electron only */}
        {isElectron && settingsTab === "general" && <AutostartCard />}


        {/* HikerAPI Scraper Protection */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "scraping" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <Shield className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">HikerAPI Scraper Protection</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Route all scrape API calls (user lookup, followers, hashtags, media info) through HikerAPI instead
            of making them directly from your accounts. This protects your accounts from scrape-related bans.
          </p>

          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label className="text-sm font-medium cursor-pointer" htmlFor="hiker-enabled">
                  Enable HikerAPI
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When enabled, all accounts globally use HikerAPI for: user lookup, followers, following,
                  hashtag scraping, media info, and user profile checks.
                </p>
              </div>
              <Switch
                id="hiker-enabled"
                checked={settings?.hikerApiEnabled ?? false}
                onCheckedChange={(v) => toggle("hikerApiEnabled", v)}
                disabled={isLoading || mutation.isPending}
                className="data-[state=checked]:bg-blue-500 shrink-0 mt-0.5"
              />
            </div>

            <div className="border-t border-border/50 pt-4 space-y-3">
              <Label className="text-sm font-medium">API Token</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="Enter your HikerAPI token"
                  value={tokenDraft ?? ""}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v !== (settings?.hikerApiToken ?? "")) {
                      saveToken(v);
                    }
                  }}
                  className="font-mono text-sm w-[50ch] max-w-full"
                />
                <Button
                  variant="outline"
                  onClick={testHikerConnection}
                  disabled={testingHiker || isLoading}
                  className="shrink-0"
                >
                  {testingHiker ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : hikerStatus === "ok" ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : hikerStatus === "fail" ? (
                    <XCircle className="w-4 h-4 text-red-500" />
                  ) : null}
                  {!testingHiker && hikerStatus === "idle" ? "Test" : hikerStatus === "ok" ? "Connected" : hikerStatus === "fail" ? "Failed" : "Testing..."}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Get your token at <span className="font-medium">hikerapi.com</span>. The token is saved securely in the database.
              </p>
            </div>
          </div>
        </div>

        {/* Abort after X scrapes — global scrape-session limit applied to every account's Follow Users tool */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "scraping" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-600">
              <Shield className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Scrape Limit</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:gap-6">
            <p className="text-sm text-muted-foreground min-w-0">
              Maximum number of HikerAPI scrape sessions the Follow Users tool is allowed to run per automation cycle, across all accounts.
            </p>
            <div className="flex items-center gap-3 shrink-0">
              <Label className="text-sm font-medium whitespace-nowrap">Abort after X scrapes</Label>
              <Input
                type="number"
                min={0}
                max={999}
                className="w-20 text-center"
                value={settings?.followMaxScrapeSessions ?? 0}
                onChange={e => {
                  const v = Math.max(0, Math.min(999, Math.trunc(Number(e.target.value) || 0)));
                  mutation.mutate({ followMaxScrapeSessions: v });
                }}
                disabled={isLoading || mutation.isPending}
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">(0 = unlimited)</span>
            </div>
          </div>
        </div>

        {/* Fake Phone Injection */}
        {settingsTab === "automation" && <FakePhoneCard />}

        {/* Follow Skip Settings */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <h3 className="text-base font-semibold mb-1">Follow Skip Settings</h3>
          <p className="text-sm text-muted-foreground mb-5">
            Control whether accounts can follow the same users as each other.
          </p>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-primary/10 text-primary mt-0.5">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="skip-followed">
                    Skip Followed Users
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    If enabled, a user already followed by <em>any</em> profile in this app will not be followed again by another profile.
                    All followed users from every account are tracked in a shared global list.
                  </p>
                </div>
              </div>
              <Switch
                id="skip-followed"
                checked={settings?.skipFollowedUsers ?? false}
                onCheckedChange={(v) => toggle("skipFollowedUsers", v)}
                disabled={isLoading || mutation.isPending}
                className="data-[state=checked]:bg-green-500 shrink-0 mt-0.5"
              />
            </div>

            <div className="border-t border-border/50 pt-4 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-orange-100 text-orange-600 mt-0.5">
                  <Ban className="w-4 h-4" />
                </div>
                <div>
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="skip-skipped">
                    Skip Already Skipped Users
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    If enabled, users who were skipped by any profile (e.g. filtered by Indian script or other rules) will not be
                    reconsidered by any other profile. Skipped users are stored in a shared global list.
                  </p>
                </div>
              </div>
              <Switch
                id="skip-skipped"
                checked={settings?.skipAlreadySkippedUsers ?? false}
                onCheckedChange={(v) => toggle("skipAlreadySkippedUsers", v)}
                disabled={isLoading || mutation.isPending}
                className="data-[state=checked]:bg-green-500 shrink-0 mt-0.5"
              />
            </div>
          </div>
        </div>




        {/* 2Captcha Integration */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "security" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-amber-100 text-amber-600">
              <KeyRound className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">2Captcha Integration</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            When accounts hit a captcha challenge, the "Fix Captcha" action uses this API key to auto-solve it via the embedded browser.
            Get your key at <span className="font-medium">2captcha.com</span>.
          </p>
          <div className="space-y-3">
            <Label className="text-sm font-medium">API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="Enter your 2captcha API key"
                value={twoCaptchaKeyDraft ?? ""}
                onChange={(e) => setTwoCaptchaKeyDraft(e.target.value)}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== (settings?.twoCaptchaApiKey ?? "")) {
                    mutation.mutate({ twoCaptchaApiKey: v });
                  }
                }}
                className="font-mono text-sm w-[50ch] max-w-full"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={captchaTestState === "loading" || !twoCaptchaKeyDraft}
                onClick={async () => {
                  setCaptchaTestState("loading");
                  try {
                    const r = await fetch("/api/settings/test-2captcha");
                    const j = await r.json();
                    if (j.ok) {
                      setCaptchaTestResult(`Balance: $${Number(j.balance).toFixed(2)}`);
                      setCaptchaTestState("ok");
                    } else {
                      setCaptchaTestResult(j.error ?? "Failed");
                      setCaptchaTestState("fail");
                    }
                  } catch {
                    setCaptchaTestResult("Request failed");
                    setCaptchaTestState("fail");
                  }
                }}
                className="shrink-0"
              >
                {captchaTestState === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test"}
              </Button>
            </div>
            {captchaTestState !== "idle" && captchaTestState !== "loading" && (
              <p className={`text-xs flex items-center gap-1.5 ${captchaTestState === "ok" ? "text-green-600" : "text-destructive"}`}>
                {captchaTestState === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {captchaTestResult}
              </p>
            )}
          </div>
        </div>

        {/* Gemini API Key */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "security" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <KeyRound className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Gemini API Key (AI Bot)</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Powers the Aura Farming Bot chat. Gemini has a generous free tier —
            get your key at <span className="font-medium">aistudio.google.com</span> → Get API Key. If both Gemini and OpenAI keys are set, Gemini is used.
          </p>
          <div className="space-y-3">
            <Label className="text-sm font-medium">API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="Enter your Gemini API key"
                value={geminiKeyDraft ?? ""}
                onChange={(e) => setGeminiKeyDraft(e.target.value)}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== ((settings as any)?.geminiApiKey ?? "")) {
                    mutation.mutate({ geminiApiKey: v } as any);
                  }
                }}
                className="font-mono text-sm w-[50ch] max-w-full"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={geminiTestState === "loading" || !geminiKeyDraft}
                onClick={async () => {
                  setGeminiTestState("loading");
                  try {
                    const r = await fetch("/api/settings/test-gemini");
                    const j = await r.json();
                    if (j.ok) {
                      setGeminiTestResult("Key is valid");
                      setGeminiTestState("ok");
                    } else {
                      setGeminiTestResult(j.error ?? "Failed");
                      setGeminiTestState("fail");
                    }
                  } catch {
                    setGeminiTestResult("Request failed");
                    setGeminiTestState("fail");
                  }
                }}
                className="shrink-0"
              >
                {geminiTestState === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test"}
              </Button>
            </div>
            {geminiTestState !== "idle" && geminiTestState !== "loading" && (
              <p className={`text-xs flex items-center gap-1.5 ${geminiTestState === "ok" ? "text-green-600" : "text-destructive"}`}>
                {geminiTestState === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {geminiTestResult}
              </p>
            )}
          </div>
        </div>

        {/* OpenAI API Key */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "security" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <KeyRound className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">OpenAI API Key (ChatGPT)</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Used by the Repost tool's "Use ChatGPT" caption feature — the caption text becomes the prompt sent to ChatGPT.
            Get your key at <span className="font-medium">platform.openai.com</span> → API Keys.
            If both Gemini and OpenAI keys are set, Gemini is preferred for the AI Bot chat.
          </p>
          <div className="space-y-3">
            <Label className="text-sm font-medium">API Key</Label>
            <Input
              type="password"
              placeholder="sk-..."
              value={openaiKeyDraft ?? ""}
              onChange={(e) => setOpenaiKeyDraft(e.target.value)}
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== ((settings as any)?.openaiApiKey ?? "")) {
                  mutation.mutate({ openaiApiKey: v } as any);
                }
              }}
              className="font-mono text-sm w-[50ch] max-w-full"
              disabled={isLoading}
            />
          </div>
        </div>

        {/* Dashboard Log Limit */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-indigo-100 text-indigo-600">
              <ScrollText className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Dashboard Log Limit</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:gap-6">
            <p className="text-sm text-muted-foreground min-w-0">
              Maximum number of rows kept in memory for the Dashboard activity log. Older entries beyond this limit are dropped.
              Larger limits preserve more history but use more memory.
            </p>
            <div className="flex items-center gap-3 shrink-0">
              <Label className="text-sm font-medium whitespace-nowrap">Max log rows</Label>
              <select
                className="flex h-9 w-48 items-center rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={settings?.logMaxRows ?? 100000}
                disabled={isLoading}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) mutation.mutate({ logMaxRows: v });
                }}
              >
                <option value={10000}>10,000</option>
                <option value={50000}>50,000</option>
                <option value={100000}>100,000</option>
                <option value={250000}>250,000</option>
                <option value={500000}>500,000</option>
                <option value={1000000}>Unlimited (1M)</option>
              </select>
            </div>
          </div>
        </div>





        {/* Display Timezone */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "data" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-cyan-100 text-cyan-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Display Timezone</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Controls how timestamps are shown across the entire app — activity log, CSV exports, and all other time displays.
            The timezone is detected automatically from your browser, no manual offset needed.
          </p>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label className="text-sm font-medium cursor-pointer" htmlFor="use-local-time">
                Use PC's Local Time
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                All timestamps show your local clock time. When off, timestamps show server UTC.
              </p>
            </div>
            <Switch
              id="use-local-time"
              checked={settings?.useLocalTime ?? false}
              onCheckedChange={(v) => toggle("useLocalTime", v)}
              disabled={isLoading || mutation.isPending}
              className="data-[state=checked]:bg-cyan-500 shrink-0 mt-0.5"
            />
          </div>
        </div>



        {/* Theme */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "general" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Palette className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Application Theme</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Choose a colour accent and light or dark mode. Your selection is saved locally and applied immediately.
          </p>
          <ThemePicker />
        </div>



        {/* App Updates */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "general" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">App Updates</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Aura Farming checks for updates automatically on startup. Click below to check right now.
          </p>
          <div className="flex gap-3 flex-wrap">
            <Button
              variant="outline"
              onClick={() => {
                const api = (window as unknown as { electronAPI?: { checkForUpdates: () => Promise<void>; openLog: () => Promise<void> } }).electronAPI;
                if (api?.checkForUpdates) {
                  api.checkForUpdates();
                } else {
                  alert("Update checks are only available in the installed desktop app.");
                }
              }}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Check for Updates
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const api = (window as unknown as { electronAPI?: { checkForUpdates: () => Promise<void>; openLog: () => Promise<void> } }).electronAPI;
                if (api?.openLog) {
                  api.openLog();
                } else {
                  alert("Log viewing is only available in the installed desktop app.");
                }
              }}
            >
              <FileText className="w-4 h-4 mr-2" />
              View Log File
            </Button>
          </div>
        </div>



        {/* Backup & Restore */}
        {isElectron && settingsTab === "data" && (
          <div className="desktop-card p-6">
            <div className="flex items-center gap-3 mb-1">
              <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600">
                <HardDrive className="w-4 h-4" />
              </div>
              <h3 className="text-base font-semibold">Backup &amp; Restore</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Automatically zip your database and settings into dated backup folders.
              Restore any backup to roll everything back to that point the app will relaunch automatically.
            </p>

            {/* Auto-backup toggle + interval */}
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="backup-enabled">
                    Enable Auto-Backup
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Automatically create a backup every N days. Backups are stored in your app data folder.
                  </p>
                </div>
                <Switch
                  id="backup-enabled"
                  checked={settings?.backupEnabled ?? false}
                  onCheckedChange={(v) => mutation.mutate({ backupEnabled: v, backupIntervalDays: settings?.backupIntervalDays ?? 7 })}
                  disabled={isLoading || mutation.isPending}
                  className="data-[state=checked]:bg-emerald-500 shrink-0 mt-0.5"
                />
              </div>

              <div className="border-t border-border/50 pt-4 flex items-center gap-3">
                <Label className="text-sm font-medium whitespace-nowrap" htmlFor="backup-interval">
                  Back up every
                </Label>
                <Input
                  id="backup-interval"
                  type="number"
                  min={1}
                  max={365}
                  className="w-20"
                  defaultValue={settings?.backupIntervalDays ?? 7}
                  key={settings?.backupIntervalDays}
                  disabled={isLoading || !(settings?.backupEnabled)}
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v > 0 && v !== settings?.backupIntervalDays) {
                      mutation.mutate({ backupEnabled: settings?.backupEnabled ?? false, backupIntervalDays: v });
                    }
                  }}
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>

              {/* Actions */}
              <div className="border-t border-border/50 pt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={backupCreating}
                  onClick={async () => {
                    setBackupCreating(true);
                    try {
                      const result = await eAPI().createBackup();
                      if (result.ok) {
                        toast({ title: "Backup created successfully" });
                        await refreshBackupList();
                      } else {
                        toast({ title: "Backup failed", description: result.error, variant: "destructive" });
                      }
                    } catch (err: any) {
                      toast({ title: "Backup failed", description: err?.message, variant: "destructive" });
                    }
                    setBackupCreating(false);
                  }}
                >
                  {backupCreating ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</>
                  ) : (
                    <><HardDrive className="w-4 h-4 mr-2" />Create Backup Now</>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => eAPI().openBackupDir()}
                >
                  <FolderOpen className="w-4 h-4 mr-2" />Open Backup Folder
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={backupListLoading}
                  onClick={refreshBackupList}
                  title="Refresh list"
                >
                  <RefreshCw className={`w-4 h-4 ${backupListLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>

              {/* Backup list */}
              {backupList.length > 0 && (
                <div className="border-t border-border/50 pt-4 space-y-2">
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Saved Backups ({backupList.length})
                  </p>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {backupList.map((entry) => {
                      const d = new Date(entry.date);
                      const label = isNaN(d.getTime())
                        ? entry.id
                        : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
                      const sizeLabel = entry.size > 1024 * 1024
                        ? `${(entry.size / 1024 / 1024).toFixed(1)} MB`
                        : entry.size > 1024
                        ? `${(entry.size / 1024).toFixed(0)} KB`
                        : `${entry.size} B`;
                      return (
                        <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{label}</p>
                            <p className="text-xs text-muted-foreground">{sizeLabel}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={backupRestoring !== null || backupDeleting !== null}
                              onClick={async () => {
                                const confirmed = window.confirm(
                                  `Restore backup from ${label}?\n\nAll current data will be replaced and the app will relaunch.`
                                );
                                if (!confirmed) return;
                                setBackupRestoring(entry.id);
                                try {
                                  const result = await eAPI().restoreBackup(entry.id);
                                  if (!result.ok) {
                                    toast({ title: "Restore failed", description: result.error, variant: "destructive" });
                                    setBackupRestoring(null);
                                  }
                                } catch (err: any) {
                                  toast({ title: "Restore failed", description: err?.message, variant: "destructive" });
                                  setBackupRestoring(null);
                                }
                              }}
                              className="h-7 px-2 text-xs"
                            >
                              {backupRestoring === entry.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <><RotateCcw className="w-3 h-3 mr-1" />Restore</>
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={backupRestoring !== null || backupDeleting !== null}
                              onClick={async () => {
                                const confirmed = window.confirm(`Delete backup from ${label}?`);
                                if (!confirmed) return;
                                setBackupDeleting(entry.id);
                                try {
                                  await eAPI().deleteBackup(entry.id);
                                  await refreshBackupList();
                                } catch {}
                                setBackupDeleting(null);
                              }}
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            >
                              {backupDeleting === entry.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Trash2 className="w-3 h-3" />
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {backupList.length === 0 && !backupListLoading && (
                <p className="text-xs text-muted-foreground pt-1">No backups yet create one above.</p>
              )}
            </div>
          </div>
        )}



        {/* Data Management */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "data" ? "none" : undefined }}>
          <h3 className="text-base font-semibold mb-2">Data Management</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Clear local cache if you are experiencing synchronisation issues with the backend database.
          </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Refresh Application State
          </Button>
        </div>

      </div>
    </AppLayout>
  );
}

const PLAN_TIERS = [
  { id: "starter",    label: "Starter",    price: "£25/mo",  limit: 5,    deviceLimit: 1,  badge: "bg-slate-100 text-slate-700"   },
  { id: "pro",        label: "Professional",   price: "£50/mo",  limit: 15,   deviceLimit: 3,  badge: "bg-blue-100 text-blue-700"    },
  { id: "business",   label: "Influencer",     price: "£100/mo", limit: 100,  deviceLimit: 10, badge: "bg-purple-100 text-purple-700" },
  { id: "enterprise", label: "Aura Farming",   price: "£250/mo", limit: 9999, deviceLimit: 25, badge: "bg-amber-100 text-amber-700"  },
];

type LicenseUser = { id: number; username: string; tier: string; account_limit: number; active: number; is_admin: number; created_at: string; expires_at: string | null };

function AdminUsersSection() {
  const { toast } = useToast();
  const [users, setUsers] = useState<LicenseUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addForm, setAddForm] = useState({ username: "", password: "", tier: "starter", accountLimit: 5, expiresAt: "" });
  const [editForm, setEditForm] = useState<{ tier: string; accountLimit: number; expiresAt: string; password: string } | null>(null);

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const r = await fetch("/api/license/users", { credentials: "include" });
      const d = await r.json();
      setUsers(Array.isArray(d) ? d : []);
    } catch {}
    setLoadingUsers(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async () => {
    if (!addForm.username.trim() || !addForm.password) return;
    try {
      const r = await fetch("/api/license/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: addForm.username.trim(), password: addForm.password, tier: addForm.tier, accountLimit: addForm.accountLimit, expiresAt: addForm.expiresAt || null }),
        credentials: "include",
      });
      const d = await r.json();
      if (d.ok) {
        toast({ title: "User created" });
        setShowAdd(false);
        setAddForm({ username: "", password: "", tier: "starter", accountLimit: 15, expiresAt: "" });
        fetchUsers();
      } else {
        toast({ title: d.error ?? "Failed to create user", variant: "destructive" });
      }
    } catch { toast({ title: "Error creating user", variant: "destructive" }); }
  };

  const handleUpdate = async (u: LicenseUser) => {
    if (!editForm) return;
    try {
      const r = await fetch(`/api/license/users/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, tier: editForm.tier, accountLimit: editForm.accountLimit, expiresAt: editForm.expiresAt || null, ...(editForm.password ? { password: editForm.password } : {}) }),
        credentials: "include",
      });
      const d = await r.json();
      if (d.ok) { toast({ title: "User updated" }); setEditingId(null); setEditForm(null); fetchUsers(); }
      else toast({ title: "Failed to update", variant: "destructive" });
    } catch { toast({ title: "Error", variant: "destructive" }); }
  };

  const handleDelete = async (u: LicenseUser) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/license/users/${u.id}`, { method: "DELETE", credentials: "include" });
      toast({ title: "User deleted" });
      fetchUsers();
    } catch {}
  };

  const handleToggleActive = async (u: LicenseUser) => {
    try {
      await fetch(`/api/license/users/${u.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: u.active ? 0 : 1 }), credentials: "include",
      });
      fetchUsers();
    } catch {}
  };

  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    const dt = new Date(d);
    const days = Math.ceil((dt.getTime() - Date.now()) / 86400000);
    const label = dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    if (days <= 0) return <span className="text-destructive font-medium">{label} (expired)</span>;
    if (days <= 7) return <span className="text-amber-500 font-medium">{label} ({days}d)</span>;
    return <span>{label}</span>;
  };

  const fmtExpiry = (d: string | null) => {
    if (!d) return <span>—</span>;
    const dt = new Date(d);
    const days = Math.ceil((dt.getTime() - Date.now()) / 86400000);
    const time = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const date = dt.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
    const label = `${time} ${date}`;
    if (days <= 0) return <span className="text-destructive font-medium">{label}</span>;
    if (days <= 7) return <span className="text-amber-500 font-medium">{label}</span>;
    return <span>{label}</span>;
  };

  const tierBadge = (tierId: string) => {
    const t = PLAN_TIERS.find(t => t.id === tierId);
    return t ? <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
             : <span className="text-[10px] text-muted-foreground">{tierId}</span>;
  };

  return (
    <div className="space-y-3 pt-2 border-t border-border/60">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">User Management</p>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 px-2.5" onClick={() => setShowAdd(s => !s)}>
          <Plus className="w-3 h-3" />{showAdd ? "Cancel" : "Add User"}
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">New User</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] mb-1 block">Username</Label>
              <Input value={addForm.username} onChange={e => setAddForm(f => ({ ...f, username: e.target.value }))} placeholder="username" className="h-7 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] mb-1 block">Password</Label>
              <Input type="password" value={addForm.password} onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))} placeholder="password" className="h-7 text-xs" />
            </div>
            <div className="col-span-2">
              <Label className="text-[10px] mb-1.5 block">Plan</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {PLAN_TIERS.map(t => (
                  <label key={t.id} className={`flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors ${addForm.tier === t.id ? "border-primary/50 bg-primary/5" : "border-border/50 hover:border-border"}`}>
                    <input type="radio" name="add-plan-tier" value={t.id} checked={addForm.tier === t.id} onChange={() => setAddForm(f => ({ ...f, tier: t.id, accountLimit: PLAN_TIERS.find(p => p.id === t.id)?.limit ?? f.accountLimit }))} className="accent-primary shrink-0" />
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{t.price}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-[10px] mb-1 block">Account Slots</Label>
              <NumField min={0} value={addForm.accountLimit} onChange={v => setAddForm(f => ({ ...f, accountLimit: v }))} className="h-7 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] mb-1 block">Expires (leave blank = never)</Label>
              <Input type="date" value={addForm.expiresAt} onChange={e => setAddForm(f => ({ ...f, expiresAt: e.target.value }))} className="h-7 text-xs" />
            </div>
          </div>
          <Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={!addForm.username.trim() || !addForm.password}>
            Create User
          </Button>
        </div>
      )}

      {loadingUsers ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading users…</div>
      ) : users.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No users found.</p>
      ) : (
        <div className="space-y-1">
          {users.map(u => (
            <div key={u.id} className={`rounded-lg border ${u.active ? "border-border" : "border-border/40 opacity-60"} bg-background`}>
              {editingId === u.id && editForm ? (
                <div className="p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="col-span-2">
                      <Label className="text-[10px] mb-1.5 block">Plan</Label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {PLAN_TIERS.map(t => (
                          <label key={t.id} className={`flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors ${editForm.tier === t.id ? "border-primary/50 bg-primary/5" : "border-border/50 hover:border-border"}`}>
                            <input type="radio" name="edit-plan-tier" value={t.id} checked={editForm.tier === t.id} onChange={() => setEditForm(f => f ? { ...f, tier: t.id, accountLimit: PLAN_TIERS.find(p => p.id === t.id)?.limit ?? f.accountLimit } : f)} className="accent-primary shrink-0" />
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
                            <span className="text-[10px] text-muted-foreground ml-auto">{t.price}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="text-[10px] mb-1 block">Slots</Label>
                      <NumField min={0} value={editForm.accountLimit} onChange={v => setEditForm(f => f ? { ...f, accountLimit: v } : f)} className="h-7 text-xs" />
                    </div>
                    <div>
                      <Label className="text-[10px] mb-1 block">Expires</Label>
                      <Input type="date" value={editForm.expiresAt} onChange={e => setEditForm(f => f ? { ...f, expiresAt: e.target.value } : f)} className="h-7 text-xs" />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px] mb-1 block">New Password (optional)</Label>
                      <Input type="password" value={editForm.password} onChange={e => setEditForm(f => f ? { ...f, password: e.target.value } : f)} placeholder="leave blank to keep" className="h-7 text-xs" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="h-6 text-xs px-2.5" onClick={() => handleUpdate(u)}>Save</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2.5" onClick={() => { setEditingId(null); setEditForm(null); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold truncate">{u.username}</span>
                      {u.is_admin === 1 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-700">Admin</span>}
                      {tierBadge(u.tier)}
                    </div>
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">DEVICES: {u.is_admin === 1 ? "∞" : (PLAN_TIERS.find(t => t.id === u.tier)?.deviceLimit ?? "—")}</span>
                      <span className="text-[10px] text-muted-foreground">ACCOUNT SLOTS: {u.is_admin === 1 ? "∞" : u.account_limit}</span>
                      <span className="text-[10px] text-muted-foreground">EXPIRES: {fmtExpiry(u.expires_at)}</span>
                    </div>
                  </div>
                  <Switch checked={!!u.active} onCheckedChange={() => handleToggleActive(u)} className="scale-75" />
                  {u.is_admin === 0 && (
                    <>
                      <button onClick={() => { setEditingId(u.id); setEditForm({ tier: u.tier, accountLimit: u.account_limit, expiresAt: u.expires_at ? u.expires_at.split("T")[0] : "", password: "" }); }} className="p-1 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => handleDelete(u)} className="p-1 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-destructive">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MyAccountTabContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    try { return localStorage.getItem("aurafarming:avatar"); } catch { return null; }
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please select an image file.", variant: "destructive" }); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const url = ev.target?.result as string;
      try { localStorage.setItem("aurafarming:avatar", url); } catch {}
      setAvatarUrl(url);
      toast({ title: "Profile picture updated" });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const { data: me, isLoading: meLoading } = useQuery<{ ok: boolean; username?: string; tier?: string; accountLimit?: number; isAdmin?: boolean; expiresAt?: string | null }>({
    queryKey: ["/api/license/me"],
    queryFn: async () => { const r = await fetch("/api/license/me", { credentials: "include" }); return r.json(); },
    staleTime: 30_000,
  });

  const handleLogout = async () => {
    await fetch("/api/license/logout", { method: "POST", credentials: "include" });
    try { localStorage.removeItem("aurafarming:savedLogin"); } catch {}
    queryClient.invalidateQueries({ queryKey: ["/api/license/me"] });
    toast({ title: "Signed out" });
  };

  if (meLoading) {
    return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading…</span></div>;
  }

  const tier = me?.ok ? (PLAN_TIERS.find(t => t.id === me.tier) ?? null) : null;

  const expiresAt = me?.ok && me.expiresAt ? new Date(me.expiresAt) : null;
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86400000) : null;
  const isExpired = daysLeft !== null && daysLeft <= 0;
  const isExpiringSoon = daysLeft !== null && daysLeft > 0 && daysLeft <= 7;

  return (
    <div className="space-y-5 max-w-md">
      {me?.ok ? (
        <>
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative cursor-pointer group shrink-0" onClick={() => avatarInputRef.current?.click()} title="Click to change profile picture">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="avatar" className="w-10 h-10 rounded-full object-cover border border-border" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><UserCircle className="w-6 h-6 text-primary" /></div>
                )}
                <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                  <Camera className="w-3.5 h-3.5 text-white" />
                </div>
              </div>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
              <div>
                <p className="text-sm font-semibold">{me.username}</p>
                {me.isAdmin && <p className="text-xs text-primary font-medium">Administrator</p>}
              </div>
            </div>
            {me.isAdmin ? (
              <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-cyan-100 text-cyan-700">Owner</span>
            ) : tier ? (
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${tier.badge}`}>{tier.label}</span>
            ) : null}
          </div>

          {/* Plan card */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Plan</span>
              <span className="font-semibold">{me.isAdmin ? "Owner (Unlimited)" : tier?.label ?? me.tier}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Devices</span>
              <span className="font-semibold">{me.isAdmin ? "∞" : `${tier?.deviceLimit ?? "—"}`}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Account slots</span>
              <span className="font-semibold">{me.isAdmin ? "∞" : `${me.accountLimit ?? "—"}`}</span>
            </div>
            {!me.isAdmin && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Subscription expires</span>
                {expiresAt ? (
                  <span className={`font-semibold ${isExpired ? "text-destructive" : isExpiringSoon ? "text-amber-500" : ""}`}>
                    {expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    {isExpiringSoon && !isExpired && <span className="ml-1">({daysLeft}d left)</span>}
                    {isExpired && <span className="ml-1">(expired)</span>}
                  </span>
                ) : (
                  <span className="text-muted-foreground font-medium">—</span>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">Not signed in. Please restart Aura Farming.</div>
      )}

      {/* Subscription plan tiers — always visible regardless of login/admin status */}
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Subscription Plans</p>
        {PLAN_TIERS.map(t => {
          const isCurrent = me?.ok && t.id === me.tier;
          return (
            <label
              key={t.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-not-allowed select-none ${isCurrent ? "border-primary/40 bg-primary/5" : "border-border/50 opacity-50"}`}
            >
              <input
                type="radio"
                name="plan-tier"
                value={t.id}
                checked={!!isCurrent}
                disabled
                readOnly
                className="accent-primary"
              />
              <div className="flex-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
                  <span className="text-xs text-muted-foreground">{t.deviceLimit} device{t.deviceLimit !== 1 ? "s" : ""} · {t.limit >= 9999 ? "Unlimited" : t.limit} slots</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${isCurrent ? "" : "text-muted-foreground"}`}>{t.price}</span>
                  {isCurrent && <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Current</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* Admin: User Management */}
      {me?.ok && me.isAdmin && <AdminUsersSection />}

      {me?.ok && (
        <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-2 text-muted-foreground hover:text-foreground w-fit">
          <LogOut className="w-3.5 h-3.5" /> Sign out
        </Button>
      )}
    </div>
  );
}

