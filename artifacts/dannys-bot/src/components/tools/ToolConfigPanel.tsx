import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { useSources, useCreateSource, useDeleteSource, useImportSources, parseJarveeHashtagFile } from "@/hooks/use-sources";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Hash, Users, ChevronRight, ArrowLeft, Copy, X, Upload, Download, ListFilter, UserPlus, Clock, ExternalLink, Activity, Heart, PlaySquare, BookOpen, Star, UserCheck, Ban, AlertCircle, MessageSquare, Bell, User, RefreshCw, Settings, Repeat2, Image, AtSign, TrendingUp, Search } from "lucide-react";
import { useRef } from "react";
import { type Tool, type Profile, type FollowedUser, type SessionAction } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
interface ToolConfigPanelProps {
  tool: Tool;
  profile: Profile;
  copyOpen?: boolean;
  onCopyOpenChange?: (v: boolean) => void;
}


export function ToolConfigPanel({ tool, profile, copyOpen: copyOpenProp, onCopyOpenChange }: ToolConfigPanelProps) {
  const { toast } = useToast();
  const { navigateTo } = useBrowserWindows();
  const updateToolMutation = useUpdateTool();  // settings saves
  const toggleMutation     = useUpdateTool();  // enable/disable never blocked by settings save
  const { data: sources, isLoading: sourcesLoading } = useSources(tool.id);
  const createSourceMutation = useCreateSource();
  const deleteSourceMutation = useDeleteSource();
  const importSourcesMutation = useImportSources();
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseJarveeHashtagFile(file);
      if (!rows.length) { toast({ title: "No hashtags found in file", variant: "destructive" }); return; }
      await importSourcesMutation.mutateAsync({
        toolId: tool.id,
        rows: rows.map(r => ({ type: 'hashtag', value: r.value, rank: r.rank, nrPosts: r.nrPosts })),
      });
      toast({ title: `Imported ${rows.length} hashtag${rows.length !== 1 ? 's' : ''}` });
    } catch {
      toast({ title: "Failed to import file", description: "Make sure it's a valid Jarvee hashtag export.", variant: "destructive" });
    } finally {
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const handleExport = () => {
    if (!sources?.length) { toast({ title: "No sources to export" }); return; }
    const header = 'Keyword\tNrPosts\tRank';
    const rows = sources.map(s => `${s.value}\t${s.nrPosts ?? ''}\t${s.rank ?? ''}`);
    const tsv = [header, ...rows].join('\r\n');
    // Encode as UTF-16LE with BOM for Jarvee compatibility
    const buf = new ArrayBuffer(2 + tsv.length * 2);
    const view = new DataView(buf);
    view.setUint8(0, 0xff); view.setUint8(1, 0xfe); // BOM
    for (let i = 0; i < tsv.length; i++) {
      view.setUint16(2 + i * 2, tsv.charCodeAt(i), true);
    }
    const blob = new Blob([buf], { type: 'text/plain;charset=utf-16le' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sources_tool_${tool.id}.txt`; a.click();
    URL.revokeObjectURL(url);
  };

  // Local state for settings form
  const [settings, setSettings] = useState(() => {
    const def = { 
      randomiseTiming: false,
      delayMin: 1, 
      delayMax: 2, 
      maxPerDayMin: 150,
      maxPerDayMax: 200,
      maxPerHourMin: 5,
      maxPerHourMax: 15,
      processMin: 5,
      processMax: 15,
      abortScrapeAfterMin: 10,
      abortScrapeAfterMax: 50,
      likeChanceMin: 1,
      likeChanceMax: 5,
      viewReelsChanceMin: 1,
      viewReelsChanceMax: 5,
      viewStoriesChanceMin: 1,
      viewStoriesChanceMax: 5,
      viewHighlightsChanceMin: 1,
      viewHighlightsChanceMax: 5,
      likeProcessMin: 1,
      likeProcessMax: 1,
      viewReelsProcessMin: 1,
      viewReelsProcessMax: 2,
      viewStoriesProcessMin: 1,
      viewStoriesProcessMax: 3,
      viewHighlightsProcessMin: 1,
      viewHighlightsProcessMax: 2,
      likeMaxPerDayMin: 30,
      likeMaxPerDayMax: 50,
      viewReelsMaxPerDayMin: 30,
      viewReelsMaxPerDayMax: 50,
      viewStoriesMaxPerDayMin: 30,
      viewStoriesMaxPerDayMax: 50,
      viewHighlightsMaxPerDayMin: 30,
      viewHighlightsMaxPerDayMax: 50,
      likeBeforeMin: 0,
      likeBeforeMax: 0,
      viewReelsBeforeMin: 0,
      viewReelsBeforeMax: 0,
      viewStoriesBeforeMin: 0,
      viewStoriesBeforeMax: 0,
      viewHighlightsBeforeMin: 0,
      viewHighlightsBeforeMax: 0,
      delayAfterFollowMin: 5,
      delayAfterFollowMax: 15,
      likeDelayMin: 2,
      likeDelayMax: 6,
      viewReelsDelayMin: 2,
      viewReelsDelayMax: 6,
      viewStoriesDelayMin: 2,
      viewStoriesDelayMax: 6,
      viewHighlightsDelayMin: 2,
      viewHighlightsDelayMax: 6,
      likeMaxPerHourMin: 2,
      likeMaxPerHourMax: 5,
      viewReelsMaxPerHourMin: 2,
      viewReelsMaxPerHourMax: 5,
      viewStoriesMaxPerHourMin: 2,
      viewStoriesMaxPerHourMax: 5,
      viewHighlightsMaxPerHourMin: 2,
      viewHighlightsMaxPerHourMax: 5,
      autoReplyEnabled: false,
      autoReplyTrigger: "",
      autoReplyMessage: "",
      dmMessages: "",
      minFollowAgeDays: 3,
      delayAfterUnfollowMin: 5,
      delayAfterUnfollowMax: 15,
      skipIndianUsers: false,
      executionOrderMin: 5,
      executionOrderMax: 10,
      viewTimelineFeedMin: 3,
      viewTimelineFeedMax: 8,
      viewTimelineFeedOrderMin: 5,
      viewTimelineFeedOrderMax: 10,
      humanToolsDelayMin: 30,
      humanToolsDelayMax: 60,
      humanSessionOrderMin: 0,
      humanSessionOrderMax: 0,
      humanSessionNotUsedMin: 0,
      humanSessionNotUsedMax: 0,
      humanToolsEnabled: true,
      sessionActionVariationEnabled: true,
      viewTimelineFeedEnabled: true,
      viewTimelineFeedNotUsedMin: 0,
      viewTimelineFeedNotUsedMax: 0,
      humanSessionEnabled: true,
      checkTimelineStoriesEnabled: true,
      checkDmEnabled: true,
      checkTimelineStoriesMin: 3,
      checkTimelineStoriesMax: 8,
      checkTimelineStoriesOrderMin: 0,
      checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0,
      checkTimelineStoriesNotUsedMax: 0,
      checkDmMin: 5,
      checkDmMax: 15,
      checkDmOrderMin: 0,
      checkDmOrderMax: 0,
      stopOnBlockEnabled: false,
      stopOnBlockMinutes: 60,
      checkDmNotUsedMin: 0,
      checkDmNotUsedMax: 0,
      contextualActionsEnabled: false,
      contextualActionsMin: 5,
      contextualActionsMax: 5,
      contextualActionsDelayMin: 0,
      contextualActionsDelayMax: 1,
      discoverPagePercentageMin: 100,
      discoverPagePercentageMax: 100,
      repostEnabled: false,
      repostSourceUsername: "",
      repostOrderMin: 0,
      repostOrderMax: 0,
      repostNotUsedMin: 0,
      repostNotUsedMax: 0,
      repostDisableAtPostCount: 0,
      repostDisableWhenExhausted: true,
      autoFollowUnfollowEnabled: false,
      autoStopFollowAtFollowingsMin: 7400,
      autoStopFollowAtFollowingsMax: 7400,
      autoStartUnfollowAfterMin: 60,
      autoStartUnfollowAfterMax: 135,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const [newSourceType, setNewSourceType] = useState<'hashtag' | 'target_followers'>('hashtag');
  const [newSourceValue, setNewSourceValue] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);

  const { data: followedUsersList, isLoading: followedUsersLoading } = useQuery<FollowedUser[]>({
    queryKey: [`/api/profiles/${tool.profileId}/followed-users`],
    refetchInterval: showFollowedUsers ? 5000 : 30000,
    staleTime: 0,
    enabled: true,
  });

  const { data: sessionActions } = useQuery<SessionAction[]>({
    queryKey: [`/api/profiles/${tool.profileId}/session-actions`],
    refetchInterval: 5000,
    staleTime: 0,
  });
  const lastAction = sessionActions?.find(a => a.toolId === tool.id);
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const nextRunStatus: { label: string; executing: boolean } | null = (() => {
    if (!tool.enabled) return null;
    if (!lastAction && !engineStatus) return null;
    const nextAt = engineStatus?.nextFollowAt ?? 0;
    if (!nextAt || nextAt <= Date.now()) return { label: "Executing", executing: true };
    return { label: format(new Date(nextAt), "d MMM, HH:mm:ss"), executing: false };
  })();

  const [showCopyModal, _setShowCopyModal] = useState(false);
  const _copyOpen = copyOpenProp ?? showCopyModal;
  const _setCopyOpen = onCopyOpenChange ?? _setShowCopyModal;
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId && !p.locked && !p.isTemplate);
  const hasOtherProfiles = allProfiles.some(p => p.id !== tool.profileId);

  // ── Follow Tool copy option groups ──────────────────────────────
  const FOLLOW_TOOL_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "General", options: [
      { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
      { key: "randomiseTiming", label: "Randomise timing", description: "Spread each account's session start times across the Wait Until Next Session window so they don't all fire simultaneously" },
    ]},
    { label: "Timing", options: [
      { key: "ft_timing", label: "Timing", description: "Delays and wait times between actions", subOptions: [
        { key: "ft_sessionWait",      label: "Wait until next session (min / max mins)", settingKeys: ["delayMin","delayMax"] },
        { key: "ft_delayAfterFollow", label: "Delay after each follow (min / max secs)",  settingKeys: ["delayAfterFollowMin","delayAfterFollowMax"] },
      ]},
    ]},
    { label: "Limits", options: [
      { key: "ft_limits", label: "Limits", description: "Caps on how many follow actions are taken", subOptions: [
        { key: "ft_usersPerSession", label: "Users per session (min / max)",      settingKeys: ["processMin","processMax"] },
        { key: "ft_maxPerDay",       label: "Max actions per day (min / max)",    settingKeys: ["maxPerDayMin","maxPerDayMax"] },
        { key: "ft_maxPerHour",      label: "Max actions per hour (min / max)",   settingKeys: ["maxPerHourMin","maxPerHourMax"] },
      ]},
    ]},
    { label: "Scraping", options: [
      { key: "ft_scraping", label: "Scraping", description: "Source quality and follow-age filters", subOptions: [
        { key: "ft_scrapeAbort",  label: "Abort scrape after (min / max results)", settingKeys: ["abortScrapeAfterMin","abortScrapeAfterMax"] },
        { key: "ft_minFollowAge", label: "Min follow age (days)",                  settingKeys: ["minFollowAgeDays"] },
      ]},
    ]},
    { label: "Injection Settings", options: [
      { key: "ft_injection", label: "Injection Settings", description: "API calls injected between follows to simulate natural behaviour", subOptions: [
        { key: "ft_injectSearch",    label: "Inject SearchByUsername (enabled + %)",  settingKeys: ["injectSearchEnabled","injectSearchMin","injectSearchMax"] },
        { key: "ft_injectSuggested", label: "Inject GetSuggestedUsers (enabled + %)", settingKeys: ["injectSuggestedEnabled","injectSuggestedMin","injectSuggestedMax"] },
        { key: "ft_injectProfileBrowsing", label: "Inject Profile Browsing (enabled + % + settings)", settingKeys: ["injectProfileBrowsingEnabled","injectProfileBrowsingMin","injectProfileBrowsingMax","injectProfileBrowsingFeedMin","injectProfileBrowsingFeedMax","injectProfileBrowsingPostPctMin","injectProfileBrowsingPostPctMax","injectProfileBrowsingBeforeFollow"] },
      ]},
    ]},
    { label: "Auto Follow / Unfollow", options: [
      { key: "ft_autoFU", label: "Auto Follow / Unfollow", description: "Automatic switching between follow and unfollow tools", subOptions: [
        { key: "ft_autoEnabled",    label: "Enabled",                                      settingKeys: ["autoFollowUnfollowEnabled"] },
        { key: "ft_autoStopAt",     label: "Stop follow at followings count (min / max)",  settingKeys: ["autoStopFollowAtFollowingsMin","autoStopFollowAtFollowingsMax"] },
        { key: "ft_autoStartAfter", label: "Start unfollow after (min / max mins)",        settingKeys: ["autoStartUnfollowAfterMin","autoStartUnfollowAfterMax"] },
      ]},
    ]},
    { label: "Session Action Variation", options: [
      { key: "ft_sav", label: "Session Action Variation", description: "Extra actions performed during a follow session", subOptions: [
        { key: "ft_sav_enabled",       label: "Enabled",                                          settingKeys: ["sessionActionVariationEnabled"] },
        { key: "ft_likeChance",        label: "Like Chance % (min / max)",                      settingKeys: ["likeChanceMin","likeChanceMax"] },
        { key: "ft_likeCount",         label: "Like Posts to like (min / max)",                 settingKeys: ["likeProcessMin","likeProcessMax"] },
        { key: "ft_likeBefore",        label: "Like Before follow % (min / max)",               settingKeys: ["likeBeforeMin","likeBeforeMax"] },
        { key: "ft_likeMaxDay",        label: "Like Max per day (min / max)",                   settingKeys: ["likeMaxPerDayMin","likeMaxPerDayMax"] },
        { key: "ft_likeDelay",         label: "Like Delay between likes (min / max secs)",      settingKeys: ["likeDelayMin","likeDelayMax"] },
        { key: "ft_reelsChance",       label: "Reels Chance % (min / max)",                     settingKeys: ["viewReelsChanceMin","viewReelsChanceMax"] },
        { key: "ft_reelsCount",        label: "Reels Count to watch (min / max)",               settingKeys: ["viewReelsProcessMin","viewReelsProcessMax"] },
        { key: "ft_reelsBefore",       label: "Reels Before follow % (min / max)",              settingKeys: ["viewReelsBeforeMin","viewReelsBeforeMax"] },
        { key: "ft_reelsMaxDay",       label: "Reels Max per day (min / max)",                  settingKeys: ["viewReelsMaxPerDayMin","viewReelsMaxPerDayMax"] },
        { key: "ft_reelsDelay",        label: "Reels Delay (min / max secs)",                   settingKeys: ["viewReelsDelayMin","viewReelsDelayMax"] },
        { key: "ft_storiesChance",     label: "Stories Chance % (min / max)",                   settingKeys: ["viewStoriesChanceMin","viewStoriesChanceMax"] },
        { key: "ft_storiesCount",      label: "Stories Count to watch (min / max)",             settingKeys: ["viewStoriesProcessMin","viewStoriesProcessMax"] },
        { key: "ft_storiesBefore",     label: "Stories Before follow % (min / max)",            settingKeys: ["viewStoriesBeforeMin","viewStoriesBeforeMax"] },
        { key: "ft_storiesMaxDay",     label: "Stories Max per day (min / max)",                settingKeys: ["viewStoriesMaxPerDayMin","viewStoriesMaxPerDayMax"] },
        { key: "ft_storiesDelay",      label: "Stories Delay (min / max secs)",                 settingKeys: ["viewStoriesDelayMin","viewStoriesDelayMax"] },
        { key: "ft_hlChance",          label: "Highlights Chance % (min / max)",                settingKeys: ["viewHighlightsChanceMin","viewHighlightsChanceMax"] },
        { key: "ft_hlCount",           label: "Highlights Count to watch (min / max)",          settingKeys: ["viewHighlightsProcessMin","viewHighlightsProcessMax"] },
        { key: "ft_hlBefore",          label: "Highlights Before follow % (min / max)",         settingKeys: ["viewHighlightsBeforeMin","viewHighlightsBeforeMax"] },
        { key: "ft_hlMaxDay",          label: "Highlights Max per day (min / max)",             settingKeys: ["viewHighlightsMaxPerDayMin","viewHighlightsMaxPerDayMax"] },
        { key: "ft_hlDelay",           label: "Highlights Delay (min / max secs)",              settingKeys: ["viewHighlightsDelayMin","viewHighlightsDelayMax"] },
      ]},
    ]},
    { label: "Stop if Blocked", options: [
      { key: "ft_stopOnBlock", label: "Stop if Blocked", description: "Pause the tool for a set time when Instagram blocks a follow action", subOptions: [
        { key: "ft_stopOnBlockEnabled", label: "Enabled",              settingKeys: ["stopOnBlockEnabled"] },
        { key: "ft_stopOnBlockMinutes", label: "Stop duration (mins)", settingKeys: ["stopOnBlockMinutes"] },
      ]},
    ]},
    { label: "Sources", options: [
      { key: "ft_sources", label: "Target Sources", description: "Copy all target sources (hashtags and accounts) to other profiles adds to existing sources" },
    ]},
  ];

  const handleFollowToolCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled  = expandedKeys.includes("startStop");
    const copySources  = expandedKeys.includes("ft_sources");
    const keysToSend   = expandedKeys.filter(k => k !== "startStop" && k !== "ft_sources");

    // When "Randomise timing" is selected and accounts are being enabled,
    // give each account a random start time within [delayMin, delayMax] so
    // they don't all fire at the same moment. This mirrors what the engine
    // does on a cold startup (randInt(delayMin, delayMax)).
    const willEnable    = copyEnabled && tool.enabled;
    const willRandomise = expandedKeys.includes("randomiseTiming");
    let staggerOffsets: number[] | undefined;
    if (willEnable && willRandomise) {
      const delayMin = Math.max(1, (settings as any).delayMin ?? 1);
      const delayMax = Math.max(delayMin, (settings as any).delayMax ?? 5);
      staggerOffsets = targetIds.map(() =>
        delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
      );
    }

    await copyToolSettingsToProfiles(
      settings as Record<string, unknown>,
      tool.type,
      targetIds,
      keysToSend,
      copyEnabled ? tool.enabled : undefined,
      staggerOffsets,
    );

    if (copySources) {
      const sourcesRes = await fetch(`/api/tools/${tool.id}/sources`, { credentials: "include" });
      const currentSources: { type: string; value: string; rank?: number | null; nrPosts?: number | null }[] =
        sourcesRes.ok ? await sourcesRes.json() : [];

      if (currentSources.length > 0) {
        const payload = currentSources.map(s => ({ type: s.type, value: s.value, rank: s.rank, nrPosts: s.nrPosts }));
        await Promise.all(
          targetIds.map(async profileId => {
            const toolsRes = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
            if (!toolsRes.ok) return;
            const tools: { id: number; type: string }[] = await toolsRes.json();
            const targetTool = tools.find(t => t.type === "follow");
            if (!targetTool) return;
            await fetch(`/api/tools/${targetTool.id}/sources/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              credentials: "include",
            });
          })
        );
      }
    }

    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const handleToggleEnable = (enabled: boolean) => {
    toggleMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled });
  };

  const queryClient = useQueryClient();

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

  const handleAddSource = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSourceValue.trim()) return;
    
    createSourceMutation.mutate({
      toolId: tool.id,
      type: newSourceType,
      value: newSourceValue.trim()
    }, {
      onSuccess: () => {
        setNewSourceValue("");
        toast({ title: "Source Added" });
      }
    });
  };

  const NumInput = ({ valueKey, min = 0, max, unit, onChange }: { valueKey: string; min?: number; max?: number; unit?: string; onChange?: (v: number) => void }) => (
    <div className="relative w-16">
      <Input type="number" className={`w-full h-6 text-xs px-2 ${unit ? 'pr-4' : ''}`} min={min} max={max}
        value={(settings as any)[valueKey]}
        onChange={(e) => {
          const v = max !== undefined ? Math.min(max, Number(e.target.value)) : Number(e.target.value);
          setSettings({ ...settings, [valueKey]: v });
          onChange?.(v);
        }}
      />
      {unit && <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">{unit}</span>}
    </div>
  );

  const ActionVariationRow = ({ label, chanceMinKey, chanceMaxKey, maxPerDayMinKey, maxPerDayMaxKey, beforeMinKey, beforeMaxKey, delayMinKey, delayMaxKey, processMinKey, processMaxKey }: { label: string; chanceMinKey: string; chanceMaxKey: string; maxPerDayMinKey: string; maxPerDayMaxKey: string; beforeMinKey: string; beforeMaxKey: string; delayMinKey: string; delayMaxKey: string; processMinKey: string; processMaxKey: string }) => (
    <div className="contents">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <NumInput valueKey={processMinKey} min={1} />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={processMaxKey} min={1} />
      <NumInput valueKey={delayMinKey} min={0} unit="s" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={delayMaxKey} min={0} unit="s" />
      <NumInput valueKey={chanceMinKey} min={0} max={100} unit="%" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={chanceMaxKey} min={0} max={100} unit="%" />
      <NumInput valueKey={beforeMinKey} min={0} max={100} unit="%" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={beforeMaxKey} min={0} max={100} unit="%" />
      <NumInput valueKey={maxPerDayMinKey} min={0} />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={maxPerDayMaxKey} min={0} />
    </div>
  );

  const SettingSlider = ({ label, value, onChange, min = 0, max = 100, step = 1, unit = "%" }: any) => {
    const [localValue, setLocalValue] = useState(value);
    
    // Use an effect to sync local value if the prop changes from outside (e.g. tool change)
    useEffect(() => {
      setLocalValue(value);
    }, [value]);

    return (
      <div className="space-y-2">
        <div className="flex justify-between">
          <Label className="text-xs font-medium">{label}</Label>
          <span className="text-xs text-muted-foreground font-mono">{localValue}{unit}</span>
        </div>
        <input 
          type="range" 
          min={min} 
          max={max} 
          step={step}
          value={localValue} 
          onChange={(e) => {
            const val = Number(e.target.value);
            setLocalValue(val);
          }}
          onMouseUp={() => onChange(localValue)}
          onTouchEnd={() => onChange(localValue)}
          className="w-full h-1.5 bg-accent rounded-lg appearance-none cursor-pointer accent-primary"
        />
      </div>
    );
  };

  // Sources sub-page for Follow tool
  if (tool.type === 'follow' && showSources) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="sm" onClick={() => setShowSources(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Follow Tool
          </Button>
        </div>
        <div className="desktop-card p-6">
          <div className="flex gap-3 mb-6 flex-wrap">
            <form onSubmit={handleAddSource} className="flex gap-3 flex-1 min-w-0">
              <select className="h-10 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 shrink-0"
                value={newSourceType} onChange={(e) => setNewSourceType(e.target.value as any)}>
                <option value="hashtag">Hashtag</option>
                <option value="target_followers">Followers of Account</option>
              </select>
              <Input placeholder={newSourceType === 'hashtag' ? "e.g. #photography" : "e.g. @natgeo"}
                value={newSourceValue} onChange={(e) => setNewSourceValue(e.target.value)} className="flex-1" />
              <Button type="submit" disabled={createSourceMutation.isPending || !newSourceValue.trim()}>
                <Plus className="w-4 h-4 mr-2" /> Add
              </Button>
            </form>
            <input ref={importFileRef} type="file" accept=".txt,.tsv,.csv" className="hidden" onChange={handleImportFile} />
            <Button type="button" variant="outline" disabled={importSourcesMutation.isPending} onClick={() => importFileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" />{importSourcesMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
            <Button type="button" variant="outline" onClick={handleExport}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          </div>
          {(sources?.length ?? 0) > 0 && (
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search sources…"
                value={sourceSearch}
                onChange={e => setSourceSearch(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
              {sourceSearch && (
                <button onClick={() => setSourceSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="space-y-2">
            {sourcesLoading ? (
              <div className="text-center py-10 text-muted-foreground text-sm">Loading sources...</div>
            ) : sources?.length === 0 ? (
              <div className="text-center py-14 bg-accent/50 rounded-xl border border-border/50 border-dashed">
                <Users className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm font-medium">No sources added yet</p>
                <p className="text-xs text-muted-foreground mt-1">Add a hashtag or account above to start targeting followers.</p>
              </div>
            ) : (() => {
              const q = sourceSearch.trim().toLowerCase().replace(/^[#@]/, "");
              const filtered = q ? sources!.filter(s => s.value.toLowerCase().includes(q)) : sources!;
              if (filtered.length === 0) return (
                <div className="text-center py-8 text-muted-foreground text-sm">No sources match "{sourceSearch}"</div>
              );
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {filtered.map(source => (
                    <div key={source.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:bg-accent/30 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                          {source.type === 'hashtag' ? <Hash className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-[150px]">#{source.value}</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            {source.rank != null && (
                              <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">Rank {source.rank}/1000</span>
                            )}
                            {source.nrPosts != null && (
                              <span className="text-[10px] text-muted-foreground">
                                {source.nrPosts >= 1_000_000 ? `${(source.nrPosts/1_000_000).toFixed(1)}M`
                                  : source.nrPosts >= 1_000 ? `${(source.nrPosts/1_000).toFixed(0)}K`
                                  : source.nrPosts} posts
                              </span>
                            )}
                            {source.rank == null && source.nrPosts == null && (
                              <span className="text-xs text-muted-foreground capitalize">{source.type.replace('_', ' ')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => deleteSourceMutation.mutate({ id: source.id, toolId: tool.id })} disabled={deleteSourceMutation.isPending}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }


  // ── Followed Users sub-page ──────────────────────────────────────────────────
  if (tool.type === 'follow' && showFollowedUsers) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300 space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setShowFollowedUsers(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Follow Tool
          </Button>
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <UserPlus className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Followed Users</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                All users followed by this account · sorted by most recent · {followedUsersList?.length ?? 0} total
              </p>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Username</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {followedUsersLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={3} className="px-5 py-3.5 bg-muted/10 h-11" />
                    </tr>
                  ))
                ) : !followedUsersList || followedUsersList.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-5 py-20 text-center text-muted-foreground">
                      <UserPlus className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">No followed users yet</p>
                      <p className="text-xs mt-1">Users will appear here once the follow tool runs.</p>
                    </td>
                  </tr>
                ) : (
                  followedUsersList.map(fu => (
                    <tr key={fu.id} className="hover:bg-accent/5 transition-colors">
                      <td className="px-5 py-3 whitespace-nowrap text-muted-foreground text-xs font-mono">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {format(new Date(fu.followedAt), "MMM d, yyyy HH:mm")}
                        </span>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap font-medium text-foreground">
                        <button
                          data-testid={`link-followed-user-${fu.id}`}
                          onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${fu.instagramUsername}/`)}
                          className="flex items-center gap-1.5 text-primary hover:text-primary/70 hover:underline transition-colors group"
                          title={`Open @${fu.instagramUsername} in browser`}
                        >
                          @{fu.instagramUsername}
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {fu.sourceValue ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-medium">
                            {fu.sourceType === 'hashtag' ? <Hash className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                            {fu.sourceValue}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs"> </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* Header & Master Switch hidden for follow tools (title/desc shown inside the settings wrapper instead) */}
      {tool.type !== 'follow' && (
      <div className="desktop-card p-6">
        <h2 className="text-xl font-bold">Create a Human Session</h2>
        {tool.type !== 'follow' && (
          <>
            <div className="flex items-center gap-3 mt-2">
              <Switch
                checked={tool.enabled}
                onCheckedChange={handleToggleEnable}
                disabled={toggleMutation.isPending}
              />
              <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                {tool.enabled ? 'ACTIVE' : 'STOPPED'}
              </span>
            </div>
          </>
        )}
        <p className="text-sm text-muted-foreground mt-2">Configure limits and target sources for this tool.</p>
        {tool.type !== 'follow' && (
          <>
            <div className="flex items-center gap-4 mt-3">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Run Timer (min)</span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="globalDelayMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                  <Input id="globalDelayMin" type="number" min="0" max="10000" className="w-20 h-7 text-xs"
                    value={settings.delayMin}
                    onChange={(e) => setSettings({...settings, delayMin: Math.min(10000, Number(e.target.value))})}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="globalDelayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                  <Input id="globalDelayMax" type="number" min="0" max="10000" className="w-20 h-7 text-xs"
                    value={settings.delayMax}
                    onChange={(e) => setSettings({...settings, delayMax: Math.min(10000, Number(e.target.value))})}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      <div className={`grid grid-cols-1 ${tool.type !== 'follow' ? 'lg:grid-cols-3' : ''} gap-3`}>
        
        {/* Settings Column */}
        <div className={`${tool.type === 'follow' ? 'col-span-1' : 'lg:col-span-1'} space-y-6`}>
          <div className={`desktop-card ${tool.type === 'follow' ? 'px-6 pb-6 pt-3' : 'p-6'} space-y-4`}>
            {tool.type === 'follow' && (
              <div className="flex items-center gap-2 flex-wrap mb-4 pb-3 border-b border-border">
                <h2 className="text-sm font-semibold">Follow Tool</h2>
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={handleToggleEnable}
                  disabled={toggleMutation.isPending}
                />
                <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                  {tool.enabled ? 'ACTIVE' : 'STOPPED'}
                </span>
                <button
                  onClick={() => setShowSources(true)}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
                >
                  <Users className="w-3.5 h-3.5 text-primary" />
                  Target Sources
                  <span className="ml-0.5 text-[10px] text-muted-foreground">
                    ({sourcesLoading ? '…' : sources?.length ?? 0})
                  </span>
                </button>
                <button
                  onClick={() => setShowFollowedUsers(true)}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
                >
                  <UserPlus className="w-3.5 h-3.5 text-primary" />
                  Followed Users
                  <span className="ml-0.5 text-[10px] text-muted-foreground">
                    ({followedUsersLoading && !followedUsersList ? '…' : followedUsersList?.length ?? 0})
                  </span>
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
                {tool.enabled && (() => {
                  const s = (tool.settings as any) ?? {};
                  const avgDelay      = ((s.delayMin ?? 5) + (s.delayMax ?? 15)) / 2;
                  const avgProcess    = ((s.processMin ?? 5) + (s.processMax ?? 15)) / 2;
                  const avgMaxPerDay  = ((s.maxPerDayMin ?? 0) + (s.maxPerDayMax ?? 0)) / 2;
                  const perHour       = avgDelay > 0 ? Math.round((avgProcess / avgDelay) * 60) : 0;
                  const perDayRaw     = perHour * 24;
                  const perDay        = avgMaxPerDay > 0 ? Math.min(perDayRaw, avgMaxPerDay) : perDayRaw;
                  return perHour > 0 ? (
                    <span className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
                      {perHour}/hr · {perDay}/day
                    </span>
                  ) : null;
                })()}
              </div>
            )}
            <div className="space-y-6">
              <div className="space-y-5">
                {/* Top row: Wait Until Next Session / Users Per Session / Delay After Follow */}
                <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                  {tool.type === 'follow' && (
                    <>
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Wait Until Next Session (min)</h4>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="sessionWaitMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                            <Input id="sessionWaitMin" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayMin}
                              onChange={(e) => setSettings({...settings, delayMin: Number(e.target.value)})}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="sessionWaitMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                            <Input id="sessionWaitMax" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayMax}
                              onChange={(e) => setSettings({...settings, delayMax: Number(e.target.value)})}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                    </>
                  )}

                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Users Per Session</h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="processMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMin}
                          onChange={(e) => setSettings({...settings, processMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="processMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMax}
                          onChange={(e) => setSettings({...settings, processMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>

                  {tool.type === 'follow' && (
                    <>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Delay After Follow (sec)</h4>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="delayAfterFollowMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                            <Input id="delayAfterFollowMin" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayAfterFollowMin}
                              onChange={(e) => setSettings({...settings, delayAfterFollowMin: Number(e.target.value)})}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="delayAfterFollowMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                            <Input id="delayAfterFollowMax" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayAfterFollowMax}
                              onChange={(e) => setSettings({...settings, delayAfterFollowMax: Number(e.target.value)})}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-start gap-x-6 gap-y-4 pt-2 border-t border-border/50">
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Max Actions Per Day <span className="normal-case font-normal">(0 = ∞)</span></h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="maxPerDayMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMin}
                          onChange={(e) => setSettings({...settings, maxPerDayMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="maxPerDayMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMax}
                          onChange={(e) => setSettings({...settings, maxPerDayMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="w-px self-stretch bg-border/50 hidden sm:block" />

                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Scraper Control</h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="abortMin" className="text-xs whitespace-nowrap text-muted-foreground">Abort Min</Label>
                        <Input id="abortMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.abortScrapeAfterMin}
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="abortMax" className="text-xs whitespace-nowrap text-muted-foreground">Abort Max</Label>
                        <Input id="abortMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.abortScrapeAfterMax}
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>

                </div>
              </div>

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="stopOnBlockEnabled"
                        checked={!!(settings as any).stopOnBlockEnabled}
                        onChange={(e) => setSettings({ ...settings, stopOnBlockEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer"
                      />
                      <label htmlFor="stopOnBlockEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap">
                        Stop tool if blocked for
                      </label>
                    </div>
                    <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).stopOnBlockEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <Input
                        type="number"
                        min="1"
                        max="1440"
                        className="w-16 h-7 text-xs"
                        value={(settings as any).stopOnBlockMinutes ?? 60}
                        onChange={(e) => setSettings({ ...settings, stopOnBlockMinutes: Math.max(1, Number(e.target.value)) } as any)}
                      />
                      <span className="text-xs text-muted-foreground">minutes</span>
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-3">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Injection Settings</h4>
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          id="injectSearchEnabled"
                          checked={!!(settings as any).injectSearchEnabled}
                          onChange={(e) => setSettings({ ...settings, injectSearchEnabled: e.target.checked } as any)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer"
                        />
                        <label htmlFor="injectSearchEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                          Inject SearchByUsername
                        </label>
                      </div>
                      <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).injectSearchEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectSearchMin ?? 30}
                          onChange={(e) => setSettings({ ...settings, injectSearchMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectSearchMax ?? 50}
                          onChange={(e) => setSettings({ ...settings, injectSearchMax: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                    </div>
                    <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          id="injectSuggestedEnabled"
                          checked={!!(settings as any).injectSuggestedEnabled}
                          onChange={(e) => setSettings({ ...settings, injectSuggestedEnabled: e.target.checked } as any)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer"
                        />
                        <label htmlFor="injectSuggestedEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                          Inject GetSuggestedUsers
                        </label>
                      </div>
                      <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).injectSuggestedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectSuggestedMin ?? 40}
                          onChange={(e) => setSettings({ ...settings, injectSuggestedMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectSuggestedMax ?? 60}
                          onChange={(e) => setSettings({ ...settings, injectSuggestedMax: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                    </div>
                    <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                    {/* ── Inject Profile Browsing ── */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          id="injectProfileBrowsingEnabled"
                          checked={!!(settings as any).injectProfileBrowsingEnabled}
                          onChange={(e) => setSettings({ ...settings, injectProfileBrowsingEnabled: e.target.checked } as any)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer"
                        />
                        <label htmlFor="injectProfileBrowsingEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                          Inject Profile Browsing
                        </label>
                      </div>
                      <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).injectProfileBrowsingEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectProfileBrowsingMin ?? 30}
                          onChange={(e) => setSettings({ ...settings, injectProfileBrowsingMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" min="0" max="100" className="w-14 h-8 text-xs"
                          value={(settings as any).injectProfileBrowsingMax ?? 50}
                          onChange={(e) => setSettings({ ...settings, injectProfileBrowsingMax: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                      {!!(settings as any).injectProfileBrowsingEnabled && (
                        <div className="flex items-center gap-1.5 flex-nowrap pt-0.5 overflow-x-auto">
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">FEED POSTS</span>
                          <Input type="number" min="1" max="30" className="w-10 h-7 text-xs shrink-0"
                            value={(settings as any).injectProfileBrowsingFeedMin ?? 3}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingFeedMin: Math.max(1, Number(e.target.value)) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input type="number" min="1" max="30" className="w-10 h-7 text-xs shrink-0"
                            value={(settings as any).injectProfileBrowsingFeedMax ?? 6}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingFeedMax: Math.max(1, Number(e.target.value)) } as any)}
                          />
                          <div className="w-px h-4 bg-border/50 shrink-0 mx-0.5" />
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">OPEN POST%</span>
                          <Input type="number" min="0" max="100" className="w-10 h-7 text-xs shrink-0"
                            value={(settings as any).injectProfileBrowsingPostPctMin ?? 0}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingPostPctMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                          <Input type="number" min="0" max="100" className="w-10 h-7 text-xs shrink-0"
                            value={(settings as any).injectProfileBrowsingPostPctMax ?? 0}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingPostPctMax: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground shrink-0">%</span>
                          <div className="w-px h-4 bg-border/50 shrink-0 mx-0.5" />
                          <input
                            type="checkbox"
                            id="injectProfileBrowsingBeforeFollow"
                            checked={!!(settings as any).injectProfileBrowsingBeforeFollow}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingBeforeFollow: e.target.checked } as any)}
                            className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                          />
                          <label htmlFor="injectProfileBrowsingBeforeFollow" className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">
                            Browse Before Follow
                          </label>
                          <Input type="number" min="0" max="100" className={`w-10 h-7 text-xs shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingBeforeFollow ? 'opacity-40 pointer-events-none' : ''}`}
                            value={(settings as any).injectProfileBrowsingBeforeFollowPctMin ?? 0}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingBeforeFollowPctMin: Number(e.target.value) } as any)}
                          />
                          <span className={`text-[10px] text-muted-foreground shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingBeforeFollow ? 'opacity-40' : ''}`}>–</span>
                          <Input type="number" min="0" max="100" className={`w-10 h-7 text-xs shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingBeforeFollow ? 'opacity-40 pointer-events-none' : ''}`}
                            value={(settings as any).injectProfileBrowsingBeforeFollowPctMax ?? 100}
                            onChange={(e) => setSettings({ ...settings, injectProfileBrowsingBeforeFollowPctMax: Number(e.target.value) } as any)}
                          />
                          <span className={`text-[10px] text-muted-foreground shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingBeforeFollow ? 'opacity-40' : ''}`}>%</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="autoFollowUnfollowEnabled"
                      checked={!!(settings as any).autoFollowUnfollowEnabled}
                      onChange={(e) => setSettings({ ...settings, autoFollowUnfollowEnabled: e.target.checked } as any)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor="autoFollowUnfollowEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                      Enable Automatic Follow / Unfollow
                    </label>
                  </div>
                  <div className={`space-y-3 pl-1 transition-opacity ${!(settings as any).autoFollowUnfollowEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Stop follow tool when followings reaches</h4>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStopFollowAtFollowingsMin ?? 7400}
                            onChange={(e) => setSettings({ ...settings, autoStopFollowAtFollowingsMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStopFollowAtFollowingsMax ?? 7400}
                            onChange={(e) => setSettings({ ...settings, autoStopFollowAtFollowingsMax: Number(e.target.value) } as any)}
                          />
                        </div>
                      </div>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Start unfollow tool after (minutes)</h4>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartUnfollowAfterMin ?? 60}
                            onChange={(e) => setSettings({ ...settings, autoStartUnfollowAfterMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartUnfollowAfterMax ?? 135}
                            onChange={(e) => setSettings({ ...settings, autoStartUnfollowAfterMax: Number(e.target.value) } as any)}
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      When your followings count (from sync) reaches the target, the follow tool stops automatically and the unfollow tool is enabled after the set delay. Based on synced following count only — not related to followers.
                    </p>
                  </div>
                </div>
              )}

              {tool.type === 'unfollow' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Unfollow Settings</h4>
                  <div className="flex flex-wrap gap-x-6 gap-y-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Min Follow Age (days)</Label>
                      <Input type="number" className="w-24 h-8 text-xs"
                        value={(settings as any).minFollowAgeDays ?? 3}
                        onChange={(e) => setSettings({ ...settings, minFollowAgeDays: Number(e.target.value) } as any)}
                      />
                      <p className="text-[10px] text-muted-foreground">Only unfollow accounts followed at least this many days ago.</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Delay after Unfollow (s)</Label>
                      <div className="flex items-center gap-1.5">
                        <Input type="number" className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMin ?? 5}
                          onChange={(e) => setSettings({ ...settings, delayAfterUnfollowMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMax ?? 15}
                          onChange={(e) => setSettings({ ...settings, delayAfterUnfollowMax: Number(e.target.value) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                  {/* Enable Automatic Follows — triggers when followings drop to threshold */}
                  <div className="pt-2 border-t border-border/50 space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="autoFollowEnabled"
                        checked={!!(settings as any).autoFollowEnabled}
                        onChange={(e) => setSettings({ ...settings, autoFollowEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer"
                      />
                      <label htmlFor="autoFollowEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                        Enable Automatic Follows
                      </label>
                    </div>
                    <div className={`space-y-3 pl-1 transition-opacity ${!(settings as any).autoFollowEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Stop unfollow tool &amp; activate follow tool when followings drops to</h4>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartFollowAtFollowingsMin ?? 5000}
                            onChange={(e) => setSettings({ ...settings, autoStartFollowAtFollowingsMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartFollowAtFollowingsMax ?? 5000}
                            onChange={(e) => setSettings({ ...settings, autoStartFollowAtFollowingsMax: Number(e.target.value) } as any)}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          id="autoStartFollowStaggerEnabled"
                          checked={!!(settings as any).autoStartFollowStaggerEnabled}
                          onChange={(e) => setSettings({ ...settings, autoStartFollowStaggerEnabled: e.target.checked } as any)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer"
                        />
                        <label htmlFor="autoStartFollowStaggerEnabled" className="text-xs text-muted-foreground cursor-pointer select-none">
                          Activate tool after
                        </label>
                        <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).autoStartFollowStaggerEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                          <Input type="number" min="0" className="w-16 h-7 text-xs"
                            value={(settings as any).autoStartFollowAfterMin ?? 60}
                            onChange={(e) => setSettings({ ...settings, autoStartFollowAfterMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-16 h-7 text-xs"
                            value={(settings as any).autoStartFollowAfterMax ?? 120}
                            onChange={(e) => setSettings({ ...settings, autoStartFollowAfterMax: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">minutes</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        When your followings count (from sync) drops to the target, the unfollow tool stops automatically and the follow tool is enabled. Based on synced following count only — not related to followers.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 border-t border-border/50">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="unfollowStopOnBlockEnabled"
                        checked={!!(settings as any).stopOnBlockEnabled}
                        onChange={(e) => setSettings({ ...settings, stopOnBlockEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer"
                      />
                      <label htmlFor="unfollowStopOnBlockEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap">
                        Stop tool if blocked for
                      </label>
                    </div>
                    <div className={`flex items-center gap-1.5 transition-opacity ${!(settings as any).stopOnBlockEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <Input
                        type="number"
                        min="1"
                        max="1440"
                        className="w-16 h-7 text-xs"
                        value={(settings as any).stopOnBlockMinutes ?? 60}
                        onChange={(e) => setSettings({ ...settings, stopOnBlockMinutes: Math.max(1, Number(e.target.value)) } as any)}
                      />
                      <span className="text-xs text-muted-foreground">minutes</span>
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'dm' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Outbound DM Messages</h4>
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">One message per line. Supports spintax: <code className="bg-muted px-1 rounded">{"{Hi|Hey} [FIRSTNAME]"}</code>. The engine picks one at random for each send.</p>
                    <textarea
                      className="flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={"{Hi|Hey} there! Loved your content 🔥\n{Hello|Hey} [FIRSTNAME], check out our page!"}
                      value={(settings as any).dmMessages ?? ""}
                      onChange={(e) => setSettings({ ...settings, dmMessages: e.target.value } as any)}
                    />
                  </div>
                </div>
              )}

              {tool.type === 'dm' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Auto Reply Feature</h4>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="autoReplyEnabled" className="text-xs font-medium">Enable Auto Reply</Label>
                      <Switch 
                        id="autoReplyEnabled" 
                        checked={settings.autoReplyEnabled} 
                        onCheckedChange={(val) => setSettings({...settings, autoReplyEnabled: val})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="autoReplyTrigger" className="text-xs">Trigger Word (on reply)</Label>
                      <Input 
                        id="autoReplyTrigger" 
                        placeholder="e.g. price, info"
                        value={settings.autoReplyTrigger}
                        onChange={(e) => setSettings({...settings, autoReplyTrigger: e.target.value})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="autoReplyMessage" className="text-xs">Reply Message</Label>
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Supports spin tax: <code className="bg-muted px-1 rounded">{`{Hi|Hello}`}</code> and <code className="bg-muted px-1 rounded">[FIRSTNAME]</code>
                      </div>
                      <textarea 
                        id="autoReplyMessage" 
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder="e.g. {Hi|Hello} [FIRSTNAME], thanks for reaching out!"
                        value={settings.autoReplyMessage}
                        onChange={(e) => setSettings({...settings, autoReplyMessage: e.target.value})}
                      />
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'follow' && (
                <div className="mt-4 border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold flex items-center gap-2">
                      <Activity className="w-4 h-4 text-primary" /> Session Action Variation
                    </h4>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="sessionActionVariationEnabled"
                        checked={!!(settings as any).sessionActionVariationEnabled}
                        onChange={(e) => setSettings({ ...settings, sessionActionVariationEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer"
                      />
                      <label htmlFor="sessionActionVariationEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                        Enabled
                      </label>
                    </div>
                  </div>
                  {/* 16-column grid: [label] [min–max] [min–max] [min–max] [min–max] [min–max] */}
                  <div
                    className={`grid items-center gap-x-1.5 gap-y-1.5 transition-opacity ${!(settings as any).sessionActionVariationEnabled ? 'opacity-40 pointer-events-none' : ''}`}
                    style={{ gridTemplateColumns: '5.5rem 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr' }}
                  >
                    {/* Header row */}
                    <span />
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Process</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Delay (s)</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Chance %</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Before %</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">/day (0=∞)</span>
                    {/* Divider */}
                    <div className="border-b border-border/40 h-px" style={{ gridColumn: '1 / -1' }} />
                    {/* Data rows */}
                    <ActionVariationRow
                      label="Like Posts"
                      chanceMinKey="likeChanceMin" chanceMaxKey="likeChanceMax"
                      maxPerDayMinKey="likeMaxPerDayMin" maxPerDayMaxKey="likeMaxPerDayMax"
                      beforeMinKey="likeBeforeMin" beforeMaxKey="likeBeforeMax"
                      delayMinKey="likeDelayMin" delayMaxKey="likeDelayMax"
                      processMinKey="likeProcessMin" processMaxKey="likeProcessMax"
                    />
                    <ActionVariationRow
                      label="View Reels"
                      chanceMinKey="viewReelsChanceMin" chanceMaxKey="viewReelsChanceMax"
                      maxPerDayMinKey="viewReelsMaxPerDayMin" maxPerDayMaxKey="viewReelsMaxPerDayMax"
                      beforeMinKey="viewReelsBeforeMin" beforeMaxKey="viewReelsBeforeMax"
                      delayMinKey="viewReelsDelayMin" delayMaxKey="viewReelsDelayMax"
                      processMinKey="viewReelsProcessMin" processMaxKey="viewReelsProcessMax"
                    />
                    <ActionVariationRow
                      label="View Stories"
                      chanceMinKey="viewStoriesChanceMin" chanceMaxKey="viewStoriesChanceMax"
                      maxPerDayMinKey="viewStoriesMaxPerDayMin" maxPerDayMaxKey="viewStoriesMaxPerDayMax"
                      beforeMinKey="viewStoriesBeforeMin" beforeMaxKey="viewStoriesBeforeMax"
                      delayMinKey="viewStoriesDelayMin" delayMaxKey="viewStoriesDelayMax"
                      processMinKey="viewStoriesProcessMin" processMaxKey="viewStoriesProcessMax"
                    />
                    <ActionVariationRow
                      label="View Highlights"
                      chanceMinKey="viewHighlightsChanceMin" chanceMaxKey="viewHighlightsChanceMax"
                      maxPerDayMinKey="viewHighlightsMaxPerDayMin" maxPerDayMaxKey="viewHighlightsMaxPerDayMax"
                      beforeMinKey="viewHighlightsBeforeMin" beforeMaxKey="viewHighlightsBeforeMax"
                      delayMinKey="viewHighlightsDelayMin" delayMaxKey="viewHighlightsDelayMax"
                      processMinKey="viewHighlightsProcessMin" processMaxKey="viewHighlightsProcessMax"
                    />
                  </div>
                </div>
              )}

              {/* ── Filters ─────────────────────────────────────────── */}
              {tool.type === 'follow' && (
                <div className="mt-4 border border-border rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold flex items-center gap-2">
                    <ListFilter className="w-4 h-4 text-primary" /> Filters
                  </h4>
                  <p className="text-[11px] text-muted-foreground">
                    Users who match an enabled filter are skipped and added to the global skip list.
                  </p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Skip Indian Users</p>
                      <p className="text-[11px] text-muted-foreground">Fetches the user's name and bio and skips if any Indic script characters are found in either (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, etc.).</p>
                    </div>
                    <Switch
                      checked={!!(settings as any).skipIndianUsers}
                      onCheckedChange={(v) => setSettings({ ...settings, skipIndianUsers: v } as any)}
                      className="data-[state=checked]:bg-green-500 ml-4 shrink-0"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Sources Column hidden for follow tool (sources are above the toggle) */}
        {tool.type !== 'follow' && (
        <div className="lg:col-span-2 space-y-6">
          <div className="desktop-card p-6">
            <h3 className="font-semibold text-lg border-b border-border pb-3 mb-4">Target Sources</h3>
            
            <div className="flex gap-3 mb-6 flex-wrap">
              <form onSubmit={handleAddSource} className="flex gap-3 flex-1 min-w-0">
                <select 
                  className="h-10 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 shrink-0"
                  value={newSourceType}
                  onChange={(e) => setNewSourceType(e.target.value as any)}
                >
                  <option value="hashtag">Hashtag</option>
                  <option value="target_followers">Followers of Account</option>
                </select>
                <Input 
                  placeholder={newSourceType === 'hashtag' ? "e.g. #photography" : "e.g. @natgeo"} 
                  value={newSourceValue}
                  onChange={(e) => setNewSourceValue(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" disabled={createSourceMutation.isPending || !newSourceValue.trim()}>
                  <Plus className="w-4 h-4 mr-2" /> Add
                </Button>
              </form>
              <Button
                type="button"
                variant="outline"
                disabled={importSourcesMutation.isPending}
                onClick={() => importFileRef.current?.click()}
              >
                <Upload className="w-4 h-4 mr-2" />
                {importSourcesMutation.isPending ? 'Importing…' : 'Import'}
              </Button>
              <Button type="button" variant="outline" onClick={handleExport}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            </div>

            {(sources?.length ?? 0) > 0 && (
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search sources…"
                  value={sourceSearch}
                  onChange={e => setSourceSearch(e.target.value)}
                  className="pl-9 h-9 text-sm"
                />
                {sourceSearch && (
                  <button onClick={() => setSourceSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <div className="space-y-2">
              {sourcesLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading sources...</div>
              ) : sources?.length === 0 ? (
                <div className="text-center py-12 bg-accent/50 rounded-lg border border-border/50 border-dashed">
                  <p className="text-muted-foreground text-sm">No sources added yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Add targets above to start automating.</p>
                </div>
              ) : (() => {
                const q = sourceSearch.trim().toLowerCase().replace(/^[#@]/, "");
                const filtered = q ? sources!.filter(s => s.value.toLowerCase().includes(q)) : sources!;
                if (filtered.length === 0) return (
                  <div className="text-center py-8 text-muted-foreground text-sm">No sources match "{sourceSearch}"</div>
                );
                return filtered.map(source => (
                  <div key={source.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:bg-accent/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary shrink-0">
                        {source.type === 'hashtag' ? <Hash className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{source.type === 'hashtag' ? `#${source.value}` : source.value}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {source.rank != null && (
                            <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                              Rank {source.rank}/1000
                            </span>
                          )}
                          {source.nrPosts != null && (
                            <span className="text-[10px] text-muted-foreground">
                              {source.nrPosts >= 1_000_000
                                ? `${(source.nrPosts / 1_000_000).toFixed(1)}M`
                                : source.nrPosts >= 1_000
                                ? `${(source.nrPosts / 1_000).toFixed(0)}K`
                                : source.nrPosts} posts
                            </span>
                          )}
                          {source.rank == null && source.nrPosts == null && (
                            <span className="text-xs text-muted-foreground capitalize">{source.type.replace('_', ' ')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteSourceMutation.mutate({ id: source.id, toolId: tool.id })}
                      disabled={deleteSourceMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
        )}

      </div>

      <CopySettingsDialog
        key={_copyOpen ? "open" : "closed"}
        open={_copyOpen}
        onOpenChange={_setCopyOpen}
        title="Copy Follow Tool Settings"
        profiles={otherProfiles}
        optionGroups={FOLLOW_TOOL_COPY_GROUPS}
        onCopy={handleFollowToolCopy}
      />
    </div>
  );
}
