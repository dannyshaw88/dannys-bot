import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  ChevronDown, ChevronUp, Heart, Copy, FolderOpen, UserPlus, UserMinus, Zap,
} from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile, type RepostedPost, type SessionAction } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { useToast } from "@/hooks/use-toast";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { api } from "@shared/routes";
import { ImageSettingsDialog } from "@/components/tools/ImageSettingsDialog";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { UnfollowToolPanel } from "@/components/tools/UnfollowToolPanel";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";

interface HumanSessionPanelProps {
  tool: Tool;
  profile: Profile;
  copyOpen?: boolean;
  onCopyOpenChange?: (v: boolean) => void;
  followTool?: Tool;
  unfollowTool?: Tool;
  contactTool?: Tool;
}

export function HumanSessionPanel({ tool, profile, copyOpen: copyOpenProp, onCopyOpenChange, followTool, unfollowTool, contactTool }: HumanSessionPanelProps) {
  const updateToolMutation = useUpdateTool();
  const embeddedUpdateTool = useUpdateTool();
  const { navigateTo } = useBrowserWindows();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showReposted, setShowReposted] = useState(false);
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false);
  const [spinPreview, setSpinPreview] = useState<string | null>(null);
  const [spinSyntaxMsg, setSpinSyntaxMsg] = useState<string | null>(null);
  const [copyOpen, _setCopyOpen] = useState(false);
  const _copyOpen = copyOpenProp ?? copyOpen;
  const _setCopyOpenFn = onCopyOpenChange ?? _setCopyOpen;
  const [repostingNow, setRepostingNow] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId && !p.locked && !p.isTemplate);
  const hasOtherProfiles = allProfiles.some(p => p.id !== tool.profileId);

  const HUMAN_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "General", options: [
      { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
      { key: "randomiseTiming", label: "Randomise timing", description: "Spread each account's session start times across the session delay window so they don't all fire simultaneously" },
    ]},
    { label: "Timing", options: [
      { key: "humanToolsDelay", label: "Human Tools Delay", description: "Interval between human session runs", subOptions: [
        { key: "hs_delayRange", label: "Session delay range", settingKeys: ["delayMin","delayMax"] },
      ]},
    ]},
    { label: "Open Instagram Calls", options: [
      { key: "hs_forceEmulation", label: "Open Instagram Calls", description: "Fires Instagram app-open API calls at the start of every session, before any other action runs", subOptions: [
        { key: "fe_enabled",   label: "Enabled",          settingKeys: ["forceEmulationEnabled"] },
        { key: "fe_randomise", label: "Randomise order",  settingKeys: ["forceEmulationRandomise"] },
      ]},
    ]},
    { label: "Embedded Tool States", options: [
      { key: "hs_followEnabled",      label: "Follow Tool — Start / Stop",             description: "Copy the Follow Tool enabled checkbox to other profiles" },
      { key: "hs_unfollowEnabled",    label: "Unfollow Tool — Start / Stop",           description: "Copy the Unfollow Tool enabled checkbox to other profiles" },
      { key: "hs_cnfEnabled",         label: "Contact New Followers — Start / Stop",   description: "Copy the Contact New Followers enabled checkbox" },
      { key: "hs_autoReplyEnabled",   label: "Auto Reply — Start / Stop",              description: "Copy the Auto Reply enabled checkbox" },
      { key: "hs_contactUsersEnabled",label: "Contact Users Sending — Start / Stop",   description: "Copy the Contact Users Sending enabled checkbox" },
    ]},
    { label: "Embedded Tool Execution Order", options: [
      { key: "hs_followOrder", label: "Follow Tool — Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Follow Tool", subOptions: [
        { key: "fo_orderRange", label: "Execution order", settingKeys: ["followOrderMin","followOrderMax"] },
        { key: "fo_skipRange",  label: "Skip chance %",   settingKeys: ["followSkipMin","followSkipMax"] },
      ]},
      { key: "hs_unfollowOrder", label: "Unfollow Tool — Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Unfollow Tool", subOptions: [
        { key: "ufo_orderRange", label: "Execution order", settingKeys: ["unfollowOrderMin","unfollowOrderMax"] },
        { key: "ufo_skipRange",  label: "Skip chance %",   settingKeys: ["unfollowSkipMin","unfollowSkipMax"] },
      ]},
      { key: "hs_contactOrder", label: "Contact Tool — Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Contact Tool", subOptions: [
        { key: "co_orderRange", label: "Execution order", settingKeys: ["contactOrderMin","contactOrderMax"] },
        { key: "co_skipRange",  label: "Skip chance %",   settingKeys: ["contactSkipMin","contactSkipMax"] },
      ]},
    ]},
    { label: "Emulation", options: [
      { key: "viewTimelineFeed", label: "View Timeline Feed", description: "Scrolling through the main feed + inline liking", subOptions: [
        { key: "vtf_enabled",    label: "Enabled",                                       settingKeys: ["viewTimelineFeedEnabled"] },
        { key: "vtf_count",      label: "Posts per session",                 settingKeys: ["viewTimelineFeedMin","viewTimelineFeedMax"] },
        { key: "vtf_order",      label: "Execution order",                   settingKeys: ["viewTimelineFeedOrderMin","viewTimelineFeedOrderMax"] },
        { key: "vtf_chance",     label: "Skip chance %",       settingKeys: ["viewTimelineFeedNotUsedMin","viewTimelineFeedNotUsedMax"] },
        { key: "vtf_like_pct",    label: "% posts to like",                  settingKeys: ["likeTimelinePostsPercentMin","likeTimelinePostsPercentMax"] },
        { key: "vtf_reel_view",   label: "% of each reel to watch",          settingKeys: ["reelWatchPercentMin","reelWatchPercentMax"] },
        { key: "vtf_like_delay",  label: "Delay between likes in sec",       settingKeys: ["likeTimelinePostsDelayMin","likeTimelinePostsDelayMax"] },
        { key: "vtf_save_media",  label: "Save liked media",               settingKeys: ["saveMediaEnabled","saveMediaPercent"] },
        { key: "vtf_click_post",       label: "Click post %",                settingKeys: ["clickPostPercentMin","clickPostPercentMax"] },
        { key: "vtf_view_profile",     label: "Visit profile %",             settingKeys: ["viewPostProfilePercentMin","viewPostProfilePercentMax"] },
        { key: "vtf_profile_feed",     label: "View profile feed % + count", settingKeys: ["viewProfileFeedPercentMin","viewProfileFeedPercentMax","viewProfileFeedCountMin","viewProfileFeedCountMax"] },
        { key: "vtf_profile_posts",    label: "Open profile posts count + %",settingKeys: ["viewProfilePostsCountMin","viewProfilePostsCountMax","viewProfilePostsPercentMin","viewProfilePostsPercentMax"] },
        { key: "vtf_follow_suggested", label: "If 0 Posts → Follow Suggested", settingKeys: ["followSuggestedUsersIfEmptyEnabled","followSuggestedUsersIfEmptyMin","followSuggestedUsersIfEmptyMax"] },
      ]},
      { key: "humanSession", label: "Human Session", description: "Core session order and cool-down", subOptions: [
        { key: "hs_enabled",      label: "Enabled",                                      settingKeys: ["humanSessionEnabled"] },
        { key: "hs_order",        label: "Execution order",                  settingKeys: ["humanSessionOrderMin","humanSessionOrderMax"] },
        { key: "hs_chance",       label: "Skip chance %",      settingKeys: ["humanSessionNotUsedMin","humanSessionNotUsedMax"] },
        { key: "hs_notif",        label: "Notifications run chance %",       settingKeys: ["notificationsRunChanceMin","notificationsRunChanceMax"] },
        { key: "hs_ownprofile",   label: "Own Profile run chance %",         settingKeys: ["ownProfileRunChanceMin","ownProfileRunChanceMax"] },
        { key: "hs_refresh",      label: "Refresh Profile run chance %",     settingKeys: ["refreshProfileRunChanceMin","refreshProfileRunChanceMax"] },
        { key: "hs_settings",     label: "Settings & Activity run chance %", settingKeys: ["settingsActivityRunChanceMin","settingsActivityRunChanceMax"] },
      ]},
      { key: "checkStories", label: "Check Timeline Stories", description: "Watch stories while active", subOptions: [
        { key: "cs_enabled", label: "Enabled",                            settingKeys: ["checkTimelineStoriesEnabled"] },
        { key: "cs_count",   label: "Stories per session",    settingKeys: ["checkTimelineStoriesMin","checkTimelineStoriesMax"] },
        { key: "cs_order",   label: "Execution order",        settingKeys: ["checkTimelineStoriesOrderMin","checkTimelineStoriesOrderMax"] },
        { key: "cs_chance",  label: "Skip chance %", settingKeys: ["checkTimelineStoriesNotUsedMin","checkTimelineStoriesNotUsedMax"] },
      ]},
      { key: "checkDm", label: "Check DMs", description: "Read direct messages", subOptions: [
        { key: "dm_enabled", label: "Enabled",                            settingKeys: ["checkDmEnabled"] },
        { key: "dm_count",   label: "DMs per session",        settingKeys: ["checkDmMin","checkDmMax"] },
        { key: "dm_order",   label: "Execution order",        settingKeys: ["checkDmOrderMin","checkDmOrderMax"] },
        { key: "dm_chance",  label: "Skip chance %", settingKeys: ["checkDmNotUsedMin","checkDmNotUsedMax"] },
      ]},
      { key: "repost", label: "Repost", description: "Repost settings for source account, alteration, caption and stop conditions", subOptions: [
        { key: "rp_enabled",    label: "Enabled",                           settingKeys: ["repostEnabled"] },
        { key: "rp_source",     label: "Source account",                    settingKeys: ["repostSourceUsername"] },
        { key: "rp_count",      label: "Posts per session",     settingKeys: ["repostMin","repostMax"] },
        { key: "rp_alteration", label: "Alteration & image settings",       settingKeys: ["repostAlterationLevel","repostImageSettings"] },
        { key: "rp_caption",    label: "Caption text",                      settingKeys: ["repostCaptionText"] },
        { key: "rp_comments",   label: "Disable comments",                  settingKeys: ["repostDisableComments"] },
        { key: "rp_order",      label: "Execution order",       settingKeys: ["repostOrderMin","repostOrderMax"] },
        { key: "rp_chance",     label: "Skip chance %", settingKeys: ["repostNotUsedMin","repostNotUsedMax"] },
        { key: "rp_stop",       label: "Stop conditions",                   settingKeys: ["repostDisableAtPostCount","repostDisableWhenExhausted"] },
      ]},
    ]},
    { label: "Follow Tool Settings", options: [
      { key: "hs_followTiming", label: "Timing", description: "Delays between each follow action", subOptions: [
        { key: "hf_delayAfterFollow", label: "Delay after each follow", settingKeys: ["follow:delayAfterFollowMin","follow:delayAfterFollowMax"] },
      ]},
      { key: "hs_followLimits", label: "Limits", description: "Caps on follow actions per session, day and hour", subOptions: [
        { key: "hf_usersPerSession", label: "Users per session",    settingKeys: ["follow:processMin","follow:processMax"] },
        { key: "hf_maxPerDay",       label: "Max actions per day",  settingKeys: ["follow:maxPerDayMin","follow:maxPerDayMax"] },
        { key: "hf_maxPerHour",      label: "Max actions per hour", settingKeys: ["follow:maxPerHourMin","follow:maxPerHourMax"] },
      ]},
      { key: "hs_followScraping", label: "Scraping", description: "Source quality and follow-age filters", subOptions: [
        { key: "hf_scrapeAbort",  label: "Abort scrape after", settingKeys: ["follow:abortScrapeAfterMin","follow:abortScrapeAfterMax"] },
        { key: "hf_minFollowAge", label: "Min follow age",                  settingKeys: ["follow:minFollowAgeDays"] },
      ]},
      { key: "hs_followFilters", label: "Filters", description: "Account quality filters applied before following", subOptions: [
        { key: "hf_skipIndian", label: "Skip Indian Users", settingKeys: ["follow:skipIndianUsers"] },
      ]},
      { key: "hs_followInjection", label: "Injection Settings", description: "API calls injected between follows to simulate natural behaviour", subOptions: [
        { key: "hf_injectSearch",          label: "Inject SearchByUsername",      settingKeys: ["follow:injectSearchEnabled","follow:injectSearchMin","follow:injectSearchMax"] },
        { key: "hf_injectSuggested",       label: "Inject GetSuggestedUsers",     settingKeys: ["follow:injectSuggestedEnabled","follow:injectSuggestedMin","follow:injectSuggestedMax"] },
        { key: "hf_injectProfileBrowsing", label: "Inject Profile Browsing", settingKeys: ["follow:injectProfileBrowsingEnabled","follow:injectProfileBrowsingMin","follow:injectProfileBrowsingMax","follow:injectProfileBrowsingFeedMin","follow:injectProfileBrowsingFeedMax","follow:injectProfileBrowsingPostPctMin","follow:injectProfileBrowsingPostPctMax","follow:injectProfileBrowsingLikePctMin","follow:injectProfileBrowsingLikePctMax","follow:injectProfileBrowsingSaveMediaPctMin","follow:injectProfileBrowsingSaveMediaPctMax","follow:injectProfileBrowsingWatchStoriesPctMin","follow:injectProfileBrowsingWatchStoriesPctMax","follow:injectProfileBrowsingViewHighlightsPctMin","follow:injectProfileBrowsingViewHighlightsPctMax","follow:injectProfileBrowsingCommentPctMin","follow:injectProfileBrowsingCommentPctMax","follow:injectProfileBrowsingCommentText","follow:injectProfileBrowsingBeforeFollow","follow:injectProfileBrowsingBeforeFollowPctMin","follow:injectProfileBrowsingBeforeFollowPctMax","follow:injectProfileBrowsingAbandonFollow","follow:injectProfileBrowsingAbandonFollowPctMin","follow:injectProfileBrowsingAbandonFollowPctMax"] },
      ]},
      { key: "hs_followAutoFU", label: "Auto Follow / Unfollow", description: "Automatic switching between follow and unfollow tools", subOptions: [
        { key: "hf_autoEnabled",    label: "Enabled",                                     settingKeys: ["follow:autoFollowUnfollowEnabled"] },
        { key: "hf_autoStopAt",     label: "Stop follow at followings count", settingKeys: ["follow:autoStopFollowAtFollowingsMin","follow:autoStopFollowAtFollowingsMax"] },
        { key: "hf_autoStartAfter", label: "Start unfollow after",       settingKeys: ["follow:autoStartUnfollowAfterMin","follow:autoStartUnfollowAfterMax"] },
      ]},
      { key: "hs_followSAV", label: "Session Action Variation", description: "Extra actions performed during a follow session", subOptions: [
        { key: "hf_sav_enabled",   label: "Enabled",                                        settingKeys: ["follow:sessionActionVariationEnabled"] },
        { key: "hf_likeChance",    label: "Like — Chance %",                    settingKeys: ["follow:likeChanceMin","follow:likeChanceMax"] },
        { key: "hf_likeCount",     label: "Like — Posts to like",               settingKeys: ["follow:likeProcessMin","follow:likeProcessMax"] },
        { key: "hf_likeBefore",    label: "Like — Before follow %",             settingKeys: ["follow:likeBeforeMin","follow:likeBeforeMax"] },
        { key: "hf_likeMaxDay",    label: "Like — Max per day",                 settingKeys: ["follow:likeMaxPerDayMin","follow:likeMaxPerDayMax"] },
        { key: "hf_likeDelay",     label: "Like — Delay between likes",   settingKeys: ["follow:likeDelayMin","follow:likeDelayMax"] },
        { key: "hf_reelsChance",   label: "Reels — Chance %",                  settingKeys: ["follow:viewReelsChanceMin","follow:viewReelsChanceMax"] },
        { key: "hf_reelsCount",    label: "Reels — Count to watch",            settingKeys: ["follow:viewReelsProcessMin","follow:viewReelsProcessMax"] },
        { key: "hf_reelsBefore",   label: "Reels — Before follow %",           settingKeys: ["follow:viewReelsBeforeMin","follow:viewReelsBeforeMax"] },
        { key: "hf_reelsMaxDay",   label: "Reels — Max per day",               settingKeys: ["follow:viewReelsMaxPerDayMin","follow:viewReelsMaxPerDayMax"] },
        { key: "hf_reelsDelay",    label: "Reels — Delay",                settingKeys: ["follow:viewReelsDelayMin","follow:viewReelsDelayMax"] },
        { key: "hf_storiesChance", label: "Stories — Chance %",                settingKeys: ["follow:viewStoriesChanceMin","follow:viewStoriesChanceMax"] },
        { key: "hf_storiesCount",  label: "Stories — Count to watch",          settingKeys: ["follow:viewStoriesProcessMin","follow:viewStoriesProcessMax"] },
        { key: "hf_storiesBefore", label: "Stories — Before follow %",         settingKeys: ["follow:viewStoriesBeforeMin","follow:viewStoriesBeforeMax"] },
        { key: "hf_storiesMaxDay", label: "Stories — Max per day",             settingKeys: ["follow:viewStoriesMaxPerDayMin","follow:viewStoriesMaxPerDayMax"] },
        { key: "hf_storiesDelay",  label: "Stories — Delay",              settingKeys: ["follow:viewStoriesDelayMin","follow:viewStoriesDelayMax"] },
        { key: "hf_hlChance",      label: "Highlights — Chance %",             settingKeys: ["follow:viewHighlightsChanceMin","follow:viewHighlightsChanceMax"] },
        { key: "hf_hlCount",       label: "Highlights — Count to watch",       settingKeys: ["follow:viewHighlightsProcessMin","follow:viewHighlightsProcessMax"] },
        { key: "hf_hlBefore",      label: "Highlights — Before follow %",      settingKeys: ["follow:viewHighlightsBeforeMin","follow:viewHighlightsBeforeMax"] },
        { key: "hf_hlMaxDay",      label: "Highlights — Max per day",          settingKeys: ["follow:viewHighlightsMaxPerDayMin","follow:viewHighlightsMaxPerDayMax"] },
        { key: "hf_hlDelay",       label: "Highlights — Delay",           settingKeys: ["follow:viewHighlightsDelayMin","follow:viewHighlightsDelayMax"] },
      ]},
      { key: "hs_followStopBlock", label: "Stop if Blocked", description: "Pause follow tool for a set time when Instagram blocks a follow action", subOptions: [
        { key: "hf_stopEnabled", label: "Enabled",              settingKeys: ["follow:stopOnBlockEnabled"] },
        { key: "hf_stopMinutes", label: "Stop duration", settingKeys: ["follow:stopOnBlockMinutes"] },
      ]},
      { key: "hs_followSources", label: "Target Sources", description: "Copy all follow tool target sources to other profiles — adds to their existing sources" },
      { key: "hs_clearFollowSources", label: "Clear Sources First", description: "Remove all existing sources from destination follow tools before copying" },
    ]},
    { label: "Unfollow Tool Settings", options: [
      { key: "hs_unfollowSettings", label: "Settings", description: "Unfollow timing, limits and age filters", subOptions: [
        { key: "uf_h_age",   label: "Unfollow after min days since follow",           settingKeys: ["unfollow:minFollowAgeDays"] },
        { key: "uf_h_wait",  label: "Wait between sessions",         settingKeys: ["unfollow:delayMin","unfollow:delayMax"] },
        { key: "uf_h_count", label: "Users per session",                  settingKeys: ["unfollow:processMin","unfollow:processMax"] },
        { key: "uf_h_delay", label: "Delay after each unfollow",    settingKeys: ["unfollow:delayAfterUnfollowMin","unfollow:delayAfterUnfollowMax"] },
      ]},
      { key: "hs_unfollowAutoFU", label: "Auto Follow / Unfollow", description: "Automatic switching between unfollow and follow tools", subOptions: [
        { key: "uf_h_autoEnabled",    label: "Enabled",                                          settingKeys: ["unfollow:autoFollowUnfollowEnabled"] },
        { key: "uf_h_autoStopAt",     label: "Stop unfollow at followings count",   settingKeys: ["unfollow:autoStopUnfollowAtFollowingsMin","unfollow:autoStopUnfollowAtFollowingsMax"] },
        { key: "uf_h_autoStartAfter", label: "Start follow after",             settingKeys: ["unfollow:autoStartFollowAfterMin","unfollow:autoStartFollowAfterMax"] },
      ]},
      { key: "hs_unfollowStopBlock", label: "Stop if Blocked", description: "Pause unfollow tool for a set time when Instagram blocks an unfollow action", subOptions: [
        { key: "uf_h_stopEnabled", label: "Enabled",              settingKeys: ["unfollow:stopOnBlockEnabled"] },
        { key: "uf_h_stopMinutes", label: "Stop duration", settingKeys: ["unfollow:stopOnBlockMinutes"] },
      ]},
    ]},
    { label: "Contact Tool Settings", options: [
      { key: "hs_contactNewFollowers", label: "Contact New Followers", description: "Auto-messaging settings for new followers", subOptions: [
        { key: "ct_h_onlyApp",   label: "Only app-followed users",              settingKeys: ["contact:contactOnlyAppFollowed"] },
        { key: "ct_h_message",   label: "Message template",                     settingKeys: ["contact:contactMessage"] },
        { key: "ct_h_interval",  label: "Check interval",      settingKeys: ["contact:contactCheckIntervalMin","contact:contactCheckIntervalMax"] },
        { key: "ct_h_perCheck",  label: "Users per check",          settingKeys: ["contact:contactUsersPerCheckMin","contact:contactUsersPerCheckMax"] },
        { key: "ct_h_apiSource", label: "API source",                           settingKeys: ["contact:contactApiSource"] },
      ]},
      { key: "hs_autoReplySettings", label: "Auto Reply", description: "Auto-respond to incoming messages", subOptions: [
        { key: "ct_h_arRules", label: "Reply rules", settingKeys: ["contact:autoReplies"] },
      ]},
      { key: "hs_contactUsersSettings", label: "Contact Users", description: "Manual user contact list settings", subOptions: [
        { key: "ct_h_usersWait",       label: "Wait between sessions",     settingKeys: ["contact:contactUsersWaitMin","contact:contactUsersWaitMax"] },
        { key: "ct_h_usersSendCount",  label: "Send count per session",         settingKeys: ["contact:contactUsersSendCountMin","contact:contactUsersSendCountMax"] },
        { key: "ct_h_usersDelay",      label: "Delay between messages",    settingKeys: ["contact:contactUsersDelayBetweenMin","contact:contactUsersDelayBetweenMax"] },
        { key: "ct_h_usersPickRandom", label: "Pick users randomly",                        settingKeys: ["contact:contactUsersPickRandom"] },
        { key: "ct_h_usersUnsend",     label: "Unsend settings",                            settingKeys: ["contact:contactUsersUnsendEnabled","contact:contactUsersUnsendMin","contact:contactUsersUnsendMax"] },
      ]},
      { key: "hs_contactStopBlock", label: "Stop if Blocked", description: "Pause contact tool for a set time when Instagram blocks a contact action", subOptions: [
        { key: "ct_h_stopEnabled", label: "Enabled",              settingKeys: ["contact:stopOnBlockEnabled"] },
        { key: "ct_h_stopMinutes", label: "Stop duration", settingKeys: ["contact:stopOnBlockMinutes"] },
      ]},
    ]},
  ];

  const handleHumanCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled          = expandedKeys.includes("startStop");
    const copyFollowEnabled    = expandedKeys.includes("hs_followEnabled");
    const copyUnfollowEnabled  = expandedKeys.includes("hs_unfollowEnabled");
    const copyCnfEnabled       = expandedKeys.includes("hs_cnfEnabled");
    const copyAutoReply        = expandedKeys.includes("hs_autoReplyEnabled");
    const copyContactUsers     = expandedKeys.includes("hs_contactUsersEnabled");
    const copyFollowSources    = expandedKeys.includes("hs_followSources");
    const clearFollowSources   = expandedKeys.includes("hs_clearFollowSources");

    const SENTINEL_KEYS = ["startStop", "hs_followEnabled", "hs_unfollowEnabled", "hs_cnfEnabled", "hs_autoReplyEnabled", "hs_contactUsersEnabled", "hs_followSources", "hs_clearFollowSources"];
    const keysToSend = expandedKeys.filter(k => !SENTINEL_KEYS.includes(k) && !k.includes(":"));

    const willRandomise = expandedKeys.includes("randomiseTiming");
    let staggerOffsets: number[] | undefined;
    if (willRandomise) {
      const delayMin = Math.max(1, (settings as any).delayMin ?? 30);
      const delayMax = Math.max(delayMin, (settings as any).delayMax ?? 60);
      staggerOffsets = targetIds.map(() =>
        delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
      );
    }
    try {
      await copyToolSettingsToProfiles(settings as Record<string,unknown>, tool.type, targetIds, keysToSend, copyEnabled ? tool.enabled : undefined, staggerOffsets);
    } catch (err) {
      console.error("[copySettings] Failed to copy human session settings:", err);
    }

    // ── Copy follow tool enabled state ───────────────────────────────────────
    if (copyFollowEnabled && followTool) {
      await Promise.all(targetIds.map(async (profileId) => {
        try {
          const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
          if (!res.ok) return;
          const tools: { id: number; type: string }[] = await res.json();
          const t = tools.find(t => t.type === "follow");
          if (!t) return;
          await fetch(`/api/tools/${t.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: followTool.enabled }),
            credentials: "include",
          });
        } catch {}
      }));
    }

    // ── Copy unfollow tool enabled state ──────────────────────────────────────
    if (copyUnfollowEnabled && unfollowTool) {
      await Promise.all(targetIds.map(async (profileId) => {
        try {
          const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
          if (!res.ok) return;
          const tools: { id: number; type: string }[] = await res.json();
          const t = tools.find(t => t.type === "unfollow");
          if (!t) return;
          await fetch(`/api/tools/${t.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: unfollowTool.enabled }),
            credentials: "include",
          });
        } catch {}
      }));
    }

    // ── Copy contact sub-feature states ───────────────────────────────────────
    const contactSrc: Record<string, unknown> = {};
    if (copyCnfEnabled && contactTool)    contactSrc.contactNewFollowersEnabled = !!(contactTool.settings as any)?.contactNewFollowersEnabled;
    if (copyAutoReply && contactTool)     contactSrc.autoReplyEnabled           = !!(contactTool.settings as any)?.autoReplyEnabled;
    if (copyContactUsers && contactTool)  contactSrc.contactUsersEnabled        = !!(contactTool.settings as any)?.contactUsersEnabled;
    if (Object.keys(contactSrc).length > 0) {
      try {
        await copyToolSettingsToProfiles(contactSrc, "contact", targetIds, Object.keys(contactSrc));
      } catch (err) {
        console.error("[copySettings] Failed to copy contact settings:", err);
      }
    }

    // ── Copy follow tool target sources ───────────────────────────────────────
    if ((copyFollowSources || clearFollowSources) && followTool) {
      const sourcesRes = copyFollowSources
        ? await fetch(`/api/tools/${followTool.id}/sources`, { credentials: "include" })
        : null;
      const currentSources: { type: string; value: string; rank?: number | null; nrPosts?: number | null }[] =
        sourcesRes?.ok ? await sourcesRes.json() : [];
      const payload = copyFollowSources && currentSources.length > 0
        ? currentSources.map(s => ({ type: s.type, value: s.value, rank: s.rank, nrPosts: s.nrPosts }))
        : [];

      await Promise.all(
        targetIds.map(async profileId => {
          const toolsRes = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
          if (!toolsRes.ok) return;
          const profileTools: { id: number; type: string }[] = await toolsRes.json();
          const targetFollowTool = profileTools.find(t => t.type === "follow");
          if (!targetFollowTool) return;

          if (clearFollowSources) {
            await fetch(`/api/tools/${targetFollowTool.id}/sources`, { method: "DELETE", credentials: "include" });
            queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, targetFollowTool.id] });
          }

          if (payload.length > 0) {
            const importRes = await fetch(`/api/tools/${targetFollowTool.id}/sources/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              credentials: "include",
            });
            if (importRes.ok) {
              queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, targetFollowTool.id] });
            } else {
              console.error(`[copySettings] Sources import failed for profile ${profileId}: ${importRes.status}`);
            }
          }
        })
      );
    }

    // ── Copy follow tool settings (prefixed keys "follow:...") ───────────────
    const followKeys = expandedKeys.filter(k => k.startsWith("follow:")).map(k => k.slice(7));
    if (followKeys.length > 0 && followTool) {
      try {
        await copyToolSettingsToProfiles(
          (followTool.settings as Record<string, unknown>) ?? {},
          "follow",
          targetIds,
          followKeys,
        );
      } catch (err) {
        console.error("[copySettings] Failed to copy follow tool settings:", err);
      }
    }

    // ── Copy unfollow tool settings (prefixed keys "unfollow:...") ───────────
    const unfollowKeys = expandedKeys.filter(k => k.startsWith("unfollow:")).map(k => k.slice(9));
    if (unfollowKeys.length > 0 && unfollowTool) {
      try {
        await copyToolSettingsToProfiles(
          (unfollowTool.settings as Record<string, unknown>) ?? {},
          "unfollow",
          targetIds,
          unfollowKeys,
        );
      } catch (err) {
        console.error("[copySettings] Failed to copy unfollow tool settings:", err);
      }
    }

    // ── Copy contact tool settings (prefixed keys "contact:...") ─────────────
    const contactKeys = expandedKeys.filter(k => k.startsWith("contact:")).map(k => k.slice(8));
    if (contactKeys.length > 0 && contactTool) {
      try {
        await copyToolSettingsToProfiles(
          (contactTool.settings as Record<string, unknown>) ?? {},
          "contact",
          targetIds,
          contactKeys,
        );
      } catch (err) {
        console.error("[copySettings] Failed to copy contact tool settings:", err);
      }
    }

    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const { data: repostedPostsList, isLoading: repostedPostsLoading } = useQuery<RepostedPost[]>({
    queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`],
    refetchInterval: 15000,
  });

  const [settings, setSettings] = useState<Record<string, any>>(() => {
    const def: Record<string, any> = {
      randomiseTiming: false,
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
      notificationsRunChanceMin: 100,
      notificationsRunChanceMax: 100,
      ownProfileRunChanceMin: 100,
      ownProfileRunChanceMax: 100,
      refreshProfileRunChanceMin: 100,
      refreshProfileRunChanceMax: 100,
      settingsActivityRunChanceMin: 100,
      settingsActivityRunChanceMax: 100,
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
      clickPostPercentMin: 0,
      clickPostPercentMax: 0,
      viewPostProfilePercentMin: 0,
      viewPostProfilePercentMax: 0,
      viewProfileFeedPercentMin: 0,
      viewProfileFeedPercentMax: 0,
      viewProfileFeedCountMin: 3,
      viewProfileFeedCountMax: 8,
      viewProfilePostsPercentMin: 0,
      viewProfilePostsPercentMax: 0,
      viewProfilePostsCountMin: 1,
      viewProfilePostsCountMax: 3,
      followOrderMin: 0,
      followOrderMax: 0,
      followSkipMin: 0,
      followSkipMax: 0,
      unfollowOrderMin: 0,
      unfollowOrderMax: 0,
      unfollowSkipMin: 0,
      unfollowSkipMax: 0,
      contactOrderMin: 0,
      contactOrderMax: 0,
      contactSkipMin: 0,
      contactSkipMax: 0,
      followSuggestedUsersIfEmptyEnabled: false,
      followSuggestedUsersIfEmptyMin: 1,
      followSuggestedUsersIfEmptyMax: 3,
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
      forceEmulationEnabled: false,
      forceEmulationRandomise: false,
      reelWatchPercentMin: 0,
      reelWatchPercentMax: 100,
      repostMin: 1,
      repostMax: 3,
    };
    return { ...def, ...(tool.settings as Record<string, any> || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localFolderPickerRef = useRef<HTMLInputElement>(null);
  const [localFolderFileCount, setLocalFolderFileCount] = useState<number | null>(null);

  useEffect(() => {
    const def: Record<string, any> = {
      randomiseTiming: false, delayMin: 30, delayMax: 60,
      viewTimelineFeedEnabled: true, viewTimelineFeedMin: 3, viewTimelineFeedMax: 8,
      viewTimelineFeedOrderMin: 5, viewTimelineFeedOrderMax: 10,
      viewTimelineFeedNotUsedMin: 0, viewTimelineFeedNotUsedMax: 0,
      humanSessionEnabled: true, humanSessionOrderMin: 0, humanSessionOrderMax: 0,
      humanSessionNotUsedMin: 0, humanSessionNotUsedMax: 0,
      notificationsRunChanceMin: 100, notificationsRunChanceMax: 100,
      ownProfileRunChanceMin: 100, ownProfileRunChanceMax: 100,
      refreshProfileRunChanceMin: 100, refreshProfileRunChanceMax: 100,
      settingsActivityRunChanceMin: 100, settingsActivityRunChanceMax: 100,
      checkTimelineStoriesEnabled: true, checkTimelineStoriesMin: 3, checkTimelineStoriesMax: 8,
      checkTimelineStoriesOrderMin: 0, checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0, checkTimelineStoriesNotUsedMax: 0,
      checkDmEnabled: true, checkDmMin: 5, checkDmMax: 15,
      checkDmOrderMin: 0, checkDmOrderMax: 0, checkDmNotUsedMin: 0, checkDmNotUsedMax: 0,
      likeTimelinePostsEnabled: false, likeTimelinePostsMin: 2, likeTimelinePostsMax: 5,
      likeTimelinePostsDelayMin: 3, likeTimelinePostsDelayMax: 8,
      likeTimelinePostsOrderMin: 0, likeTimelinePostsOrderMax: 0,
      likeTimelinePostsNotUsedMin: 0, likeTimelinePostsNotUsedMax: 0,
      saveMediaEnabled: false, saveMediaPercent: 20,
      likeTimelinePostsPercentMin: 0, likeTimelinePostsPercentMax: 0,
      clickPostPercentMin: 0, clickPostPercentMax: 0,
      viewPostProfilePercentMin: 0, viewPostProfilePercentMax: 0,
      viewProfileFeedPercentMin: 0, viewProfileFeedPercentMax: 0,
      viewProfileFeedCountMin: 3, viewProfileFeedCountMax: 8,
      viewProfilePostsPercentMin: 0, viewProfilePostsPercentMax: 0,
      viewProfilePostsCountMin: 1, viewProfilePostsCountMax: 3,
      followOrderMin: 0, followOrderMax: 0, followSkipMin: 0, followSkipMax: 0,
      unfollowOrderMin: 0, unfollowOrderMax: 0, unfollowSkipMin: 0, unfollowSkipMax: 0,
      contactOrderMin: 0, contactOrderMax: 0, contactSkipMin: 0, contactSkipMax: 0,
      followSuggestedUsersIfEmptyEnabled: false, followSuggestedUsersIfEmptyMin: 1, followSuggestedUsersIfEmptyMax: 3,
      repostEnabled: false, repostUseHikerApi: false, repostSourceUsername: "",
      repostDisableUsernameSource: false, repostLocalFolderEnabled: false,
      repostLocalFolderPath: "", repostLocalFolderDeleteAfterUpload: true,
      repostAlterationLevel: "small", repostCaptionText: "",
      repostImageSettings: {
        contrast: { enabled: true, min: 5, max: 250 }, brightness: { enabled: true, min: 5, max: 250 },
        noise: { enabled: true, min: 5, max: 15 }, sharpen: { enabled: true, min: 1.0, max: 2.0 },
        pixelate: { enabled: true, min: 0.9, max: 2.1 },
      },
      repostOrderMin: 0, repostOrderMax: 0, repostNotUsedMin: 0, repostNotUsedMax: 0,
      repostDisableComments: false, repostDisableAtPostCount: 0, repostDisableWhenExhausted: true,
      forceEmulationEnabled: false, forceEmulationRandomise: false,
      reelWatchPercentMin: 0, reelWatchPercentMax: 100,
      repostMin: 1, repostMax: 3,
    };
    setSettings(prev => ({ ...def, ...(tool.settings as Record<string, any> || {}), ...prev }));
  }, [tool.id]);

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
        <Label className="text-xs text-muted-foreground uppercase">Min</Label>
        <div className="relative">
          <Input type="number" min="0" max="100" className="w-16 h-7 text-xs pr-5"
            value={settings[minKey] ?? 0}
            onChange={(e) => setSettings({ ...settings, [minKey]: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground uppercase">Max</Label>
        <div className="relative">
          <Input type="number" min="0" max="100" className="w-16 h-7 text-xs pr-5"
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
    return { label: format(new Date(nextAt), "HH:mm:ss, d MMM"), executing: false };
  })();

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* ── Master enable/disable ─────────────────────────────── */}
      <div className="border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="font-bold text-[19px] shrink-0">Human Session Tool</h4>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(enabled) => {
              updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled });
            }}
            disabled={updateToolMutation.isPending}
          />
          <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
            {tool.enabled ? 'ACTIVE' : 'STOPPED'}
          </span>
          {/* ── Execute Every — inline on title row ── */}
          <div className="flex items-center gap-2 ml-2 pl-2 border-l border-border">
            <span className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">Execute Every (min)</span>
            <div className="flex items-center gap-1.5">
              <Label className="text-[10px] text-muted-foreground">Min</Label>
              <Input type="number" min="1" max="10000" className="w-14 h-7 text-xs"
                value={settings.delayMin ?? 30}
                onChange={(e) => setSettings({ ...settings, delayMin: Math.max(1, Number(e.target.value)) })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-[10px] text-muted-foreground">Max</Label>
              <Input type="number" min="1" max="10000" className="w-14 h-7 text-xs"
                value={settings.delayMax ?? 60}
                onChange={(e) => setSettings({ ...settings, delayMax: Math.max(1, Number(e.target.value)) })}
              />
            </div>
          </div>
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

      {/* ── EMULATION GROUP ──────────────────────────────────────────── */}
      <div className="mt-[25px] max-w-[50%]">
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 border-b border-cyan-400">
            <Zap className="w-5 h-5 text-white shrink-0" />
            <h4 className="font-bold text-[17px] text-white">Emulation</h4>
          </div>
          <div className="divide-y divide-border">

            {/* ── Open Instagram Calls (was Force Emulation) ── */}
            <div className="px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-semibold text-sm whitespace-nowrap">Open Instagram Calls</span>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="forceEmulationEnabled"
                    checked={!!settings.forceEmulationEnabled}
                    onChange={(e) => setSettings({ ...settings, forceEmulationEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor="forceEmulationEnabled" className="text-sm font-medium cursor-pointer select-none">Enabled</label>
                </div>
                <div className={`flex items-center gap-2 transition-opacity ${!settings.forceEmulationEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <input type="checkbox" id="forceEmulationRandomise"
                    checked={!!settings.forceEmulationRandomise}
                    onChange={(e) => setSettings({ ...settings, forceEmulationRandomise: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor="forceEmulationRandomise" className="text-sm cursor-pointer select-none">Randomise order</label>
                </div>
              </div>
              <div className={`flex items-center gap-2 mt-2 transition-opacity ${!settings.forceEmulationEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Fire Chance %</span>
                <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                  value={(settings as any).forceEmulationChanceMin ?? 100}
                  onChange={(e) => setSettings({ ...settings, forceEmulationChanceMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                  value={(settings as any).forceEmulationChanceMax ?? 100}
                  onChange={(e) => setSettings({ ...settings, forceEmulationChanceMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                />
                <span className="text-[10px] text-muted-foreground">% of executions</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Fires Instagram app-open API calls at the start of every session, before any other action runs.
              </p>
            </div>

            {/* ── View Timeline Feed ── */}
            <div className="px-4 py-3 space-y-1.5">
              {/* ROW 1: [✓] View Timeline Feed | Posts Min/Max | If 0 Posts→Follow Suggested | Reel View%  ——  Order % / Skip Chance on right */}
              <div className="flex items-center justify-between gap-4">
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
                      <UserPlus className="w-3.5 h-3.5 text-green-500 shrink-0" />
                      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">If 0 Posts → Follow Suggested</span>
                      <input type="checkbox" id="followSuggestedUsersIfEmptyEnabled"
                        checked={!!settings.followSuggestedUsersIfEmptyEnabled}
                        onChange={(e) => setSettings({ ...settings, followSuggestedUsersIfEmptyEnabled: e.target.checked })}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <div className={`flex items-center gap-1.5 transition-opacity ${!settings.followSuggestedUsersIfEmptyEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input type="number" min="1" max="10" className="w-12 h-7 text-xs"
                          value={settings.followSuggestedUsersIfEmptyMin ?? 1}
                          onChange={(e) => setSettings({ ...settings, followSuggestedUsersIfEmptyMin: Math.max(1, Number(e.target.value)) })}
                        />
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input type="number" min="1" max="10" className="w-12 h-7 text-xs"
                          value={settings.followSuggestedUsersIfEmptyMax ?? 3}
                          onChange={(e) => setSettings({ ...settings, followSuggestedUsersIfEmptyMax: Math.max(1, Number(e.target.value)) })}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <PlaySquare className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reel View%</span>
                      {pctInputs("reelWatchPercentMin", "reelWatchPercentMax")}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, viewTimelineFeedOrderMin: Math.max(0, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, viewTimelineFeedOrderMax: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, viewTimelineFeedNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, viewTimelineFeedNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                  </div>
                </div>
              </div>
              {/* ROW 2: Like% | Like Delay | Save Liked — left-aligned */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  <Heart className="w-3.5 h-3.5 text-pink-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                  {pctInputs("likeTimelinePostsPercentMin", "likeTimelinePostsPercentMax")}
                </div>
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
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Save Liked</span>
                  <input type="checkbox" id="saveMediaEnabled"
                    checked={!!settings.saveMediaEnabled}
                    onChange={(e) => setSettings({ ...settings, saveMediaEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <div className={`flex items-center gap-1.5 transition-opacity ${!settings.saveMediaEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="relative">
                      <Input type="number" min={1} max={100} className="w-14 h-7 text-xs pr-5"
                        value={settings.saveMediaPercent ?? 20}
                        onChange={(e) => setSettings({ ...settings, saveMediaPercent: Math.min(100, Math.max(1, Number(e.target.value))) })}
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">of liked saved</span>
                  </div>
                </div>
              </div>
              {/* ROW 3: Click on Post% */}
              <div className={`flex items-center gap-1.5 pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                {pctInputs("clickPostPercentMin", "clickPostPercentMax")}
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Click on Post% — chance to open a post from the feed</span>
              </div>
        {/* ── Click Post → Visit Profile → View Feed → View Posts cascade ── */}
        {!!settings.viewTimelineFeedEnabled && (
          <div className="border-l-2 border-muted ml-1 pl-3 space-y-2 pt-1">

            {/* Visit Profile % — shown when click% is set */}
            {(settings.clickPostPercentMax ?? 0) > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE%</span>
                {pctInputs("viewPostProfilePercentMin", "viewPostProfilePercentMax")}
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">CHANCE TO VISIT THE POST AUTHOR'S PROFILE</span>
              </div>
            )}

            {/* View Profile's Feed % + View Timeline Posts — on same row */}
            {(settings.clickPostPercentMax ?? 0) > 0 && (settings.viewPostProfilePercentMax ?? 0) > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE'S FEED%</span>
                {pctInputs("viewProfileFeedPercentMin", "viewProfileFeedPercentMax")}
                {(settings.viewProfileFeedPercentMax ?? 0) > 0 && (
                  <>
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">AMOUNT OF POSTS TO SCROLL</span>
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <Input type="number" min="1" max="20" className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMin ?? 1}
                      onChange={(e) => setSettings({ ...settings, viewProfilePostsCountMin: Math.max(1, Number(e.target.value)) })}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <Input type="number" min="1" max="20" className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMax ?? 3}
                      onChange={(e) => setSettings({ ...settings, viewProfilePostsCountMax: Math.max(1, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">at</span>
                    {pctInputs("viewProfilePostsPercentMin", "viewProfilePostsPercentMax")}
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">chance</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

            {/* ── Human Session ── */}
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-wrap">
                <input type="checkbox" id="humanSessionEnabled"
                  checked={!!settings.humanSessionEnabled}
                  onChange={(e) => setSettings({ ...settings, humanSessionEnabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                />
                <label htmlFor="humanSessionEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none whitespace-nowrap shrink-0">
                  <User className="w-4 h-4 text-violet-500" />
                  Human Session
                </label>
                <div className={`flex items-center gap-2.5 flex-wrap transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  {([
                    { minKey: "notificationsRunChanceMin",    maxKey: "notificationsRunChanceMax",    label: "Notifs",   Icon: Bell,      color: "text-orange-500" },
                    { minKey: "ownProfileRunChanceMin",       maxKey: "ownProfileRunChanceMax",       label: "Profile",  Icon: User,      color: "text-indigo-500" },
                    { minKey: "refreshProfileRunChanceMin",   maxKey: "refreshProfileRunChanceMax",   label: "Refresh",  Icon: RefreshCw, color: "text-cyan-500"   },
                    { minKey: "settingsActivityRunChanceMin", maxKey: "settingsActivityRunChanceMax", label: "Settings", Icon: Settings,  color: "text-gray-500"   },
                  ] as { minKey: string; maxKey: string; label: string; Icon: React.ElementType; color: string }[]).map(({ minKey, maxKey, label, Icon, color }, idx, arr) => (
                    <div key={minKey} className="flex items-center gap-1 shrink-0">
                      <Icon className={`w-3 h-3 shrink-0 ${color}`} />
                      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide whitespace-nowrap shrink-0">{label}</span>
                      <div className="flex items-center gap-0.5">
                        <div className="relative">
                          <Input type="number" min="0" max="100" className="w-14 h-6 text-xs pr-5 pl-1.5"
                            value={(settings as any)[minKey] ?? 100}
                            onChange={e => setSettings({ ...settings, [minKey]: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                          />
                          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground px-0.5">–</span>
                        <div className="relative">
                          <Input type="number" min="0" max="100" className="w-14 h-6 text-xs pr-5 pl-1.5"
                            value={(settings as any)[maxKey] ?? 100}
                            onChange={e => setSettings({ ...settings, [maxKey]: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                          />
                          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                        </div>
                      </div>
                      {idx < arr.length - 1 && <span className="text-border text-xs ml-1 shrink-0">|</span>}
                    </div>
                  ))}
                </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.humanSessionOrderMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, humanSessionOrderMin: Math.max(0, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.humanSessionOrderMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, humanSessionOrderMax: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.humanSessionNotUsedMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, humanSessionNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.humanSessionNotUsedMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, humanSessionNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                  </div>
                </div>
              </div>
              <p className={`text-[11px] text-muted-foreground transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40' : ''}`}>
                Runs all four sub-actions in a random order each session: visits the notification inbox, browses the account's own profile, pull-to-refreshes it, and opens Settings &amp; Activity.
              </p>
            </div>

            {/* ── Check Stories from Timeline ── */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
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
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesOrderMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkTimelineStoriesOrderMin: Math.max(0, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesOrderMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkTimelineStoriesOrderMax: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesNotUsedMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkTimelineStoriesNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesNotUsedMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkTimelineStoriesNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Check Direct Messages ── */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
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
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkDmOrderMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkDmOrderMin: Math.max(0, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkDmOrderMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkDmOrderMax: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkDmNotUsedMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkDmNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.checkDmNotUsedMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, checkDmNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Make a Post ── */}
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="checkbox" id="repostEnabled"
                    checked={!!settings.repostEnabled}
                    onChange={(e) => setSettings({ ...settings, repostEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="repostEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <Repeat2 className="w-4 h-4 text-green-500" />
                    Make a Post
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-1.5 text-xs h-7 px-2.5"
                    onClick={() => setShowReposted(v => !v)}
                  >
                    <Repeat2 className="w-3.5 h-3.5 text-green-500" />
                    Posted Posts
                    <span className="text-[10px] text-muted-foreground ml-0.5">({repostedPostsList?.length ?? '…'})</span>
                    {showReposted ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.repostOrderMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, repostOrderMin: Math.max(0, Number(e.target.value)) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.repostOrderMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, repostOrderMax: Math.max(0, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.repostNotUsedMin ?? 0}
                      onChange={(e) => setSettings({ ...settings, repostNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                      value={settings.repostNotUsedMax ?? 0}
                      onChange={(e) => setSettings({ ...settings, repostNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) })}
                    />
                  </div>
                </div>
              </div>

              {/* Posted Posts table */}
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
                              <p className="text-xs font-medium">No posts yet</p>
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
                                    className="flex items-center gap-1 text-primary hover:underline group"
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

        <div className={`space-y-3 ${!settings.repostEnabled ? 'hidden' : ''}`}>
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
              placeholder="Type a caption or use a token"
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

          {/* Source 1: @username */}
          <div className="border border-border/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="repostDisableUsernameSource"
                checked={!!settings.repostDisableUsernameSource}
                onChange={(e) => setSettings({ ...settings, repostDisableUsernameSource: e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer"
              />
              <label htmlFor="repostDisableUsernameSource" className="text-[11px] text-muted-foreground cursor-pointer select-none">Disable this source</label>
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5 ml-1">
                <AtSign className="w-3.5 h-3.5 text-muted-foreground" /> Source: Instagram Account
              </Label>
            </div>
            {!settings.repostDisableUsernameSource && (<>
            <div className={`flex flex-wrap items-end gap-4`}>
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
            </>)}
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

        </div>
      </div>

          </div>{/* end divide-y */}
        </div>{/* end EMULATION rounded-xl */}
      </div>{/* end EMULATION outer */}

      {/* ── Follow Tool (embedded) ────────────────────────────── */}
      {followTool && (
        <div className="mt-[25px] max-w-[50%]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-cyan-500 border-b border-cyan-400 gap-4">
              <div className="flex items-center gap-2">
                <UserPlus className="w-8 h-8 text-white shrink-0" />
                <h4 className="font-bold text-[19px] shrink-0 text-white">Follow Tool</h4>
                <input
                  type="checkbox"
                  id={`ft-enabled-${followTool.id}`}
                  checked={followTool.enabled}
                  onChange={(e) => embeddedUpdateTool.mutate({ id: followTool.id, profileId: followTool.profileId, enabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-white cursor-pointer"
                />
                <label htmlFor={`ft-enabled-${followTool.id}`} className="text-sm font-medium cursor-pointer select-none text-white">
                  {followTool.enabled ? "ACTIVE" : "STOPPED"}
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).followOrderMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, followOrderMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).followOrderMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, followOrderMax: Number(e.target.value) } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).followSkipMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, followSkipMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).followSkipMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, followSkipMax: Number(e.target.value) } as any)}
                  />
                </div>
              </div>
            </div>
            {followTool.enabled && <div className="p-4">
              <ToolConfigPanel tool={followTool} profile={profile} hideEnableToggle skipChanceMin={(settings as any).followSkipMin ?? 0} skipChanceMax={(settings as any).followSkipMax ?? 0} executeEveryMin={settings.delayMin ?? 30} executeEveryMax={settings.delayMax ?? 60} />
            </div>}
          </div>
        </div>
      )}

      {/* ── Unfollow Tool (embedded) ──────────────────────────── */}
      {unfollowTool && (
        <div className="mt-[25px] max-w-[50%]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-cyan-500 border-b border-cyan-400 gap-4">
              <div className="flex items-center gap-2">
                <UserMinus className="w-8 h-8 text-white shrink-0" />
                <h4 className="font-bold text-[19px] shrink-0 text-white">Unfollow Tool</h4>
                <input
                  type="checkbox"
                  id={`uft-enabled-${unfollowTool.id}`}
                  checked={unfollowTool.enabled}
                  onChange={(e) => embeddedUpdateTool.mutate({ id: unfollowTool.id, profileId: unfollowTool.profileId, enabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-white cursor-pointer"
                />
                <label htmlFor={`uft-enabled-${unfollowTool.id}`} className="text-sm font-medium cursor-pointer select-none text-white">
                  {unfollowTool.enabled ? "ACTIVE" : "STOPPED"}
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowOrderMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, unfollowOrderMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowOrderMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, unfollowOrderMax: Number(e.target.value) } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowSkipMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, unfollowSkipMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowSkipMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, unfollowSkipMax: Number(e.target.value) } as any)}
                  />
                </div>
              </div>
            </div>
            {unfollowTool.enabled && <div className="p-4">
              <UnfollowToolPanel tool={unfollowTool} profile={profile} hideEnableToggle skipChanceMin={(settings as any).unfollowSkipMin ?? 0} skipChanceMax={(settings as any).unfollowSkipMax ?? 0} />
            </div>}
          </div>
        </div>
      )}

      {/* ── Contact Tool (embedded) ───────────────────────────── */}
      {contactTool && (
        <div className="mt-[25px] max-w-[50%]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-cyan-500 border-b border-cyan-400 gap-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-8 h-8 text-white shrink-0" />
                <h4 className="font-bold text-[19px] shrink-0 text-white">Contact Tool</h4>
                <input
                  type="checkbox"
                  id={`ct-enabled-${contactTool.id}`}
                  checked={contactTool.enabled}
                  onChange={(e) => embeddedUpdateTool.mutate({ id: contactTool.id, profileId: contactTool.profileId, enabled: e.target.checked })}
                  className="w-3.5 h-3.5 accent-white cursor-pointer"
                />
                <label htmlFor={`ct-enabled-${contactTool.id}`} className="text-sm font-medium cursor-pointer select-none text-white">
                  {contactTool.enabled ? "ACTIVE" : "STOPPED"}
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).contactOrderMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, contactOrderMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).contactOrderMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, contactOrderMax: Number(e.target.value) } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).contactSkipMin ?? 0}
                    onChange={(e) => setSettings({ ...settings, contactSkipMin: Number(e.target.value) } as any)}
                  />
                  <span className="text-[10px] text-white">–</span>
                  <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                    value={(settings as any).contactSkipMax ?? 0}
                    onChange={(e) => setSettings({ ...settings, contactSkipMax: Number(e.target.value) } as any)}
                  />
                </div>
              </div>
            </div>
            {contactTool.enabled && <div className="p-4">
              <ContactToolPanel tool={contactTool} profile={profile} embedded />
            </div>}
          </div>
        </div>
      )}

      <CopySettingsDialog
        key={_copyOpen ? "open" : "closed"}
        open={_copyOpen}
        onOpenChange={_setCopyOpenFn}
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
