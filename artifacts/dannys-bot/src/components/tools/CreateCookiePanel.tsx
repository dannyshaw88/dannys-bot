import { useState, useCallback, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUpdateProfile, useProfiles } from "@/hooks/use-profiles";
import { queryClient } from "@/lib/queryClient";
import { CopySettingsDialog } from "@/components/tools/CopySettingsDialog";
import { Loader2, CheckCircle2, Globe, Link2, Clock, Shuffle, BarChart2, ExternalLink, RefreshCw, ChevronLeft } from "lucide-react";
import type { Profile } from "@shared/schema";

interface CookieBakerSettings {
  enabled: boolean;
  execIntervalMin: number;
  execIntervalMax: number;
  sitesMin: number;
  sitesMax: number;
  scrollDelayMin: number;
  scrollDelayMax: number;
  internalLinksMin: number;
  internalLinksMax: number;
  internalScrollDelayMin: number;
  internalScrollDelayMax: number;
  visitRandom: boolean;
  sites: string;
}

interface CookieBakerVisit {
  url: string;
  scrollTimeSec: number;
  linksVisited: string[];
}

interface CookieBakerSessionActivity {
  sessionAt: number;
  sites: CookieBakerVisit[];
}

const DEFAULTS: CookieBakerSettings = {
  enabled: false,
  execIntervalMin: 60,
  execIntervalMax: 120,
  sitesMin: 3,
  sitesMax: 5,
  scrollDelayMin: 5,
  scrollDelayMax: 15,
  internalLinksMin: 1,
  internalLinksMax: 3,
  internalScrollDelayMin: 3,
  internalScrollDelayMax: 10,
  visitRandom: true,
  sites: "",
};

const COPY_GROUPS = [
  {
    label: "Cookie Baker",
    options: [
      {
        key: "cookieBakerAll",
        label: "All Settings",
        description: "Copy all cookie baker settings to target accounts",
        subOptions: [
          { key: "cb_enabled",  label: "Start / Stop",                settingKeys: ["enabled"] },
          { key: "cb_interval", label: "Execute interval (min / max)", settingKeys: ["execIntervalMin", "execIntervalMax"] },
          { key: "cb_sites",    label: "Sites per session (min / max)", settingKeys: ["sitesMin", "sitesMax"] },
          { key: "cb_scroll",   label: "Scroll delay (min / max secs)", settingKeys: ["scrollDelayMin", "scrollDelayMax"] },
          { key: "cb_links",    label: "Internal links (min / max)",    settingKeys: ["internalLinksMin", "internalLinksMax"] },
          { key: "cb_iscroll",  label: "Internal scroll delay (min / max secs)", settingKeys: ["internalScrollDelayMin", "internalScrollDelayMax"] },
          { key: "cb_random",   label: "Visit websites at random",      settingKeys: ["visitRandom"] },
          { key: "cb_siteList", label: "Website list",                  settingKeys: ["sites"] },
        ],
      },
    ],
  },
];

interface Props {
  profile: Profile;
}

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatSessionDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace("www.", "") + (u.pathname !== "/" ? u.pathname.slice(0, 30) + (u.pathname.length > 30 ? "…" : "") : "");
  } catch {
    return url.slice(0, 40);
  }
}

export function CreateCookiePanel({ profile }: Props) {
  const [local, setLocal] = useState<CookieBakerSettings>(() => ({
    ...DEFAULTS,
    ...(((profile as any).cookieBakerSettings as Partial<CookieBakerSettings>) ?? {}),
  }));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [copyOpen, setCopyOpen] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<CookieBakerSessionActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateProfileMutation = useUpdateProfile();
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();

  const otherProfiles = allProfiles.filter((p: Profile) => p.id !== profile.id && !p.locked);
  const hasOtherProfiles = allProfiles.some((p: Profile) => p.id !== profile.id);

  const fetchActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch(`/api/profiles/${profile.id}/cookie-baker/activity`);
      if (res.ok) setActivity(await res.json());
    } catch {}
    setActivityLoading(false);
  }, [profile.id]);

  useEffect(() => {
    if (showActivity) fetchActivity();
  }, [showActivity, fetchActivity]);

  const save = useCallback(
    (next: CookieBakerSettings) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(() => {
        updateProfileMutation.mutate(
          { id: profile.id, cookieBakerSettings: next as any },
          {
            onSuccess: () => {
              setSaveStatus("saved");
              queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id] });
              setTimeout(() => setSaveStatus("idle"), 2000);
            },
            onError: () => setSaveStatus("idle"),
          },
        );
      }, 600);
    },
    [profile.id, updateProfileMutation],
  );

  const update = (patch: Partial<CookieBakerSettings>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    save(next);
  };

  const handleToggleEnabled = (v: boolean) => {
    update({ enabled: v });
    if (v) {
      fetch(`/api/profiles/${profile.id}/cookie-baker/run-now`, { method: "POST" }).catch(() => {});
    }
  };

  const handleCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const patch: Partial<CookieBakerSettings> = {};
    if (expandedKeys.includes("cb_enabled"))  patch.enabled = local.enabled;
    if (expandedKeys.includes("cb_interval")) { patch.execIntervalMin = local.execIntervalMin; patch.execIntervalMax = local.execIntervalMax; }
    if (expandedKeys.includes("cb_sites"))    { patch.sitesMin = local.sitesMin; patch.sitesMax = local.sitesMax; }
    if (expandedKeys.includes("cb_scroll"))   { patch.scrollDelayMin = local.scrollDelayMin; patch.scrollDelayMax = local.scrollDelayMax; }
    if (expandedKeys.includes("cb_links"))    { patch.internalLinksMin = local.internalLinksMin; patch.internalLinksMax = local.internalLinksMax; }
    if (expandedKeys.includes("cb_iscroll"))  { patch.internalScrollDelayMin = local.internalScrollDelayMin; patch.internalScrollDelayMax = local.internalScrollDelayMax; }
    if (expandedKeys.includes("cb_random"))   patch.visitRandom = local.visitRandom;
    if (expandedKeys.includes("cb_siteList")) patch.sites = local.sites;

    if (!Object.keys(patch).length) return;

    await Promise.all(
      targetIds.map((id) =>
        fetch(`/api/profiles/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookieBakerSettings: { ...DEFAULTS, ...patch } }),
        }),
      ),
    );
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    toast({ title: "Settings copied", description: `Applied to ${targetIds.length} account${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const numInput = (val: number, onChange: (v: number) => void, min = 0) => (
    <Input
      type="number"
      min={min}
      value={val}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 w-[72px] text-sm"
    />
  );

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pb-3 border-b border-border">
        <Switch checked={local.enabled} onCheckedChange={handleToggleEnabled} />
        <Label className="text-sm font-semibold">Enable Cookie Baker</Label>
        {!showActivity && (
          <button
            className="text-xs text-blue-500 hover:text-blue-600 hover:underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!hasOtherProfiles}
            onClick={() => setCopyOpen(true)}
          >
            Copy Settings
          </button>
        )}
        <button
          className={`text-xs hover:underline underline-offset-2 cursor-pointer ${showActivity ? "text-primary font-semibold" : "text-blue-500 hover:text-blue-600"}`}
          onClick={() => setShowActivity(!showActivity)}
        >
          {showActivity ? "← Settings" : "Activity"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {!showActivity && saveStatus === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          {!showActivity && saveStatus === "saved"  && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
        </div>
      </div>

      {/* ── Activity View ────────────────────────────────────────────────── */}
      {showActivity && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-muted-foreground">All sessions — most recent first</p>
            <button
              onClick={fetchActivity}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${activityLoading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          {activityLoading && activity.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : activity.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
              <BarChart2 className="w-8 h-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No activity yet</p>
              <p className="text-xs text-muted-foreground/70">Sessions will appear here after the cookie baker runs.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activity.map((session, si) => (
                <div key={si} className="rounded-lg border border-border bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border/60">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs font-semibold text-foreground">
                      {formatSessionDate(session.sessionAt)} — {formatSessionTime(session.sessionAt)}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {session.sites.length} site{session.sites.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="divide-y divide-border/40">
                    {session.sites.map((site, i) => (
                      <div key={i} className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <Globe className="w-3 h-3 text-primary mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-foreground truncate" title={site.url}>
                                {shortUrl(site.url)}
                              </span>
                              <a href={site.url} target="_blank" rel="noreferrer"
                                className="text-muted-foreground hover:text-primary transition-colors shrink-0"
                                title={site.url}>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" /> {site.scrollTimeSec}s scroll
                              </span>
                              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                <Link2 className="w-2.5 h-2.5" /> {site.linksVisited.length} internal link{site.linksVisited.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            {site.linksVisited.length > 0 && (
                              <div className="mt-1.5 space-y-0.5 pl-2 border-l border-border/60">
                                {site.linksVisited.map((link, li) => (
                                  <div key={li} className="flex items-center gap-1.5">
                                    <Link2 className="w-2.5 h-2.5 text-blue-400 shrink-0" />
                                    <span className="text-[10px] text-muted-foreground truncate" title={link}>
                                      {shortUrl(link)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Settings View ────────────────────────────────────────────────── */}
      {!showActivity && (
        <div className="space-y-5">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Clock className="w-3.5 h-3.5 text-primary" /> Execute Every
            </p>
            <div className="flex items-center gap-2">
              {numInput(local.execIntervalMin, (v) => update({ execIntervalMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.execIntervalMax, (v) => update({ execIntervalMax: v }), 1)}
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Globe className="w-3.5 h-3.5 text-primary" /> Process Websites
            </p>
            <div className="flex items-center gap-2">
              {numInput(local.sitesMin, (v) => update({ sitesMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.sitesMax, (v) => update({ sitesMax: v }), 1)}
              <span className="text-xs text-muted-foreground">per session</span>
            </div>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Clock className="w-3.5 h-3.5 text-violet-500" /> Scrolling Time
            </p>
            <div className="flex items-center gap-2">
              {numInput(local.scrollDelayMin, (v) => update({ scrollDelayMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.scrollDelayMax, (v) => update({ scrollDelayMax: v }), 1)}
              <span className="text-xs text-muted-foreground">secs per site</span>
            </div>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Link2 className="w-3.5 h-3.5 text-blue-500" /> Visit Internal Links
            </p>
            <div className="flex items-center gap-2">
              {numInput(local.internalLinksMin, (v) => update({ internalLinksMin: v }), 0)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.internalLinksMax, (v) => update({ internalLinksMax: v }), 0)}
              <span className="text-xs text-muted-foreground">per site</span>
            </div>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Clock className="w-3.5 h-3.5 text-emerald-500" /> Scrolling Time (internal)
            </p>
            <div className="flex items-center gap-2">
              {numInput(local.internalScrollDelayMin, (v) => update({ internalScrollDelayMin: v }), 1)}
              <span className="text-xs text-muted-foreground">–</span>
              {numInput(local.internalScrollDelayMax, (v) => update({ internalScrollDelayMax: v }), 1)}
              <span className="text-xs text-muted-foreground">secs per link</span>
            </div>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Shuffle className="w-3.5 h-3.5 text-orange-500" /> Order
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={local.visitRandom}
                onCheckedChange={(v) => update({ visitRandom: !!v })}
              />
              <span className="text-sm">Visit websites at random</span>
            </label>
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-medium mb-2">
              <Globe className="w-3.5 h-3.5 text-primary" /> Websites
            </p>
            <div className="space-y-2">
              <Textarea
                placeholder={"www.example.com\nwww.bbc.co.uk\nhttps://news.ycombinator.com"}
                value={local.sites}
                onChange={(e) => update({ sites: e.target.value })}
                className="font-mono text-xs min-h-[140px] resize-y"
              />
              <p className="text-xs text-muted-foreground">
                One website per line — www.example.com format. Include https:// if needed, otherwise https is assumed.
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-muted/40 border border-border/50 p-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">How it works:</strong> When enabled, a hidden background browser visits these websites using this account's proxy and user agent, building up real browsing cookies. Open the Embedded Browser while it's running to see it in action. If the EB isn't open, it runs silently in the background.
          </div>
        </div>
      )}

      <CopySettingsDialog
        key={copyOpen ? "open" : "closed"}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title="Copy Cookie Baker Settings"
        profiles={otherProfiles}
        optionGroups={COPY_GROUPS}
        onCopy={handleCopy}
      />
    </div>
  );
}
