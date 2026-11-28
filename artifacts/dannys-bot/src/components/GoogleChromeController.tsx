import { useCallback, useEffect, useRef, useState } from "react";
import { Settings, Play, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const PROFILE_ID = 10_000_000;

function usePersistentBrowserSetting<T extends string | boolean>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === null) return initialValue;
      const parsed: unknown = JSON.parse(saved);
      return typeof parsed === typeof initialValue ? parsed as T : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);

  return [value, setValue] as const;
}

const parsePositive = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function GoogleChromeController() {
  const { toast } = useToast();
  const isDesktopApp = typeof (window as any).electronAPI?.openBrowserWindow === "function";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const [urlEnabled, setUrlEnabled] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.urlEnabled", false);
  const [url, setUrl] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.url", "");
  const [messageEnabled, setMessageEnabled] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.messageEnabled", false);
  const [message, setMessage] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.message", "");
  const [skipAlreadyMessaged, setSkipAlreadyMessaged] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.skipAlreadyMessaged", false);
  const [continueWhereLeftOff, setContinueWhereLeftOff] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.continueWhereLeftOff", false);
  const [girlsOnly, setGirlsOnly] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.girlsOnly", false);
  const [stopLimitsEnabled, setStopLimitsEnabled] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.stopLimitsEnabled", false);
  const [stopMinutes, setStopMinutes] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.stopMinutes", "");
  const [maxUsers, setMaxUsers] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.maxUsers", "");
  const [scheduleEnabled, setScheduleEnabled] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.scheduleEnabled", false);
  const [intervalMin, setIntervalMin] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.intervalMin", "");
  const [intervalMax, setIntervalMax] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.intervalMax", "");
  const [amountEnabled, setAmountEnabled] = usePersistentBrowserSetting<boolean>("aura.googleChrome.sendDms.amountEnabled", false);
  const [amountMin, setAmountMin] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.amountMin", "");
  const [amountMax, setAmountMax] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.amountMax", "");
  const [delayMin, setDelayMin] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.delayMinSeconds", "30");
  const [delayMax, setDelayMax] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.delayMaxSeconds", "60");
  const [progress, setProgress] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.progress", "");
  const [nextRunAt, setNextRunAt] = usePersistentBrowserSetting<string>("aura.googleChrome.sendDms.nextRunAt", "");

  const runLock = useRef(false);
  const stopRequested = useRef(false);
  const runRef = useRef<() => Promise<void>>(async () => {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleNextRun = useCallback((min: number, max: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const delayMs = (min + Math.random() * Math.max(0, max - min)) * 60_000;
    setNextRunAt(String(Date.now() + delayMs));
  }, [setNextRunAt]);

  const run = useCallback(async () => {
    if (runLock.current) return;
    if (!isDesktopApp) {
      toast({
        title: "Open Aura Farming desktop app",
        description: "A web preview cannot open a browser window on your computer.",
        variant: "destructive",
      });
      return;
    }
    if (!urlEnabled || !url.trim()) {
      toast({ title: "Set the page URL in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }
    if (!messageEnabled || !message.trim()) {
      toast({ title: "Enable and enter a message in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    let target: URL;
    try {
      target = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported URL");
    } catch {
      toast({ title: "Enter a valid page URL in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    const delayMinSeconds = Number(delayMin);
    const delayMaxSeconds = Number(delayMax);
    if (!delayMin.trim() || !delayMax.trim() || !Number.isFinite(delayMinSeconds) ||
      !Number.isFinite(delayMaxSeconds) || delayMinSeconds < 0 || delayMaxSeconds < delayMinSeconds) {
      toast({ title: "Enter a valid message delay range in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    const minAmount = parsePositive(amountMin);
    const maxAmount = parsePositive(amountMax);
    if (amountEnabled && (minAmount === null || maxAmount === null || maxAmount < minAmount)) {
      toast({ title: "Enter a valid message amount range in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    const minInterval = parsePositive(intervalMin);
    const maxInterval = parsePositive(intervalMax);
    if (scheduleEnabled && (minInterval === null || maxInterval === null || maxInterval < minInterval)) {
      toast({ title: "Enter a valid run interval in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    const messageOptions = message.split("!!").map(part => part.trim()).filter(Boolean);
    if (!messageOptions.length) {
      toast({ title: "Enter a non-empty message in Settings", variant: "destructive" });
      setSettingsOpen(true);
      return;
    }

    let savedProgress: { url?: string; cursor?: number; messagedUrls?: string[] } = {};
    try { savedProgress = JSON.parse(progress || "{}"); } catch {}
    const sameTarget = savedProgress.url === target.href;
    const alreadyMessagedUrls = Array.isArray(savedProgress.messagedUrls)
      ? savedProgress.messagedUrls.filter((value): value is string => typeof value === "string").slice(-5000)
      : [];
    const startIndex = continueWhereLeftOff && sameTarget && !skipAlreadyMessaged
      ? Math.max(0, Math.floor(Number(savedProgress.cursor) || 0))
      : 0;
    const amount = amountEnabled && minAmount !== null && maxAmount !== null
      ? Math.floor(minAmount + Math.random() * (maxAmount - minAmount + 1))
      : undefined;
    const stopAfterMinutes = stopLimitsEnabled ? parsePositive(stopMinutes) ?? undefined : undefined;
    const userLimit = stopLimitsEnabled ? parsePositive(maxUsers) ?? undefined : undefined;

    runLock.current = true;
    stopRequested.current = false;
    setRunning(true);
    setNextRunAt("");
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    try {
      const response = await fetch(`/api/browser/${PROFILE_ID}/send-dms/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: target.href,
          messages: messageOptions,
          amount,
          delayMinSeconds,
          delayMaxSeconds,
          maxUsers: userLimit,
          stopAfterMinutes,
          skipAlreadyMessaged,
          alreadyMessagedUrls,
          startIndex,
          girlsOnly,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `Send DMs failed (${response.status})`);

      const sentUrls = Array.isArray(data.sentUrls)
        ? data.sentUrls.filter((value: unknown): value is string => typeof value === "string")
        : [];
      setProgress(JSON.stringify({
        url: target.href,
        cursor: Number.isFinite(data.nextIndex) ? Math.max(0, data.nextIndex) : 0,
        messagedUrls: [...new Set([...alreadyMessagedUrls, ...sentUrls])].slice(-5000),
      }));
      if (typeof data.notice === "string" && data.notice) {
        toast({ title: "Send DMs stopped", description: data.notice, variant: "destructive" });
      }
    } catch (error: any) {
      toast({
        title: "Google Chrome run failed",
        description: error?.message ?? "The browser could not be started.",
        variant: "destructive",
      });
    } finally {
      runLock.current = false;
      setRunning(false);
      if (!stopRequested.current && scheduleEnabled && minInterval !== null && maxInterval !== null) {
        scheduleNextRun(minInterval, maxInterval);
      }
    }
  }, [
    amountEnabled, amountMax, amountMin, continueWhereLeftOff, delayMax, delayMin, girlsOnly,
    intervalMax, intervalMin, isDesktopApp, message, messageEnabled, progress, scheduleEnabled,
    scheduleNextRun, setNextRunAt, setProgress, skipAlreadyMessaged, stopLimitsEnabled,
    stopMinutes, toast, url, urlEnabled, maxUsers,
  ]);
  runRef.current = run;

  const stop = useCallback(async () => {
    stopRequested.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNextRunAt("");
    if (!runLock.current) setRunning(false);
    try {
      await fetch(`/api/browser/${PROFILE_ID}/send-dms/stop`, { method: "POST" });
    } catch {}
  }, [setNextRunAt]);

  useEffect(() => {
    if (!scheduleEnabled || !nextRunAt || !isDesktopApp) return;
    const dueAt = Number(nextRunAt);
    if (!Number.isFinite(dueAt)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setNextRunAt("");
      void runRef.current();
    }, Math.max(0, dueAt - Date.now()));
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isDesktopApp, nextRunAt, scheduleEnabled, setNextRunAt]);

  useEffect(() => {
    if (scheduleEnabled) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (nextRunAt) setNextRunAt("");
  }, [nextRunAt, scheduleEnabled, setNextRunAt]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const CheckRow = ({ id, checked, onCheckedChange, children }: {
    id: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div className="flex items-center gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={value => onCheckedChange(value === true)} />
      <label htmlFor={id} className="text-sm">{children}</label>
    </div>
  );

  return (
    <div className="h-full min-h-[300px] w-full flex items-start justify-center pt-8">
      <div className="flex items-center gap-3" role="group" aria-label="Google Chrome controls">
        <Button
          variant="ghost"
          size="icon"
          className="h-14 w-14"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="h-6 w-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`h-14 w-14 text-green-600 ${running ? "opacity-40" : ""}`}
          onClick={() => void run()}
          disabled={running || !isDesktopApp}
          title={isDesktopApp ? "Play" : "Open the Aura Farming desktop app to launch Google Chrome"}
          aria-label="Play"
          aria-pressed={running}
        >
          <Play className="h-6 w-6" fill="currentColor" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`h-14 w-14 text-red-600 ${running ? "" : "opacity-40"}`}
          onClick={() => void stop()}
          disabled={!running && !nextRunAt}
          title="Stop"
          aria-label="Stop"
          aria-pressed={running || !!nextRunAt}
        >
          <Square className="h-5 w-5" fill="currentColor" />
        </Button>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Google Chrome settings
              </DialogTitle>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto space-y-5 pr-1">
            <section className="space-y-4">
              <h3 className="text-sm font-semibold">Send DMs</h3>
              <CheckRow id="chrome-dm-url-enabled" checked={urlEnabled} onCheckedChange={setUrlEnabled}>
                Use this page URL
              </CheckRow>
              <Input
                type="url"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="https://www.facebook.com/…"
                disabled={!urlEnabled}
                aria-label="Page URL"
              />
              <CheckRow id="chrome-dm-message-enabled" checked={messageEnabled} onCheckedChange={setMessageEnabled}>
                Message to DM
              </CheckRow>
              <Input
                value={message}
                onChange={event => setMessage(event.target.value)}
                placeholder="Message 1!!Message 2"
                disabled={!messageEnabled}
                aria-label="Messages to send"
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm" htmlFor="chrome-dm-delay-min">Minimum delay between messages (seconds)</label>
                  <Input id="chrome-dm-delay-min" type="number" min="0" step="any" value={delayMin} onChange={event => setDelayMin(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm" htmlFor="chrome-dm-delay-max">Maximum delay between messages (seconds)</label>
                  <Input id="chrome-dm-delay-max" type="number" min="0" step="any" value={delayMax} onChange={event => setDelayMax(event.target.value)} />
                </div>
              </div>
              <CheckRow id="chrome-dm-amount-enabled" checked={amountEnabled} onCheckedChange={setAmountEnabled}>
                Limit messages per run
              </CheckRow>
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" min="1" value={amountMin} onChange={event => setAmountMin(event.target.value)} disabled={!amountEnabled} placeholder="Minimum" aria-label="Minimum messages per run" />
                <Input type="number" min="1" value={amountMax} onChange={event => setAmountMax(event.target.value)} disabled={!amountEnabled} placeholder="Maximum" aria-label="Maximum messages per run" />
              </div>
              <CheckRow id="chrome-dm-skip-existing" checked={skipAlreadyMessaged} onCheckedChange={setSkipAlreadyMessaged}>
                Skip already messaged users
              </CheckRow>
              <CheckRow id="chrome-dm-continue" checked={continueWhereLeftOff} onCheckedChange={setContinueWhereLeftOff}>
                Continue where I left off
              </CheckRow>
              <CheckRow id="chrome-dm-girls-only" checked={girlsOnly} onCheckedChange={setGirlsOnly}>
                Girls Only
              </CheckRow>
              <CheckRow id="chrome-dm-stop-limits" checked={stopLimitsEnabled} onCheckedChange={setStopLimitsEnabled}>
                Stop after a time or user limit
              </CheckRow>
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" min="1" value={stopMinutes} onChange={event => setStopMinutes(event.target.value)} disabled={!stopLimitsEnabled} placeholder="Minutes" aria-label="Stop after minutes" />
                <Input type="number" min="1" value={maxUsers} onChange={event => setMaxUsers(event.target.value)} disabled={!stopLimitsEnabled} placeholder="Maximum users" aria-label="Maximum users" />
              </div>
              <CheckRow id="chrome-dm-schedule-enabled" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled}>
                Schedule repeated runs
              </CheckRow>
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" min="1" value={intervalMin} onChange={event => setIntervalMin(event.target.value)} disabled={!scheduleEnabled} placeholder="Minimum minutes" aria-label="Minimum minutes between runs" />
                <Input type="number" min="1" value={intervalMax} onChange={event => setIntervalMax(event.target.value)} disabled={!scheduleEnabled} placeholder="Maximum minutes" aria-label="Maximum minutes between runs" />
              </div>
            </section>
            {!isDesktopApp && (
              <p className="text-xs text-muted-foreground">
                The web preview cannot open a browser on your computer. Use the Aura Farming desktop app to run Google Chrome.
              </p>
            )}
          </div>
          <div className="flex justify-end border-t pt-3 shrink-0">
            <Button onClick={() => setSettingsOpen(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
