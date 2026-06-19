import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { Users, Ban, Shield, CheckCircle2, XCircle, Loader2, RefreshCw, Database, KeyRound, Timer, FileText, AlertCircle, ScrollText, HardDrive, FolderOpen, RotateCcw, Trash2, Palette, Moon, Sun, BookOpen, ChevronRight, Phone, Power, Terminal, Download, Pencil, X, Crown, LogOut, UserCircle, Camera, Upload, Plus } from "lucide-react";
import type { GlobalSettings } from "@shared/schema";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTheme, THEME_COLORS } from "@/hooks/use-theme";

type BackupEntry = { id: string; date: string; size: number };
const eAPI = () => (window as any).electronAPI;
const isElectron = typeof window !== "undefined" && typeof eAPI()?.createBackup === "function";

// ─── Jarvee parser helpers ───────────────────────────────────────────────────

interface JarveeEntry {
  username: string;
  userId: string;
  followedAt: string; // ISO
}

interface JarveeGroup {
  accountUsername: string; // before " | "
  entries: JarveeEntry[];
}

function jarveeDateToISO(raw: string): string {
  // "26/04/2026 21:36"  →  "2026-04-26T21:36:00.000Z"
  const [datePart, timePart] = raw.trim().split(" ");
  if (!datePart) return new Date().toISOString();
  const [day, month, year] = datePart.split("/");
  const time = timePart ?? "00:00";
  return new Date(`${year}-${month}-${day}T${time}:00.000Z`).toISOString();
}

function parseJarveeFile(buffer: ArrayBuffer): JarveeGroup[] {
  let text = new TextDecoder("utf-16le").decode(buffer);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, JarveeEntry[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const accountFull = cols[0].trim();
    const accountUsername = accountFull.split(" | ")[0].trim();
    const target = (cols[3] ?? "").trim();
    const userId = (cols[6] ?? "").trim();
    const dateRaw = (cols[2] ?? "").trim();
    if (!target || !accountUsername) continue;
    if (!groups.has(accountUsername)) groups.set(accountUsername, []);
    groups.get(accountUsername)!.push({
      username: target,
      userId,
      followedAt: jarveeDateToISO(dateRaw),
    });
  }
  return Array.from(groups.entries()).map(([accountUsername, entries]) => ({
    accountUsername,
    entries,
  }));
}

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
      toast({ title: result ? "Equinox will start with Windows" : "Autostart disabled" });
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
              Equinox will launch automatically when Windows starts. The app opens minimised to the tray.
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
  const [settingsTab, setSettingsTab] = useState("my account");

  // ─── Jarvee import state ───────────────────────────────────────────────────
  const jarveeFileRef = useRef<HTMLInputElement>(null);

  const verifyAllMinMinsRef = useRef<HTMLInputElement>(null);
  const verifyAllMinSecsRef = useRef<HTMLInputElement>(null);
  const verifyAllMaxMinsRef = useRef<HTMLInputElement>(null);
  const verifyAllMaxSecsRef = useRef<HTMLInputElement>(null);
  const sameProxyMinMinsRef = useRef<HTMLInputElement>(null);
  const sameProxyMinSecsRef = useRef<HTMLInputElement>(null);
  const sameProxyMaxMinsRef = useRef<HTMLInputElement>(null);
  const sameProxyMaxSecsRef = useRef<HTMLInputElement>(null);

  const toSecs = (m: number, s: number) => Math.max(0, Math.round(m) * 60 + Math.round(s));
  const msOf = (totalSecs: number) => ({ m: Math.floor((totalSecs ?? 0) / 60), s: (totalSecs ?? 0) % 60 });
  const [jarveeGroups, setJarveeGroups] = useState<JarveeGroup[] | null>(null);
  const [jarveeFileName, setJarveeFileName] = useState<string>("");
  const [jarveeImporting, setJarveeImporting] = useState(false);
  const [jarveeProgress, setJarveeProgress] = useState<{ current: number; total: number } | null>(null);
  type ImportResult = { accountUsername: string; imported: number; skipped: number; error?: string };
  const [jarveeResults, setJarveeResults] = useState<ImportResult[] | null>(null);

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
        {(["My Account", "General", "Scraping", "Automation", "Security", "Data"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setSettingsTab(tab.toLowerCase())}
            className={`px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${settingsTab === tab.toLowerCase() ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {settingsTab === "my account" && (
        <div className="desktop-card p-6">
          <MyAccountTabContent />
        </div>
      )}

      <div className={`space-y-4 max-w-2xl ${["my account"].includes(settingsTab) ? "hidden" : ""}`}>

        {/* Talk to Equinox Bot shortcut */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("equinox-bot-open", { detail: "open" }))}
          className="block w-full text-left"
          style={{ display: settingsTab !== "general" ? "none" : undefined }}
        >
          <div className="desktop-card p-4 flex items-center justify-between cursor-pointer hover:bg-accent/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <img src="/bot-logo.png" alt="" className="w-4 h-4 object-contain" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Talk to Equinox Bot</p>
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
                  className="font-mono text-sm"
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



        {/* Scraped User Skip Settings */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Database className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Scraped User Skip Settings</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Track every user scraped from a hashtag globally across all accounts. When enabled, a user
            scraped by Account A won't be scraped again by Account B saving HikerAPI credits.
            The hashtag cursor position is also shared globally so accounts continue where others left off.
          </p>

          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label className="text-sm font-medium cursor-pointer" htmlFor="skip-scraped">
                  Skip Already Scraped Users
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Users already scraped by any account are excluded from future scrape batches for the
                  configured number of days.
                </p>
              </div>
              <Switch
                id="skip-scraped"
                checked={settings?.skipScrapedUsers ?? false}
                onCheckedChange={(v) => toggle("skipScrapedUsers", v)}
                disabled={isLoading || mutation.isPending}
                className="data-[state=checked]:bg-purple-500 shrink-0 mt-0.5"
              />
            </div>

            <div className="border-t border-border/50 pt-4 flex items-start justify-between gap-4">
              <div>
                <Label className="text-sm font-medium cursor-pointer" htmlFor="scrape-all-if-skipped">
                  Scrape all users if some are skipped?
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  If the follow session ends short of its target (users skipped by any filter -- already followed, skip list, Indian names, etc.), HikerAPI will keep scraping additional pages until the target follow count is reached. Only works for hashtag sources (follower lists have no pagination cursor).
                </p>
              </div>
              <Switch
                id="scrape-all-if-skipped"
                checked={settings?.scrapeAllIfSkipped ?? false}
                onCheckedChange={(v) => toggle("scrapeAllIfSkipped", v)}
                disabled={isLoading || mutation.isPending}
                className="data-[state=checked]:bg-purple-500 shrink-0 mt-0.5"
              />
            </div>

            <div className="border-t border-border/50 pt-4 space-y-2">
              <Label className="text-sm font-medium" htmlFor="ignore-days">
                Ignore scraped users for (days)
              </Label>
              <Input
                id="ignore-days"
                type="number"
                min={1}
                max={3650}
                className="w-32"
                defaultValue={settings?.scrapedUserIgnoreDays ?? 365}
                key={settings?.scrapedUserIgnoreDays}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0 && v !== settings?.scrapedUserIgnoreDays) {
                    mutation.mutate({ scrapedUserIgnoreDays: v });
                  }
                }}
                disabled={isLoading || !(settings?.skipScrapedUsers)}
              />
              <p className="text-xs text-muted-foreground">
                Default 365 days effectively means never scrape the same user twice.
              </p>
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
                className="font-mono text-sm flex-1"
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
            Powers the Equinox Bot chat and the Scan with AI feature in Evasion Stats. Gemini has a generous free tier —
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
                className="font-mono text-sm flex-1"
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
              className="font-mono text-sm"
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
          <p className="text-sm text-muted-foreground mb-5">
            Maximum number of rows kept in memory for the Dashboard activity log. Older entries beyond this limit are dropped.
            Larger limits preserve more history but use more memory.
          </p>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Max log rows</Label>
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



        {/* Verify Delay Mode selector */}
        <div className="desktop-card p-5" style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <p className="text-sm font-semibold mb-1">Verify Delay Mode</p>
          <p className="text-xs text-muted-foreground mb-4">Select one — only the active mode applies when verifying accounts.</p>
          <div className="flex gap-3">
            <button
              onClick={() => mutation.mutate({ verifyDelayMode: "general" })}
              className={`flex-1 rounded-lg border-2 p-3 text-left transition-colors ${(settings?.verifyDelayMode ?? "general") === "general" ? "border-green-500 bg-green-50 dark:bg-green-950/40" : "border-border opacity-60"}`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <div className={`w-3 h-3 rounded-full border-2 ${(settings?.verifyDelayMode ?? "general") === "general" ? "border-green-500 bg-green-500" : "border-muted-foreground"}`} />
                <span className="text-sm font-medium">Verify All Accounts Delay</span>
              </div>
              <p className="text-xs text-muted-foreground pl-5">Flat delay between every account one at a time, regardless of proxy</p>
            </button>
            <button
              onClick={() => mutation.mutate({ verifyDelayMode: "sameProxy" })}
              className={`flex-1 rounded-lg border-2 p-3 text-left transition-colors ${settings?.verifyDelayMode === "sameProxy" ? "border-orange-500 bg-orange-50 dark:bg-orange-950/40" : "border-border opacity-60"}`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <div className={`w-3 h-3 rounded-full border-2 ${settings?.verifyDelayMode === "sameProxy" ? "border-orange-500 bg-orange-500" : "border-muted-foreground"}`} />
                <span className="text-sm font-medium">Same Proxy Delay</span>
              </div>
              <p className="text-xs text-muted-foreground pl-5">Different proxies verify simultaneously — stagger accounts on the same IP</p>
            </button>
          </div>
        </div>

        {/* Verify All Delay */}
        <div className={`desktop-card p-6 transition-opacity ${(settings?.verifyDelayMode ?? "general") !== "general" ? "opacity-40 pointer-events-none select-none" : ""}`} style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <Timer className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Verify All Accounts Delay</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Sequential delay applied between every account when this mode is active.
          </p>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <div>
              <Label className="text-sm font-medium mb-2 block">Min delay</Label>
              <div className="flex items-center gap-2">
                <Input
                  ref={verifyAllMinMinsRef}
                  type="number" min={0} max={1440}
                  className="w-24"
                  defaultValue={msOf(settings?.verifyAllDelayMin ?? 5).m}
                  key={`vamin-m-${settings?.verifyAllDelayMin}`}
                  onBlur={() => {
                    const m = parseInt(verifyAllMinMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(verifyAllMinSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.verifyAllDelayMin) mutation.mutate({ verifyAllDelayMin: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">min</span>
                <Input
                  ref={verifyAllMinSecsRef}
                  type="number" min={0} max={59}
                  className="w-24"
                  defaultValue={msOf(settings?.verifyAllDelayMin ?? 5).s}
                  key={`vamin-s-${settings?.verifyAllDelayMin}`}
                  onBlur={() => {
                    const m = parseInt(verifyAllMinMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(verifyAllMinSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.verifyAllDelayMin) mutation.mutate({ verifyAllDelayMin: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium mb-2 block">Max delay</Label>
              <div className="flex items-center gap-2">
                <Input
                  ref={verifyAllMaxMinsRef}
                  type="number" min={0} max={1440}
                  className="w-24"
                  defaultValue={msOf(settings?.verifyAllDelayMax ?? 15).m}
                  key={`vamax-m-${settings?.verifyAllDelayMax}`}
                  onBlur={() => {
                    const m = parseInt(verifyAllMaxMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(verifyAllMaxSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.verifyAllDelayMax) mutation.mutate({ verifyAllDelayMax: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">min</span>
                <Input
                  ref={verifyAllMaxSecsRef}
                  type="number" min={0} max={59}
                  className="w-24"
                  defaultValue={msOf(settings?.verifyAllDelayMax ?? 15).s}
                  key={`vamax-s-${settings?.verifyAllDelayMax}`}
                  onBlur={() => {
                    const m = parseInt(verifyAllMaxMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(verifyAllMaxSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.verifyAllDelayMax) mutation.mutate({ verifyAllDelayMax: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
          </div>
        </div>

        {/* Same Proxy Delay */}
        <div className={`desktop-card p-6 transition-opacity ${settings?.verifyDelayMode !== "sameProxy" ? "opacity-40 pointer-events-none select-none" : ""}`} style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-orange-100 text-orange-600">
              <Timer className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Verify Accounts Sharing the Same Proxy — Delay</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            When verifying multiple accounts that share the same proxy IP, this delay is applied between each account on that proxy. Accounts on different proxies are verified simultaneously — so 10 accounts across 10 proxies all start at once, with this delay staggering the remaining 9 on each proxy.
          </p>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <div>
              <Label className="text-sm font-medium mb-2 block">Min delay</Label>
              <div className="flex items-center gap-2">
                <Input
                  ref={sameProxyMinMinsRef}
                  type="number" min={0} max={1440}
                  className="w-24"
                  defaultValue={msOf(settings?.sameProxyDelayMin ?? 0).m}
                  key={`spmin-m-${settings?.sameProxyDelayMin}`}
                  onBlur={() => {
                    const m = parseInt(sameProxyMinMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(sameProxyMinSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.sameProxyDelayMin) mutation.mutate({ sameProxyDelayMin: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">min</span>
                <Input
                  ref={sameProxyMinSecsRef}
                  type="number" min={0} max={59}
                  className="w-24"
                  defaultValue={msOf(settings?.sameProxyDelayMin ?? 0).s}
                  key={`spmin-s-${settings?.sameProxyDelayMin}`}
                  onBlur={() => {
                    const m = parseInt(sameProxyMinMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(sameProxyMinSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.sameProxyDelayMin) mutation.mutate({ sameProxyDelayMin: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium mb-2 block">Max delay</Label>
              <div className="flex items-center gap-2">
                <Input
                  ref={sameProxyMaxMinsRef}
                  type="number" min={0} max={1440}
                  className="w-24"
                  defaultValue={msOf(settings?.sameProxyDelayMax ?? 0).m}
                  key={`spmax-m-${settings?.sameProxyDelayMax}`}
                  onBlur={() => {
                    const m = parseInt(sameProxyMaxMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(sameProxyMaxSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.sameProxyDelayMax) mutation.mutate({ sameProxyDelayMax: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">min</span>
                <Input
                  ref={sameProxyMaxSecsRef}
                  type="number" min={0} max={59}
                  className="w-24"
                  defaultValue={msOf(settings?.sameProxyDelayMax ?? 0).s}
                  key={`spmax-s-${settings?.sameProxyDelayMax}`}
                  onBlur={() => {
                    const m = parseInt(sameProxyMaxMinsRef.current?.value ?? "0", 10);
                    const s = parseInt(sameProxyMaxSecsRef.current?.value ?? "0", 10);
                    const total = toSecs(isNaN(m) ? 0 : m, isNaN(s) ? 0 : s);
                    if (total !== settings?.sameProxyDelayMax) mutation.mutate({ sameProxyDelayMax: total });
                  }}
                  disabled={isLoading}
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
          </div>
        </div>



        {/* Pre-filled Phone Number */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "automation" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <Phone className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Pre-filled Phone Number</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Phone number typed into the browser when you click "Add Phone Number" in the Embedded Browser toolbar.
            Accepts any digits and symbols — no country code required.
          </p>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Phone number</Label>
            <Input
              type="text"
              className="w-64"
              placeholder="e.g. 07911 123456"
              defaultValue={settings?.preFilledPhoneNumber ?? ""}
              key={settings?.preFilledPhoneNumber}
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== (settings?.preFilledPhoneNumber ?? "")) {
                  mutation.mutate({ preFilledPhoneNumber: v });
                }
              }}
              disabled={isLoading}
            />
          </div>
        </div>



        {/* CSV Export Timezone */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "data" ? "none" : undefined }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-cyan-100 text-cyan-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">CSV Export Timezone</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            When enabled, exported timestamps are automatically converted to your PC's local time.
            The timezone is detected from your browser no manual offset needed.
          </p>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label className="text-sm font-medium cursor-pointer" htmlFor="use-local-time">
                Use PC's Local Time
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Timestamps in exported CSV files will match your local clock instead of server UTC.
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
            Equinox checks for updates automatically on startup. Click below to check right now.
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



        {/* Jarvee Import */}
        <div className="desktop-card p-6" style={{ display: settingsTab !== "data" ? "none" : undefined }}>
          <h3 className="text-base font-semibold mb-1 flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Jarvee Import Followed Users
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Import your Jarvee followed-users export so Equinox won't re-follow those accounts.
            Select the <code className="text-xs bg-muted px-1 rounded">FOLLOWEDUSERS_*.txt</code> file from your Jarvee data folder.
          </p>

          {/* File picker */}
          <div className="flex items-center gap-3 mb-4">
            <input
              ref={jarveeFileRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setJarveeFileName(file.name);
                setJarveeResults(null);
                try {
                  const buf = await file.arrayBuffer();
                  const groups = parseJarveeFile(buf);
                  setJarveeGroups(groups);
                } catch {
                  toast({ title: "Failed to parse file", description: "Make sure it's a Jarvee FOLLOWEDUSERS export.", variant: "destructive" });
                  setJarveeGroups(null);
                }
                // Reset input so same file can be re-selected
                e.target.value = "";
              }}
            />
            <Button variant="outline" onClick={() => jarveeFileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" />
              {jarveeFileName ? "Change File" : "Select File"}
            </Button>
            {jarveeFileName && (
              <span className="text-sm text-muted-foreground truncate max-w-xs">{jarveeFileName}</span>
            )}
          </div>

          {/* Parsed preview */}
          {jarveeGroups && jarveeGroups.length > 0 && (
            <div className="mb-4">
              <p className="text-sm font-medium mb-2">
                Found <strong>{jarveeGroups.length}</strong> account{jarveeGroups.length !== 1 ? "s" : ""},{" "}
                <strong>{jarveeGroups.reduce((s, g) => s + g.entries.length, 0).toLocaleString()}</strong> total entries
              </p>
              <div className="rounded border overflow-hidden text-sm">
                <table className="w-full">
                  <thead className="bg-muted text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Jarvee Account</th>
                      <th className="text-right px-3 py-2 font-medium">Entries</th>
                      {jarveeResults && <th className="text-right px-3 py-2 font-medium">Result</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {jarveeGroups.map((g) => {
                      const res = jarveeResults?.find(r => r.accountUsername === g.accountUsername);
                      return (
                        <tr key={g.accountUsername} className="border-t">
                          <td className="px-3 py-1.5 font-mono text-xs">{g.accountUsername}</td>
                          <td className="px-3 py-1.5 text-right">{g.entries.length.toLocaleString()}</td>
                          {jarveeResults && (
                            <td className="px-3 py-1.5 text-right">
                              {res ? (
                                res.error ? (
                                  <span className="text-destructive flex items-center justify-end gap-1">
                                    <AlertCircle className="w-3 h-3" />{res.error}
                                  </span>
                                ) : (
                                  <span className="text-green-600 dark:text-green-400">
                                    +{res.imported.toLocaleString()} new, {res.skipped.toLocaleString()} skipped
                                  </span>
                                )
                              ) : (
                                <span className="text-muted-foreground"> </span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Progress / Import button */}
              <div className="mt-3 flex items-center gap-3">
                {!jarveeResults && (
                  <Button
                    disabled={jarveeImporting}
                    onClick={async () => {
                      if (!jarveeGroups) return;
                      setJarveeImporting(true);
                      setJarveeProgress({ current: 0, total: jarveeGroups.length });
                      const results: ImportResult[] = [];
                      for (let i = 0; i < jarveeGroups.length; i++) {
                        const g = jarveeGroups[i];
                        setJarveeProgress({ current: i + 1, total: jarveeGroups.length });
                        try {
                          const res = await fetch("/api/jarvee/import-followed-users", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({ profileUsername: g.accountUsername, entries: g.entries }),
                          });
                          const json = await res.json();
                          if (!res.ok) {
                            results.push({ accountUsername: g.accountUsername, imported: 0, skipped: g.entries.length, error: json.error ?? "Unknown error" });
                          } else {
                            results.push({ accountUsername: g.accountUsername, imported: json.imported, skipped: json.skipped });
                          }
                        } catch (err: any) {
                          results.push({ accountUsername: g.accountUsername, imported: 0, skipped: g.entries.length, error: err?.message ?? "Network error" });
                        }
                      }
                      setJarveeResults(results);
                      setJarveeImporting(false);
                      setJarveeProgress(null);
                      const totalImported = results.reduce((s, r) => s + r.imported, 0);
                      toast({ title: `Import complete ${totalImported.toLocaleString()} new entries added` });
                    }}
                  >
                    {jarveeImporting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Importing {jarveeProgress?.current}/{jarveeProgress?.total}…
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 mr-2" />
                        Import All Accounts
                      </>
                    )}
                  </Button>
                )}
                {jarveeResults && (
                  <Button variant="outline" onClick={() => { setJarveeGroups(null); setJarveeResults(null); setJarveeFileName(""); }}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}

          {jarveeGroups && jarveeGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">No account data found in the file.</p>
          )}
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



        {/* Server Debug Log */}
        {settingsTab === "data" && <ServerLogCard />}

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

function ServerLogCard() {
  const { toast } = useToast();
  const [lines, setLines] = useState<string[]>([]);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [totalLines, setTotalLines] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);

  const fetchLog = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/logs/server?lines=200", { credentials: "include" });
      const data = await res.json();
      if (data.error) { setError(data.error); setLines([]); }
      else { setLines(data.lines ?? []); setLogPath(data.path ?? null); setTotalLines(data.totalLines ?? 0); }
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch log");
    } finally {
      setLoading(false);
    }
  };

  const downloadLog = async () => {
    try {
      const res = await fetch("/api/logs/server?lines=5000", { credentials: "include" });
      const data = await res.json();
      if (data.error) { toast({ title: "Download failed", description: data.error, variant: "destructive" }); return; }
      const text = (data.lines as string[]).join("\n");
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "equinox-debug.log";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e?.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    if (expanded && lines.length === 0) fetchLog();
  }, [expanded]);

  useEffect(() => {
    if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="desktop-card p-6">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-100 text-slate-600">
            <Terminal className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Server Debug Log</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Full server output written to disk — includes all account creation steps, EB harvest details, and automation events.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(v => !v)} className="shrink-0 text-xs">
          {expanded ? "Hide" : "Show"}
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          {logPath && (
            <p className="text-xs font-mono text-muted-foreground bg-muted/40 rounded px-2 py-1 break-all">
              {logPath}
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={fetchLog} disabled={loading} className="gap-1.5">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={downloadLog} className="gap-1.5">
              <Download className="w-3.5 h-3.5" />
              Download Full Log
            </Button>
            {totalLines > 200 && (
              <span className="text-xs text-muted-foreground self-center">
                Showing last 200 of {totalLines.toLocaleString()} lines
              </span>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5">{error}</p>
          )}

          {lines.length > 0 && (
            <div
              ref={tailRef}
              className="bg-black/90 rounded-md p-3 h-72 overflow-y-auto font-mono text-[11px] leading-relaxed text-green-300 space-y-0.5"
            >
              {lines.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all opacity-90 hover:opacity-100">{line}</div>
              ))}
            </div>
          )}

          {lines.length === 0 && !loading && !error && (
            <p className="text-xs text-muted-foreground">No log lines yet — the file is created when the server starts.</p>
          )}
        </div>
      )}
    </div>
  );
}

const PLAN_TIERS = [
  { id: "starter",    label: "Starter",    price: "£25/mo",  limit: 15,   badge: "bg-slate-100 text-slate-700"   },
  { id: "pro",        label: "Pro",         price: "£50/mo",  limit: 100,  badge: "bg-blue-100 text-blue-700"    },
  { id: "business",   label: "Business",    price: "£100/mo", limit: 250,  badge: "bg-purple-100 text-purple-700" },
  { id: "enterprise", label: "Enterprise",  price: "£250/mo", limit: 1000, badge: "bg-amber-100 text-amber-700"  },
];

type LicenseUser = { id: number; username: string; tier: string; account_limit: number; active: number; is_admin: number; created_at: string; expires_at: string | null };

function AdminUsersSection() {
  const { toast } = useToast();
  const [users, setUsers] = useState<LicenseUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addForm, setAddForm] = useState({ username: "", password: "", tier: "starter", accountLimit: 15, expiresAt: "" });
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
              <Input type="number" value={addForm.accountLimit} onChange={e => setAddForm(f => ({ ...f, accountLimit: Number(e.target.value) }))} className="h-7 text-xs" />
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
                      <Input type="number" value={editForm.accountLimit} onChange={e => setEditForm(f => f ? { ...f, accountLimit: Number(e.target.value) } : f)} className="h-7 text-xs" />
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
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{u.is_admin === 1 ? "∞" : u.account_limit} slots</span>
                      <span className="text-[10px] text-muted-foreground">Exp: {fmtDate(u.expires_at)}</span>
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
    try { return localStorage.getItem("equinox:avatar"); } catch { return null; }
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast({ title: "Invalid file", description: "Please select an image file.", variant: "destructive" }); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const url = ev.target?.result as string;
      try { localStorage.setItem("equinox:avatar", url); } catch {}
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
    try { localStorage.removeItem("equinox:savedLogin"); } catch {}
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
              <span className="text-muted-foreground">Account slots</span>
              <span className="font-semibold">{me.isAdmin ? "Unlimited" : `${me.accountLimit ?? "—"}`}</span>
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
        <div className="text-sm text-muted-foreground">Not signed in. Please restart Equinox.</div>
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
                  <span className="text-xs text-muted-foreground">up to {t.limit} accounts</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${isCurrent ? "" : "text-muted-foreground"}`}>{t.price}</span>
                  {isCurrent && <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Current</span>}
                  {!isCurrent && <span className="text-[10px] text-muted-foreground italic">coming soon</span>}
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

