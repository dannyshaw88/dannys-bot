import { useState, useEffect, useRef } from "react";
import { useUpdateTool } from "@/hooks/use-tools";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MessageSquare, UserCheck, Clock, Users, Zap, Shuffle, Loader2, Download } from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";

interface Props {
  tool: Tool;
  profile: Profile;
  embedded?: boolean;
}

function applySpintax(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_, group) => {
    const parts = group.split("|");
    return parts[Math.floor(Math.random() * parts.length)];
  });
}

export function ContactNewFollowersPanel({ tool, profile, embedded }: Props) {
  const updateToolMutation = useUpdateTool();
  const queryClient = useQueryClient();
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const [previewText, setPreviewText] = useState("");
  const [extractResult, setExtractResult] = useState<{ queued: number } | null>(null);


  const extractNowMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/profiles/${profile.id}/tools/contact/extract-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: settings.contactExtractCount ?? 20 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error ?? "Extract failed");
      }
      return res.json() as Promise<{ ok: boolean; queued: number }>;
    },
    onSuccess: (data) => {
      setExtractResult({ queued: data.queued });
      queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] });
    },
    onError: (e: Error) => {
      setExtractResult({ queued: 0 });
    },
  });

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      contactNewFollowersEnabled: true,
      contactOnlyAppFollowed: true,
      contactMessage: "",
      contactCheckIntervalMin: 30,
      contactCheckIntervalMax: 60,
      contactUsersPerCheckMin: 1,
      contactUsersPerCheckMax: 20,
      contactApiSource: "account",
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<typeof settings | null>(null);

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    pendingSettings.current = settings;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      pendingSettings.current = null;
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [settings]);

  // Flush any unsaved changes immediately when the component unmounts (tab switch).
  // Uses keepalive so the request completes even after the component is gone.
  useEffect(() => {
    return () => {
      if (pendingSettings.current) {
        fetch(`/api/tools/${tool.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: tool.profileId, settings: pendingSettings.current }),
          keepalive: true,
        });
        pendingSettings.current = null;
      }
    };
  }, []);

  const numInput = (key: string, min: number, max: number, width = "w-20") => (
    <Input
      type="number"
      min={min}
      max={max}
      className={`${width} h-7 text-xs`}
      value={settings[key] ?? min}
      onChange={(e) => setSettings({ ...settings, [key]: Math.max(min, Math.min(max, Number(e.target.value))) })}
    />
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-300">

      {/* Enable toggle */}
      <div className="flex items-center gap-3 px-1">
        <input
          type="checkbox"
          id="contactNewFollowersEnabled"
          checked={!!settings.contactNewFollowersEnabled}
          onChange={(e) => setSettings({ ...settings, contactNewFollowersEnabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
        />
        <div>
          <label htmlFor="contactNewFollowersEnabled" className="text-sm font-semibold cursor-pointer select-none">Contact New Followers</label>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-muted-foreground">Automatically queue DMs for new followers of this account.</p>
            {!embedded && (() => {
              if (!settings.contactNewFollowersEnabled) return null;
              const nextAt = engineStatus?.nextContactAt ?? 0;
              if (!nextAt) return null;
              const executing = nextAt <= Date.now();
              const label = executing ? null : format(new Date(nextAt), "d MMM, HH:mm:ss");
              return (
                <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
                  <Clock className="w-3 h-3 shrink-0" />
                  {executing
                    ? <span>Executing</span>
                    : <span>Scheduled for: <span className="text-foreground">{label}</span></span>}
                </span>
              );
            })()}
            {settings.contactNewFollowersEnabled && (() => {
              const avgInterval = ((settings.contactCheckIntervalMin ?? 30) + (settings.contactCheckIntervalMax ?? 60)) / 2;
              const avgPerCheck = ((settings.contactUsersPerCheckMin ?? 1) + (settings.contactUsersPerCheckMax ?? 20)) / 2;
              const perHour = avgInterval > 0 ? Math.round((avgPerCheck / avgInterval) * 60) : 0;
              const perDay = perHour * 24;
              return perHour > 0 ? (
                <span className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
                  ~{perHour}/hr · ~{perDay}/day
                </span>
              ) : null;
            })()}
          </div>
        </div>
      </div>

      <div className={settings.contactNewFollowersEnabled ? "space-y-4" : "hidden"}><div className="border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-500" />
          <h4 className="font-semibold text-sm">Settings</h4>
        </div>

        {/* Only app-followed users */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="contactOnlyAppFollowed"
            checked={!!settings.contactOnlyAppFollowed}
            onChange={(e) => setSettings({ ...settings, contactOnlyAppFollowed: e.target.checked })}
            className="w-3.5 h-3.5 mt-0.5 accent-primary cursor-pointer shrink-0"
          />
          <div>
            <label htmlFor="contactOnlyAppFollowed" className="text-sm font-medium cursor-pointer select-none flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-green-600" />
              Only followers who were followed through the app
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Restricts the queue to followers who also appear in the Follow Tool's Followed Users list for this profile.
            </p>
          </div>
        </div>

        {/* Message with SpinTax */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Message</Label>
            <button
              onClick={() => setPreviewText(applySpintax(settings.contactMessage ?? ""))}
              className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors"
            >
              <Shuffle className="w-3 h-3" />
              Preview spin
            </button>
          </div>
          <textarea
            rows={4}
            className="w-full text-sm border border-border rounded-lg p-3 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            placeholder={`{Hi|Hello|Hey} {there|friend}! Thanks for following check out our latest posts 🙌`}
            value={settings.contactMessage ?? ""}
            onChange={(e) => {
              setSettings({ ...settings, contactMessage: e.target.value });
              setPreviewText("");
            }}
          />
          {!(settings.contactMessage ?? "").trim() && (
            <p className="text-[11px] text-destructive font-medium">
              A message is required before Extract Now will find new followers.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Use <code className="bg-muted px-1 rounded">{"{Hi|Hello|Hey}"}</code> syntax to randomly pick one option. Click "Preview spin" to see a sample.
          </p>
          {previewText && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-800">
              <span className="font-semibold text-[11px] text-blue-500 uppercase tracking-wider block mb-0.5">Preview</span>
              {previewText}
            </div>
          )}
        </div>

        {/* Check interval + users per check */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Check Every (min)</span>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Min</Label>
                {numInput("contactCheckIntervalMin", 1, 10000)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Max</Label>
                {numInput("contactCheckIntervalMax", 1, 10000)}
              </div>
            </div>
            <div className="w-px self-stretch bg-border/50 hidden sm:block" />
            <div className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">New Followers to Check</span>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Min</Label>
                {numInput("contactUsersPerCheckMin", 1, 100)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Max</Label>
                {numInput("contactUsersPerCheckMax", 1, 100)}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Each GetFollowers API call returns up to 20 users. Values above 20 will trigger multiple calls.
          </p>
        </div>

        {/* API Source */}
        <div className="space-y-1">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 shrink-0">
              <Zap className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">GetFollowers API Source</span>
            </div>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="contactApiSource"
                  value="account"
                  checked={settings.contactApiSource === "account"}
                  onChange={() => setSettings({ ...settings, contactApiSource: "account" })}
                  className="accent-primary"
                />
                <span className="text-sm">Account itself</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="contactApiSource"
                  value="hiker"
                  checked={settings.contactApiSource === "hiker"}
                  onChange={() => setSettings({ ...settings, contactApiSource: "hiker" })}
                  className="accent-primary"
                />
                <span className="text-sm">HikerAPI</span>
              </label>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            HikerAPI requires a valid token in the global Settings page.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 text-primary border-primary/40 hover:bg-primary/5"
          disabled={extractNowMutation.isPending}
          onClick={() => { setExtractResult(null); extractNowMutation.mutate(); }}
        >
          {extractNowMutation.isPending
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting…</>
            : <><Download className="w-3.5 h-3.5" /> Extract Now</>
          }
        </Button>
        <Input
          type="number"
          min={1}
          max={10000}
          className="w-20 h-8 text-xs"
          value={settings.contactExtractCount ?? 20}
          onChange={(e) => setSettings({ ...settings, contactExtractCount: Math.max(1, Number(e.target.value)) })}
        />
        <div className="text-[11px] text-muted-foreground leading-snug">
          Fetches this many recent followers now and adds any new ones to the <strong>Pending Messages</strong> queue.
          {extractResult !== null && (
            <span className={`ml-2 font-medium ${extractResult.queued > 0 ? "text-green-600" : "text-muted-foreground"}`}>
              {extractResult.queued > 0
                ? `↳ ${extractResult.queued} user${extractResult.queued !== 1 ? "s" : ""} queued`
                : "↳ No new users found"}
            </span>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
