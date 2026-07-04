import { useState, useEffect, useTransition, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { useSources, useCreateSource, useDeleteSource, useUpdateSource, useImportSources, useClearSources, useClearSourcesByType, parseJarveeHashtagFile } from "@/hooks/use-sources";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumField } from "@/components/ui/num-field";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Hash, Users, ChevronRight, ArrowLeft, Copy, X, Upload, Download, ListFilter, UserPlus, Clock, ExternalLink, Activity, Heart, PlaySquare, BookOpen, Star, UserCheck, Ban, AlertCircle, MessageSquare, Bell, User, RefreshCw, Settings, Repeat2, Image, AtSign, TrendingUp, Search } from "lucide-react";
import { useRef } from "react";
import { type Tool, type Profile, type FollowedUser, type SessionAction } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { api } from "@shared/routes";
interface ToolConfigPanelProps {
  tool: Tool;
  profile: Profile;
  copyOpen?: boolean;
  onCopyOpenChange?: (v: boolean) => void;
  hideEnableToggle?: boolean;
  skipChanceMin?: number;
  skipChanceMax?: number;
  executeEveryMin?: number;
  executeEveryMax?: number;
  overrideProfiles?: Profile[];
}


export function ToolConfigPanel({ tool, profile, copyOpen: copyOpenProp, onCopyOpenChange, hideEnableToggle, skipChanceMin, skipChanceMax, executeEveryMin, executeEveryMax, overrideProfiles }: ToolConfigPanelProps) {
  const { toast } = useToast();
  const { navigateTo } = useBrowserWindows();
  const updateToolMutation = useUpdateTool();  // settings saves
  const toggleMutation     = useUpdateTool();  // enable/disable never blocked by settings save
  const { data: sources, isLoading: sourcesLoading } = useSources(tool.id);
  const createSourceMutation = useCreateSource();
  const deleteSourceMutation = useDeleteSource();
  const importSourcesMutation = useImportSources();
  const updateSourceMutation = useUpdateSource();
  const clearSourcesMutation = useClearSources();
  const clearSourcesByTypeMutation = useClearSourcesByType();
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
      hashtagSourceRanking: 50,
      followerSourceRanking: 50,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const [newSourceType, setNewSourceType] = useState<'hashtag' | 'target_followers'>('hashtag');
  const [newSourceValue, setNewSourceValue] = useState("");
  const [localPriorities, setLocalPriorities] = useState<Record<number, string>>({});
  const [sourceSearch, setSourceSearch] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [newHashtagValue, setNewHashtagValue] = useState("");
  const [newFollowerValue, setNewFollowerValue] = useState("");
  const [hashtagSectionOpen, setHashtagSectionOpen] = useState(true);
  const [followerSectionOpen, setFollowerSectionOpen] = useState(true);
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);
  const [, startSourcesTransition] = useTransition();

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
  const [showBrowsingDialog, setShowBrowsingDialog] = useState(false);
  const _copyOpen = copyOpenProp ?? showCopyModal;
  const _setCopyOpen = onCopyOpenChange ?? _setShowCopyModal;
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = overrideProfiles ?? allProfiles.filter(p => p.id !== tool.profileId && !p.locked && !p.isTemplate);
  const hasOtherProfiles = allProfiles.some(p => p.id !== tool.profileId);

  // ── Follow Tool copy option groups ──────────────────────────────
  const FOLLOW_TOOL_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "General", options: [
      { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
      { key: "randomiseTiming", label: "Randomise timing", description: "Spread each account's session start times across the Wait Until Next Session window so they don't all fire simultaneously" },
    ]},
    { label: "Timing", options: [
      { key: "ft_timing", label: "Timing", description: "Delays and wait times between actions", subOptions: [
        { key: "ft_delayAfterFollow", label: "Delay after each follow",  settingKeys: ["delayAfterFollowMin","delayAfterFollowMax"] },
      ]},
    ]},
    { label: "Limits", options: [
      { key: "ft_limits", label: "Limits", description: "Caps on how many follow actions are taken", subOptions: [
        { key: "ft_usersPerSession", label: "Users per session",      settingKeys: ["processMin","processMax"] },
        { key: "ft_maxPerDay",       label: "Max actions per day",    settingKeys: ["maxPerDayMin","maxPerDayMax"] },
        { key: "ft_maxPerHour",      label: "Max actions per hour",   settingKeys: ["maxPerHourMin","maxPerHourMax"] },
      ]},
    ]},
    { label: "Scraping", options: [
      { key: "ft_scraping", label: "Scraping", description: "Source quality and follow-age filters", subOptions: [
        { key: "ft_scrapeAbort",  label: "Abort scrape after", settingKeys: ["abortScrapeAfterMin","abortScrapeAfterMax"] },
        { key: "ft_minFollowAge", label: "Min follow age",                  settingKeys: ["minFollowAgeDays"] },
      ]},
    ]},
    { label: "Injection Settings", options: [
      { key: "ft_injection", label: "Injection Settings", description: "API calls injected between follows to simulate natural behaviour", subOptions: [
        { key: "ft_injectSearch",    label: "Inject SearchByUsername",  settingKeys: ["injectSearchEnabled","injectSearchMin","injectSearchMax"] },
        { key: "ft_injectSuggested", label: "Inject GetSuggestedUsers", settingKeys: ["injectSuggestedEnabled","injectSuggestedMin","injectSuggestedMax"] },
        { key: "ft_injectProfileBrowsing", label: "Inject Profile Browsing", settingKeys: ["injectProfileBrowsingEnabled","injectProfileBrowsingMin","injectProfileBrowsingMax","injectProfileBrowsingFeedChanceMin","injectProfileBrowsingFeedChanceMax","injectProfileBrowsingFeedMin","injectProfileBrowsingFeedMax","injectProfileBrowsingFeedOrderMin","injectProfileBrowsingFeedOrderMax","injectProfileBrowsingPostPctMin","injectProfileBrowsingPostPctMax","injectProfileBrowsingLikePctMin","injectProfileBrowsingLikePctMax","injectProfileBrowsingLikeScrollMin","injectProfileBrowsingLikeScrollMax","injectProfileBrowsingLikePctOrderMin","injectProfileBrowsingLikePctOrderMax","injectProfileBrowsingSaveMediaPctMin","injectProfileBrowsingSaveMediaPctMax","injectProfileBrowsingSaveMediaScrollMin","injectProfileBrowsingSaveMediaScrollMax","injectProfileBrowsingSaveMediaPctOrderMin","injectProfileBrowsingSaveMediaPctOrderMax","injectProfileBrowsingWatchStoriesPctMin","injectProfileBrowsingWatchStoriesPctMax","injectProfileBrowsingWatchStoriesScrollMin","injectProfileBrowsingWatchStoriesScrollMax","injectProfileBrowsingWatchStoriesPctOrderMin","injectProfileBrowsingWatchStoriesPctOrderMax","injectProfileBrowsingViewHighlightsPctMin","injectProfileBrowsingViewHighlightsPctMax","injectProfileBrowsingViewHighlightsScrollMin","injectProfileBrowsingViewHighlightsScrollMax","injectProfileBrowsingViewHighlightsPctOrderMin","injectProfileBrowsingViewHighlightsPctOrderMax","injectProfileBrowsingViewReelsPctMin","injectProfileBrowsingViewReelsPctMax","injectProfileBrowsingViewReelsScrollMin","injectProfileBrowsingViewReelsScrollMax","injectProfileBrowsingViewReelsPctOrderMin","injectProfileBrowsingViewReelsPctOrderMax","injectProfileBrowsingCommentEnabled","injectProfileBrowsingCommentPctMin","injectProfileBrowsingCommentPctMax","injectProfileBrowsingCommentPctOrderMin","injectProfileBrowsingCommentPctOrderMax","injectProfileBrowsingCommentText","injectProfileBrowsingShareToDmPctMin","injectProfileBrowsingShareToDmPctMax","injectProfileBrowsingShareToDmPctOrderMin","injectProfileBrowsingShareToDmPctOrderMax","injectProfileBrowsingBeforeFollow","injectProfileBrowsingBeforeFollowPctMin","injectProfileBrowsingBeforeFollowPctMax","injectProfileBrowsingAbandonFollow","injectProfileBrowsingAbandonFollowPctMin","injectProfileBrowsingAbandonFollowPctMax","injectProfileBrowsingAbandonFollowOrderMin","injectProfileBrowsingAbandonFollowOrderMax"] },
      ]},
    ]},
    { label: "Filters", options: [
      { key: "ft_filters", label: "Filters", description: "Account quality filters applied before following", subOptions: [
        { key: "ft_skipIndian", label: "Skip Indian Users", settingKeys: ["skipIndianUsers"] },
      ]},
    ]},
    { label: "Auto Follow / Unfollow", options: [
      { key: "ft_autoFU", label: "Auto Follow / Unfollow", description: "Automatic switching between follow and unfollow tools", subOptions: [
        { key: "ft_autoEnabled",    label: "Enabled",                                      settingKeys: ["autoFollowUnfollowEnabled"] },
        { key: "ft_autoStopAt",     label: "Stop follow at followings count",  settingKeys: ["autoStopFollowAtFollowingsMin","autoStopFollowAtFollowingsMax"] },
        { key: "ft_autoStartAfter", label: "Start unfollow after",        settingKeys: ["autoStartUnfollowAfterMin","autoStartUnfollowAfterMax"] },
      ]},
    ]},
    { label: "Session Action Variation", options: [
      { key: "ft_sav", label: "Session Action Variation", description: "Extra actions performed during a follow session", subOptions: [
        { key: "ft_sav_enabled",       label: "Enabled",                                          settingKeys: ["sessionActionVariationEnabled"] },
        { key: "ft_likeChance",        label: "Like Chance %",                      settingKeys: ["likeChanceMin","likeChanceMax"] },
        { key: "ft_likeCount",         label: "Like Posts to like",                 settingKeys: ["likeProcessMin","likeProcessMax"] },
        { key: "ft_likeBefore",        label: "Like Before follow %",               settingKeys: ["likeBeforeMin","likeBeforeMax"] },
        { key: "ft_likeMaxDay",        label: "Like Max per day",                   settingKeys: ["likeMaxPerDayMin","likeMaxPerDayMax"] },
        { key: "ft_likeDelay",         label: "Like Delay between likes",      settingKeys: ["likeDelayMin","likeDelayMax"] },
        { key: "ft_reelsChance",       label: "Reels Chance %",                     settingKeys: ["viewReelsChanceMin","viewReelsChanceMax"] },
        { key: "ft_reelsCount",        label: "Reels Count to watch",               settingKeys: ["viewReelsProcessMin","viewReelsProcessMax"] },
        { key: "ft_reelsBefore",       label: "Reels Before follow %",              settingKeys: ["viewReelsBeforeMin","viewReelsBeforeMax"] },
        { key: "ft_reelsMaxDay",       label: "Reels Max per day",                  settingKeys: ["viewReelsMaxPerDayMin","viewReelsMaxPerDayMax"] },
        { key: "ft_reelsDelay",        label: "Reels Delay",                   settingKeys: ["viewReelsDelayMin","viewReelsDelayMax"] },
        { key: "ft_storiesChance",     label: "Stories Chance %",                   settingKeys: ["viewStoriesChanceMin","viewStoriesChanceMax"] },
        { key: "ft_storiesCount",      label: "Stories Count to watch",             settingKeys: ["viewStoriesProcessMin","viewStoriesProcessMax"] },
        { key: "ft_storiesBefore",     label: "Stories Before follow %",            settingKeys: ["viewStoriesBeforeMin","viewStoriesBeforeMax"] },
        { key: "ft_storiesMaxDay",     label: "Stories Max per day",                settingKeys: ["viewStoriesMaxPerDayMin","viewStoriesMaxPerDayMax"] },
        { key: "ft_storiesDelay",      label: "Stories Delay",                 settingKeys: ["viewStoriesDelayMin","viewStoriesDelayMax"] },
        { key: "ft_hlChance",          label: "Highlights Chance %",                settingKeys: ["viewHighlightsChanceMin","viewHighlightsChanceMax"] },
        { key: "ft_hlCount",           label: "Highlights Count to watch",          settingKeys: ["viewHighlightsProcessMin","viewHighlightsProcessMax"] },
        { key: "ft_hlBefore",          label: "Highlights Before follow %",         settingKeys: ["viewHighlightsBeforeMin","viewHighlightsBeforeMax"] },
        { key: "ft_hlMaxDay",          label: "Highlights Max per day",             settingKeys: ["viewHighlightsMaxPerDayMin","viewHighlightsMaxPerDayMax"] },
        { key: "ft_hlDelay",           label: "Highlights Delay",              settingKeys: ["viewHighlightsDelayMin","viewHighlightsDelayMax"] },
      ]},
    ]},
    { label: "Stop if Blocked", options: [
      { key: "ft_stopOnBlock", label: "Stop if Blocked", description: "Pause the tool for a set time when Instagram blocks a follow action", subOptions: [
        { key: "ft_stopOnBlockEnabled", label: "Enabled",              settingKeys: ["stopOnBlockEnabled"] },
        { key: "ft_stopOnBlockMinutes", label: "Stop duration", settingKeys: ["stopOnBlockMinutes"] },
      ]},
    ]},
    { label: "Sources", options: [
      { key: "ft_sources", label: "Target Sources", description: "Copy all target sources to other profiles — adds to their existing sources" },
      { key: "ft_clearSources", label: "Clear Sources First", description: "Remove all existing sources from destination profiles before copying" },
    ]},
  ];

  const handleFollowToolCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled       = expandedKeys.includes("startStop");
    const copySources       = expandedKeys.includes("ft_sources");
    const clearSourcesFirst = expandedKeys.includes("ft_clearSources");
    const keysToSend        = expandedKeys.filter(k => k !== "startStop" && k !== "ft_sources" && k !== "ft_clearSources");

    // When "Randomise timing" is selected and accounts are being enabled,
    // give each account a random start time within [delayMin, delayMax] so
    // they don't all fire at the same moment. This mirrors what the engine
    // does on a cold startup (randInt(delayMin, delayMax)).
    const willRandomise = expandedKeys.includes("randomiseTiming");
    let staggerOffsets: number[] | undefined;
    if (willRandomise) {
      const delayMin = Math.max(1, (settings as any).delayMin ?? 1);
      const delayMax = Math.max(delayMin, (settings as any).delayMax ?? 5);
      staggerOffsets = targetIds.map(() =>
        delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
      );
    }

    try {
      await copyToolSettingsToProfiles(
        settings as Record<string, unknown>,
        tool.type,
        targetIds,
        keysToSend,
        copyEnabled ? tool.enabled : undefined,
        staggerOffsets,
      );
    } catch (err) {
      console.error("[copySettings] Failed to copy follow tool settings:", err);
    }

    if (clearSourcesFirst || copySources) {
      const sourcesRes = copySources
        ? await fetch(`/api/tools/${tool.id}/sources`, { credentials: "include" })
        : null;
      const currentSources: { type: string; value: string; rank?: number | null; nrPosts?: number | null }[] =
        sourcesRes?.ok ? await sourcesRes.json() : [];
      const payload = copySources && currentSources.length > 0
        ? currentSources
            .filter((s: any) => s.enabled !== false)
            .map(s => ({ type: s.type, value: s.value, rank: s.rank, nrPosts: s.nrPosts }))
        : [];

      await Promise.all(
        targetIds.map(async profileId => {
          const toolsRes = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
          if (!toolsRes.ok) return;
          const profileTools: { id: number; type: string }[] = await toolsRes.json();
          const targetTool = profileTools.find(t => t.type === "follow");
          if (!targetTool) return;

          if (clearSourcesFirst) {
            await fetch(`/api/tools/${targetTool.id}/sources`, { method: "DELETE", credentials: "include" });
            queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, targetTool.id] });
          }

          if (payload.length > 0) {
            const importRes = await fetch(`/api/tools/${targetTool.id}/sources/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              credentials: "include",
            });
            if (importRes.ok) {
              queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, targetTool.id] });
            } else {
              console.error(`[copySettings] Sources import failed for profile ${profileId}: ${importRes.status}`);
            }
          }
        })
      );
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

  const NumInput = ({ valueKey, min = 0, max, unit, onChange, pairKey, pairRole }: { valueKey: string; min?: number; max?: number; unit?: string; onChange?: (v: number) => void; pairKey?: string; pairRole?: "min" | "max" }) => (
    <div className="relative w-16">
      <NumField className={`w-full h-6 text-xs px-2 ${unit ? 'pr-4' : ''}`} min={min} max={max}
        value={(settings as any)[valueKey]}
        onChange={(v) => {
          if (pairKey && pairRole === "min") v = Math.min(v, (settings as any)[pairKey] ?? v);
          if (pairKey && pairRole === "max") v = Math.max(v, (settings as any)[pairKey] ?? v);
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
      <NumInput valueKey={processMinKey} min={1} pairKey={processMaxKey} pairRole="min" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={processMaxKey} min={1} pairKey={processMinKey} pairRole="max" />
      <NumInput valueKey={delayMinKey} min={0} unit="s" pairKey={delayMaxKey} pairRole="min" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={delayMaxKey} min={0} unit="s" pairKey={delayMinKey} pairRole="max" />
      <NumInput valueKey={chanceMinKey} min={0} max={100} unit="%" pairKey={chanceMaxKey} pairRole="min" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={chanceMaxKey} min={0} max={100} unit="%" pairKey={chanceMinKey} pairRole="max" />
      <NumInput valueKey={beforeMinKey} min={0} max={100} unit="%" pairKey={beforeMaxKey} pairRole="min" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={beforeMaxKey} min={0} max={100} unit="%" pairKey={beforeMinKey} pairRole="max" />
      <NumInput valueKey={maxPerDayMinKey} min={0} pairKey={maxPerDayMaxKey} pairRole="min" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={maxPerDayMaxKey} min={0} pairKey={maxPerDayMinKey} pairRole="max" />
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
    const hashtags = sources?.filter(s => s.type === 'hashtag') ?? [];
    const followers = sources?.filter(s => s.type === 'target_followers') ?? [];

    const SourceRow = ({ source }: { source: NonNullable<typeof sources>[number] }) => {
      const displayPriority = localPriorities[source.id] !== undefined
        ? localPriorities[source.id]
        : String(source.rank ?? 100);
      return (
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded border border-border bg-background hover:bg-accent/30 transition-colors">
          <div className="flex items-center gap-2 min-w-0">
            {source.type === 'hashtag'
              ? <Hash className="w-3.5 h-3.5 text-primary shrink-0" />
              : <Users className="w-3.5 h-3.5 text-primary shrink-0" />}
            <span className="text-sm font-medium truncate">
              {source.type === 'hashtag' ? `#${source.value}` : `@${source.value.replace(/^@/, '')}`}
            </span>
            {source.nrPosts != null && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {source.nrPosts >= 1_000_000 ? `${(source.nrPosts/1_000_000).toFixed(1)}M`
                  : source.nrPosts >= 1_000 ? `${(source.nrPosts/1_000).toFixed(0)}K`
                  : source.nrPosts} posts
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <input
              type="number"
              min={1}
              max={100}
              value={displayPriority}
              title="Pick priority 1–100. Higher = picked more often. Set one source to 100 to use it exclusively."
              onChange={(e) => setLocalPriorities(p => ({ ...p, [source.id]: e.target.value }))}
              onBlur={() => {
                const v = Math.max(1, Math.min(100, parseInt(displayPriority, 10) || 1));
                setLocalPriorities(p => { const n = { ...p }; delete n[source.id]; return n; });
                updateSourceMutation.mutate({ id: source.id, toolId: tool.id, rank: v, enabled: source.enabled !== false });
              }}
              className="w-12 h-5 text-[10px] text-center border border-border rounded px-1 bg-background"
            />
            <span className="text-[10px] text-muted-foreground">%</span>
            <button
              className="ml-1 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 transition-colors"
              onClick={() => deleteSourceMutation.mutate({ id: source.id, toolId: tool.id })}
              disabled={deleteSourceMutation.isPending}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      );
    };

    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="sm" onClick={() => setShowSources(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Follow Tool
          </Button>
        </div>

        <input ref={importFileRef} type="file" accept=".txt,.tsv,.csv" className="hidden" onChange={handleImportFile} />

        <div className="desktop-card p-5 space-y-5">

          {/* ── Hashtags Section ────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <input
                type="checkbox"
                id="hashtagSection"
                checked={hashtagSectionOpen}
                onChange={e => setHashtagSectionOpen(e.target.checked)}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <label htmlFor="hashtagSection" className="text-sm font-bold cursor-pointer select-none flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-primary" /> Hashtags
                <span className="text-xs text-muted-foreground font-normal">({hashtags.length})</span>
              </label>
              <div className="flex items-center gap-1" title="Probability of selecting Hashtags as the source type for each session (1–100)">
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">Ranking</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={(settings as any).hashtagSourceRanking ?? 50}
                  onChange={e => {
                    const v = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
                    setSettings(s => ({ ...s, hashtagSourceRanking: v }));
                  }}
                  className="w-12 h-5 text-[10px] text-center border border-border rounded px-1 bg-background"
                />
                <span className="text-[10px] text-muted-foreground">%</span>
              </div>
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={importSourcesMutation.isPending} onClick={() => importFileRef.current?.click()}>
                  <Upload className="w-3.5 h-3.5 mr-1.5" />{importSourcesMutation.isPending ? 'Importing…' : 'Import'}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleExport} disabled={!hashtags.length}>
                  <Download className="w-3.5 h-3.5 mr-1.5" /> Export
                </Button>
              </div>
            </div>

            {hashtagSectionOpen && (
              <>
                <form
                  onSubmit={e => { e.preventDefault(); if (!newHashtagValue.trim()) return; createSourceMutation.mutate({ toolId: tool.id, type: 'hashtag', value: newHashtagValue.trim().replace(/^#/, '') }, { onSuccess: () => setNewHashtagValue('') }); }}
                  className="flex gap-2 mb-3"
                >
                  <Input
                    placeholder="#photography"
                    value={newHashtagValue}
                    onChange={e => setNewHashtagValue(e.target.value)}
                    className="w-40 h-8 text-sm"
                  />
                  <Button type="submit" size="sm" className="h-8" disabled={!newHashtagValue.trim() || createSourceMutation.isPending}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add
                  </Button>
                </form>

                {sourcesLoading ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">Loading…</div>
                ) : hashtags.length === 0 ? (
                  <div className="text-center py-5 border border-dashed border-border/60 rounded-lg text-muted-foreground text-xs">No hashtags added yet</div>
                ) : (
                  <div className="space-y-1 max-h-[360px] overflow-y-auto pr-0.5 mb-3">
                    {hashtags.map(s => <SourceRow key={s.id} source={s} />)}
                  </div>
                )}

                {hashtags.length > 0 && (
                  <Button type="button" variant="outline" size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30 w-full h-8"
                    disabled={clearSourcesByTypeMutation.isPending}
                    onClick={() => clearSourcesByTypeMutation.mutate({ toolId: tool.id, type: 'hashtag' })}>
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    {clearSourcesByTypeMutation.isPending ? 'Clearing…' : `Clear Hashtags (${hashtags.length})`}
                  </Button>
                )}
              </>
            )}
          </div>

          <div className="border-t border-border/60" />

          {/* ── Followers of Account Section ────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <input
                type="checkbox"
                id="followerSection"
                checked={followerSectionOpen}
                onChange={e => setFollowerSectionOpen(e.target.checked)}
                className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
              />
              <label htmlFor="followerSection" className="text-sm font-bold cursor-pointer select-none flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-primary" /> Followers of Account
                <span className="text-xs text-muted-foreground font-normal">({followers.length})</span>
              </label>
              <div className="flex items-center gap-1 ml-auto" title="Probability of selecting Followers of Account as the source type for each session (1–100)">
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">Ranking</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={(settings as any).followerSourceRanking ?? 50}
                  onChange={e => {
                    const v = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
                    setSettings(s => ({ ...s, followerSourceRanking: v }));
                  }}
                  className="w-12 h-5 text-[10px] text-center border border-border rounded px-1 bg-background"
                />
                <span className="text-[10px] text-muted-foreground">%</span>
              </div>
            </div>

            {followerSectionOpen && (
              <>
                <form
                  onSubmit={e => { e.preventDefault(); if (!newFollowerValue.trim()) return; createSourceMutation.mutate({ toolId: tool.id, type: 'target_followers', value: newFollowerValue.trim().replace(/^@/, '') }, { onSuccess: () => setNewFollowerValue('') }); }}
                  className="flex gap-2 mb-3"
                >
                  <Input
                    placeholder="@natgeo"
                    value={newFollowerValue}
                    onChange={e => setNewFollowerValue(e.target.value)}
                    className="w-40 h-8 text-sm"
                  />
                  <Button type="submit" size="sm" className="h-8" disabled={!newFollowerValue.trim() || createSourceMutation.isPending}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add
                  </Button>
                </form>

                {sourcesLoading ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">Loading…</div>
                ) : followers.length === 0 ? (
                  <div className="text-center py-5 border border-dashed border-border/60 rounded-lg text-muted-foreground text-xs">No accounts added yet</div>
                ) : (
                  <div className="space-y-1 max-h-[360px] overflow-y-auto pr-0.5 mb-3">
                    {followers.map(s => <SourceRow key={s.id} source={s} />)}
                  </div>
                )}

                {followers.length > 0 && (
                  <Button type="button" variant="outline" size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30 w-full h-8"
                    disabled={clearSourcesByTypeMutation.isPending}
                    onClick={() => clearSourcesByTypeMutation.mutate({ toolId: tool.id, type: 'target_followers' })}>
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    {clearSourcesByTypeMutation.isPending ? 'Clearing…' : `Clear Followers (${followers.length})`}
                  </Button>
                )}
              </>
            )}
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
                    onChange={(e) => { const v = Math.min(10000, Math.max(0, Number(e.target.value))); setSettings({...settings, delayMin: v, delayMax: Math.max(v, settings.delayMax ?? 10000)}); }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="globalDelayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                  <Input id="globalDelayMax" type="number" min="0" max="10000" className="w-20 h-7 text-xs"
                    value={settings.delayMax}
                    onChange={(e) => { const v = Math.min(10000, Math.max(0, Number(e.target.value))); setSettings({...settings, delayMax: v, delayMin: Math.min(v, settings.delayMin ?? 0)}); }}
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
                {!hideEnableToggle && (<>
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={handleToggleEnable}
                  disabled={toggleMutation.isPending}
                />
                <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                  {tool.enabled ? 'ACTIVE' : 'STOPPED'}
                </span>
                </>)}
                <button
                  onClick={() => startSourcesTransition(() => setShowSources(true))}
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
                {!hideEnableToggle && nextRunStatus && (
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
                  const avgExecuteEvery   = ((executeEveryMin ?? 30) + (executeEveryMax ?? 60)) / 2;
                  const avgUsersPerSession = ((s.processMin ?? 5) + (s.processMax ?? 15)) / 2;
                  const avgMaxPerDay      = ((s.maxPerDayMin ?? 0) + (s.maxPerDayMax ?? 0)) / 2;
                  const avgSkip           = ((skipChanceMin ?? 0) + (skipChanceMax ?? 0)) / 2;
                  const executionChance   = Math.max(0, 1 - avgSkip / 100);
                  const sessionsPerHour   = avgExecuteEvery > 0 ? 60 / avgExecuteEvery : 0;
                  const perHour           = Math.round(sessionsPerHour * avgUsersPerSession * executionChance);
                  const perDayRaw         = perHour * 24;
                  const perDay            = avgMaxPerDay > 0 ? Math.min(perDayRaw, avgMaxPerDay) : perDayRaw;
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
                {/* Single row: Users Per Session / Delay After Follow / Max Actions Per Day / Scraper Control */}
                <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Users Per Session</h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="processMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMin}
                          onChange={(e) => setSettings({...settings, processMin: Math.min(Number(e.target.value), settings.processMax ?? Infinity)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="processMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMax}
                          onChange={(e) => setSettings({...settings, processMax: Math.max(Number(e.target.value), settings.processMin ?? 0)})}
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
                              onChange={(e) => setSettings({...settings, delayAfterFollowMin: Math.min(Number(e.target.value), settings.delayAfterFollowMax ?? Infinity)})}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="delayAfterFollowMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                            <Input id="delayAfterFollowMax" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayAfterFollowMax}
                              onChange={(e) => setSettings({...settings, delayAfterFollowMax: Math.max(Number(e.target.value), settings.delayAfterFollowMin ?? 0)})}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  <div className="w-px self-stretch bg-border/50 hidden sm:block" />

                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Max Actions Per Day <span className="normal-case font-normal">(0 = ∞)</span></h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="maxPerDayMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMin}
                          onChange={(e) => setSettings({...settings, maxPerDayMin: Math.min(Number(e.target.value), settings.maxPerDayMax ?? Infinity)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="maxPerDayMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMax}
                          onChange={(e) => setSettings({...settings, maxPerDayMax: Math.max(Number(e.target.value), settings.maxPerDayMin ?? 0)})}
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
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMin: Math.min(Number(e.target.value), settings.abortScrapeAfterMax ?? Infinity)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="abortMax" className="text-xs whitespace-nowrap text-muted-foreground">Abort Max</Label>
                        <Input id="abortMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.abortScrapeAfterMax}
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMax: Math.max(Number(e.target.value), settings.abortScrapeAfterMin ?? 0)})}
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
                      <NumField
                        min={1}
                        max={1440}
                        className="w-16 h-7 text-xs"
                        value={(settings as any).stopOnBlockMinutes ?? 60}
                        onChange={(v) => setSettings({ ...settings, stopOnBlockMinutes: v } as any)}
                      />
                      <span className="text-xs text-muted-foreground">minutes</span>
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-2">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Injection Settings</h4>
                  {/* Row 1: Inject Search + Inject Suggested Users + Inject Browsing */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input type="checkbox" id="injectSearchEnabled" checked={!!(settings as any).injectSearchEnabled} onChange={(e) => setSettings({ ...settings, injectSearchEnabled: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                      <label htmlFor="injectSearchEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">Inject Search</label>
                      <div className={`flex items-center gap-1 transition-opacity ${!(settings as any).injectSearchEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <NumField min={1} max={100} className="w-[51px] h-7 text-xs shrink-0" value={(settings as any).injectSearchMin ?? 1} onChange={(v) => setSettings({ ...settings, injectSearchMin: Math.min(v, (settings as any).injectSearchMax ?? 100) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                        <NumField min={1} max={100} className="w-[51px] h-7 text-xs shrink-0" value={(settings as any).injectSearchMax ?? 1} onChange={(v) => setSettings({ ...settings, injectSearchMax: Math.max(v, (settings as any).injectSearchMin ?? 1) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">%</span>
                      </div>
                    </div>
                    <div className="w-px h-5 bg-border/50 shrink-0" />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input type="checkbox" id="injectSuggestedEnabled" checked={!!(settings as any).injectSuggestedEnabled} onChange={(e) => setSettings({ ...settings, injectSuggestedEnabled: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                      <label htmlFor="injectSuggestedEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0" title="GetSuggestedUsers always fires before the first follow every session. Enable this to also re-inject it mid-session at the set % chance per follow.">Inject Suggested Users (Re-inject %)</label>
                      <div className={`flex items-center gap-1 transition-opacity ${!(settings as any).injectSuggestedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <NumField min={1} max={100} className="w-12 h-7 text-xs shrink-0" value={(settings as any).injectSuggestedMin ?? 1} onChange={(v) => setSettings({ ...settings, injectSuggestedMin: Math.min(v, (settings as any).injectSuggestedMax ?? 100) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                        <NumField min={1} max={100} className="w-12 h-7 text-xs shrink-0" value={(settings as any).injectSuggestedMax ?? 1} onChange={(v) => setSettings({ ...settings, injectSuggestedMax: v, injectSuggestedMin: Math.min((settings as any).injectSuggestedMin ?? 1, v) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">%</span>
                      </div>
                    </div>
                    <div className="w-px h-5 bg-border/50 shrink-0" />
                    {/* Inject Browsing — click Open to open dialog */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input type="checkbox" id="injectProfileBrowsingEnabled" checked={!!(settings as any).injectProfileBrowsingEnabled} onChange={(e) => setSettings({ ...settings, injectProfileBrowsingEnabled: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                      <label htmlFor="injectProfileBrowsingEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">Inject Browsing</label>
                      <div className={`flex items-center gap-1 transition-opacity ${!(settings as any).injectProfileBrowsingEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <NumField min={1} max={100} className="w-[51px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingMin ?? 1} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingMin: v, injectProfileBrowsingMax: Math.max(v, (settings as any).injectProfileBrowsingMax ?? 100) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                        <NumField min={1} max={100} className="w-[51px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingMax ?? 1} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingMax: v, injectProfileBrowsingMin: Math.min(v, (settings as any).injectProfileBrowsingMin ?? 1) } as any)} />
                        <span className="text-[10px] text-muted-foreground shrink-0">%</span>
                      </div>
                      <button type="button" onClick={() => setShowBrowsingDialog(true)} className="text-[10px] font-semibold text-primary underline cursor-pointer hover:text-primary/70 transition-colors shrink-0 ml-0.5">Open</button>
                    </div>
                    {/* Inject Browsing sub-settings dialog */}
                    {showBrowsingDialog && (
                      <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setShowBrowsingDialog(false)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative bg-background border border-border rounded-xl shadow-2xl p-5 min-w-[580px]" onClick={(e) => e.stopPropagation()}>
                          {/* Centred title */}
                          <div className="relative flex items-center justify-center mb-3">
                            <span className="text-xs font-bold text-foreground uppercase tracking-wider">Inject Browsing Settings</span>
                            <button type="button" onClick={() => setShowBrowsingDialog(false)} className="absolute right-0 text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {/* Column headers — 3 groups: Chance % | Scroll | Order % */}
                            <div className="flex items-center gap-2 shrink-0 pb-0.5">
                              <span className="shrink-0 w-[140px]" />
                              <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 whitespace-nowrap">Chance %</span>
                              <span className="invisible text-[10px] shrink-0">–</span>
                              <span className="invisible w-[52px] shrink-0" />
                              <div className="w-px h-3 bg-border/50 shrink-0" />
                              <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 whitespace-nowrap">Amount</span>
                              <span className="invisible text-[10px] shrink-0">–</span>
                              <span className="invisible w-[52px] shrink-0" />
                              <div className="w-px h-3 bg-border/50 shrink-0" />
                              <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider shrink-0 whitespace-nowrap">Order %</span>
                            </div>
                            <div className="w-full h-px bg-border/40" />
                            {/* Browse Before Follow — Chance % only, no Scroll / no Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="flex items-center gap-1.5 w-[140px] shrink-0">
                                <input type="checkbox" id="injectProfileBrowsingBeforeFollow" checked={!!(settings as any).injectProfileBrowsingBeforeFollow} onChange={(e) => setSettings({ ...settings, injectProfileBrowsingBeforeFollow: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                                <label htmlFor="injectProfileBrowsingBeforeFollow" className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">Browse Before Follow</label>
                              </div>
                              <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingBeforeFollow ? 'opacity-40 pointer-events-none' : ''}`}>
                                <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingBeforeFollowPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingBeforeFollowPctMin: v, injectProfileBrowsingBeforeFollowPctMax: Math.max(v, (settings as any).injectProfileBrowsingBeforeFollowPctMax ?? 0) } as any)} />
                                <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                                <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingBeforeFollowPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingBeforeFollowPctMax: v, injectProfileBrowsingBeforeFollowPctMin: Math.min(v, (settings as any).injectProfileBrowsingBeforeFollowPctMin ?? 0) } as any)} />
                              </div>
                            </div>
                            <div className="w-full h-px bg-border/40" />
                            {/* Visit Profile — hardcoded, not editable */}
                            <div className="flex items-center gap-2 shrink-0 opacity-50 select-none">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Visit Profile</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">100</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">100</span>
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">—</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">—</span>
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <span className="text-[10px] text-muted-foreground italic shrink-0">First</span>
                            </div>
                            {/* Scroll Feed — hardcoded, not editable */}
                            <div className="flex items-center gap-2 shrink-0 opacity-50 select-none">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Scroll Feed</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">100</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">100</span>
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">—</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <span className="text-[10px] text-muted-foreground w-[52px] text-center shrink-0">—</span>
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <span className="text-[10px] text-muted-foreground italic shrink-0">Second</span>
                            </div>
                            {/* Feed Posts — Chance % (call at all) + Scroll count (posts to fetch) + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Feed Posts</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedChanceMin ?? 100} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedChanceMin: v, injectProfileBrowsingFeedChanceMax: Math.max(v, (settings as any).injectProfileBrowsingFeedChanceMax ?? 100) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedChanceMax ?? 100} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedChanceMax: v, injectProfileBrowsingFeedChanceMin: Math.min(v, (settings as any).injectProfileBrowsingFeedChanceMin ?? 100) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedMin ?? 3} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedMin: v, injectProfileBrowsingFeedMax: Math.max(v, (settings as any).injectProfileBrowsingFeedMax ?? 30) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedMax ?? 6} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedMax: v, injectProfileBrowsingFeedMin: Math.min(v, (settings as any).injectProfileBrowsingFeedMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedOrderMin: v, injectProfileBrowsingFeedOrderMax: Math.max(v, (settings as any).injectProfileBrowsingFeedOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingFeedOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingFeedOrderMax: v, injectProfileBrowsingFeedOrderMin: Math.min(v, (settings as any).injectProfileBrowsingFeedOrderMin ?? 0) } as any)} />
                            </div>
                            {/* Like — Chance % per post + Scroll count (max posts to iterate) + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Like</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikePctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikePctMin: v, injectProfileBrowsingLikePctMax: Math.max(v, (settings as any).injectProfileBrowsingLikePctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikePctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikePctMax: v, injectProfileBrowsingLikePctMin: Math.min(v, (settings as any).injectProfileBrowsingLikePctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikeScrollMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikeScrollMin: v, injectProfileBrowsingLikeScrollMax: Math.max(v, (settings as any).injectProfileBrowsingLikeScrollMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikeScrollMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikeScrollMax: v, injectProfileBrowsingLikeScrollMin: Math.min(v, (settings as any).injectProfileBrowsingLikeScrollMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikePctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikePctOrderMin: v, injectProfileBrowsingLikePctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingLikePctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingLikePctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingLikePctOrderMax: v, injectProfileBrowsingLikePctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingLikePctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* Save Media — Chance % + Scroll count + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Save Media</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaPctMin: v, injectProfileBrowsingSaveMediaPctMax: Math.max(v, (settings as any).injectProfileBrowsingSaveMediaPctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaPctMax: v, injectProfileBrowsingSaveMediaPctMin: Math.min(v, (settings as any).injectProfileBrowsingSaveMediaPctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaScrollMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaScrollMin: v, injectProfileBrowsingSaveMediaScrollMax: Math.max(v, (settings as any).injectProfileBrowsingSaveMediaScrollMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaScrollMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaScrollMax: v, injectProfileBrowsingSaveMediaScrollMin: Math.min(v, (settings as any).injectProfileBrowsingSaveMediaScrollMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaPctOrderMin: v, injectProfileBrowsingSaveMediaPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingSaveMediaPctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingSaveMediaPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingSaveMediaPctOrderMax: v, injectProfileBrowsingSaveMediaPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingSaveMediaPctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* Watch Stories — Chance % + Scroll count (story items) + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Watch Stories</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesPctMin: v, injectProfileBrowsingWatchStoriesPctMax: Math.max(v, (settings as any).injectProfileBrowsingWatchStoriesPctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesPctMax: v, injectProfileBrowsingWatchStoriesPctMin: Math.min(v, (settings as any).injectProfileBrowsingWatchStoriesPctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesScrollMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesScrollMin: v, injectProfileBrowsingWatchStoriesScrollMax: Math.max(v, (settings as any).injectProfileBrowsingWatchStoriesScrollMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesScrollMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesScrollMax: v, injectProfileBrowsingWatchStoriesScrollMin: Math.min(v, (settings as any).injectProfileBrowsingWatchStoriesScrollMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesPctOrderMin: v, injectProfileBrowsingWatchStoriesPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingWatchStoriesPctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingWatchStoriesPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingWatchStoriesPctOrderMax: v, injectProfileBrowsingWatchStoriesPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingWatchStoriesPctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* View Highlights — Chance % + Scroll count + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">View Highlights</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsPctMin: v, injectProfileBrowsingViewHighlightsPctMax: Math.max(v, (settings as any).injectProfileBrowsingViewHighlightsPctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsPctMax: v, injectProfileBrowsingViewHighlightsPctMin: Math.min(v, (settings as any).injectProfileBrowsingViewHighlightsPctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsScrollMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsScrollMin: v, injectProfileBrowsingViewHighlightsScrollMax: Math.max(v, (settings as any).injectProfileBrowsingViewHighlightsScrollMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsScrollMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsScrollMax: v, injectProfileBrowsingViewHighlightsScrollMin: Math.min(v, (settings as any).injectProfileBrowsingViewHighlightsScrollMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsPctOrderMin: v, injectProfileBrowsingViewHighlightsPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingViewHighlightsPctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewHighlightsPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewHighlightsPctOrderMax: v, injectProfileBrowsingViewHighlightsPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingViewHighlightsPctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* View Reels — Chance % + Scroll count + Order % */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">View Reels</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsPctMin: v, injectProfileBrowsingViewReelsPctMax: Math.max(v, (settings as any).injectProfileBrowsingViewReelsPctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsPctMax: v, injectProfileBrowsingViewReelsPctMin: Math.min(v, (settings as any).injectProfileBrowsingViewReelsPctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsScrollMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsScrollMin: v, injectProfileBrowsingViewReelsScrollMax: Math.max(v, (settings as any).injectProfileBrowsingViewReelsScrollMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={30} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsScrollMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsScrollMax: v, injectProfileBrowsingViewReelsScrollMin: Math.min(v, (settings as any).injectProfileBrowsingViewReelsScrollMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsPctOrderMin: v, injectProfileBrowsingViewReelsPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingViewReelsPctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingViewReelsPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingViewReelsPctOrderMax: v, injectProfileBrowsingViewReelsPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingViewReelsPctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* Comment — checkbox enables the row + reveals text input */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2 shrink-0">
                                <div className="flex items-center gap-1.5 w-[140px] shrink-0">
                                  <input type="checkbox" id="injectProfileBrowsingCommentEnabled" checked={!!(settings as any).injectProfileBrowsingCommentEnabled} onChange={(e) => setSettings({ ...settings, injectProfileBrowsingCommentEnabled: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                                  <label htmlFor="injectProfileBrowsingCommentEnabled" className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">Comment</label>
                                </div>
                                <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingCommentEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                                  <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingCommentPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingCommentPctMin: v, injectProfileBrowsingCommentPctMax: Math.max(v, (settings as any).injectProfileBrowsingCommentPctMax ?? 0) } as any)} />
                                  <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                                  <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingCommentPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingCommentPctMax: v, injectProfileBrowsingCommentPctMin: Math.min(v, (settings as any).injectProfileBrowsingCommentPctMin ?? 0) } as any)} />
                                  <div className="w-px h-5 bg-border/50 shrink-0" />
                                  <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingCommentPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingCommentPctOrderMin: v, injectProfileBrowsingCommentPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingCommentPctOrderMax ?? 0) } as any)} />
                                  <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                                  <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingCommentPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingCommentPctOrderMax: v, injectProfileBrowsingCommentPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingCommentPctOrderMin ?? 0) } as any)} />
                                </div>
                              </div>
                              {!!(settings as any).injectProfileBrowsingCommentEnabled && (
                                <textarea
                                  rows={3}
                                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 leading-relaxed"
                                  value={(settings as any).injectProfileBrowsingCommentText ?? ""}
                                  onChange={(e) => setSettings({ ...settings, injectProfileBrowsingCommentText: e.target.value } as any)}
                                />
                              )}
                            </div>
                            {/* Share to DM */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap shrink-0 w-[140px]">Share to DM</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingShareToDmPctMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingShareToDmPctMin: v, injectProfileBrowsingShareToDmPctMax: Math.max(v, (settings as any).injectProfileBrowsingShareToDmPctMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingShareToDmPctMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingShareToDmPctMax: v, injectProfileBrowsingShareToDmPctMin: Math.min(v, (settings as any).injectProfileBrowsingShareToDmPctMin ?? 0) } as any)} />
                              <div className="w-px h-5 bg-border/50 shrink-0" />
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingShareToDmPctOrderMin ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingShareToDmPctOrderMin: v, injectProfileBrowsingShareToDmPctOrderMax: Math.max(v, (settings as any).injectProfileBrowsingShareToDmPctOrderMax ?? 0) } as any)} />
                              <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                              <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingShareToDmPctOrderMax ?? 0} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingShareToDmPctOrderMax: v, injectProfileBrowsingShareToDmPctOrderMin: Math.min(v, (settings as any).injectProfileBrowsingShareToDmPctOrderMin ?? 0) } as any)} />
                            </div>
                            {/* Abandon Follow — separator + checkbox, NO Order % */}
                            <div className="w-full h-px bg-border/40 mt-0.5" />
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="flex items-center gap-1.5 w-[140px] shrink-0">
                                <input type="checkbox" id="injectProfileBrowsingAbandonFollow" checked={!!(settings as any).injectProfileBrowsingAbandonFollow} onChange={(e) => setSettings({ ...settings, injectProfileBrowsingAbandonFollow: e.target.checked } as any)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                                <label htmlFor="injectProfileBrowsingAbandonFollow" className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap shrink-0">Abandon Follow</label>
                              </div>
                              <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!(settings as any).injectProfileBrowsingAbandonFollow ? 'opacity-40 pointer-events-none' : ''}`}>
                                <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingAbandonFollowPctMin ?? 10} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingAbandonFollowPctMin: v, injectProfileBrowsingAbandonFollowPctMax: Math.max(v, (settings as any).injectProfileBrowsingAbandonFollowPctMax ?? 100) } as any)} />
                                <span className="text-[10px] text-muted-foreground shrink-0">–</span>
                                <NumField min={0} max={100} className="w-[52px] h-7 text-xs shrink-0" value={(settings as any).injectProfileBrowsingAbandonFollowPctMax ?? 20} onChange={(v) => setSettings({ ...settings, injectProfileBrowsingAbandonFollowPctMax: v, injectProfileBrowsingAbandonFollowPctMin: Math.min(v, (settings as any).injectProfileBrowsingAbandonFollowPctMin ?? 0) } as any)} />
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 flex justify-end">
                            <Button variant="outline" size="sm" onClick={() => setShowBrowsingDialog(false)}>Close</Button>
                          </div>
                        </div>
                      </div>
                    )}
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
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStopFollowAtFollowingsMin ?? 7400}
                            onChange={(v) => setSettings({ ...settings, autoStopFollowAtFollowingsMin: Math.min(v, (settings as any).autoStopFollowAtFollowingsMax ?? Infinity) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStopFollowAtFollowingsMax ?? 7400}
                            onChange={(v) => setSettings({ ...settings, autoStopFollowAtFollowingsMax: Math.max(v, (settings as any).autoStopFollowAtFollowingsMin ?? 0) } as any)}
                          />
                        </div>
                      </div>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Start unfollow tool after (minutes)</h4>
                        <div className="flex items-center gap-1.5">
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartUnfollowAfterMin ?? 60}
                            onChange={(v) => setSettings({ ...settings, autoStartUnfollowAfterMin: Math.min(v, (settings as any).autoStartUnfollowAfterMax ?? Infinity) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartUnfollowAfterMax ?? 135}
                            onChange={(v) => setSettings({ ...settings, autoStartUnfollowAfterMax: Math.max(v, (settings as any).autoStartUnfollowAfterMin ?? 0) } as any)}
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
                      <NumField min={0} className="w-24 h-8 text-xs"
                        value={(settings as any).minFollowAgeDays ?? 3}
                        onChange={(v) => setSettings({ ...settings, minFollowAgeDays: v } as any)}
                      />
                      <p className="text-[10px] text-muted-foreground">Only unfollow accounts followed at least this many days ago.</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Delay after Unfollow (s)</Label>
                      <div className="flex items-center gap-1.5">
                        <NumField min={0} className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMin ?? 5}
                          onChange={(v) => setSettings({ ...settings, delayAfterUnfollowMin: Math.min(v, (settings as any).delayAfterUnfollowMax ?? Infinity) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <NumField min={0} className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMax ?? 15}
                          onChange={(v) => setSettings({ ...settings, delayAfterUnfollowMax: Math.max(v, (settings as any).delayAfterUnfollowMin ?? 0) } as any)}
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
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartFollowAtFollowingsMin ?? 5000}
                            onChange={(v) => setSettings({ ...settings, autoStartFollowAtFollowingsMin: Math.min(v, (settings as any).autoStartFollowAtFollowingsMax ?? Infinity) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <NumField min={0} className="w-20 h-7 text-xs"
                            value={(settings as any).autoStartFollowAtFollowingsMax ?? 5000}
                            onChange={(v) => setSettings({ ...settings, autoStartFollowAtFollowingsMax: Math.max(v, (settings as any).autoStartFollowAtFollowingsMin ?? 0) } as any)}
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
                          <NumField min={0} className="w-16 h-7 text-xs"
                            value={(settings as any).autoStartFollowAfterMin ?? 60}
                            onChange={(v) => setSettings({ ...settings, autoStartFollowAfterMin: Math.min(v, (settings as any).autoStartFollowAfterMax ?? Infinity) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <NumField min={0} className="w-16 h-7 text-xs"
                            value={(settings as any).autoStartFollowAfterMax ?? 120}
                            onChange={(v) => setSettings({ ...settings, autoStartFollowAfterMax: Math.max(v, (settings as any).autoStartFollowAfterMin ?? 0) } as any)}
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
                      <NumField
                        min={1}
                        max={1440}
                        className="w-16 h-7 text-xs"
                        value={(settings as any).stopOnBlockMinutes ?? 60}
                        onChange={(v) => setSettings({ ...settings, stopOnBlockMinutes: v } as any)}
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
                <div className="flex rounded-lg border border-border overflow-hidden text-sm shrink-0">
                  <button type="button"
                    className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${newSourceType === 'hashtag' ? 'bg-primary text-primary-foreground font-medium' : 'bg-background text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
                    onClick={() => setNewSourceType('hashtag')}>
                    <Hash className="w-3.5 h-3.5" />Hashtag
                  </button>
                  <div className="w-px bg-border" />
                  <button type="button"
                    className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${newSourceType === 'target_followers' ? 'bg-primary text-primary-foreground font-medium' : 'bg-background text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
                    onClick={() => setNewSourceType('target_followers')}>
                    <Users className="w-3.5 h-3.5" />Followers of Account
                  </button>
                </div>
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
              <Button type="button" variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                disabled={clearSourcesMutation.isPending || !sources?.length}
                onClick={() => clearSourcesMutation.mutate(tool.id)}>
                <Trash2 className="w-4 h-4 mr-2" />{clearSourcesMutation.isPending ? 'Clearing…' : 'Clear All'}
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
                return filtered.map(source => {
                  const detailPriority = localPriorities[source.id] !== undefined
                    ? localPriorities[source.id]
                    : String(source.rank ?? 100);
                  return (
                    <div key={source.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:bg-accent/30 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary shrink-0">
                          {source.type === 'hashtag' ? <Hash className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{source.type === 'hashtag' ? `#${source.value}` : source.value}</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            {source.nrPosts != null && (
                              <span className="text-[10px] text-muted-foreground">
                                {source.nrPosts >= 1_000_000
                                  ? `${(source.nrPosts / 1_000_000).toFixed(1)}M`
                                  : source.nrPosts >= 1_000
                                  ? `${(source.nrPosts / 1_000).toFixed(0)}K`
                                  : source.nrPosts} posts
                              </span>
                            )}
                            {source.nrPosts == null && (
                              <span className="text-xs text-muted-foreground capitalize">{source.type.replace('_', ' ')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-1" title="Pick priority 1–100. Higher = picked more often. Set one source to 100 to use it exclusively.">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={detailPriority}
                            onChange={(e) => setLocalPriorities(p => ({ ...p, [source.id]: e.target.value }))}
                            onBlur={() => {
                              const v = Math.max(1, Math.min(100, parseInt(detailPriority, 10) || 1));
                              setLocalPriorities(p => { const n = { ...p }; delete n[source.id]; return n; });
                              updateSourceMutation.mutate({ id: source.id, toolId: tool.id, rank: v, enabled: source.enabled !== false });
                            }}
                            className="w-14 h-7 text-xs text-center border border-border rounded px-1 bg-background"
                          />
                          <span className="text-xs text-muted-foreground">%</span>
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
                    </div>
                  );
                });
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
        sharedTargetsStorageKey="copyDialog:shared:targets"
      />
    </div>
  );
}
