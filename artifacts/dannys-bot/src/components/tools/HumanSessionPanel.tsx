import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Bell, User, RefreshCw, Settings, PlaySquare, BookOpen,
  MessageSquare, Repeat2, AtSign, Clock, ExternalLink, Image as ImageIcon,
  ChevronDown, ChevronUp, Heart, Copy, FolderOpen,
} from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile, type RepostedPost, type SessionAction } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { useToast } from "@/hooks/use-toast";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { ImageSettingsDialog } from "@/components/tools/ImageSettingsDialog";

interface HumanSessionPanelProps {
  tool: Tool;
  profile: Profile;
}

export function HumanSessionPanel({ tool, profile }: HumanSessionPanelProps) {
  const updateToolMutation = useUpdateTool();
  const { navigateTo } = useBrowserWindows();
  const { toast } = useToast();
  const [showReposted, setShowReposted] = useState(false);
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false);
  const [spinPreview, setSpinPreview] = useState<string | null>(null);
  const [spinSyntaxMsg, setSpinSyntaxMsg] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [repostingNow, setRepostingNow] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId && !p.locked);
  const hasOtherProfiles = allProfiles.some(p => p.id !== tool.profileId);

  const HUMAN_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "General", options: [
      { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
      { key: "randomiseTiming", label: "Randomise timing", description: "Spread each account's session start times across the session delay window so they don't all fire simultaneously" },
    ]},
    { label: "Timing", options: [
      { key: "humanToolsDelay", label: "Human Tools Delay", description: "Interval between human session runs", subOptions: [
        { key: "hs_delayRange", label: "Session delay range (min / max)", settingKeys: ["delayMin","delayMax"] },
      ]},
    ]},
    { label: "Actions", options: [
      { key: "viewTimelineFeed", label: "View Timeline Feed", description: "Scrolling through the main feed + inline liking", subOptions: [
        { key: "vtf_enabled",    label: "Enabled",                                       settingKeys: ["viewTimelineFeedEnabled"] },
        { key: "vtf_count",      label: "Posts per session (min / max)",                 settingKeys: ["viewTimelineFeedMin","viewTimelineFeedMax"] },
        { key: "vtf_order",      label: "Execution order (min / max)",                   settingKeys: ["viewTimelineFeedOrderMin","viewTimelineFeedOrderMax"] },
        { key: "vtf_chance",     label: "Skip chance % (0=always run, 100=never)",       settingKeys: ["viewTimelineFeedNotUsedMin","viewTimelineFeedNotUsedMax"] },
        { key: "vtf_like_pct",   label: "% posts to like (min / max)",                  settingKeys: ["likeTimelinePostsPercentMin","likeTimelinePostsPercentMax"] },
        { key: "vtf_like_delay", label: "Delay between likes in sec (min / max)",        settingKeys: ["likeTimelinePostsDelayMin","likeTimelinePostsDelayMax"] },
        { key: "vtf_save_media", label: "Save liked media (enabled + %)",                settingKeys: ["saveMediaEnabled","saveMediaPercent"] },
      ]},
      { key: "humanSession", label: "Human Session (Visit Profile)", description: "Core session order and cool-down", subOptions: [
        { key: "hs_enabled", label: "Enabled",                            settingKeys: ["humanSessionEnabled"] },
        { key: "hs_order",   label: "Execution order (min / max)",        settingKeys: ["humanSessionOrderMin","humanSessionOrderMax"] },
        { key: "hs_chance",  label: "Skip chance % (0=always run, 100=never)", settingKeys: ["humanSessionNotUsedMin","humanSessionNotUsedMax"] },
      ]},
      { key: "checkReels", label: "Check Timeline Reels", description: "View reels while active", subOptions: [
        { key: "cr_enabled", label: "Enabled",                            settingKeys: ["checkTimelineReelsEnabled"] },
        { key: "cr_count",   label: "Reels per session (min / max)",      settingKeys: ["checkTimelineReelsMin","checkTimelineReelsMax"] },
        { key: "cr_order",   label: "Execution order (min / max)",        settingKeys: ["checkTimelineReelsOrderMin","checkTimelineReelsOrderMax"] },
        { key: "cr_chance",  label: "Skip chance % (0=always run, 100=never)", settingKeys: ["checkTimelineReelsNotUsedMin","checkTimelineReelsNotUsedMax"] },
      ]},
      { key: "checkStories", label: "Check Timeline Stories", description: "Watch stories while active", subOptions: [
        { key: "cs_enabled", label: "Enabled",                            settingKeys: ["checkTimelineStoriesEnabled"] },
        { key: "cs_count",   label: "Stories per session (min / max)",    settingKeys: ["checkTimelineStoriesMin","checkTimelineStoriesMax"] },
        { key: "cs_order",   label: "Execution order (min / max)",        settingKeys: ["checkTimelineStoriesOrderMin","checkTimelineStoriesOrderMax"] },
        { key: "cs_chance",  label: "Skip chance % (0=always run, 100=never)", settingKeys: ["checkTimelineStoriesNotUsedMin","checkTimelineStoriesNotUsedMax"] },
      ]},
      { key: "checkDm", label: "Check DMs", description: "Read direct messages", subOptions: [
        { key: "dm_enabled", label: "Enabled",                            settingKeys: ["checkDmEnabled"] },
        { key: "dm_count",   label: "DMs per session (min / max)",        settingKeys: ["checkDmMin","checkDmMax"] },
        { key: "dm_order",   label: "Execution order (min / max)",        settingKeys: ["checkDmOrderMin","checkDmOrderMax"] },
        { key: "dm_chance",  label: "Skip chance % (0=always run, 100=never)", settingKeys: ["checkDmNotUsedMin","checkDmNotUsedMax"] },
      ]},
      { key: "repost", label: "Repost", description: "Repost settings for source account, alteration, caption and stop conditions", subOptions: [
        { key: "rp_enabled",    label: "Enabled",                           settingKeys: ["repostEnabled"] },
        { key: "rp_source",     label: "Source account",                    settingKeys: ["repostSourceUsername"] },
        { key: "rp_count",      label: "Posts per session (min / max)",     settingKeys: ["repostMin","repostMax"] },
        { key: "rp_alteration", label: "Alteration & image settings",       settingKeys: ["repostAlterationLevel","repostImageSettings"] },
        { key: "rp_caption",    label: "Caption text",                      settingKeys: ["repostCaptionText"] },
        { key: "rp_comments",   label: "Disable comments",                  settingKeys: ["repostDisableComments"] },
        { key: "rp_order",      label: "Execution order (min / max)",       settingKeys: ["repostOrderMin","repostOrderMax"] },
        { key: "rp_chance",     label: "Skip chance % (0=always run, 100=never)", settingKeys: ["repostNotUsedMin","repostNotUsedMax"] },
        { key: "rp_stop",       label: "Stop conditions",                   settingKeys: ["repostDisableAtPostCount","repostDisableWhenExhausted"] },
      ]},
    ]},
  ];

  const handleHumanCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled = expandedKeys.includes("startStop");
    const keysToSend  = expandedKeys.filter(k => k !== "startStop");
    const willEnable    = copyEnabled && tool.enabled;
    const willRandomise = expandedKeys.includes("randomiseTiming") && willEnable;
    let staggerOffsets: number[] | undefined;
    if (willRandomise && targetIds.length > 1) {
      const delayMax = (settings as any).delayMax ?? 60;
      staggerOffsets = targetIds.map((_, i) =>
        Math.round((i * delayMax) / Math.max(1, targetIds.length - 1))
      );
    }
    await copyToolSettingsToProfiles(settings as Record<string,unknown>, tool.type, targetIds, keysToSend, copyEnabled ? tool.enabled : undefined, staggerOffsets);
    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const { data: repostedPostsList, isLoading: repostedPostsLoading } = useQuery<RepostedPost[]>({
    queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`],
    refetchInterval: 15000,
  });

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      randomiseTiming: false,
      delayMin: 30,
      delayMax: 60,
      viewTimelineFeedEnabled: false,
      viewTimelineFeedMin: 3,
      viewTimelineFeedMax: 8,
      viewTimelineFeedOrderMin: 5,
      viewTimelineFeedOrderMax: 10,
      viewTimelineFeedNotUsedMin: 0,
      viewTimelineFeedNotUsedMax: 0,
      humanSessionEnabled: false,
      humanSessionOrderMin: 0,
      humanSessionOrderMax: 0,
      humanSessionNotUsedMin: 0,
      humanSessionNotUsedMax: 0,
      checkTimelineReelsEnabled: false,
      checkTimelineReelsMin: 3,
      checkTimelineReelsMax: 8,
      checkTimelineReelsOrderMin: 0,
      checkTimelineReelsOrderMax: 0,
      checkTimelineReelsNotUsedMin: 0,
      checkTimelineReelsNotUsedMax: 0,
      checkTimelineStoriesEnabled: false,
      checkTimelineStoriesMin: 3,
      checkTimelineStoriesMax: 8,
      checkTimelineStoriesOrderMin: 0,
      checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0,
      checkTimelineStoriesNotUsedMax: 0,
      checkDmEnabled: false,
      checkDmMin: 5,
      checkDmMax: 15,
      checkDmOrderMin: 0,
      checkDmOrderMax: 0,
      checkDmNotUsedMin: 0,
      checkDmNotUsedMax: 0,
      likeTimelinePostsEnabled: false,
      likeTimelinePostsMin: 2,
      likeTimelinePostsMax: 5,
      likeTimelinePostsDelayMin: 3,
      likeTimelinePostsDelayMax: 8,
      likeTimelinePostsOrderMin: 0,
      likeTimelinePostsOrderMax: 0,
      likeTimelinePostsNotUsedMin: 0,
      likeTimelinePostsNotUsedMax: 0,
      saveMediaEnabled: false,
      saveMediaPercent: 20,
      likeTimelinePostsPercentMin: 0,
      likeTimelinePostsPercentMax: 0,
      repostEnabled: false,
      repostUseHikerApi: false,
      repostSourceUsername: "",
      repostDisableUsernameSource: false,
      repostLocalFolderEnabled: false,
      repostLocalFolderPath: "",
      repostLocalFolderDeleteAfterUpload: true,
      repostAlterationLevel: "small",
      repostCaptionText: "",
      repostImageSettings: {
        contrast:   { enabled: true, min: 5,   max: 250 },
        brightness: { enabled: true, min: 5,   max: 250 },
        noise:      { enabled: true, min: 5,   max: 15  },
        sharpen:    { enabled: true, min: 1.0, max: 2.0 },
        pixelate:   { enabled: true, min: 0.9, max: 2.1 },
      },
      repostOrderMin: 0,
      repostOrderMax: 0,
      repostNotUsedMin: 0,
      repostNotUsedMax: 0,
      repostDisableComments: false,
      repostDisableAtPostCount: 0,
      repostDisableWhenExhausted: true,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localFolderPickerRef = useRef<HTMLInputElement>(null);
  const [localFolderFileCount, setLocalFolderFileCount] = useState<number | null>(null);

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [settings]);

  const DEFAULT_IMG_SETTINGS = {
    contrast:   { enabled: true, min: 5,   max: 250 },
    brightness: { enabled: true, min: 5,   max: 250 },
    noise:      { enabled: true, min: 5,   max: 15  },
    sharpen:    { enabled: true, min: 1.0, max: 2.0 },
    pixelate:   { enabled: true, min: 0.9, max: 2.1 },
  };
  const imgSettings: typeof DEFAULT_IMG_SETTINGS = (settings as any).repostImageSettings ?? DEFAULT_IMG_SETTINGS;
  const setImgFilter = (key: string, val: unknown) =>
    setSettings({ ...settings, repostImageSettings: { ...imgSettings, [key]: val } } as any);

  const IMG_FILTER_DEFS = [
    { key: "contrast",   label: "Contrast",        step: 1,   isInt: true  },
    { key: "brightness", label: "Brightness",       step: 1,   isInt: true  },
    { key: "noise",      label: "Noise",            step: 1,   isInt: true  },
    { key: "sharpen",    label: "Sharpen Effect",   step: 0.1, isInt: false },
    { key: "pixelate",   label: "Pixelate Effect",  step: 0.1, isInt: false },
  ] as const;

  const pctInputs = (minKey: string, maxKey: string) => (
    <>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Min</Label>
        <div className="relative">
          <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
            value={settings[minKey] ?? 0}
            onChange={(e) => setSettings({ ...settings, [minKey]: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">Max</Label>
        <div className="relative">
          <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
            value={settings[maxKey] ?? 0}
            onChange={(e) => setSettings({ ...settings, [maxKey]: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
        </div>
      </div>
    </>
  );

  const { data: sessionActions } = useQuery<SessionAction[]>({
    queryKey: [`/api/profiles/${tool.profileId}/session-actions`],
    refetchInterval: 15000,
  });
  const lastAction = sessionActions?.find(a => a.toolId === tool.id);
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const nextRunStatus: { label: string; executing: boolean } | null = (() => {
    if (!tool.enabled) return null;
    if (!lastAction && !(engineStatus?.nextHumanSessionAt)) return null;
    const nextAt = engineStatus?.nextHumanSessionAt ?? 0;
    if (!nextAt || nextAt <= Date.now()) return { label: "Executing", executing: true };
    return { label: format(new Date(nextAt), "HH:mm:ss"), executing: false };
  })();

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* ── Master enable/disable ─────────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-2">
        <h4 className="font-semibold text-sm">Human Session Tool</h4>
        <div className="flex items-center gap-3 flex-wrap">
          <Switch
            checked={tool.enabled}
            onCheckedChange={(enabled) => updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled })}
            disabled={updateToolMutation.isPending}
          />
          <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
            {tool.enabled ? 'ACTIVE' : 'STOPPED'}
          </span>
          <button
            onClick={() => setCopyOpen(true)}
            className="ml-1 text-xs text-blue-500 hover:text-blue-600 hover:underline underline-offset-2 cursor-pointer"
          >
            COPY SETTINGS
          </button>
          {nextRunStatus && (
            <span className="flex items-center gap-1 text-[11px] font-bold ml-2" style={{ color: nextRunStatus.executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
              <Clock className="w-3 h-3 shrink-0" />
              {nextRunStatus.executing
                ? <span>Executing</span>
                : <span>Scheduled for: <span className="text-foreground">{nextRunStatus.label}</span></span>
              }
            </span>
          )}
        </div>
      </div>

      {/* ── Timer ─────────────────────────────────────────────── */}
      <div className="border border-border rounded-xl p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <h4 className="font-semibold text-sm">Execute Every (min)</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">How often the actions below run.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="10000" className="w-16 h-7 text-xs"
                value={settings.delayMin ?? 30}
                onChange={(e) => setSettings({ ...settings, delayMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="10000" className="w-16 h-7 text-xs"
                value={settings.delayMax ?? 60}
                onChange={(e) => setSettings({ ...settings, delayMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── View Timeline Feed ─────────────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <input type="checkbox" id="viewTimelineFeedEnabled"
              checked={!!settings.viewTimelineFeedEnabled}
              onChange={(e) => setSettings({ ...settings, viewTimelineFeedEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="viewTimelineFeedEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
              <ImageIcon className="w-4 h-4 text-blue-500 shrink-0" />
              View Timeline Feed
            </label>
            <div className={`flex items-center gap-3 flex-wrap transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts</span>
                <Label className="text-xs text-muted-foreground">Min</Label>
                <Input type="number" min="1" max="100" className="w-14 h-7 text-xs"
                  value={settings.viewTimelineFeedMin ?? 3}
                  onChange={(e) => setSettings({ ...settings, viewTimelineFeedMin: Math.max(1, Number(e.target.value)) })}
                />
                <Label className="text-xs text-muted-foreground">Max</Label>
                <Input type="number" min="1" max="100" className="w-14 h-7 text-xs"
                  value={settings.viewTimelineFeedMax ?? 8}
                  onChange={(e) => setSettings({ ...settings, viewTimelineFeedMax: Math.max(1, Number(e.target.value)) })}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5 text-pink-500 shrink-0" />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                {pctInputs("likeTimelinePostsPercentMin", "likeTimelinePostsPercentMax")}
              </div>
            </div>
          </div>
          <div className={`flex flex-col items-end gap-1.5 shrink-0 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("viewTimelineFeedOrderMin", "viewTimelineFeedOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("viewTimelineFeedNotUsedMin", "viewTimelineFeedNotUsedMax")}
            </div>
          </div>
        </div>
        {/* Like delay + save media — only shown when like % is configured */}
        {!!(settings.viewTimelineFeedEnabled && (settings.likeTimelinePostsPercentMax ?? 0) > 0) && (
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like Delay</span>
              <Label className="text-xs text-muted-foreground">Min</Label>
              <div className="relative">
                <Input type="number" min="0" max="300" className="w-14 h-7 text-xs pr-4"
                  value={settings.likeTimelinePostsDelayMin ?? 3}
                  onChange={(e) => setSettings({ ...settings, likeTimelinePostsDelayMin: Math.max(0, Number(e.target.value)) })}
                />
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">s</span>
              </div>
              <Label className="text-xs text-muted-foreground">Max</Label>
              <div className="relative">
                <Input type="number" min="0" max="300" className="w-14 h-7 text-xs pr-4"
                  value={settings.likeTimelinePostsDelayMax ?? 8}
                  onChange={(e) => setSettings({ ...settings, likeTimelinePostsDelayMax: Math.max(0, Number(e.target.value)) })}
                />
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">s</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Save Liked</span>
              <input type="checkbox" id="saveMediaEnabled"
                checked={!!settings.saveMediaEnabled}
                onChange={(e) => setSettings({ ...settings, saveMediaEnabled: e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <div className={`flex items-center gap-2 transition-opacity ${!settings.saveMediaEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="relative">
                  <Input type="number" min={1} max={100} className="w-14 h-7 text-xs pr-5"
                    value={settings.saveMediaPercent ?? 20}
                    onChange={(e) => setSettings({ ...settings, saveMediaPercent: Math.min(100, Math.max(1, Number(e.target.value))) })}
                  />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                </div>
                <Label className="text-xs text-muted-foreground">of liked saved</Label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Human Session (Notifications / Own Profile / etc.) ─── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2 pt-0.5">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="humanSessionEnabled"
                checked={!!settings.humanSessionEnabled}
                onChange={(e) => setSettings({ ...settings, humanSessionEnabled: e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <label htmlFor="humanSessionEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                <User className="w-4 h-4 text-violet-500" />
                Human Session
              </label>
            </div>
            <div className={`flex items-center gap-1.5 flex-wrap transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-orange-50 border border-orange-200 text-orange-600 font-medium"><Bell className="w-3 h-3" />Notifications</span>
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-600 font-medium"><User className="w-3 h-3" />Own Profile</span>
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-cyan-50 border border-cyan-200 text-cyan-600 font-medium"><RefreshCw className="w-3 h-3" />Refresh Profile</span>
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-gray-50 border border-gray-200 text-gray-600 font-medium"><Settings className="w-3 h-3" />Settings & Activity</span>
            </div>
          </div>
          <div className={`flex flex-col items-end gap-1.5 shrink-0 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("humanSessionOrderMin", "humanSessionOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("humanSessionNotUsedMin", "humanSessionNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40' : ''}`}>
          Runs all four sub-actions in a random order each session: visits the notification inbox, browses the account's own profile, pull-to-refreshes it, and opens Settings &amp; Activity.
        </p>
      </div>

      {/* ── Check Reels · Stories · DMs — one row each ─────────── */}
      <div className="border border-border rounded-xl p-4 space-y-2">

        {/* Check Reels from Timeline */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <input type="checkbox" id="checkTimelineReelsEnabled"
              checked={!!settings.checkTimelineReelsEnabled}
              onChange={(e) => setSettings({ ...settings, checkTimelineReelsEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkTimelineReelsEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
              <PlaySquare className="w-4 h-4 text-rose-500 shrink-0" />
              Check Reels from Timeline
            </label>
            <div className={`flex items-center gap-1.5 transition-opacity ${!settings.checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Watch</span>
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="50" className="w-14 h-7 text-xs"
                value={settings.checkTimelineReelsMin ?? 3}
                onChange={(e) => setSettings({ ...settings, checkTimelineReelsMin: Math.max(1, Number(e.target.value)) })}
              />
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="50" className="w-14 h-7 text-xs"
                value={settings.checkTimelineReelsMax ?? 8}
                onChange={(e) => setSettings({ ...settings, checkTimelineReelsMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
          <div className={`flex flex-col items-end gap-1.5 shrink-0 transition-opacity ${!settings.checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkTimelineReelsOrderMin", "checkTimelineReelsOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("checkTimelineReelsNotUsedMin", "checkTimelineReelsNotUsedMax")}
            </div>
          </div>
        </div>

        <div className="border-t border-border/50" />

        {/* Check Stories from Timeline */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <input type="checkbox" id="checkTimelineStoriesEnabled"
              checked={!!settings.checkTimelineStoriesEnabled}
              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkTimelineStoriesEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
              <BookOpen className="w-4 h-4 text-sky-500 shrink-0" />
              Check Stories from Timeline
            </label>
            <div className={`flex items-center gap-1.5 transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Watch</span>
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="50" className="w-14 h-7 text-xs"
                value={settings.checkTimelineStoriesMin ?? 3}
                onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMin: Math.max(1, Number(e.target.value)) })}
              />
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="50" className="w-14 h-7 text-xs"
                value={settings.checkTimelineStoriesMax ?? 8}
                onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
          <div className={`flex flex-col items-end gap-1.5 shrink-0 transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkTimelineStoriesOrderMin", "checkTimelineStoriesOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("checkTimelineStoriesNotUsedMin", "checkTimelineStoriesNotUsedMax")}
            </div>
          </div>
        </div>

        <div className="border-t border-border/50" />

        {/* Check Direct Messages */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <input type="checkbox" id="checkDmEnabled"
              checked={!!settings.checkDmEnabled}
              onChange={(e) => setSettings({ ...settings, checkDmEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkDmEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
              <MessageSquare className="w-4 h-4 text-teal-500 shrink-0" />
              Check Direct Messages
            </label>
            <div className={`flex items-center gap-1.5 transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Check</span>
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="100" className="w-14 h-7 text-xs"
                value={settings.checkDmMin ?? 5}
                onChange={(e) => setSettings({ ...settings, checkDmMin: Math.max(1, Number(e.target.value)) })}
              />
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="100" className="w-14 h-7 text-xs"
                value={settings.checkDmMax ?? 15}
                onChange={(e) => setSettings({ ...settings, checkDmMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
          <div className={`flex flex-col items-end gap-1.5 shrink-0 transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkDmOrderMin", "checkDmOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("checkDmNotUsedMin", "checkDmNotUsedMax")}
            </div>
          </div>
        </div>

      </div>


      {/* ── Repost ────────────────────────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="repostEnabled"
              checked={!!settings.repostEnabled}
              onChange={(e) => setSettings({ ...settings, repostEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="repostEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
              <Repeat2 className="w-4 h-4 text-green-500" />
              Repost
            </label>
          </div>
          {settings.repostEnabled && (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("repostOrderMin", "repostOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Skip Chance</span>
              {pctInputs("repostNotUsedMin", "repostNotUsedMax")}
            </div>
          </div>
          )}
        </div>

        <div className={`space-y-3 ${!settings.repostEnabled ? 'hidden' : ''}`}>
          {/* Source 1: @username */}
          <div className="border border-border/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <AtSign className="w-3.5 h-3.5 text-muted-foreground" /> Source: Instagram Account
              </Label>
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  id="repostDisableUsernameSource"
                  checked={!!settings.repostDisableUsernameSource}
                  onChange={(e) => setSettings({ ...settings, repostDisableUsernameSource: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer"
                />
                <label htmlFor="repostDisableUsernameSource" className="text-[11px] text-muted-foreground cursor-pointer select-none">Disable this source</label>
              </div>
            </div>
            <div className={`flex flex-wrap items-end gap-4 transition-opacity ${settings.repostDisableUsernameSource ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Account username <span className="text-muted-foreground/60">(without @)</span></Label>
              <div className="relative max-w-[220px]">
                <AtSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder="username"
                  className="h-8 text-xs pl-7"
                  value={settings.repostSourceUsername ?? ""}
                  onChange={(e) => setSettings({ ...settings, repostSourceUsername: e.target.value.replace(/^@/, '') })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Posts per session (min / max)</Label>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Min</Label>
                  <Input type="number" min="1" max="20" className="w-16 h-7 text-xs"
                    value={settings.repostMin ?? 1}
                    onChange={(e) => setSettings({ ...settings, repostMin: Math.max(1, Number(e.target.value)) })}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Max</Label>
                  <Input type="number" min="1" max="20" className="w-16 h-7 text-xs"
                    value={settings.repostMax ?? 1}
                    onChange={(e) => setSettings({ ...settings, repostMax: Math.max(1, Number(e.target.value)) })}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Alteration level</Label>
              <div className="flex gap-1">
                {(["small", "medium", "high"] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setSettings({ ...settings, repostAlterationLevel: lvl })}
                    className={`h-8 px-3 text-xs rounded border transition-colors capitalize ${
                      (settings.repostAlterationLevel ?? "small") === lvl
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Image settings</Label>
              <button
                type="button"
                onClick={() => setImageSettingsOpen(true)}
                className="h-8 px-3 text-xs rounded border transition-colors flex items-center gap-1.5 bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              >
                <Settings className="w-3 h-3" />
                Configure
              </button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Disable when my posts reach <span className="text-muted-foreground/60">(0 = off)</span></Label>
              <Input
                type="number" min="0" className="w-20 h-8 text-xs"
                value={settings.repostDisableAtPostCount ?? 0}
                onChange={(e) => setSettings({ ...settings, repostDisableAtPostCount: Math.max(0, Number(e.target.value)) })}
              />
            </div>
            </div>{/* end flex-wrap */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="repostUseHikerApi"
                checked={!!settings.repostUseHikerApi}
                onChange={(e) => setSettings({ ...settings, repostUseHikerApi: e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <label htmlFor="repostUseHikerApi" className="text-xs text-muted-foreground cursor-pointer select-none">
                Use HikerAPI to scrape source account feed (GetNewMedia)
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="repostDisableWhenExhausted"
                checked={!!settings.repostDisableWhenExhausted}
                onChange={(e) => setSettings({ ...settings, repostDisableWhenExhausted: e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <label htmlFor="repostDisableWhenExhausted" className="text-xs text-muted-foreground cursor-pointer select-none">
                Auto-disable when no more unique posts are found from the source account
              </label>
            </div>
          </div>{/* end Source 1 border */}

          {/* Source 2: Local PC Folder */}
          <div className="border border-border/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  id="repostLocalFolderEnabled"
                  checked={!!settings.repostLocalFolderEnabled}
                  onChange={(e) => setSettings({ ...settings, repostLocalFolderEnabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer"
                />
                <label htmlFor="repostLocalFolderEnabled" className="text-xs font-semibold text-foreground flex items-center gap-1.5 cursor-pointer select-none">
                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" /> Source: Local PC Folder
                </label>
              </div>
            </div>
            <div className={`space-y-2 transition-opacity ${!settings.repostLocalFolderEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Folder path on your PC <span className="text-muted-foreground/60">(e.g. C:\Images\Repost)</span></Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    placeholder="C:\Users\You\Pictures\Repost"
                    className="h-8 text-xs font-mono flex-1"
                    value={settings.repostLocalFolderPath ?? ""}
                    onChange={(e) => setSettings({ ...settings, repostLocalFolderPath: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => localFolderPickerRef.current?.click()}
                    className="h-8 px-3 text-xs rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    Browse…
                  </button>
                  {/* Hidden folder picker webkitdirectory: user picks a folder, browser returns all files inside it */}
                  <input
                    ref={localFolderPickerRef}
                    type="file"
                    // @ts-ignore webkitdirectory is valid but missing from TS typedefs
                    webkitdirectory=""
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (!files.length) return;
                      const IMAGE_EXTS = new Set(["jpg","jpeg","png","webp","gif"]);
                      const imgFiles = files.filter(f => IMAGE_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? ""));
                      const topFolder = files[0].webkitRelativePath.split("/")[0];
                      setSettings({ ...settings, repostLocalFolderPath: topFolder });
                      setLocalFolderFileCount(imgFiles.length);
                      e.target.value = "";
                    }}
                  />
                </div>
                {localFolderFileCount !== null && (
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <FolderOpen className="w-3 h-3 shrink-0" />
                    {localFolderFileCount} image{localFolderFileCount !== 1 ? "s" : ""} found in folder verify the full path above is correct (e.g. C:\Users\You\Pictures\Repost).
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="repostLocalFolderDeleteAfterUpload"
                  checked={settings.repostLocalFolderDeleteAfterUpload !== false}
                  onChange={(e) => setSettings({ ...settings, repostLocalFolderDeleteAfterUpload: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                />
                <label htmlFor="repostLocalFolderDeleteAfterUpload" className="text-xs text-muted-foreground cursor-pointer select-none">
                  Delete image from PC folder after successful upload
                </label>
              </div>
            </div>
          </div>{/* end Source 2 border */}

          {/* Shared options */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="repostDisableComments"
              checked={!!settings.repostDisableComments}
              onChange={(e) => setSettings({ ...settings, repostDisableComments: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="repostDisableComments" className="text-xs text-muted-foreground cursor-pointer select-none">
              Disable comments after repost
            </label>
          </div>

          {/* ── Post Caption Text ──────────────────────────────────── */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground font-semibold">Post Caption Text</Label>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="h-6 px-2.5 text-[10px] rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  onClick={() => {
                    const t = (settings as any).repostCaptionText ?? "";
                    let depth = 0;
                    let err: string | null = null;
                    for (const ch of t) {
                      if (ch === "{") depth++;
                      else if (ch === "}") { depth--; if (depth < 0) { err = "Unexpected }"; break; } }
                    }
                    if (!err && depth !== 0) err = `${depth} unclosed {`;
                    setSpinSyntaxMsg(err ?? "✓ Syntax OK");
                    setSpinPreview(null);
                  }}
                >
                  Check Spin Syntax
                </button>
                <button
                  type="button"
                  className="h-6 px-2.5 text-[10px] rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  onClick={() => {
                    let result = (settings as any).repostCaptionText ?? "";
                    let i = 0;
                    while (result.includes("{") && i++ < 100) {
                      const prev = result;
                      result = result.replace(/\{([^{}]+)\}/g, (_: string, g: string) => {
                        const opts = g.split("|");
                        return opts[Math.floor(Math.random() * opts.length)];
                      });
                      if (prev === result) break;
                    }
                    setSpinPreview(result);
                    setSpinSyntaxMsg(null);
                  }}
                >
                  Spin Text
                </button>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground/70">
              You can use multi-level spin syntax for the caption. Leave blank to use the original post's caption.
            </p>

            <Textarea
              className="text-xs font-mono resize-none h-24 leading-relaxed"
              placeholder={"[ORIGINALPOSTCAPTION]\n\nor mix spin syntax:\n{Great post|Amazing|Love this} {by @USERNAME|from @USERNAME}"}
              value={(settings as any).repostCaptionText ?? ""}
              onChange={(e) => {
                setSettings({ ...settings, repostCaptionText: e.target.value } as any);
                setSpinPreview(null);
                setSpinSyntaxMsg(null);
              }}
            />

            {/* Token chips */}
            <div className="flex flex-wrap gap-1">
              {[
                "[ORIGINALPOSTCAPTION]",
                "[ORIGINALPOSTHASHTAGS]",
                "[ORIGINALPOSTCAPTION NO HASHTAGS]",
                "@USERNAME",
                "@CURRENTUSERNAME",
                "[POSTURL]",
              ].map((tok) => (
                <button
                  key={tok}
                  type="button"
                  title={`Click to insert ${tok}`}
                  className="h-5 px-1.5 text-[9px] font-mono rounded bg-muted/60 border border-border/50 text-muted-foreground hover:bg-primary/10 hover:border-primary/40 hover:text-primary transition-colors"
                  onClick={() => {
                    const cur = (settings as any).repostCaptionText ?? "";
                    setSettings({ ...settings, repostCaptionText: cur ? `${cur}\n${tok}` : tok } as any);
                    setSpinPreview(null);
                    setSpinSyntaxMsg(null);
                  }}
                >
                  {tok}
                </button>
              ))}
            </div>

            {/* Spin preview / syntax result */}
            {spinSyntaxMsg && (
              <p className={`text-[10px] px-2 py-1 rounded border ${spinSyntaxMsg.startsWith("✓") ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800" : "text-destructive border-destructive/30 bg-destructive/5"}`}>
                {spinSyntaxMsg}
              </p>
            )}
            {spinPreview !== null && (
              <div className="space-y-0.5">
                <Label className="text-[10px] text-muted-foreground/70">Spin preview</Label>
                <p className="text-[10px] text-muted-foreground border border-border/50 rounded px-2 py-1.5 bg-muted/20 whitespace-pre-wrap break-all leading-relaxed">{spinPreview || <em>(empty)</em>}</p>
              </div>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground leading-relaxed">
            During each session, picks the latest unreposted post from the source account and reposts it.
            <br />
            <strong>Disable at post count</strong> reads the post count from this profile's Instagram bio to stop reposting once the goal is reached.
          </p>

          {/* Warning: skip chance is 100 repost will never run automatically */}
          {(Number((settings as any).repostNotUsedMin ?? 0) >= 100 || Number((settings as any).repostNotUsedMax ?? 0) >= 100) && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700">
              <span className="text-amber-500 text-sm shrink-0">⚠️</span>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                <strong>Skip chance is 100% repost will never run automatically.</strong><br />
                Set <em>Skip chance %</em> min and max to <strong>0</strong> so repost always runs each session.
              </p>
            </div>
          )}

          {/* Manual trigger */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-1.5 text-xs h-7 px-2.5 border-green-300 text-green-700 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-950/30"
              disabled={repostingNow || !settings.repostEnabled || !String((settings as any).repostSourceUsername ?? "").trim()}
              onClick={async () => {
                setRepostingNow(true);
                try {
                  const res = await fetch(`/api/profiles/${tool.profileId}/run-repost-now`, { method: "POST" });
                  const data = await res.json() as { ok: boolean; message: string };
                  toast({
                    title: data.ok ? "Repost queued" : "Repost failed",
                    description: data.message,
                    variant: data.ok ? "default" : "destructive",
                  });
                } catch (e: any) {
                  toast({ title: "Error", description: e?.message ?? "Unknown error", variant: "destructive" });
                } finally {
                  setRepostingNow(false);
                }
              }}
            >
              {repostingNow ? (
                <><span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />Reposting…</>
              ) : (
                <><Repeat2 className="w-3.5 h-3.5 shrink-0" />Run Repost Now</>
              )}
            </Button>
            <span className="text-[10px] text-muted-foreground">Bypass skip chance &amp; timer posts 1 now</span>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="flex items-center gap-1.5 text-xs h-7 px-2.5"
            onClick={() => setShowReposted(v => !v)}
          >
            <Repeat2 className="w-3.5 h-3.5 text-green-500" />
            Reposted Posts
            <span className="text-[10px] text-muted-foreground ml-0.5">({repostedPostsList?.length ?? '…'})</span>
            {showReposted ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
          </Button>

          {showReposted && (
            <div className="border border-border rounded-lg overflow-hidden animate-in fade-in duration-200">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                    <tr>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 whitespace-nowrap">Source Account</th>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 whitespace-nowrap">Source Post</th>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 whitespace-nowrap">My Repost</th>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 w-full">Caption (preview)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {repostedPostsLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <tr key={i} className="animate-pulse">
                          <td colSpan={5} className="px-4 py-3 bg-muted/10 h-10" />
                        </tr>
                      ))
                    ) : !repostedPostsList || repostedPostsList.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                          <Repeat2 className="w-6 h-6 mx-auto mb-2 text-muted-foreground/30" />
                          <p className="text-xs font-medium">No posts reposted yet</p>
                        </td>
                      </tr>
                    ) : (
                      repostedPostsList.map(rp => (
                        <tr key={rp.id} className="hover:bg-accent/5 transition-colors">
                          <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground text-xs font-mono">
                            <span className="flex items-center gap-1.5">
                              <Clock className="w-3 h-3 shrink-0" />
                              {format(new Date(rp.repostedAt), "MMM d, HH:mm:ss")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap font-medium text-foreground">
                            <button
                              onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${rp.sourceUsername}/`)}
                              className="flex items-center gap-1 text-primary hover:underline group text-xs"
                            >
                              @{rp.sourceUsername}
                              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground font-mono">
                            {rp.shortcode ? (
                              <button
                                onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/p/${rp.shortcode}/`)}
                                className="flex items-center gap-1 text-primary hover:underline group"
                              >
                                <ImageIcon className="w-3 h-3" />
                                {rp.shortcode}
                                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </button>
                            ) : (
                              <span className="text-muted-foreground/40"> </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground font-mono">
                            {(rp as any).postedShortcode ? (
                              <button
                                onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/p/${(rp as any).postedShortcode}/`)}
                                className="flex items-center gap-1 text-green-500 hover:underline group"
                              >
                                <ImageIcon className="w-3 h-3" />
                                {(rp as any).postedShortcode}
                                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </button>
                            ) : (
                              <span className="text-muted-foreground/40"> </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[240px]">
                            <span className="line-clamp-2">{rp.caption || " "}</span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <CopySettingsDialog
        key={copyOpen ? "open" : "closed"}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title="Copy Human Session Settings"
        profiles={otherProfiles}
        optionGroups={HUMAN_COPY_GROUPS}
        onCopy={handleHumanCopy}
      />

      <ImageSettingsDialog
        open={imageSettingsOpen}
        onClose={() => setImageSettingsOpen(false)}
        settings={imgSettings}
        alterationLevel={settings.repostAlterationLevel ?? "small"}
        onSave={(saved) => setSettings({ ...settings, repostImageSettings: saved } as any)}
      />
    </div>
  );
}
