import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Users, Ban, Shield, CheckCircle2, XCircle, Loader2, RefreshCw, Database } from "lucide-react";
import type { GlobalSettings } from "@shared/schema";
import { useState } from "react";

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

  const { data: settings, isLoading } = useQuery<GlobalSettings>({
    queryKey: ["/api/settings"],
    queryFn: fetchSettings,
  });

  // Sync token input from DB on first load only (don't overwrite while user is typing)
  const [tokenInitialized, setTokenInitialized] = useState(false);
  if (settings && !tokenInitialized) {
    setTokenDraft(settings.hikerApiToken ?? "");
    setTokenInitialized(true);
  }

  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: (data) => {
      qc.setQueryData(["/api/settings"], data);
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

      <div className="space-y-6 max-w-2xl">

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

        {/* Follow Deduplication */}
        <div className="desktop-card p-6">
          <h3 className="text-base font-semibold mb-1">Follow Deduplication</h3>
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

        {/* Scraped User Deduplication */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Database className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">Scraped User Deduplication</h3>
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

        {/* Theme */}
        <div className="desktop-card p-6">
          <h3 className="text-base font-semibold mb-2">Application Theme</h3>
          <p className="text-sm text-muted-foreground">
            Danny's Bot is designed with a clean white desktop interface to maximise productivity during automation management.
            Dark mode is intentionally disabled to maintain this professional aesthetic.
          </p>
        </div>

        {/* App Updates */}
        <div className="desktop-card p-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold">App Updates</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Danny's Bot checks for updates automatically on startup. Click below to check right now.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              const api = (window as unknown as { electronAPI?: { checkForUpdates: () => Promise<void> } }).electronAPI;
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
        </div>

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
