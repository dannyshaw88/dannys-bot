import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Bell, User, RefreshCw, Settings, PlaySquare, BookOpen,
  MessageSquare, Repeat2, AtSign, Clock, ExternalLink, Image as ImageIcon,
  ChevronDown, ChevronUp, Heart, Copy,
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
  const [copyOpen, setCopyOpen] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId);

  const HUMAN_KEY_MAP: Record<string, string[]> = {
    humanToolsDelay:    ["delayMin","delayMax"],
    viewTimelineFeed:   ["viewTimelineFeedEnabled","viewTimelineFeedMin","viewTimelineFeedMax","viewTimelineFeedOrderMin","viewTimelineFeedOrderMax","viewTimelineFeedNotUsedMin","viewTimelineFeedNotUsedMax"],
    humanSession:       ["humanSessionEnabled","humanSessionOrderMin","humanSessionOrderMax","humanSessionNotUsedMin","humanSessionNotUsedMax"],
    checkReels:         ["checkTimelineReelsEnabled","checkTimelineReelsMin","checkTimelineReelsMax","checkTimelineReelsOrderMin","checkTimelineReelsOrderMax","checkTimelineReelsNotUsedMin","checkTimelineReelsNotUsedMax"],
    checkStories:       ["checkTimelineStoriesEnabled","checkTimelineStoriesMin","checkTimelineStoriesMax","checkTimelineStoriesOrderMin","checkTimelineStoriesOrderMax","checkTimelineStoriesNotUsedMin","checkTimelineStoriesNotUsedMax"],
    checkDm:            ["checkDmEnabled","checkDmMin","checkDmMax","checkDmOrderMin","checkDmOrderMax","checkDmNotUsedMin","checkDmNotUsedMax"],
    likeTimelinePosts:  ["likeTimelinePostsEnabled","likeTimelinePostsMin","likeTimelinePostsMax","likeTimelinePostsOrderMin","likeTimelinePostsOrderMax","likeTimelinePostsNotUsedMin","likeTimelinePostsNotUsedMax"],
    repost:             ["repostEnabled","repostSourceUsername","repostAlterationLevel","repostImageSettings","repostOrderMin","repostOrderMax","repostNotUsedMin","repostNotUsedMax","repostDisableAtPostCount","repostDisableWhenExhausted"],
  };
  const HUMAN_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "Timing", options: [
      { key: "humanToolsDelay", label: "Human Tools Delay", description: "Interval between human session runs" },
    ]},
    { label: "Actions", options: [
      { key: "viewTimelineFeed",  label: "View Timeline Feed",  description: "Enabled state, duration range, order and cool-down" },
      { key: "humanSession",      label: "Human Session (Visit Profile)", description: "Enabled, order and cool-down" },
      { key: "checkReels",        label: "Check Timeline Reels", description: "Enabled, duration, order and cool-down" },
      { key: "checkStories",      label: "Check Timeline Stories", description: "Enabled, duration, order and cool-down" },
      { key: "checkDm",           label: "Check DMs",            description: "Enabled, duration, order and cool-down" },
      { key: "likeTimelinePosts", label: "Like Timeline Posts",  description: "Enabled, count range, order and cool-down" },
      { key: "repost",            label: "Repost",               description: "Enabled, source account, order, cool-down, stop conditions" },
    ]},
  ];

  const handleHumanCopy = async (targetIds: number[], selectedKeys: Set<string>) => {
    const keysToSend = [...selectedKeys].flatMap(k => HUMAN_KEY_MAP[k] ?? []);
    await copyToolSettingsToProfiles(settings as Record<string,unknown>, tool.type, targetIds, keysToSend);
    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const { data: repostedPostsList, isLoading: repostedPostsLoading } = useQuery<RepostedPost[]>({
    queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`],
    refetchInterval: 15000,
  });

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      delayMin: 30,
      delayMax: 60,
      viewTimelineFeedEnabled: true,
      viewTimelineFeedMin: 3,
      viewTimelineFeedMax: 8,
      viewTimelineFeedOrderMin: 5,
      viewTimelineFeedOrderMax: 10,
      viewTimelineFeedNotUsedMin: 0,
      viewTimelineFeedNotUsedMax: 0,
      humanSessionEnabled: true,
      humanSessionOrderMin: 0,
      humanSessionOrderMax: 0,
      humanSessionNotUsedMin: 0,
      humanSessionNotUsedMax: 0,
      checkTimelineReelsEnabled: true,
      checkTimelineReelsMin: 3,
      checkTimelineReelsMax: 8,
      checkTimelineReelsOrderMin: 0,
      checkTimelineReelsOrderMax: 0,
      checkTimelineReelsNotUsedMin: 0,
      checkTimelineReelsNotUsedMax: 0,
      checkTimelineStoriesEnabled: true,
      checkTimelineStoriesMin: 3,
      checkTimelineStoriesMax: 8,
      checkTimelineStoriesOrderMin: 0,
      checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0,
      checkTimelineStoriesNotUsedMax: 0,
      checkDmEnabled: true,
      checkDmMin: 5,
      checkDmMax: 15,
      checkDmOrderMin: 0,
      checkDmOrderMax: 0,
      checkDmNotUsedMin: 0,
      checkDmNotUsedMax: 0,
      likeTimelinePostsEnabled: true,
      likeTimelinePostsMin: 2,
      likeTimelinePostsMax: 5,
      likeTimelinePostsOrderMin: 0,
      likeTimelinePostsOrderMax: 0,
      likeTimelinePostsNotUsedMin: 0,
      likeTimelinePostsNotUsedMax: 0,
      repostEnabled: false,
      repostSourceUsername: "",
      repostAlterationLevel: "small",
      repostImageSettings: {
        contrast:       { enabled: true, min: 5,   max: 250 },
        brightness:     { enabled: true, min: 5,   max: 250 },
        noise:          { enabled: true, min: 5,   max: 15  },
        sharpen:        { enabled: true, min: 1.0, max: 2.0 },
        pixelate:       { enabled: true, min: 0.9, max: 2.1 },
        randomMetadata: true,
      },
      repostOrderMin: 0,
      repostOrderMax: 0,
      repostNotUsedMin: 0,
      repostNotUsedMax: 0,
      repostDisableAtPostCount: 0,
      repostDisableWhenExhausted: true,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [settings]);

  const DEFAULT_IMG_SETTINGS = {
    contrast:       { enabled: true, min: 5,   max: 250 },
    brightness:     { enabled: true, min: 5,   max: 250 },
    noise:          { enabled: true, min: 5,   max: 15  },
    sharpen:        { enabled: true, min: 1.0, max: 2.0 },
    pixelate:       { enabled: true, min: 0.9, max: 2.1 },
    randomMetadata: true,
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
      <div className="border border-border rounded-xl p-4 flex items-center justify-between gap-4">
        <div>
          <h4 className="font-semibold text-sm">Human Session Tool</h4>
          {nextRunStatus && (
            <p className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: nextRunStatus.executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
              <Clock className="w-3 h-3 shrink-0" />
              {nextRunStatus.executing
                ? <span className="font-medium">Executing</span>
                : <><span>Scheduled:</span> <span className="font-mono font-medium text-foreground">{nextRunStatus.label}</span></>
              }
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={tool.enabled}
            onCheckedChange={(enabled) => updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled })}
            disabled={updateToolMutation.isPending}
          />
          <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
            {tool.enabled ? 'ACTIVE' : 'STOPPED'}
          </span>
        </div>
      </div>

      {/* ── Timer ─────────────────────────────────────────────── */}
      <div className="border border-border rounded-xl p-4">
        <div className="flex items-center justify-between">
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
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="viewTimelineFeedEnabled"
              checked={!!settings.viewTimelineFeedEnabled}
              onChange={(e) => setSettings({ ...settings, viewTimelineFeedEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="viewTimelineFeedEnabled" className="font-semibold text-sm cursor-pointer select-none">View Timeline Feed</label>
          </div>
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("viewTimelineFeedOrderMin", "viewTimelineFeedOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("viewTimelineFeedNotUsedMin", "viewTimelineFeedNotUsedMax")}
            </div>
          </div>
        </div>
        <div className={`flex items-center gap-4 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to View</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                value={settings.viewTimelineFeedMin ?? 3}
                onChange={(e) => setSettings({ ...settings, viewTimelineFeedMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                value={settings.viewTimelineFeedMax ?? 8}
                onChange={(e) => setSettings({ ...settings, viewTimelineFeedMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Human Session (Notifications / Own Profile / etc.) ─── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
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
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("humanSessionOrderMin", "humanSessionOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("humanSessionNotUsedMin", "humanSessionNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40' : ''}`}>
          Runs all four sub-actions in a random order each session: visits the notification inbox, browses the account's own profile, pull-to-refreshes it, and opens Settings &amp; Activity.
        </p>
      </div>

      {/* ── Check Reels from Timeline ──────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="checkTimelineReelsEnabled"
              checked={!!settings.checkTimelineReelsEnabled}
              onChange={(e) => setSettings({ ...settings, checkTimelineReelsEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkTimelineReelsEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
              <PlaySquare className="w-4 h-4 text-rose-500" />
              Check Reels from Timeline
            </label>
          </div>
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkTimelineReelsOrderMin", "checkTimelineReelsOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("checkTimelineReelsNotUsedMin", "checkTimelineReelsNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.checkTimelineReelsEnabled ? 'opacity-40' : ''}`}>
          Scrolls through the Reels tab feed and marks reels as watched.
        </p>
        <div className={`flex items-center gap-4 transition-opacity ${!settings.checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reels to Watch</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.checkTimelineReelsMin ?? 3}
                onChange={(e) => setSettings({ ...settings, checkTimelineReelsMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.checkTimelineReelsMax ?? 8}
                onChange={(e) => setSettings({ ...settings, checkTimelineReelsMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Check Stories from Timeline ────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="checkTimelineStoriesEnabled"
              checked={!!settings.checkTimelineStoriesEnabled}
              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkTimelineStoriesEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
              <BookOpen className="w-4 h-4 text-sky-500" />
              Check Stories from Timeline
            </label>
          </div>
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkTimelineStoriesOrderMin", "checkTimelineStoriesOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("checkTimelineStoriesNotUsedMin", "checkTimelineStoriesNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40' : ''}`}>
          Watches stories from the top of Instagram's home feed tray.
        </p>
        <div className={`flex items-center gap-4 transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Stories to Watch</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.checkTimelineStoriesMin ?? 3}
                onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.checkTimelineStoriesMax ?? 8}
                onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Check Direct Messages ──────────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="checkDmEnabled"
              checked={!!settings.checkDmEnabled}
              onChange={(e) => setSettings({ ...settings, checkDmEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="checkDmEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
              <MessageSquare className="w-4 h-4 text-teal-500" />
              Check Direct Messages
            </label>
          </div>
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("checkDmOrderMin", "checkDmOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("checkDmNotUsedMin", "checkDmNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.checkDmEnabled ? 'opacity-40' : ''}`}>
          Calls <code className="bg-muted px-1 rounded text-[10px]">getDirectMessagesInternal</code> to simulate checking the inbox.
        </p>
        <div className={`flex items-center gap-4 transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">DMs to Check</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                value={settings.checkDmMin ?? 5}
                onChange={(e) => setSettings({ ...settings, checkDmMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                value={settings.checkDmMax ?? 15}
                onChange={(e) => setSettings({ ...settings, checkDmMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Like Posts from Timeline ──────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pt-0.5">
            <input type="checkbox" id="likeTimelinePostsEnabled"
              checked={!!settings.likeTimelinePostsEnabled}
              onChange={(e) => setSettings({ ...settings, likeTimelinePostsEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="likeTimelinePostsEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
              <Heart className="w-4 h-4 text-pink-500" />
              Like Posts from Timeline
            </label>
          </div>
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.likeTimelinePostsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("likeTimelinePostsOrderMin", "likeTimelinePostsOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
              {pctInputs("likeTimelinePostsNotUsedMin", "likeTimelinePostsNotUsedMax")}
            </div>
          </div>
        </div>
        <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.likeTimelinePostsEnabled ? 'opacity-40' : ''}`}>
          Likes posts from the home timeline feed. If a post is a reel, it is marked as watched before liking.
        </p>
        <div className={`flex items-center gap-4 transition-opacity ${!settings.likeTimelinePostsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Like</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.likeTimelinePostsMin ?? 2}
                onChange={(e) => setSettings({ ...settings, likeTimelinePostsMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="50" className="w-16 h-7 text-xs"
                value={settings.likeTimelinePostsMax ?? 5}
                onChange={(e) => setSettings({ ...settings, likeTimelinePostsMax: Math.max(1, Number(e.target.value)) })}
              />
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
          <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!settings.repostEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
              {pctInputs("repostOrderMin", "repostOrderMax")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Run Chance</span>
              {pctInputs("repostNotUsedMin", "repostNotUsedMax")}
            </div>
          </div>
        </div>

        <div className={`space-y-3 transition-opacity ${!settings.repostEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Repost from account <span className="text-muted-foreground/60">(without @)</span></Label>
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

          <p className="text-[10px] text-muted-foreground leading-relaxed">
            During each session, picks the latest unreposted post from the source account and reposts it with the original caption.
            <br />
            <strong>Disable at post count</strong> reads the post count from this profile's Instagram bio to stop reposting once the goal is reached.
          </p>

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
                      <th className="px-4 py-2.5 font-bold bg-muted/30 whitespace-nowrap">Post ID / Code</th>
                      <th className="px-4 py-2.5 font-bold bg-muted/30 w-full">Caption (preview)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {repostedPostsLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <tr key={i} className="animate-pulse">
                          <td colSpan={4} className="px-4 py-3 bg-muted/10 h-10" />
                        </tr>
                      ))
                    ) : !repostedPostsList || repostedPostsList.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
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
                              <span className="truncate max-w-[100px] block" title={rp.mediaId}>{rp.mediaId}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[240px]">
                            <span className="line-clamp-2">{rp.caption || "—"}</span>
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

      <Button
        variant="outline"
        className="w-full gap-2"
        disabled={otherProfiles.length === 0}
        onClick={() => setCopyOpen(true)}
      >
        <Copy className="w-3.5 h-3.5" /> Copy Settings
      </Button>

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
