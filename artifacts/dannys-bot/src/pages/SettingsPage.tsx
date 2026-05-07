import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Users, Ban, Shield, CheckCircle2, XCircle, Loader2, RefreshCw, Database, KeyRound, Timer, FileText, Upload, AlertCircle, ScrollText, HardDrive, FolderOpen, RotateCcw, Trash2, Palette, Moon, Sun } from "lucide-react";
import type { GlobalSettings } from "@shared/schema";
import { useState, useRef, useEffect } from "react";
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

  // ─── Jarvee import state ───────────────────────────────────────────────────
  const jarveeFileRef = useRef<HTMLInputElement>(null);
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

      <div className="space-y-4 max-w-2xl">

        {/* HikerAPI Scraper Protection */}
        <div className="desktop-card p-6">
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

        <div className="border-t border-border/60" />

        {/* Follow Skip Settings */}
        <div className="desktop-card p-6">
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

        <div className="border-t border-border/60" />

        {/* Scraped User Skip Settings */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Database className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Scraped User Skip Settings</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Track every user scraped from a hashtag globally across all accounts. When enabled, a user
            scraped by Account A won't be scraped again by Account B — saving HikerAPI credits.
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
                Default 365 days — effectively means never scrape the same user twice.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-border/60" />

        {/* 2Captcha Integration */}
        <div className="desktop-card p-6">
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

        <div className="border-t border-border/60" />

        {/* API Log Limit */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-indigo-100 text-indigo-600">
              <ScrollText className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">API Log Limit</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Maximum number of rows loaded in the Dashboard API call log. Older entries beyond this limit are not displayed.
            Larger limits use more memory but preserve more history.
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

        <div className="border-t border-border/60" />

        {/* Verify All Delay */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <Timer className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Verify All Accounts Delay</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            When "Verify All Accounts" is triggered from the Accounts page, this delay is applied between each verification to avoid rate limiting.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Min delay (seconds)</Label>
              <Input
                type="number" min={0} max={300}
                className="w-28"
                defaultValue={settings?.verifyAllDelayMin ?? 5}
                key={settings?.verifyAllDelayMin}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v !== settings?.verifyAllDelayMin) {
                    mutation.mutate({ verifyAllDelayMin: v });
                  }
                }}
                disabled={isLoading}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Max delay (seconds)</Label>
              <Input
                type="number" min={0} max={300}
                className="w-28"
                defaultValue={settings?.verifyAllDelayMax ?? 15}
                key={settings?.verifyAllDelayMax}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v !== settings?.verifyAllDelayMax) {
                    mutation.mutate({ verifyAllDelayMax: v });
                  }
                }}
                disabled={isLoading}
              />
            </div>
          </div>
        </div>

        <div className="border-t border-border/60" />

        {/* CSV Export Timezone */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-cyan-100 text-cyan-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">CSV Export Timezone</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            When enabled, exported timestamps are automatically converted to your PC's local time.
            The timezone is detected from your browser — no manual offset needed.
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

        <div className="border-t border-border/60" />

        {/* Theme */}
        <div className="desktop-card p-6">
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

        <div className="border-t border-border/60" />

        {/* App Updates */}
        <div className="desktop-card p-6">
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

        <div className="border-t border-border/60" />

        {/* Jarvee Import */}
        <div className="desktop-card p-6">
          <h3 className="text-base font-semibold mb-1 flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Jarvee Import — Followed Users
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
                                <span className="text-muted-foreground">—</span>
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
                      toast({ title: `Import complete — ${totalImported.toLocaleString()} new entries added` });
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

        {isElectron && (
          <div className="border-t border-border/60" />
        )}

        {/* Backup & Restore */}
        {isElectron && (
          <div className="desktop-card p-6">
            <div className="flex items-center gap-3 mb-1">
              <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600">
                <HardDrive className="w-4 h-4" />
              </div>
              <h3 className="text-base font-semibold">Backup &amp; Restore</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Automatically zip your database and settings into dated backup folders.
              Restore any backup to roll everything back to that point — the app will relaunch automatically.
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
                <p className="text-xs text-muted-foreground pt-1">No backups yet — create one above.</p>
              )}
            </div>
          </div>
        )}

        <div className="border-t border-border/60" />

        {/* Data Management */}
        <div className="desktop-card p-6">
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
