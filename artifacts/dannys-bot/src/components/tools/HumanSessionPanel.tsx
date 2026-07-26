import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfiles } from "@/hooks/use-profiles";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumField } from "@/components/ui/num-field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Bell, User, RefreshCw, Settings, PlaySquare, BookOpen, Bookmark,
  MessageSquare, Repeat2, AtSign, Clock, ExternalLink, Image as ImageIcon,
  ChevronDown, ChevronUp, Heart, Copy, FolderOpen, UserPlus, UserMinus, Zap, Film, Percent, AlignLeft, Trash2, Globe, Compass, Music, Hash,
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
  overrideProfiles?: Profile[];
}

export function HumanSessionPanel({ tool, profile, copyOpen: copyOpenProp, onCopyOpenChange, followTool, unfollowTool, contactTool, overrideProfiles }: HumanSessionPanelProps) {
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
  const [webBrowsingTab, setWebBrowsingTab] = useState<"settings"|"log">("settings");
  const _copyOpen = copyOpenProp ?? copyOpen;
  const _setCopyOpenFn = onCopyOpenChange ?? _setCopyOpen;
  const [repostingNow, setRepostingNow] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const otherProfiles = overrideProfiles ?? allProfiles.filter(p => p.id !== tool.profileId && !p.locked && !p.isTemplate);
  const hasOtherProfiles = overrideProfiles ? overrideProfiles.length > 0 : allProfiles.some(p => p.id !== tool.profileId);

  const HUMAN_COPY_GROUPS: CopyOptionGroup[] = [
    { label: "General", options: [
      // NOTE: "startStop" (Tool Toggle enabled/disabled) is intentionally excluded here.
      // The on/off state of each slot is independently owned — propagating it via
      // Copy Settings stamps enabled=true onto every target account, causing all
      // of their HS toggles to show as running in the UI.  Do NOT re-add it.
      { key: "randomiseTiming", label: "Randomise timing", description: "Stagger each account's start across the delay window" },
      { key: "humanToolsDelay", label: "Human Tools Delay", description: "Interval between human session runs", subOptions: [
        { key: "hs_delayRange", label: "Session delay range", settingKeys: ["delayMin","delayMax"] },
      ]},
    ]},
    { label: "Emulation", options: [
      { key: "hs_emulationGroup", label: "Emulation Group", description: "Enable / disable the entire Emulation section", subOptions: [
        { key: "emg_enabled", label: "Enabled", settingKeys: ["emulationGroupEnabled"] },
      ]},
      { key: "viewTimelineFeed", label: "View Timeline Feed", description: "Scrolling through the main feed + inline liking", subOptions: [
        { key: "vtf_enabled",    label: "Enabled",                                       settingKeys: ["viewTimelineFeedEnabled"] },
        { key: "vtf_count",      label: "Posts per session",                 settingKeys: ["viewTimelineFeedMin","viewTimelineFeedMax"] },
        { key: "vtf_order",      label: "Execution order",                   settingKeys: ["viewTimelineFeedOrderMin","viewTimelineFeedOrderMax"] },
        { key: "vtf_chance",     label: "Skip chance %",       settingKeys: ["viewTimelineFeedNotUsedMin","viewTimelineFeedNotUsedMax"] },
        { key: "vtf_like_pct",    label: "% posts to like",                  settingKeys: ["likeTimelinePostsPercentMin","likeTimelinePostsPercentMax"] },
        { key: "vtf_like_delay",  label: "Delay between likes in sec",       settingKeys: ["likeTimelinePostsDelayMin","likeTimelinePostsDelayMax"] },
        { key: "vtf_save_media",  label: "Save liked media",               settingKeys: ["saveMediaEnabled","saveMediaPercent"] },
        { key: "vtf_share_post",  label: "Share % (chance to share viewed posts to feed)", settingKeys: ["sharePostPercentMin","sharePostPercentMax"] },
        { key: "vtf_expand_caption", label: "Expand Caption %",             settingKeys: ["expandCaptionPercentMin","expandCaptionPercentMax"] },
        { key: "vtf_tap_audio",          label: "Tap Audio % (browse song page)",       settingKeys: ["tapAudioPercentMin","tapAudioPercentMax"] },
        { key: "vtf_click_hashtag",      label: "Click Hashtag % (browse hashtag grid)", settingKeys: ["clickHashtagPercentMin","clickHashtagPercentMax"] },
        { key: "vtf_view_profile",     label: "Visit profile %",             settingKeys: ["viewPostProfilePercentMin","viewPostProfilePercentMax"] },
        { key: "vtf_profile_feed",     label: "View profile feed % + count", settingKeys: ["viewProfileFeedPercentMin","viewProfileFeedPercentMax","viewProfileFeedCountMin","viewProfileFeedCountMax"] },
        { key: "vtf_profile_posts",    label: "Open profile posts count + %",settingKeys: ["viewProfilePostsCountMin","viewProfilePostsCountMax","viewProfilePostsPercentMin","viewProfilePostsPercentMax"] },
      ]},
      { key: "explorePage", label: "Visit Explore Page", description: "Independent explore-page browsing session with its own order and skip chance", subOptions: [
        { key: "ep_enabled", label: "Enabled",          settingKeys: ["followSuggestedUsersIfEmptyEnabled"] },
        { key: "ep_order",   label: "Execution order",  settingKeys: ["explorePageOrderMin","explorePageOrderMax"] },
        { key: "ep_chance",  label: "Skip chance %",    settingKeys: ["explorePageSkipMin","explorePageSkipMax"] },
        { key: "ep_scroll",  label: "Posts to scroll",  settingKeys: ["exploreScrollMin","exploreScrollMax"] },
        { key: "ep_click",   label: "Posts to click",   settingKeys: ["exploreClickMin","exploreClickMax"] },
        { key: "ep_like",    label: "Like %",           settingKeys: ["exploreLikePctMin","exploreLikePctMax"] },
        { key: "ep_profile", label: "Visit author profile %", settingKeys: ["exploreVisitProfilePctMin","exploreVisitProfilePctMax"] },
        { key: "ep_prof_scroll", label: "Posts to scroll on profile", settingKeys: ["exploreProfileScrollMin","exploreProfileScrollMax"] },
        { key: "ep_prof_click",  label: "Posts to click on profile",  settingKeys: ["exploreProfileClickMin","exploreProfileClickMax"] },
      ]},
      { key: "viewReels", label: "View Reels", description: "Independent reels-watching session, not tied to the timeline feed", subOptions: [
        { key: "vr_enabled",  label: "Enabled",           settingKeys: ["viewReelsEnabled"] },
        { key: "vr_order",    label: "Execution order",   settingKeys: ["viewReelsOrderMin","viewReelsOrderMax"] },
        { key: "vr_chance",   label: "Chance % (% chance reels run at all)", settingKeys: ["reelWatchChanceMin","reelWatchChanceMax"] },
        { key: "vr_count",    label: "Reels/Op (how many reels to watch)", settingKeys: ["reelWatchCountMin","reelWatchCountMax"] },
        { key: "vr_view_pct", label: "% of each reel to watch", settingKeys: ["reelWatchPercentMin","reelWatchPercentMax"] },
        { key: "vr_like_pct", label: "% of reels to like",      settingKeys: ["reelLikePercentMin","reelLikePercentMax"] },
        { key: "vr_skip",     label: "Skip chance %",     settingKeys: ["viewReelsNotUsedMin","viewReelsNotUsedMax"] },
      ]},
      { key: "humanSession", label: "Random Actions", description: "Core session order and cool-down", subOptions: [
        { key: "hs_enabled",      label: "Enabled",                                      settingKeys: ["humanSessionEnabled"] },
        { key: "hs_order",        label: "Execution order",                  settingKeys: ["humanSessionOrderMin","humanSessionOrderMax"] },
        { key: "hs_chance",       label: "Skip chance %",      settingKeys: ["humanSessionNotUsedMin","humanSessionNotUsedMax"] },
        { key: "hs_notif",        label: "Notifications run chance %",       settingKeys: ["notificationsRunChanceMin","notificationsRunChanceMax"] },
        { key: "hs_ownprofile",   label: "Own Profile run chance %",         settingKeys: ["ownProfileRunChanceMin","ownProfileRunChanceMax"] },
        { key: "hs_settings",     label: "Settings run chance %",            settingKeys: ["settingsActivityRunChanceMin","settingsActivityRunChanceMax"] },
        { key: "hs_activity",     label: "View Activity run chance %",       settingKeys: ["viewActivityRunChanceMin","viewActivityRunChanceMax"] },
        { key: "hs_saved",        label: "View Saved run chance %",          settingKeys: ["viewSavedRunChanceMin","viewSavedRunChanceMax"] },
      ]},
      { key: "checkStories", label: "Check Timeline Stories", description: "Watch stories while active", subOptions: [
        { key: "cs_enabled", label: "Enabled",                            settingKeys: ["checkTimelineStoriesEnabled"] },
        { key: "cs_count",   label: "Stories per session",    settingKeys: ["checkTimelineStoriesMin","checkTimelineStoriesMax"] },
        { key: "cs_order",   label: "Execution order",        settingKeys: ["checkTimelineStoriesOrderMin","checkTimelineStoriesOrderMax"] },
        { key: "cs_chance",  label: "Skip chance %", settingKeys: ["checkTimelineStoriesNotUsedMin","checkTimelineStoriesNotUsedMax"] },
        { key: "cs_like",    label: "Like %",        settingKeys: ["storyLikePctMin","storyLikePctMax"] },
        { key: "cs_share",   label: "Share %",       settingKeys: ["storySharePctMin","storySharePctMax"] },
      ]},
      { key: "checkDm", label: "Check DMs", description: "Read direct messages", subOptions: [
        { key: "dm_enabled", label: "Enabled",                            settingKeys: ["checkDmEnabled"] },
        { key: "dm_count",   label: "DMs per session",        settingKeys: ["checkDmMin","checkDmMax"] },
        { key: "dm_order",   label: "Execution order",        settingKeys: ["checkDmOrderMin","checkDmOrderMax"] },
        { key: "dm_chance",  label: "Skip chance %", settingKeys: ["checkDmNotUsedMin","checkDmNotUsedMax"] },
      ]},
      { key: "repost", label: "Repost", description: "Repost settings for source account, local folder, alteration, caption and stop conditions", subOptions: [
        { key: "rp_enabled",         label: "Enabled",                          settingKeys: ["repostEnabled"] },
        { key: "rp_source",          label: "Source account",                   settingKeys: ["repostSourceUsername"] },
        { key: "rp_disable_src",     label: "Disable username source",          settingKeys: ["repostDisableUsernameSource"] },
        { key: "rp_hiker",           label: "Use HikerAPI",                     settingKeys: ["repostUseHikerApi"] },
        { key: "rp_local_folder",    label: "Local folder (path + enabled)",    settingKeys: ["repostLocalFolderEnabled","repostLocalFolderPath"] },
        { key: "rp_local_opts",      label: "Local folder options",             settingKeys: ["repostLocalFolderDeleteAfterUpload","repostLocalFolderNoRepeat","repostLocalFolderRandom"] },
        { key: "rp_count",           label: "Posts per session",                settingKeys: ["repostMin","repostMax"] },
        { key: "rp_alteration",      label: "Alteration & image settings",      settingKeys: ["repostAlterationLevel","repostImageSettings"] },
        { key: "rp_make_unique",     label: "Make it unique",                   settingKeys: ["repostMakeUnique"] },
        { key: "rp_chatgpt",         label: "Use ChatGPT for caption",          settingKeys: ["repostUseChatGpt"] },
        { key: "rp_caption",         label: "Caption text",                     settingKeys: ["repostCaptionText"] },
        { key: "rp_comments",        label: "Disable comments",                 settingKeys: ["repostDisableComments"] },
        { key: "rp_order",           label: "Execution order",                  settingKeys: ["repostOrderMin","repostOrderMax"] },
        { key: "rp_chance",          label: "Skip chance %",                    settingKeys: ["repostNotUsedMin","repostNotUsedMax"] },
        { key: "rp_stop",            label: "Stop conditions",                  settingKeys: ["repostDisableAtPostCount","repostDisableWhenExhausted"] },
      ]},
    ]},
    { label: "Follow Tool Settings", options: [
      { key: "hs_followEnabled", label: "Follow Tool Start / Stop", description: "Copy the Follow Tool enabled checkbox to other profiles" },
      { key: "hs_followOrder", label: "Follow Tool Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Follow Tool", subOptions: [
        { key: "fo_orderRange", label: "Execution order", settingKeys: ["followOrderMin","followOrderMax"] },
        { key: "fo_skipRange",  label: "Skip chance %",   settingKeys: ["followSkipMin","followSkipMax"] },
      ]},
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
        { key: "hf_injectProfileBrowsing", label: "Inject Profile Browsing", settingKeys: ["follow:injectProfileBrowsingEnabled","follow:injectProfileBrowsingMin","follow:injectProfileBrowsingMax","follow:injectProfileBrowsingBeforeFollow","follow:injectProfileBrowsingBeforeFollowPctMin","follow:injectProfileBrowsingBeforeFollowPctMax","follow:injectProfileBrowsingFeedChanceMin","follow:injectProfileBrowsingFeedChanceMax","follow:injectProfileBrowsingFeedMin","follow:injectProfileBrowsingFeedMax","follow:injectProfileBrowsingFeedOrderMin","follow:injectProfileBrowsingFeedOrderMax","follow:injectProfileBrowsingLikePctMin","follow:injectProfileBrowsingLikePctMax","follow:injectProfileBrowsingLikeScrollMin","follow:injectProfileBrowsingLikeScrollMax","follow:injectProfileBrowsingLikePctOrderMin","follow:injectProfileBrowsingLikePctOrderMax","follow:injectProfileBrowsingSaveMediaPctMin","follow:injectProfileBrowsingSaveMediaPctMax","follow:injectProfileBrowsingSaveMediaScrollMin","follow:injectProfileBrowsingSaveMediaScrollMax","follow:injectProfileBrowsingSaveMediaPctOrderMin","follow:injectProfileBrowsingSaveMediaPctOrderMax","follow:injectProfileBrowsingWatchStoriesPctMin","follow:injectProfileBrowsingWatchStoriesPctMax","follow:injectProfileBrowsingWatchStoriesScrollMin","follow:injectProfileBrowsingWatchStoriesScrollMax","follow:injectProfileBrowsingWatchStoriesPctOrderMin","follow:injectProfileBrowsingWatchStoriesPctOrderMax","follow:injectProfileBrowsingViewHighlightsPctMin","follow:injectProfileBrowsingViewHighlightsPctMax","follow:injectProfileBrowsingViewHighlightsScrollMin","follow:injectProfileBrowsingViewHighlightsScrollMax","follow:injectProfileBrowsingViewHighlightsPctOrderMin","follow:injectProfileBrowsingViewHighlightsPctOrderMax","follow:injectProfileBrowsingViewReelsPctMin","follow:injectProfileBrowsingViewReelsPctMax","follow:injectProfileBrowsingViewReelsScrollMin","follow:injectProfileBrowsingViewReelsScrollMax","follow:injectProfileBrowsingViewReelsPctOrderMin","follow:injectProfileBrowsingViewReelsPctOrderMax","follow:injectProfileBrowsingCommentEnabled","follow:injectProfileBrowsingCommentPctMin","follow:injectProfileBrowsingCommentPctMax","follow:injectProfileBrowsingCommentPctOrderMin","follow:injectProfileBrowsingCommentPctOrderMax","follow:injectProfileBrowsingCommentText","follow:injectProfileBrowsingShareToDmPctMin","follow:injectProfileBrowsingShareToDmPctMax","follow:injectProfileBrowsingShareToDmPctOrderMin","follow:injectProfileBrowsingShareToDmPctOrderMax","follow:injectProfileBrowsingAbandonFollow","follow:injectProfileBrowsingAbandonFollowPctMin","follow:injectProfileBrowsingAbandonFollowPctMax","follow:injectProfileBrowsingAbandonFollowOrderMin","follow:injectProfileBrowsingAbandonFollowOrderMax"] },
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
    ]},
    { label: "Unfollow Tool Settings", options: [
      { key: "hs_unfollowEnabled", label: "Unfollow Tool Start / Stop", description: "Copy the Unfollow Tool enabled checkbox to other profiles" },
      { key: "hs_unfollowOrder", label: "Unfollow Tool Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Unfollow Tool", subOptions: [
        { key: "ufo_orderRange", label: "Execution order", settingKeys: ["unfollowOrderMin","unfollowOrderMax"] },
        { key: "ufo_skipRange",  label: "Skip chance %",   settingKeys: ["unfollowSkipMin","unfollowSkipMax"] },
      ]},
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
      { key: "hs_cnfEnabled",          label: "Contact New Followers Start / Stop",   description: "Copy the Contact New Followers enabled checkbox" },
      { key: "hs_autoReplyEnabled",    label: "Auto Reply Start / Stop",              description: "Copy the Auto Reply enabled checkbox" },
      { key: "hs_contactUsersEnabled", label: "Contact Users Sending Start / Stop",   description: "Copy the Contact Users Sending enabled checkbox" },
      { key: "hs_contactOrder", label: "Contact Tool Execution Order & Skip", description: "Copy execution order and skip chance for the embedded Contact Tool", subOptions: [
        { key: "co_orderRange", label: "Execution order", settingKeys: ["contactOrderMin","contactOrderMax"] },
        { key: "co_skipRange",  label: "Skip chance %",   settingKeys: ["contactSkipMin","contactSkipMax"] },
      ]},
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
        { key: "ct_h_usersSendCount",  label: "Send count per session",         settingKeys: ["contact:contactUsersSendCountMin","contact:contactUsersSendCountMax"] },
        { key: "ct_h_usersDelay",      label: "Delay between messages",    settingKeys: ["contact:contactUsersDelayBetweenMin","contact:contactUsersDelayBetweenMax"] },
        { key: "ct_h_usersPickRandom", label: "Pick users randomly",                        settingKeys: ["contact:contactUsersPickRandom"] },
        { key: "ct_h_usersUnsend",     label: "Unsend settings",                            settingKeys: ["contact:contactUsersUnsendEnabled","contact:contactUsersUnsendMin","contact:contactUsersUnsendMax"] },
        { key: "ct_h_usersEquinox",    label: "Message an Aura Farming User",                    settingKeys: ["contact:contactEquinoxUserEnabled","contact:contactEquinoxMessage","contact:contactEquinoxNoRepeat"] },
      ]},
      { key: "hs_contactStopBlock", label: "Stop if Blocked", description: "Pause contact tool for a set time when Instagram blocks a contact action", subOptions: [
        { key: "ct_h_stopEnabled", label: "Enabled",              settingKeys: ["contact:stopOnBlockEnabled"] },
        { key: "ct_h_stopMinutes", label: "Stop duration", settingKeys: ["contact:stopOnBlockMinutes"] },
      ]},
    ]},
    { label: "Web Browsing Settings", options: [
      { key: "hs_webBrowsing", label: "Web Browsing", description: "Website browsing during Instagram sessions — builds genuine browser history", subOptions: [
        { key: "wb_enabled",     label: "Enabled",                                          settingKeys: ["webBrowsingEnabled"] },
        { key: "wb_order",       label: "Execution order",                                  settingKeys: ["webBrowsingOrderMin","webBrowsingOrderMax"] },
        { key: "wb_skip",        label: "Skip chance %",                                    settingKeys: ["webBrowsingSkipMin","webBrowsingSkipMax"] },
        { key: "wb_visitRandom", label: "Visit websites at random",                        settingKeys: ["webBrowsingVisitRandom"] },
        { key: "wb_sites",       label: "Website URLs (tick to copy URLs to other accounts)", settingKeys: ["webBrowsingSites"] },
        { key: "wb_sitesRange",  label: "Sites to visit range",                            settingKeys: ["webBrowsingSitesMin","webBrowsingSitesMax"] },
        { key: "wb_links",       label: "Internal links range",                            settingKeys: ["webBrowsingInternalLinksMin","webBrowsingInternalLinksMax"] },
        { key: "wb_timeOnSite",  label: "Time on site (min) range",                       settingKeys: ["webBrowsingTimeOnSiteMin","webBrowsingTimeOnSiteMax"] },
        { key: "wb_timeOnLinks", label: "Time on internal links (min) range",              settingKeys: ["webBrowsingTimeOnLinksMin","webBrowsingTimeOnLinksMax"] },
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

    const SENTINEL_KEYS = ["startStop", "hs_followEnabled", "hs_unfollowEnabled", "hs_cnfEnabled", "hs_autoReplyEnabled", "hs_contactUsersEnabled", "hs_followSources"];
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
    const copyErrors: string[] = [];
    try {
      await copyToolSettingsToProfiles(settings as Record<string,unknown>, tool.type, targetIds, keysToSend, copyEnabled ? tool.enabled : undefined, staggerOffsets);
    } catch (err) {
      console.error("[copySettings] Failed to copy human session settings:", err);
      copyErrors.push("Human session settings");
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
        copyErrors.push("Contact tool settings");
      }
    }

    // ── Copy follow tool target sources ───────────────────────────────────────
    if (copyFollowSources && followTool) {
      const sourcesRes = await fetch(`/api/tools/${followTool.id}/sources`, { credentials: "include" });
      const currentSources: { type: string; value: string; rank?: number | null; nrPosts?: number | null }[] =
        sourcesRes?.ok ? await sourcesRes.json() : [];
      const payload = currentSources.length > 0
        ? currentSources
            .filter((s: any) => s.enabled !== false)
            .map(s => ({ type: s.type, value: s.value, rank: s.rank, nrPosts: s.nrPosts }))
        : [];

      await Promise.all(
        targetIds.map(async profileId => {
          const toolsRes = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
          if (!toolsRes.ok) return;
          const profileTools: { id: number; type: string }[] = await toolsRes.json();
          const targetFollowTool = profileTools.find(t => t.type === "follow");
          if (!targetFollowTool) return;

          // Always delete existing sources first (replace semantics, never append)
          await fetch(`/api/tools/${targetFollowTool.id}/sources`, {
            method: "DELETE",
            credentials: "include",
          });

          if (payload.length > 0) {
            const importRes = await fetch(`/api/tools/${targetFollowTool.id}/sources/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              credentials: "include",
            });
            if (!importRes.ok) {
              console.error(`[copySettings] Sources import failed for profile ${profileId}: ${importRes.status}`);
            }
          }
          queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, targetFollowTool.id] });
        })
      );
    }

    // ── Copy follow tool settings (prefixed keys "follow:...") ───────────────
    const followKeys = [
      ...expandedKeys.filter(k => k.startsWith("follow:")).map(k => k.slice(7)),
      // Always copy ranking percentages alongside the source lists
      ...(copyFollowSources ? ["hashtagSourceRanking", "followerSourceRanking"] : []),
    ];
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
        copyErrors.push("Follow tool settings");
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
        copyErrors.push("Unfollow tool settings");
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
        copyErrors.push("Contact tool settings");
      }
    }

    if (copyErrors.length > 0) {
      throw new Error(`Failed to copy: ${copyErrors.join(", ")}. Check the browser console for details.`);
    }

    // Invalidate React Query caches for every target profile so navigating to
    // them immediately shows the new settings rather than stale cached data.
    targetIds.forEach(profileId => {
      queryClient.invalidateQueries({ queryKey: [api.tools.listByProfile.path, profileId] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, profileId] });
    });
    queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });

    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const { data: repostedPostsList, isLoading: repostedPostsLoading } = useQuery<RepostedPost[]>({
    queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`],
    refetchInterval: 15000,
  });

  const deleteRepostedPost = async (id: number) => {
    await fetch(`/api/reposted-posts/${id}`, { method: "DELETE", credentials: "include" });
    queryClient.invalidateQueries({ queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`] });
  };

  const deleteAllRepostedPosts = async () => {
    await fetch(`/api/profiles/${tool.profileId}/reposted-posts`, { method: "DELETE", credentials: "include" });
    queryClient.invalidateQueries({ queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`] });
  };

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
      settingsActivityRunChanceMin: 50,
      settingsActivityRunChanceMax: 100,
      viewActivityRunChanceMin: 50,
      viewActivityRunChanceMax: 100,
      viewSavedRunChanceMin: 50,
      viewSavedRunChanceMax: 100,
      checkTimelineStoriesEnabled: true,
      checkTimelineStoriesMin: 3,
      checkTimelineStoriesMax: 8,
      checkTimelineStoriesSlideMin: 2,
      checkTimelineStoriesSlideMax: 5,
      checkTimelineStoriesWatchPctMin: 0,
      checkTimelineStoriesWatchPctMax: 0,
      checkTimelineStoriesOrderMin: 0,
      checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0,
      checkTimelineStoriesNotUsedMax: 0,
      storyLikePctMin: 0,
      storyLikePctMax: 0,
      storySharePctMin: 0,
      storySharePctMax: 0,
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
      sharePostPercentMin: 0,
      sharePostPercentMax: 0,
      likeTimelinePostsPercentMin: 0,
      likeTimelinePostsPercentMax: 0,
      expandCaptionPercentMin: 0,
      expandCaptionPercentMax: 0,
      tapAudioPercentMin: 0,
      tapAudioPercentMax: 0,
      clickHashtagPercentMin: 0,
      clickHashtagPercentMax: 0,
      viewReelsEnabled: false,
      viewReelsOrderMin: 0,
      viewReelsOrderMax: 0,
      viewReelsNotUsedMin: 0,
      viewReelsNotUsedMax: 0,
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
      explorePageOrderMin: 0,
      explorePageOrderMax: 0,
      explorePageSkipMin: 0,
      explorePageSkipMax: 0,
      exploreScrollMin: 5,
      exploreScrollMax: 15,
      exploreClickMin: 1,
      exploreClickMax: 3,
      exploreLikePctMin: 0,
      exploreLikePctMax: 30,
      exploreVisitProfilePctMin: 0,
      exploreVisitProfilePctMax: 20,
      exploreProfileScrollMin: 3,
      exploreProfileScrollMax: 8,
      exploreProfileClickMin: 1,
      exploreProfileClickMax: 3,
      repostEnabled: false,
      repostUseHikerApi: false,
      repostSourceUsername: "",
      repostDisableUsernameSource: false,
      repostLocalFolderEnabled: false,
      repostLocalFolderPath: "",
      repostLocalFolderDeleteAfterUpload: true,
      repostLocalFolderNoRepeat: false,
      repostUseChatGpt: false,
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
      reelWatchChanceMin: 100,
      reelWatchChanceMax: 100,
      reelWatchCountMin: 1,
      reelWatchCountMax: 3,
      reelLikePercentMin: 0,
      reelLikePercentMax: 0,
      repostMin: 1,
      repostMax: 1,
      webBrowsingEnabled: false,
      webBrowsingOrderMin: 0,
      webBrowsingOrderMax: 0,
      webBrowsingSkipMin: 0,
      webBrowsingSkipMax: 0,
      webBrowsingVisitRandom: true,
      webBrowsingSites: "",
      webBrowsingSitesMin: 3,
      webBrowsingSitesMax: 5,
      webBrowsingInternalLinksMin: 2,
      webBrowsingInternalLinksMax: 5,
      webBrowsingTimeOnSiteMin: 1,
      webBrowsingTimeOnSiteMax: 3,
      webBrowsingTimeOnLinksMin: 1,
      webBrowsingTimeOnLinksMax: 2,
    };
    return { ...def, ...(tool.settings as Record<string, any> || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      settingsActivityRunChanceMin: 50, settingsActivityRunChanceMax: 100,
      viewActivityRunChanceMin: 50, viewActivityRunChanceMax: 100,
      viewSavedRunChanceMin: 50, viewSavedRunChanceMax: 100,
      checkTimelineStoriesEnabled: true, checkTimelineStoriesMin: 3, checkTimelineStoriesMax: 8,
      checkTimelineStoriesSlideMin: 2, checkTimelineStoriesSlideMax: 5,
      checkTimelineStoriesWatchPctMin: 0, checkTimelineStoriesWatchPctMax: 0,
      checkTimelineStoriesOrderMin: 0, checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0, checkTimelineStoriesNotUsedMax: 0,
      storyLikePctMin: 0, storyLikePctMax: 0, storySharePctMin: 0, storySharePctMax: 0,
      checkDmEnabled: true, checkDmMin: 5, checkDmMax: 15,
      checkDmOrderMin: 0, checkDmOrderMax: 0, checkDmNotUsedMin: 0, checkDmNotUsedMax: 0,
      likeTimelinePostsEnabled: false, likeTimelinePostsMin: 2, likeTimelinePostsMax: 5,
      likeTimelinePostsDelayMin: 3, likeTimelinePostsDelayMax: 8,
      likeTimelinePostsOrderMin: 0, likeTimelinePostsOrderMax: 0,
      likeTimelinePostsNotUsedMin: 0, likeTimelinePostsNotUsedMax: 0,
      saveMediaEnabled: false, saveMediaPercent: 20,
      sharePostPercentMin: 0, sharePostPercentMax: 0,
      likeTimelinePostsPercentMin: 0, likeTimelinePostsPercentMax: 0,
      expandCaptionPercentMin: 0, expandCaptionPercentMax: 0,
      tapAudioPercentMin: 0, tapAudioPercentMax: 0,
      clickHashtagPercentMin: 0, clickHashtagPercentMax: 0,
      viewReelsEnabled: false, viewReelsOrderMin: 0, viewReelsOrderMax: 0,
      viewReelsNotUsedMin: 0, viewReelsNotUsedMax: 0,
      viewPostProfilePercentMin: 0, viewPostProfilePercentMax: 0,
      viewProfileFeedPercentMin: 0, viewProfileFeedPercentMax: 0,
      viewProfileFeedCountMin: 3, viewProfileFeedCountMax: 8,
      viewProfilePostsPercentMin: 0, viewProfilePostsPercentMax: 0,
      viewProfilePostsCountMin: 1, viewProfilePostsCountMax: 3,
      followOrderMin: 0, followOrderMax: 0, followSkipMin: 0, followSkipMax: 0,
      unfollowOrderMin: 0, unfollowOrderMax: 0, unfollowSkipMin: 0, unfollowSkipMax: 0,
      contactOrderMin: 0, contactOrderMax: 0, contactSkipMin: 0, contactSkipMax: 0,
      followSuggestedUsersIfEmptyEnabled: false, followSuggestedUsersIfEmptyMin: 1, followSuggestedUsersIfEmptyMax: 3,
      explorePageOrderMin: 0, explorePageOrderMax: 0,
      explorePageSkipMin: 0, explorePageSkipMax: 0,
      exploreScrollMin: 5, exploreScrollMax: 15,
      exploreClickMin: 1, exploreClickMax: 3,
      exploreLikePctMin: 0, exploreLikePctMax: 30,
      exploreVisitProfilePctMin: 0, exploreVisitProfilePctMax: 20,
      exploreProfileScrollMin: 3, exploreProfileScrollMax: 8,
      exploreProfileClickMin: 1, exploreProfileClickMax: 3,
      repostEnabled: false, repostUseHikerApi: false, repostSourceUsername: "",
      repostDisableUsernameSource: false, repostLocalFolderEnabled: false,
      repostLocalFolderPath: "", repostLocalFolderDeleteAfterUpload: true,
      repostLocalFolderNoRepeat: false, repostUseChatGpt: false,
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
      reelWatchChanceMin: 100, reelWatchChanceMax: 100,
      reelWatchCountMin: 1, reelWatchCountMax: 3,
      reelLikePercentMin: 0, reelLikePercentMax: 0,
      repostMin: 1, repostMax: 1,
      webBrowsingEnabled: false,
      webBrowsingOrderMin: 0, webBrowsingOrderMax: 0,
      webBrowsingSkipMin: 0, webBrowsingSkipMax: 0,
      webBrowsingVisitRandom: true,
      webBrowsingSites: "",
      webBrowsingSitesMin: 3, webBrowsingSitesMax: 5,
      webBrowsingInternalLinksMin: 2, webBrowsingInternalLinksMax: 5,
      webBrowsingTimeOnSiteMin: 1, webBrowsingTimeOnSiteMax: 3,
      webBrowsingTimeOnLinksMin: 1, webBrowsingTimeOnLinksMax: 2,
    };
    setSettings(prev => ({ ...def, ...(tool.settings as Record<string, any> || {}), ...prev }));
  }, [tool.id]);

  const latestHsSettings = useRef(settings);
  useEffect(() => { latestHsSettings.current = settings; });
  const hsToolIdRef = useRef(tool.id);
  const hsProfileIdRef = useRef(tool.profileId);
  useEffect(() => { hsToolIdRef.current = tool.id; hsProfileIdRef.current = tool.profileId; }, [tool.id, tool.profileId]);
  // Flush pending save immediately on unmount so settings survive panel close / app restart
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        updateToolMutation.mutate({ id: hsToolIdRef.current, profileId: hsProfileIdRef.current, settings: latestHsSettings.current });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
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
          <NumField min={0} max={100} className="w-16 h-7 text-xs pr-5"
            value={settings[minKey] ?? 0}
            onChange={(v) => setSettings({ ...settings, [minKey]: v })}
          />
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground uppercase">Max</Label>
        <div className="relative">
          <NumField min={0} max={100} className="w-16 h-7 text-xs pr-5"
            value={settings[maxKey] ?? 0}
            onChange={(v) => setSettings({ ...settings, [maxKey]: v })}
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

  const { data: cbActivity } = useQuery<Array<{ sessionAt: number; sites: Array<{ url: string; visitedAt: number; scrollTimeSec: number; linksVisited: string[] }>; error?: string }>>({
    queryKey: [`/api/profiles/${tool.profileId}/cookie-baker/activity`],
    refetchInterval: 30000,
  });

  const handleSplitWebsites = async () => {
    const allUrls = ((settings as any).webBrowsingSites ?? "")
      .split("\n")
      .map((u: string) => u.trim())
      .filter((u: string) => u.startsWith("http"));
    if (allUrls.length === 0) {
      toast({ title: "No URLs", description: "Add website URLs to this account first, then split.", variant: "destructive" });
      return;
    }
    // Deduplicate URLs first so split guarantees no cross-account duplicates
    const uniqueUrls = [...new Set(allUrls)];
    const profileIds = [...new Set([tool.profileId, ...allProfiles.map(p => p.id)])];
    if (profileIds.length === 0) return;
    // Round-robin distribution: each URL goes to exactly one account
    const buckets: string[][] = profileIds.map(() => []);
    uniqueUrls.forEach((url, idx) => buckets[idx % profileIds.length].push(url));
    try {
      await Promise.all(profileIds.map(async (profileId, i) => {
        const chunk = buckets[i];
        if (chunk.length === 0) return;
        const chunkStr = chunk.join("\n");
        if (profileId === tool.profileId) {
          setSettings((prev: any) => ({ ...prev, webBrowsingSites: chunkStr }));
          return; // will be saved automatically by the settings watcher
        }
        const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
        if (!res.ok) return;
        const tools: { id: number; type: string; settings: any }[] = await res.json();
        const hsTool = tools.find(t => t.type === "human_sessions");
        if (!hsTool) return;
        await fetch(`/api/tools/${hsTool.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { ...(hsTool.settings ?? {}), webBrowsingSites: chunkStr } }),
          credentials: "include",
        });
      }));
      toast({ title: "URLs split", description: `Distributed ${uniqueUrls.length} URL${uniqueUrls.length !== 1 ? "s" : ""} across ${profileIds.length} account${profileIds.length !== 1 ? "s" : ""} — no duplicates.` });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    } catch {
      toast({ title: "Split failed", description: "Could not distribute URLs to all accounts.", variant: "destructive" });
    }
  };
  const lastAction = sessionActions?.find(a => a.toolId === tool.id);
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const nextRunStatus: { label: string; executing: boolean } | null = (() => {
    if (!tool.enabled) return null;
    if (!lastAction && !(engineStatus?.nextHumanSessionAt)) return null;
    const nextAt = engineStatus?.nextHumanSessionAt ?? 0;
    if (!nextAt || nextAt <= Date.now()) return { label: "Executing", executing: true };
    return { label: format(new Date(nextAt), "hh:mm:ssaaa - do MMMM yyyy"), executing: false };
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
              <NumField min={1} max={10000} className="w-14 h-7 text-xs"
                value={settings.delayMin ?? 30}
                onChange={(v) => setSettings({ ...settings, delayMin: v })}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-[10px] text-muted-foreground">Max</Label>
              <NumField min={1} max={10000} className="w-14 h-7 text-xs"
                value={settings.delayMax ?? 60}
                onChange={(v) => setSettings({ ...settings, delayMax: v })}
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
      <div className="mt-[25px]">
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 border-b border-cyan-400">
            <input type="checkbox" id="emulationGroupEnabled"
              checked={(settings as any).emulationGroupEnabled !== false}
              onChange={(e) => setSettings({ ...settings, emulationGroupEnabled: e.target.checked } as any)}
              className="w-3.5 h-3.5 cursor-pointer shrink-0"
              style={{ accentColor: 'white' }}
            />
            <Zap className="w-5 h-5 text-white shrink-0" />
            <h4 className="font-bold text-[17px] text-white">Emulation</h4>
          </div>
          {(settings as any).emulationGroupEnabled !== false && (
          <div className="divide-y divide-border">

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
                      <NumField min={1} max={100} className="w-14 h-7 text-xs"
                        value={settings.viewTimelineFeedMin ?? 3}
                        onChange={(v) => setSettings({ ...settings, viewTimelineFeedMin: v })}
                      />
                      <Label className="text-xs text-muted-foreground">Max</Label>
                      <NumField min={1} max={100} className="w-14 h-7 text-xs"
                        value={settings.viewTimelineFeedMax ?? 8}
                        onChange={(v) => setSettings({ ...settings, viewTimelineFeedMax: v })}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedNotUsedMax: v })}
                    />
                  </div>
                </div>
              </div>
              {/* Expand Caption% — click "more" on a % of viewed posts */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("expandCaptionPercentMin", "expandCaptionPercentMax")}
                  <AlignLeft className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Expand Caption%</span>
                </div>
              </div>
              {/* ROW 3: Tap Audio% — tap the music affordance on a post to browse the song's grid */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("tapAudioPercentMin", "tapAudioPercentMax")}
                  <Music className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Tap Audio%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">tap post audio to browse other posts with same song</span>
                </div>
              </div>
              {/* ROW 3b: Click Hashtag% — tap a hashtag in the caption to browse that hashtag's grid */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("clickHashtagPercentMin", "clickHashtagPercentMax")}
                  <Hash className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Click Hashtag%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">tap a caption hashtag, scroll grid, 1–10% chance to tap a post</span>
                </div>
              </div>
              {/* ROW 4 (was 2): Like Delay | Save Liked | Like% — left-aligned */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("likeTimelinePostsPercentMin", "likeTimelinePostsPercentMax")}
                  <Heart className="w-3.5 h-3.5 text-red-500 fill-red-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like Delay</span>
                  <Label className="text-xs text-muted-foreground">Min</Label>
                  <div className="relative">
                    <NumField min={0} max={300} className="w-14 h-7 text-xs pr-4"
                      value={settings.likeTimelinePostsDelayMin ?? 3}
                      onChange={(v) => setSettings({ ...settings, likeTimelinePostsDelayMin: v })}
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">s</span>
                  </div>
                  <Label className="text-xs text-muted-foreground">Max</Label>
                  <div className="relative">
                    <NumField min={0} max={300} className="w-14 h-7 text-xs pr-4"
                      value={settings.likeTimelinePostsDelayMax ?? 8}
                      onChange={(v) => setSettings({ ...settings, likeTimelinePostsDelayMax: v })}
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
                      <NumField min={1} max={100} className="w-14 h-7 text-xs pr-5"
                        value={settings.saveMediaPercent ?? 20}
                        onChange={(v) => setSettings({ ...settings, saveMediaPercent: v })}
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">of liked saved</span>
                  </div>
                </div>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <div className="flex items-center gap-1.5">
                  {pctInputs("sharePostPercentMin", "sharePostPercentMax")}
                  <Repeat2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Share%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">chance to share viewed posts to feed</span>
                </div>
              </div>
        {/* ── Visit Profile → View Feed → View Posts cascade ── */}
        {!!settings.viewTimelineFeedEnabled && (
          <div className="space-y-2 pt-1">

            {/* Visit Profile % — chance to visit the post author's profile directly from the feed */}
            <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-border/40">
              {pctInputs("viewPostProfilePercentMin", "viewPostProfilePercentMax")}
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE%</span>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">CHANCE TO VISIT THE POST AUTHOR'S PROFILE</span>
            </div>

            {/* View Profile's Feed % + View Timeline Posts — on same row */}
            {(settings.viewPostProfilePercentMax ?? 0) > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {pctInputs("viewProfileFeedPercentMin", "viewProfileFeedPercentMax")}
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE'S FEED%</span>
                {(settings.viewProfileFeedPercentMax ?? 0) > 0 && (
                  <>
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">AMOUNT OF POSTS TO SCROLL ON</span>
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={20} className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, viewProfilePostsCountMin: v })}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={20} className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, viewProfilePostsCountMax: v })}
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

            {/* ── Visit Explore Page ── */}
            <div className="px-4 py-3 space-y-2">
              {/* Title row */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <input type="checkbox" id="followSuggestedUsersIfEmptyEnabled"
                    checked={!!(settings as any).followSuggestedUsersIfEmptyEnabled}
                    onChange={(e) => setSettings({ ...settings, followSuggestedUsersIfEmptyEnabled: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="followSuggestedUsersIfEmptyEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <Compass className="w-4 h-4 text-cyan-500 shrink-0" />
                    Visit Explore Page
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!(settings as any).followSuggestedUsersIfEmptyEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageOrderMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageOrderMax: v } as any)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageSkipMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageSkipMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageSkipMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageSkipMax: v } as any)}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-settings */}
              {!!(settings as any).followSuggestedUsersIfEmptyEnabled && (
                <div className="space-y-1.5 pl-5">
                  {/* Row 1: Posts to scroll on Explore */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreScrollMin ?? 5}
                      onChange={(v) => setSettings({ ...settings, exploreScrollMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreScrollMax ?? 15}
                      onChange={(v) => setSettings({ ...settings, exploreScrollMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Scroll on Explore</span>
                  </div>
                  {/* Row 2: Posts to click on */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={0} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreClickMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, exploreClickMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={0} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreClickMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreClickMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Click On</span>
                  </div>
                  {/* Row 3: Like % */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreLikePctMin ?? 0}
                          onChange={(v) => setSettings({ ...settings, exploreLikePctMin: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreLikePctMax ?? 30}
                          onChange={(v) => setSettings({ ...settings, exploreLikePctMax: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <Heart className="w-3.5 h-3.5 text-red-500 fill-red-500 shrink-0" />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                  </div>
                  {/* Row 4: Visit Author's Profile % */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreVisitProfilePctMin ?? 0}
                          onChange={(v) => setSettings({ ...settings, exploreVisitProfilePctMin: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreVisitProfilePctMax ?? 20}
                          onChange={(v) => setSettings({ ...settings, exploreVisitProfilePctMax: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <User className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Visit Author's Profile%</span>
                  </div>
                  {/* Row 5: Posts to scroll on profile */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileScrollMin ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreProfileScrollMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileScrollMax ?? 8}
                      onChange={(v) => setSettings({ ...settings, exploreProfileScrollMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Scroll on Profile</span>
                  </div>
                  {/* Row 6: Posts to click on profile */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={0} max={20} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileClickMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, exploreProfileClickMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={0} max={20} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileClickMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreProfileClickMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Click on Profile</span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Random Actions ── */}
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 shrink-0">
                  <input type="checkbox" id="humanSessionEnabled"
                    checked={!!settings.humanSessionEnabled}
                    onChange={(e) => setSettings({ ...settings, humanSessionEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="humanSessionEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <User className="w-4 h-4 text-violet-500" />
                    Random Actions
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.humanSessionOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, humanSessionOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.humanSessionOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, humanSessionOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.humanSessionNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, humanSessionNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.humanSessionNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, humanSessionNotUsedMax: v })}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-row — all 5 jitter action chances on one row */}
              <div className={`flex items-center gap-1 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                {([
                  { minKey: "notificationsRunChanceMin",    maxKey: "notificationsRunChanceMax",    label: "Notifs",    Icon: Bell,      color: "text-orange-500" },
                  { minKey: "ownProfileRunChanceMin",       maxKey: "ownProfileRunChanceMax",       label: "Profile",   Icon: User,      color: "text-indigo-500" },
                  { minKey: "settingsActivityRunChanceMin", maxKey: "settingsActivityRunChanceMax", label: "Settings",  Icon: Settings,  color: "text-gray-500"   },
                  { minKey: "viewActivityRunChanceMin",     maxKey: "viewActivityRunChanceMax",     label: "Activity",  Icon: Zap,       color: "text-yellow-500" },
                  { minKey: "viewSavedRunChanceMin",        maxKey: "viewSavedRunChanceMax",        label: "Saved",     Icon: Bookmark,  color: "text-pink-500"   },
                ] as { minKey: string; maxKey: string; label: string; Icon: React.ElementType; color: string }[]).map(({ minKey, maxKey, label, Icon, color }) => (
                  <div key={minKey} className="flex-1 flex flex-col items-center gap-0.5">
                    <div className="flex items-center gap-1">
                      <Icon className={`w-3 h-3 shrink-0 ${color}`} />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">{label}</span>
                    </div>
                    <div className="flex items-center gap-0.5 w-full">
                      <div className="relative flex-1">
                        <NumField min={0} max={100} className="w-full h-7 text-xs pr-4 pl-1"
                          value={(settings as any)[minKey] ?? 100}
                          onChange={v => setSettings({ ...settings, [minKey]: v } as any)}
                        />
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">–</span>
                      <div className="relative flex-1">
                        <NumField min={0} max={100} className="w-full h-7 text-xs pr-4 pl-1"
                          value={(settings as any)[maxKey] ?? 100}
                          onChange={v => setSettings({ ...settings, [maxKey]: v } as any)}
                        />
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── View Reels ── */}
            <div className="px-4 py-3 space-y-2">
              {/* Title row */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <input type="checkbox" id="viewReelsEnabled"
                    checked={!!(settings as any).viewReelsEnabled}
                    onChange={(e) => setSettings({ ...settings, viewReelsEnabled: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="viewReelsEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <Film className="w-4 h-4 text-violet-500 shrink-0" />
                    View Reels
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!(settings as any).viewReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).viewReelsOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewReelsOrderMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).viewReelsOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewReelsOrderMax: v } as any)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).viewReelsNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewReelsNotUsedMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).viewReelsNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewReelsNotUsedMax: v } as any)}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-row — settings below title */}
              <div className={`flex items-center gap-2.5 flex-wrap transition-opacity ${!(settings as any).viewReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("reelWatchChanceMin", "reelWatchChanceMax")}
                  <Percent className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Chance%</span>
                </div>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                  <NumField min={0} max={50} className="w-16 h-7 text-xs"
                    value={settings.reelWatchCountMin ?? 1}
                    onChange={(v) => setSettings({ ...settings, reelWatchCountMin: v })}
                  />
                  <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                  <NumField min={0} max={50} className="w-16 h-7 text-xs"
                    value={settings.reelWatchCountMax ?? 3}
                    onChange={(v) => setSettings({ ...settings, reelWatchCountMax: v })}
                  />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reels/Op</span>
                </div>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <div className="flex items-center gap-1.5">
                  {pctInputs("reelWatchPercentMin", "reelWatchPercentMax")}
                  <PlaySquare className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reel View%</span>
                </div>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <div className="flex items-center gap-1.5">
                  {pctInputs("reelLikePercentMin", "reelLikePercentMax")}
                  <Heart className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reel Like%</span>
                </div>
              </div>
            </div>

            {/* ── Check Stories from Timeline ── */}
            <div className="px-4 py-3 space-y-2">
              {/* Title row — checkbox + label + ORDER/SKIP on right */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <input type="checkbox" id="checkTimelineStoriesEnabled"
                    checked={!!settings.checkTimelineStoriesEnabled}
                    onChange={(e) => setSettings({ ...settings, checkTimelineStoriesEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="checkTimelineStoriesEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <BookOpen className="w-4 h-4 text-sky-500 shrink-0" />
                    Check Stories from Timeline
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkTimelineStoriesOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkTimelineStoriesOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkTimelineStoriesNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkTimelineStoriesNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkTimelineStoriesNotUsedMax: v })}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-row 1 — Users to Watch | Slides per User | Watch % */}
              <div className={`flex items-center gap-2.5 flex-wrap transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <NumField min={1} max={50} className="w-14 h-7 text-xs"
                  value={settings.checkTimelineStoriesMin ?? 3}
                  onChange={(v) => setSettings({ ...settings, checkTimelineStoriesMin: v })}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={1} max={50} className="w-14 h-7 text-xs"
                  value={settings.checkTimelineStoriesMax ?? 8}
                  onChange={(v) => setSettings({ ...settings, checkTimelineStoriesMax: v })}
                />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Users to Watch</span>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <NumField min={1} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).checkTimelineStoriesSlideMin ?? 2}
                  onChange={(v) => setSettings({ ...settings, checkTimelineStoriesSlideMin: v } as any)}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={1} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).checkTimelineStoriesSlideMax ?? 5}
                  onChange={(v) => setSettings({ ...settings, checkTimelineStoriesSlideMax: v } as any)}
                />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Slides per User</span>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                {pctInputs("checkTimelineStoriesWatchPctMin", "checkTimelineStoriesWatchPctMax")}
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Watch %</span>
              </div>
              {/* Sub-row 2 — Like % | Share % */}
              <div className={`flex items-center gap-2.5 flex-wrap transition-opacity ${!settings.checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={settings.storyLikePctMin ?? 0}
                  onChange={(v) => setSettings({ ...settings, storyLikePctMin: v })}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={settings.storyLikePctMax ?? 0}
                  onChange={(v) => setSettings({ ...settings, storyLikePctMax: v })}
                />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like %</span>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={settings.storySharePctMin ?? 0}
                  onChange={(v) => setSettings({ ...settings, storySharePctMin: v })}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={settings.storySharePctMax ?? 0}
                  onChange={(v) => setSettings({ ...settings, storySharePctMax: v })}
                />
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Share %</span>
              </div>
            </div>

            {/* ── Check Direct Messages ── */}
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <input type="checkbox" id="checkDmEnabled"
                    checked={!!settings.checkDmEnabled}
                    onChange={(e) => setSettings({ ...settings, checkDmEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="checkDmEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <MessageSquare className="w-4 h-4 text-teal-500 shrink-0" />
                    Check Direct Messages
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkDmOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkDmOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkDmOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkDmOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkDmNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkDmNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.checkDmNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, checkDmNotUsedMax: v })}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-row — Check X/Y settings */}
              <div className={`flex items-center gap-1.5 flex-wrap transition-opacity ${!settings.checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Check</span>
                <Label className="text-xs text-muted-foreground">Min</Label>
                <NumField min={1} max={100} className="w-14 h-7 text-xs"
                  value={settings.checkDmMin ?? 5}
                  onChange={(v) => setSettings({ ...settings, checkDmMin: v })}
                />
                <Label className="text-xs text-muted-foreground">Max</Label>
                <NumField min={1} max={100} className="w-14 h-7 text-xs"
                  value={settings.checkDmMax ?? 15}
                  onChange={(v) => setSettings({ ...settings, checkDmMax: v })}
                />
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
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.repostOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, repostOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.repostOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, repostOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.repostNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, repostNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.repostNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, repostNotUsedMax: v })}
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
                          <th className="px-2 py-2.5 font-bold bg-muted/30 whitespace-nowrap text-right">
                            {repostedPostsList && repostedPostsList.length > 0 && (
                              <button
                                onClick={() => { if (confirm("Delete all posted posts? This allows all images to be re-posted.")) deleteAllRepostedPosts(); }}
                                className="inline-flex items-center gap-1 text-destructive hover:text-destructive/80 transition-colors text-[10px] normal-case font-semibold"
                                title="Delete all posted posts"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete All
                              </button>
                            )}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {repostedPostsLoading ? (
                          Array.from({ length: 4 }).map((_, i) => (
                            <tr key={i} className="animate-pulse">
                              <td colSpan={6} className="px-4 py-3 bg-muted/10 h-10" />
                            </tr>
                          ))
                        ) : !repostedPostsList || repostedPostsList.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
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
                              <td className="px-2 py-2.5 text-right whitespace-nowrap">
                                <button
                                  onClick={() => deleteRepostedPost(rp.id)}
                                  className="text-muted-foreground/40 hover:text-destructive transition-colors p-1 rounded"
                                  title="Delete this entry (allows re-posting this image)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
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
              <div className="flex items-center gap-3">
                <Label className="text-xs text-muted-foreground font-semibold">Post Caption Text</Label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    id="repostUseChatGpt"
                    checked={!!(settings as any).repostUseChatGpt}
                    onChange={(e) => setSettings({ ...settings, repostUseChatGpt: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor="repostUseChatGpt" className="text-xs text-muted-foreground cursor-pointer select-none">Use ChatGPT</label>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    id="repostMakeUnique"
                    checked={!!(settings as any).repostMakeUnique}
                    onChange={(e) => setSettings({ ...settings, repostMakeUnique: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="repostMakeUnique" className="text-xs text-muted-foreground cursor-pointer select-none">Make it unique</label>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    id="repostDisableComments"
                    checked={!!settings.repostDisableComments}
                    onChange={(e) => setSettings({ ...settings, repostDisableComments: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="repostDisableComments" className="text-xs text-muted-foreground cursor-pointer select-none">Disable comments</label>
                </div>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground/70">
              You can use multi-level spin syntax for the caption. Leave blank to use the original post's caption.
            </p>

            <div className="flex items-center gap-2">
              <Textarea
                className="text-xs font-mono resize-none h-[72px] leading-relaxed flex-1"
                rows={3}
                value={(settings as any).repostCaptionText ?? ""}
                onChange={(e) => {
                  setSettings({ ...settings, repostCaptionText: e.target.value } as any);
                  setSpinPreview(null);
                  setSpinSyntaxMsg(null);
                }}
              />
              <div className="flex flex-col gap-1 self-center">
                <button
                  type="button"
                  className="h-6 px-2.5 text-[10px] rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors whitespace-nowrap"
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
                  Check Spintax
                </button>
                <button
                  type="button"
                  className="h-6 px-2.5 text-[10px] rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors whitespace-nowrap"
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
                  className="h-6 px-2 text-[11px] font-mono rounded bg-muted/60 border border-border/50 text-muted-foreground hover:bg-primary/10 hover:border-primary/40 hover:text-primary transition-colors"
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

          {/* Posts per session — always visible regardless of source */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground font-semibold">Posts per session (min / max)</Label>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Min</Label>
                  <NumField min={1} max={20} className="w-16 h-7 text-xs"
                    value={settings.repostMin ?? 1}
                    onChange={(v) => setSettings({ ...settings, repostMin: v })}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Max</Label>
                  <NumField min={1} max={20} className="w-16 h-7 text-xs"
                    value={settings.repostMax ?? 1}
                    onChange={(v) => setSettings({ ...settings, repostMax: v })}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Source 1: @username */}
          <div className="border border-border/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="repostUsernameSourceEnabled"
                checked={!settings.repostDisableUsernameSource}
                onChange={(e) => setSettings({ ...settings, repostDisableUsernameSource: !e.target.checked })}
                className="w-3.5 h-3.5 accent-primary cursor-pointer"
              />
              <label htmlFor="repostUsernameSourceEnabled" className="text-xs font-semibold text-foreground cursor-pointer select-none tracking-wide">
                INSTAGRAM ACCOUNT
              </label>
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
              <NumField
                min={0} className="w-20 h-8 text-xs"
                value={settings.repostDisableAtPostCount ?? 0}
                onChange={(v) => setSettings({ ...settings, repostDisableAtPostCount: v })}
              />
            </div>
            </div>{/* end flex-wrap */}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="repostUseHikerApi"
                  checked={!!settings.repostUseHikerApi}
                  onChange={(e) => setSettings({ ...settings, repostUseHikerApi: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                />
                <label htmlFor="repostUseHikerApi" className="text-xs text-muted-foreground cursor-pointer select-none">
                  Use HikerAPI for scraping
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
                  Disable when no more posts are found
                </label>
              </div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="text"
                    placeholder="C:\Users\You\Pictures\Repost"
                    className="h-8 text-xs font-mono w-[280px]"
                    value={settings.repostLocalFolderPath ?? ""}
                    onChange={(e) => setSettings({ ...settings, repostLocalFolderPath: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const api = (window as any).electronAPI;
                      if (!api?.openFolderDialog) return;
                      const result = await api.openFolderDialog();
                      if (result?.canceled || !result?.folder) return;
                      const folderPath: string = result.folder;
                      const updatedSettings = { ...settings, repostLocalFolderPath: folderPath };
                      setSettings(updatedSettings);
                      // Save immediately — bypass the 600ms debounce so the path
                      // is written to the DB before Electron can close. The normal
                      // debounce only fires if the user keeps editing; for a native
                      // file-dialog pick we need instant persistence.
                      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
                      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings: updatedSettings });
                      try {
                        const countResult = await api.countFolderFiles(folderPath);
                        setLocalFolderFileCount(countResult?.count ?? 0);
                      } catch { setLocalFolderFileCount(0); }
                    }}
                    className="h-8 px-3 text-xs rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    Browse…
                  </button>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="repostLocalFolderNoRepeat"
                      checked={!!(settings as any).repostLocalFolderNoRepeat}
                      onChange={(e) => setSettings({ ...settings, repostLocalFolderNoRepeat: e.target.checked } as any)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                    />
                    <label htmlFor="repostLocalFolderNoRepeat" className="text-xs text-muted-foreground cursor-pointer select-none">
                      Do not repost the same image
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="repostLocalFolderRandom"
                      checked={!!(settings as any).repostLocalFolderRandom}
                      onChange={(e) => setSettings({ ...settings, repostLocalFolderRandom: e.target.checked } as any)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                    />
                    <label htmlFor="repostLocalFolderRandom" className="text-xs text-muted-foreground cursor-pointer select-none">
                      Pick at random
                    </label>
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
                      Delete from PC after upload
                    </label>
                  </div>

                </div>
                {localFolderFileCount !== null && (
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <FolderOpen className="w-3 h-3 shrink-0" />
                    {localFolderFileCount} image{localFolderFileCount !== 1 ? "s" : ""} found in folder.
                  </p>
                )}
              </div>
            </div>
          </div>{/* end Source 2 border */}



        </div>
      </div>

          </div>
          )}{/* end emulationGroupEnabled conditional + divide-y */}
        </div>{/* end EMULATION rounded-xl */}
      </div>{/* end EMULATION outer */}

      {/* ── Follow Tool (embedded) ────────────────────────────── */}
      {followTool && (
        <div className="mt-[25px]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center border-b border-border">
              <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 w-[37.5%] shrink-0">
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
              <div className="ml-auto flex flex-col gap-1.5 shrink-0 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).followOrderMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, followOrderMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).followOrderMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, followOrderMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).followSkipMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, followSkipMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).followSkipMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, followSkipMax: v } as any)}
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
        <div className="mt-[25px]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center border-b border-border">
              <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 w-[37.5%] shrink-0">
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
              <div className="ml-auto flex flex-col gap-1.5 shrink-0 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowOrderMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, unfollowOrderMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowOrderMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, unfollowOrderMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowSkipMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, unfollowSkipMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).unfollowSkipMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, unfollowSkipMax: v } as any)}
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
        <div className="mt-[25px]">
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center border-b border-border">
              <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 w-[37.5%] shrink-0">
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
              <div className="ml-auto flex flex-col gap-1.5 shrink-0 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).contactOrderMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, contactOrderMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).contactOrderMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, contactOrderMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).contactSkipMin ?? 0}
                    onChange={(v) => setSettings({ ...settings, contactSkipMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).contactSkipMax ?? 0}
                    onChange={(v) => setSettings({ ...settings, contactSkipMax: v } as any)}
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

      {/* ── Web Browsing (LAST — visits external sites to build browser history) ── */}
      <div className="mt-[25px]">
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="flex items-center border-b border-border">
            <div className="flex items-center gap-2 px-4 py-3 bg-cyan-500 w-[37.5%] shrink-0">
              <Globe className="w-5 h-5 text-white shrink-0" />
              <h4 className="font-bold text-[19px] shrink-0 text-white">Web Browsing</h4>
              <input
                type="checkbox"
                id="webBrowsingEnabled"
                checked={!!settings.webBrowsingEnabled}
                onChange={(e) => setSettings({ ...settings, webBrowsingEnabled: e.target.checked })}
                className="w-3.5 h-3.5 accent-white cursor-pointer"
              />
              <label htmlFor="webBrowsingEnabled" className="text-sm font-medium cursor-pointer select-none text-white">
                {settings.webBrowsingEnabled ? "ACTIVE" : "STOPPED"}
              </label>
            </div>
            <div className="ml-auto flex flex-col gap-1.5 shrink-0 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).webBrowsingOrderMin ?? 0}
                  onChange={(v) => setSettings({ ...settings, webBrowsingOrderMin: v } as any)}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).webBrowsingOrderMax ?? 0}
                  onChange={(v) => setSettings({ ...settings, webBrowsingOrderMax: v } as any)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).webBrowsingSkipMin ?? 0}
                  onChange={(v) => setSettings({ ...settings, webBrowsingSkipMin: v } as any)}
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <NumField min={0} max={100} className="w-14 h-7 text-xs"
                  value={(settings as any).webBrowsingSkipMax ?? 0}
                  onChange={(v) => setSettings({ ...settings, webBrowsingSkipMax: v } as any)}
                />
              </div>
            </div>
          </div>
          {/* Tab bar — only shown when enabled */}
          {!!settings.webBrowsingEnabled && (
          <div className="flex border-b border-border bg-muted/30">
            <button
              onClick={() => setWebBrowsingTab("settings")}
              className={`px-4 py-2 text-xs font-semibold transition-colors ${webBrowsingTab === "settings" ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              Settings
            </button>
            <button
              onClick={() => setWebBrowsingTab("log")}
              className={`px-4 py-2 text-xs font-semibold transition-colors ${webBrowsingTab === "log" ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              Sites Visited
            </button>
          </div>
          )}
          {!!settings.webBrowsingEnabled && (webBrowsingTab === "settings" ? (
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="webBrowsingVisitRandom"
                    checked={(settings as any).webBrowsingVisitRandom !== false}
                    onChange={(e) => setSettings({ ...settings, webBrowsingVisitRandom: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <label htmlFor="webBrowsingVisitRandom" className="text-sm cursor-pointer select-none">Visit websites at random</label>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto text-xs gap-1.5 border-cyan-300 text-cyan-700 hover:bg-cyan-50 hover:border-cyan-400 dark:text-cyan-400"
                  onClick={handleSplitWebsites}
                  title="Distribute all URLs evenly across every account — no duplicates"
                >
                  <Repeat2 className="w-3.5 h-3.5" />
                  Split across accounts
                </Button>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Website URLs (one per line)</Label>
                <Textarea
                  rows={6}
                  placeholder={"https://example.com\nhttps://news.ycombinator.com\nhttps://reddit.com"}
                  value={(settings as any).webBrowsingSites ?? ""}
                  onChange={(e) => setSettings({ ...settings, webBrowsingSites: e.target.value } as any)}
                  className="text-xs font-mono resize-none"
                  spellCheck={false}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  {((settings as any).webBrowsingSites ?? "").split("\n").filter((u: string) => u.trim().startsWith("http")).length} URL{((settings as any).webBrowsingSites ?? "").split("\n").filter((u: string) => u.trim().startsWith("http")).length !== 1 ? "s" : ""} · "Split across accounts" divides these evenly with no duplicates
                </p>
              </div>
              <div className="flex gap-4 flex-wrap items-center">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Sites to Visit</Label>
                  <NumField min={1} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingSitesMin ?? 3}
                    onChange={(v) => setSettings({ ...settings, webBrowsingSitesMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={1} max={100} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingSitesMax ?? 5}
                    onChange={(v) => setSettings({ ...settings, webBrowsingSitesMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Internal Links</Label>
                  <NumField min={0} max={50} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingInternalLinksMin ?? 2}
                    onChange={(v) => setSettings({ ...settings, webBrowsingInternalLinksMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={50} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingInternalLinksMax ?? 5}
                    onChange={(v) => setSettings({ ...settings, webBrowsingInternalLinksMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Time on Site (min)</Label>
                  <NumField min={0} max={60} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingTimeOnSiteMin ?? 1}
                    onChange={(v) => setSettings({ ...settings, webBrowsingTimeOnSiteMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={60} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingTimeOnSiteMax ?? 3}
                    onChange={(v) => setSettings({ ...settings, webBrowsingTimeOnSiteMax: v } as any)}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground whitespace-nowrap">Time on Links (min)</Label>
                  <NumField min={0} max={60} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingTimeOnLinksMin ?? 1}
                    onChange={(v) => setSettings({ ...settings, webBrowsingTimeOnLinksMin: v } as any)}
                  />
                  <span className="text-[10px] text-muted-foreground">–</span>
                  <NumField min={0} max={60} className="w-14 h-7 text-xs"
                    value={(settings as any).webBrowsingTimeOnLinksMax ?? 2}
                    onChange={(v) => setSettings({ ...settings, webBrowsingTimeOnLinksMax: v } as any)}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4">
              {!cbActivity || cbActivity.length === 0 ? (
                <p className="text-xs text-muted-foreground">No web browsing sessions recorded yet.</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {cbActivity.map((session, si) => (
                    <div key={si} className="border border-border rounded-lg p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <Globe className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                        <span className="text-[11px] font-semibold text-foreground">
                          {new Date(session.sessionAt).toLocaleString()}
                        </span>
                        {session.error && (
                          <span className="text-[10px] text-destructive ml-auto">⚠ {session.error}</span>
                        )}
                      </div>
                      {session.sites.map((site, siteIdx) => (
                        <div key={siteIdx} className="pl-4 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <ExternalLink className="w-3 h-3 text-blue-500 shrink-0" />
                            <a href={site.url} target="_blank" rel="noopener noreferrer"
                               className="text-[11px] text-blue-500 hover:underline truncate max-w-xs">{site.url}</a>
                            <span className="text-[10px] text-muted-foreground ml-auto">{site.scrollTimeSec}s</span>
                          </div>
                          {site.linksVisited.length > 0 && (
                            <div className="pl-4 space-y-0.5">
                              {site.linksVisited.map((link, li) => (
                                <div key={li} className="flex items-center gap-1">
                                  <span className="text-[10px] text-muted-foreground">↳</span>
                                  <a href={link} target="_blank" rel="noopener noreferrer"
                                     className="text-[10px] text-muted-foreground hover:text-foreground hover:underline truncate max-w-xs">{link}</a>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {session.sites.length === 0 && !session.error && (
                        <p className="text-[10px] text-muted-foreground pl-4">No sites visited in this session.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <CopySettingsDialog
        key={_copyOpen ? "open" : "closed"}
        open={_copyOpen}
        onOpenChange={_setCopyOpenFn}
        title="Copy Human Session Settings"
        profiles={otherProfiles}
        optionGroups={HUMAN_COPY_GROUPS}
        onCopy={handleHumanCopy}
        sharedTargetsStorageKey="copyDialog:shared:targets"
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
